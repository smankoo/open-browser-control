/**
 * Firefox implementation of the Open Browser Control action set.
 *
 * Actions here produce the same ActionResult shapes that the protocol
 * defines (src/types/protocol.ts) — agents see no difference between a
 * click executed in Chrome and one executed in Firefox.
 *
 * Because Firefox does not expose the Chrome DevTools Protocol, these
 * actions drive the page through browser.scripting.executeScript (MAIN
 * world) and the tabs/webNavigation APIs.
 *
 * Known tradeoffs:
 *   - Synthetic mouse/keyboard events have isTrusted=false. Most pages are
 *     fine, but a few user-gesture-gated APIs (file pickers, clipboard
 *     writes, some OAuth redirects) are not. The protocol's request_user
 *     action is the escape hatch for those.
 *   - Full-page and rect screenshots use browser.tabs.captureTab (Firefox
 *     only). Captured at 1x CSS resolution so text is readable and
 *     coordinates are stable; downscaled only if the rect would exceed
 *     Firefox's 2D canvas limits. Agents zoom in by re-capturing a
 *     smaller page-coord rect.
 */

import type {
  AgentAction,
  ActionResult,
  ActionSuccess,
  ActionError,
  PageState,
} from '../../types/protocol';
import { isSafeUrl } from '../../utils/url-utils';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function success(id: string, data: Record<string, unknown>, pageState?: PageState): ActionSuccess {
  return { type: 'result', id, success: true, data, pageState };
}

function error(id: string, msg: string): ActionError {
  return { type: 'result', id, success: false, error: msg };
}

async function getPageState(tabId: number): Promise<PageState> {
  const tab = await chrome.tabs.get(tabId);
  return { url: tab.url ?? '', title: tab.title ?? '', tabId };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a function in the page's MAIN world and return its value.
 * chrome.scripting.executeScript returns InjectionResult[] in both Chrome
 * and Firefox (128+).
 */
async function runInPage<A extends unknown[], R>(
  tabId: number,
  fn: (...args: A) => R,
  args?: A
): Promise<R> {
  // `world: 'MAIN'` is needed so the page's own JS state (React, window
  // globals, etc.) is visible. The @types/chrome typings cover this.
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: fn as (...a: unknown[]) => unknown,
    args: (args ?? []) as unknown[],
  });
  return results[0]?.result as R;
}

// ─── Action Dispatcher ───────────────────────────────────────────────────────

export async function executeAction(action: AgentAction, tabId: number): Promise<ActionResult> {
  try {
    switch (action.action) {
      case 'screenshot':
        return await doScreenshot(action.id, tabId, action.params);
      case 'click':
        return await doClick(action.id, tabId, action.params);
      case 'type':
        return await doType(action.id, tabId, action.params);
      case 'keypress':
        return await doKeyPress(action.id, tabId, action.params);
      case 'scroll':
        return await doScroll(action.id, tabId, action.params);
      case 'navigate':
        return await doNavigate(action.id, tabId, action.params);
      case 'wait':
        return await doWait(action.id, tabId, action.params);
      case 'get_dom':
        return await doGetDom(action.id, tabId, action.params);
      case 'get_page_info':
        return await doGetPageInfo(action.id, tabId);
      case 'execute_js':
        return await doExecuteJs(action.id, tabId, action.params);
      case 'select_option':
        return await doSelectOption(action.id, tabId, action.params);
      case 'hover':
        return await doHover(action.id, tabId, action.params);
      case 'new_tab':
        return await doNewTab(action.id, action.params);
      case 'close_tab':
        return await doCloseTab(action.id, tabId);
      case 'switch_tab':
        return await doSwitchTab(action.id, action.params);
      case 'list_tabs':
        return await doListTabs(action.id);
      case 'request_user':
        return error(action.id, 'request_user is handled externally');
      default: {
        const unknownAction = action as { id: string; action: string };
        return error(unknownAction.id, `Unknown action: ${unknownAction.action}`);
      }
    }
  } catch (err) {
    return error(action.id, err instanceof Error ? err.message : String(err));
  }
}

// ─── Screenshot ─────────────────────────────────────────────────────────────

async function captureViewport(tabId: number, windowId: number): Promise<string> {
  // Prefer Firefox's `browser.tabs.captureTab(tabId)` — it captures the
  // given tab regardless of whether it's the window's active tab, which
  // matters when the user is looking at a different tab while the agent
  // works. Fall back to the cross-browser `captureVisibleTab(windowId)`
  // on engines that don't implement captureTab.
  const ff = (globalThis as unknown as {
    browser?: {
      tabs?: {
        captureTab?: (tabId: number, options: { format: string }) => Promise<string>;
        captureVisibleTab?: (windowId: number, options: { format: string }) => Promise<string>;
      };
    };
  }).browser;

  let dataUrl: string;
  if (ff?.tabs?.captureTab) {
    dataUrl = await ff.tabs.captureTab(tabId, { format: 'png' });
  } else if (ff?.tabs?.captureVisibleTab) {
    dataUrl = await ff.tabs.captureVisibleTab(windowId, { format: 'png' });
  } else {
    dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  }
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

async function base64FromBlob(blob: Blob): Promise<string> {
  const reader = new FileReader();
  return new Promise((resolve, reject) => {
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

type CaptureTabFn = (
  tabId: number,
  options: {
    format?: string;
    rect?: { x: number; y: number; width: number; height: number };
    scale?: number;
  },
) => Promise<string>;

function getCaptureTab(): CaptureTabFn | null {
  const ff = (globalThis as unknown as {
    browser?: { tabs?: { captureTab?: CaptureTabFn } };
  }).browser;
  return ff?.tabs?.captureTab ?? null;
}

async function doScreenshot(
  id: string,
  tabId: number,
  params?: {
    fullPage?: boolean;
    selector?: string;
    rect?: { x: number; y: number; width: number; height: number };
  }
): Promise<ActionResult> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.windowId === undefined) return error(id, 'Tab has no window');

  if (params?.selector) {
    // Look up the element's page-coord rect without scrolling — captureTab
    // captures from the rendered page so the element doesn't need to be in
    // the current viewport.
    const rect = await runInPage(tabId, (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: r.x + window.scrollX,
        y: r.y + window.scrollY,
        width: r.width,
        height: r.height,
      };
    }, [params.selector]);

    if (!rect) return error(id, `Element not found: ${params.selector}`);
    return await captureRect(id, tabId, tab.windowId, rect, { kind: 'selector', selector: params.selector });
  }

  if (params?.rect) {
    // Explicit page-coord rect — the zoom-in workflow after a full-page shot.
    return await captureRect(id, tabId, tab.windowId, params.rect, { kind: 'rect' });
  }

  if (params?.fullPage) {
    const dims = await runInPage(tabId, () => ({
      scrollWidth: Math.max(
        document.documentElement.scrollWidth,
        document.body?.scrollWidth ?? 0,
      ),
      scrollHeight: Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight ?? 0,
      ),
    }));
    return await captureRect(
      id, tabId, tab.windowId,
      { x: 0, y: 0, width: dims.scrollWidth, height: dims.scrollHeight },
      { kind: 'fullPage' },
    );
  }

  const base64 = await captureViewport(tabId, tab.windowId);
  const pageState = await getPageState(tabId);
  return success(id, { screenshot: base64, format: 'png', encoding: 'base64' }, pageState);
}

/**
 * Capture a page-coord rectangle using browser.tabs.captureTab (Firefox
 * only). Output is native CSS resolution (scale=1) by default — readable
 * text and predictable coordinates — with downscaling only if the rect
 * would exceed Firefox's 32767-per-side / ~472M-px-area 2D canvas limit.
 *
 * For full-page shots of very long pages, the agent can use the reported
 * `pageRect` to re-capture a narrower region at full detail.
 */
async function captureRect(
  id: string,
  tabId: number,
  _windowId: number,
  rect: { x: number; y: number; width: number; height: number },
  context: { kind: 'selector' | 'rect' | 'fullPage'; selector?: string },
): Promise<ActionResult> {
  const captureTab = getCaptureTab();
  if (!captureTab) {
    return error(id, 'Rect/full-page screenshot requires browser.tabs.captureTab (Firefox only)');
  }

  if (rect.width <= 0 || rect.height <= 0) {
    return error(id, 'Capture rect has non-positive dimensions');
  }

  // captureTab's `scale` maps CSS px → output px 1:1. Default to 1x (readable
  // text, stable coordinates) and only downscale to stay under the canvas
  // limits. No auto-boost to devicePixelRatio: the agent zooms in explicitly
  // by passing a smaller `rect`.
  const MAX_SIDE = 32000;
  const MAX_AREA = 400_000_000;
  let scale = 1;
  if (rect.width * scale > MAX_SIDE) scale = Math.min(scale, MAX_SIDE / rect.width);
  if (rect.height * scale > MAX_SIDE) scale = Math.min(scale, MAX_SIDE / rect.height);
  if (rect.width * rect.height * scale * scale > MAX_AREA) {
    scale = Math.min(scale, Math.sqrt(MAX_AREA / (rect.width * rect.height)));
  }

  const dataUrl = await captureTab(tabId, {
    format: 'png',
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    scale,
  });

  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;

  const pageState = await getPageState(tabId);
  const outputW = Math.round(rect.width * scale);
  const outputH = Math.round(rect.height * scale);
  const data: Record<string, unknown> = {
    screenshot: base64,
    format: 'png',
    encoding: 'base64',
    pageRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    outputSize: { width: outputW, height: outputH },
    scale,
  };
  if (context.kind === 'selector' && context.selector) {
    data.selector = context.selector;
  }
  if (scale < 1) {
    data.note =
      'Image was downscaled to fit canvas limits. To read fine detail, call browser_screenshot again with rect:{x,y,width,height} narrowed to a smaller sub-region.';
  }
  return success(id, data, pageState);
}

// ─── Click / Hover ──────────────────────────────────────────────────────────

async function doClick(
  id: string,
  tabId: number,
  params: { x?: number; y?: number; selector?: string; text?: string; button?: string; clickCount?: number }
): Promise<ActionResult> {
  const button = params.button === 'right' ? 2 : params.button === 'middle' ? 1 : 0;
  const clickCount = params.clickCount ?? 1;

  const result = await runInPage(tabId, (p: {
    x?: number; y?: number; selector?: string; text?: string; button: number; clickCount: number;
  }) => {
    function findByText(target: string): Element | null {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const t = target.toLowerCase();
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (node.textContent?.toLowerCase().includes(t)) {
          const el = node.parentElement;
          if (el) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return el;
          }
        }
      }
      return null;
    }

    let el: Element | null = null;
    let cx = 0;
    let cy = 0;

    if (p.x !== undefined && p.y !== undefined) {
      el = document.elementFromPoint(p.x, p.y);
      cx = p.x;
      cy = p.y;
    } else if (p.selector) {
      el = document.querySelector(p.selector);
      if (el) {
        const r = el.getBoundingClientRect();
        cx = r.x + r.width / 2;
        cy = r.y + r.height / 2;
        if (r.width === 0 || r.height === 0 || cx < 0 || cy < 0) {
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
          const r2 = el.getBoundingClientRect();
          cx = r2.x + r2.width / 2;
          cy = r2.y + r2.height / 2;
        }
      }
    } else if (p.text) {
      el = findByText(p.text);
      if (el) {
        const r = el.getBoundingClientRect();
        cx = r.x + r.width / 2;
        cy = r.y + r.height / 2;
      }
    }

    if (!el) return { ok: false as const, reason: 'not_found' };

    const common = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: cx,
      clientY: cy,
      button: p.button,
      buttons: p.button === 0 ? 1 : p.button === 2 ? 2 : 4,
    };

    (el as HTMLElement).focus?.();
    el.dispatchEvent(new PointerEvent('pointerdown', { ...common, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', common));
    el.dispatchEvent(new PointerEvent('pointerup', { ...common, pointerType: 'mouse', isPrimary: true, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...common, buttons: 0 }));

    for (let i = 0; i < p.clickCount; i++) {
      el.dispatchEvent(new MouseEvent('click', { ...common, detail: i + 1 }));
    }
    if (p.clickCount === 2) {
      el.dispatchEvent(new MouseEvent('dblclick', { ...common, detail: 2 }));
    }

    // Fallback: if it's an anchor with href and nothing navigated, use
    // .click() which triggers the browser's default navigation path.
    if (el.tagName === 'A' && (el as HTMLAnchorElement).href && p.button === 0) {
      (el as HTMLAnchorElement).click();
    }

    return { ok: true as const, x: cx, y: cy };
  }, [{ ...params, button, clickCount }]);

  if (!result?.ok) {
    return error(id, 'Could not find element to click');
  }

  await sleep(100);
  const pageState = await getPageState(tabId);
  return success(id, { clicked: { x: result.x, y: result.y }, button: params.button ?? 'left', clickCount }, pageState);
}

async function doHover(
  id: string,
  tabId: number,
  params: { x?: number; y?: number; selector?: string; text?: string }
): Promise<ActionResult> {
  const result = await runInPage(tabId, (p: { x?: number; y?: number; selector?: string; text?: string }) => {
    function findByText(target: string): Element | null {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const t = target.toLowerCase();
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (node.textContent?.toLowerCase().includes(t)) {
          const el = node.parentElement;
          if (el) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return el;
          }
        }
      }
      return null;
    }

    let el: Element | null = null;
    let cx = 0;
    let cy = 0;
    if (p.x !== undefined && p.y !== undefined) {
      el = document.elementFromPoint(p.x, p.y);
      cx = p.x; cy = p.y;
    } else if (p.selector) {
      el = document.querySelector(p.selector);
      if (el) {
        const r = el.getBoundingClientRect();
        cx = r.x + r.width / 2;
        cy = r.y + r.height / 2;
      }
    } else if (p.text) {
      el = findByText(p.text);
      if (el) {
        const r = el.getBoundingClientRect();
        cx = r.x + r.width / 2;
        cy = r.y + r.height / 2;
      }
    }
    if (!el) return null;

    const common = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy };
    el.dispatchEvent(new PointerEvent('pointerover', { ...common, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseover', common));
    el.dispatchEvent(new PointerEvent('pointermove', { ...common, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousemove', common));
    return { x: cx, y: cy };
  }, [params]);

  if (!result) return error(id, 'Could not find element to hover');

  await sleep(100);
  const pageState = await getPageState(tabId);
  return success(id, { hovered: { x: result.x, y: result.y } }, pageState);
}

// ─── Type / Keypress ────────────────────────────────────────────────────────

async function doType(
  id: string,
  tabId: number,
  params: { text: string; selector?: string; clear?: boolean; pressEnter?: boolean }
): Promise<ActionResult> {
  await runInPage(tabId, (p: { text: string; selector?: string; clear?: boolean; pressEnter?: boolean }) => {
    let target: Element | null = null;
    if (p.selector) {
      target = document.querySelector(p.selector);
      if (target) (target as HTMLElement).focus?.();
    } else {
      target = document.activeElement;
    }
    if (!target) return;

    const setValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const current = p.clear ? '' : target.value;
      setValue(target, current + p.text);
    } else if ((target as HTMLElement).isContentEditable) {
      if (p.clear) {
        const range = document.createRange();
        range.selectNodeContents(target);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        document.execCommand('delete');
      }
      document.execCommand('insertText', false, p.text);
    } else {
      // Fire per-character keyboard events so page handlers see them.
      for (const ch of p.text) {
        target.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, composed: true }));
        target.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true, composed: true }));
        target.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true, composed: true }));
      }
    }

    if (p.pressEnter) {
      const common = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, composed: true, cancelable: true };
      target.dispatchEvent(new KeyboardEvent('keydown', common));
      target.dispatchEvent(new KeyboardEvent('keypress', common));
      target.dispatchEvent(new KeyboardEvent('keyup', common));
      // Submit parent form if present.
      const form = (target as HTMLElement).closest?.('form');
      if (form instanceof HTMLFormElement) {
        form.requestSubmit?.() ?? form.submit();
      }
    }
  }, [params]);

  await sleep(100);
  const pageState = await getPageState(tabId);
  return success(id, { typed: params.text, pressedEnter: !!params.pressEnter }, pageState);
}

async function doKeyPress(
  id: string,
  tabId: number,
  params: { key: string; modifiers?: string[] }
): Promise<ActionResult> {
  await runInPage(tabId, (p: { key: string; modifiers?: string[] }) => {
    const mods = new Set(p.modifiers ?? []);
    const init: KeyboardEventInit = {
      key: p.key,
      code: p.key.length === 1 ? `Key${p.key.toUpperCase()}` : p.key,
      ctrlKey: mods.has('ctrl'),
      altKey: mods.has('alt'),
      shiftKey: mods.has('shift'),
      metaKey: mods.has('meta'),
      bubbles: true,
      composed: true,
      cancelable: true,
    };
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  }, [params]);

  const pageState = await getPageState(tabId);
  return success(id, { key: params.key, modifiers: params.modifiers ?? [] }, pageState);
}

// ─── Scroll ─────────────────────────────────────────────────────────────────

async function doScroll(
  id: string,
  tabId: number,
  params: { direction: string; amount?: number; selector?: string }
): Promise<ActionResult> {
  const amount = params.amount ?? 500;
  let dx = 0, dy = 0;
  switch (params.direction) {
    case 'up': dy = -amount; break;
    case 'down': dy = amount; break;
    case 'left': dx = -amount; break;
    case 'right': dx = amount; break;
  }

  await runInPage(tabId, (p: { dx: number; dy: number; selector?: string }) => {
    if (p.selector) {
      const el = document.querySelector(p.selector);
      if (el) (el as HTMLElement).scrollBy(p.dx, p.dy);
    } else {
      window.scrollBy({ left: p.dx, top: p.dy, behavior: 'instant' as ScrollBehavior });
    }
  }, [{ dx, dy, selector: params.selector }]);

  await sleep(200);
  const pageState = await getPageState(tabId);
  return success(id, { scrolled: params.direction, amount }, pageState);
}

// ─── Navigate / Wait ────────────────────────────────────────────────────────

async function doNavigate(
  id: string,
  tabId: number,
  params: { url: string }
): Promise<ActionResult> {
  if (!isSafeUrl(params.url)) {
    return error(id, `Blocked navigation to unsafe URL: only http and https URLs are allowed`);
  }

  await chrome.tabs.update(tabId, { url: params.url });

  // Wait for the tab to reach status:'complete', with a 10s ceiling.
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 10000);
    const listener = (updatedId: number, changeInfo: { status?: string }) => {
      if (updatedId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });

  const pageState = await getPageState(tabId);
  return success(id, { navigated: params.url }, pageState);
}

async function doWait(
  id: string,
  tabId: number,
  params: { selector?: string; text?: string; ms?: number; navigation?: boolean; timeout?: number }
): Promise<ActionResult> {
  const timeout = params.timeout ?? 10000;

  if (params.ms) {
    await sleep(params.ms);
    const pageState = await getPageState(tabId);
    return success(id, { waited: params.ms }, pageState);
  }

  if (params.selector) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = await runInPage(tabId, (sel: string) => !!document.querySelector(sel), [params.selector]);
      if (found) {
        const pageState = await getPageState(tabId);
        return success(id, { found: params.selector, elapsed: Date.now() - start }, pageState);
      }
      await sleep(200);
    }
    return error(id, `Timeout waiting for selector: ${params.selector}`);
  }

  if (params.text) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = await runInPage(tabId, (txt: string) => !!document.body?.innerText?.includes(txt), [params.text]);
      if (found) {
        const pageState = await getPageState(tabId);
        return success(id, { found: params.text, elapsed: Date.now() - start }, pageState);
      }
      await sleep(200);
    }
    return error(id, `Timeout waiting for text: ${params.text}`);
  }

  if (params.navigation) {
    await sleep(2000);
    const pageState = await getPageState(tabId);
    return success(id, { waited: 'navigation' }, pageState);
  }

  return error(id, 'No wait condition specified');
}

// ─── DOM / Info / JS ────────────────────────────────────────────────────────

async function doGetDom(
  id: string,
  tabId: number,
  params?: { simplified?: boolean; selector?: string }
): Promise<ActionResult> {
  const selector = params?.selector ?? 'body';
  const simplified = params?.simplified !== false;

  if (simplified) {
    const data = await runInPage(tabId, (sel: string) => {
      const root = document.querySelector(sel) || document.body;
      if (!root) return { elements: [], headings: [], textLength: 0 };

      const interactiveSelectors =
        'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [onclick], [tabindex]';
      const elements: Record<string, unknown>[] = [];

      root.querySelectorAll(interactiveSelectors).forEach((el, i) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        if (getComputedStyle(el).visibility === 'hidden') return;

        const value = (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)
          ? el.value.slice(0, 100)
          : '';

        elements.push({
          index: i,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          text: (el.textContent || '').trim().slice(0, 100),
          type: el.getAttribute('type') || '',
          name: el.getAttribute('name') || '',
          id: el.id || '',
          href: el.getAttribute('href') || '',
          placeholder: el.getAttribute('placeholder') || '',
          value,
          ariaLabel: el.getAttribute('aria-label') || '',
          bounds: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        });
      });

      const headings: Record<string, string>[] = [];
      root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
        headings.push({ tag: h.tagName, text: h.textContent?.trim().slice(0, 200) || '' });
      });

      return {
        elements,
        headings,
        textLength: (root as HTMLElement).innerText?.length || 0,
      };
    }, [selector]);

    const pageState = await getPageState(tabId);
    return success(id, { dom: data ?? {} }, pageState);
  }

  const html = await runInPage(tabId, (sel: string) => {
    const root = document.querySelector(sel) || document.body;
    if (!root) return '';
    const s = (root as HTMLElement).outerHTML;
    return s.length > 50000 ? s.slice(0, 50000) + '... [truncated]' : s;
  }, [selector]);

  const pageState = await getPageState(tabId);
  return success(id, { html: html ?? '' }, pageState);
}

async function doGetPageInfo(id: string, tabId: number): Promise<ActionResult> {
  const pageState = await getPageState(tabId);
  const info = await runInPage(tabId, () => ({
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    forms: document.forms.length,
    links: document.links.length,
    images: document.images.length,
    cookies: document.cookie ? 'present' : 'none',
    scrollY: window.scrollY,
    scrollHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight,
    viewportWidth: window.innerWidth,
  }));
  return success(id, { pageInfo: info ?? {} }, pageState);
}

async function doExecuteJs(
  id: string,
  tabId: number,
  params: { expression: string }
): Promise<ActionResult> {
  // Evaluate the expression in the page's MAIN world via a Function
  // constructor so statements and return-value expressions both work.
  try {
    const value = await runInPage(tabId, async (expr: string) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (async () => { return (${expr}); })()`);
      return await fn();
    }, [params.expression]);

    const pageState = await getPageState(tabId);
    return success(id, { result: value ?? null }, pageState);
  } catch (err) {
    return error(id, `JS error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function doSelectOption(
  id: string,
  tabId: number,
  params: { selector: string; value?: string; text?: string }
): Promise<ActionResult> {
  const result = await runInPage(tabId, (p: { selector: string; value?: string; text?: string }) => {
    const sel = document.querySelector(p.selector);
    if (!(sel instanceof HTMLSelectElement)) return { error: 'Not a select element' };
    let found = false;
    for (const opt of Array.from(sel.options)) {
      if ((p.value !== undefined && opt.value === p.value) ||
          (p.text !== undefined && opt.text.includes(p.text))) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        found = true;
        break;
      }
    }
    return { found, value: sel.value };
  }, [params]);

  const pageState = await getPageState(tabId);
  return success(id, { selected: result ?? {} }, pageState);
}

// ─── Tabs ───────────────────────────────────────────────────────────────────

async function doNewTab(id: string, params?: { url?: string }): Promise<ActionResult> {
  const tab = await chrome.tabs.create({ url: params?.url ?? 'about:blank' });
  return success(id, { tabId: tab.id, url: tab.url ?? '' });
}

async function doCloseTab(id: string, tabId: number): Promise<ActionResult> {
  await chrome.tabs.remove(tabId);
  return success(id, { closed: tabId });
}

async function doSwitchTab(id: string, params: { tabId: number }): Promise<ActionResult> {
  await chrome.tabs.update(params.tabId, { active: true });
  const pageState = await getPageState(params.tabId);
  return success(id, { switchedTo: params.tabId }, pageState);
}

async function doListTabs(id: string): Promise<ActionResult> {
  const tabs = await chrome.tabs.query({});
  const tabList = tabs.map((t) => ({
    id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId,
  }));
  return success(id, { tabs: tabList });
}

// ─── Tool Schema (same as Chrome) ────────────────────────────────────────────

export function getToolSchema() {
  return [
    {
      name: 'screenshot',
      description:
        'Take a screenshot of the current page or a specific element. Returns base64-encoded PNG. ' +
        'Default is viewport at 1x CSS resolution. Response includes pageRect (page coords depicted) ' +
        'so you can follow up with rect:{x,y,width,height} to zoom into a sub-region at full detail.',
      parameters: {
        type: 'object',
        properties: {
          fullPage: { type: 'boolean', description: 'Capture full scrollable page' },
          selector: { type: 'string', description: 'CSS selector to screenshot specific element' },
          rect: {
            type: 'object',
            description: 'Page-coordinate rect to capture (zoom into a region returned in a prior pageRect)',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
            required: ['x', 'y', 'width', 'height'],
          },
        },
      },
    },
    {
      name: 'click',
      description: 'Click on a page element by coordinates, CSS selector, or visible text.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' }, y: { type: 'number' },
          selector: { type: 'string' }, text: { type: 'string' },
          button: { type: 'string', enum: ['left', 'right', 'middle'] },
          clickCount: { type: 'number' },
        },
      },
    },
    {
      name: 'type',
      description: 'Type text into the focused element or a specific element.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' }, selector: { type: 'string' },
          clear: { type: 'boolean' }, pressEnter: { type: 'boolean' },
        },
        required: ['text'],
      },
    },
    {
      name: 'keypress',
      description: 'Press a keyboard key, optionally with modifiers.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          modifiers: { type: 'array', items: { type: 'string', enum: ['ctrl', 'alt', 'shift', 'meta'] } },
        },
        required: ['key'],
      },
    },
    {
      name: 'scroll',
      description: 'Scroll the page or a specific element.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
          amount: { type: 'number' }, selector: { type: 'string' },
        },
        required: ['direction'],
      },
    },
    {
      name: 'navigate',
      description: 'Navigate to a URL.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
    {
      name: 'wait',
      description: 'Wait for an element, text, navigation, or fixed time.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' }, text: { type: 'string' },
          ms: { type: 'number' }, navigation: { type: 'boolean' }, timeout: { type: 'number' },
        },
      },
    },
    {
      name: 'get_dom',
      description: 'Get the DOM structure. By default returns simplified interactive elements. Set simplified=false for raw HTML.',
      parameters: {
        type: 'object',
        properties: { simplified: { type: 'boolean' }, selector: { type: 'string' } },
      },
    },
    {
      name: 'get_page_info',
      description: 'Get current page metadata.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'execute_js',
      description: 'Execute JavaScript in the page context. Returns the result value.',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string' } },
        required: ['expression'],
      },
    },
    {
      name: 'select_option',
      description: 'Select an option from a <select> dropdown.',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string' }, value: { type: 'string' }, text: { type: 'string' } },
        required: ['selector'],
      },
    },
    {
      name: 'hover',
      description: 'Move mouse over an element.',
      parameters: {
        type: 'object',
        properties: { x: { type: 'number' }, y: { type: 'number' }, selector: { type: 'string' }, text: { type: 'string' } },
      },
    },
    {
      name: 'request_user',
      description: 'Ask the user to perform an action. AI pauses until user signals done.',
      parameters: {
        type: 'object',
        properties: { message: { type: 'string' }, timeout: { type: 'number' } },
        required: ['message'],
      },
    },
    {
      name: 'new_tab',
      description: 'Open a new browser tab.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
      },
    },
    {
      name: 'close_tab',
      description: 'Close the current active tab.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'switch_tab',
      description: 'Switch to a specific tab by ID.',
      parameters: {
        type: 'object',
        properties: { tabId: { type: 'number' } },
        required: ['tabId'],
      },
    },
    {
      name: 'list_tabs',
      description: 'List all open browser tabs with their IDs, URLs, and titles.',
      parameters: { type: 'object', properties: {} },
    },
  ];
}
