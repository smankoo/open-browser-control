/**
 * High-level browser actions implemented via Chrome DevTools Protocol (CDP).
 * These abstractions give the AI agent simple verbs (click, type, scroll, etc.)
 * instead of raw CDP commands.
 */

import type {
  AgentAction,
  ActionResult,
  ActionSuccess,
  ActionError,
  PageState,
} from '../types/protocol';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function success(id: string, data: Record<string, unknown>, pageState?: PageState): ActionSuccess {
  return { type: 'result', id, success: true, data, pageState };
}

function error(id: string, msg: string): ActionError {
  return { type: 'result', id, success: false, error: msg };
}

async function cdp(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

async function getPageState(tabId: number): Promise<PageState> {
  const tab = await chrome.tabs.get(tabId);
  return {
    url: tab.url ?? '',
    title: tab.title ?? '',
    tabId,
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Debugger Management ─────────────────────────────────────────────────────

const attachedTabs = new Set<number>();

export async function ensureDebuggerAttached(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) return;
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        // Already attached is fine
        if (chrome.runtime.lastError.message?.includes('Already attached')) {
          attachedTabs.add(tabId);
          resolve();
        } else {
          reject(new Error(chrome.runtime.lastError.message));
        }
      } else {
        attachedTabs.add(tabId);
        resolve();
      }
    });
  });
}

export function markDetached(tabId: number): void {
  attachedTabs.delete(tabId);
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attachedTabs.delete(source.tabId);
});

// ─── Action Dispatcher ───────────────────────────────────────────────────────

export async function executeAction(action: AgentAction, tabId: number): Promise<ActionResult> {
  try {
    await ensureDebuggerAttached(tabId);

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
        // Handled by the background service worker, not here
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

// ─── Action Implementations ─────────────────────────────────────────────────

async function doScreenshot(
  id: string,
  tabId: number,
  params?: { fullPage?: boolean; selector?: string }
): Promise<ActionResult> {
  if (params?.selector) {
    // Get element bounds and clip to that
    const result = await cdp(tabId, 'Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(params.selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`,
      returnByValue: true,
    }) as { result: { value: unknown } };

    if (!result?.result?.value) {
      return error(id, `Element not found: ${params.selector}`);
    }

    const clip = result.result.value as { x: number; y: number; width: number; height: number };
    const capture = (await cdp(tabId, 'Page.captureScreenshot', {
      format: 'png',
      clip: { ...clip, scale: 1 },
    })) as { data: string };

    return success(id, { screenshot: capture.data, format: 'png', encoding: 'base64', clip });
  }

  if (params?.fullPage) {
    // Get full page metrics
    const metrics = (await cdp(tabId, 'Page.getLayoutMetrics')) as {
      contentSize: { width: number; height: number };
    };

    const capture = (await cdp(tabId, 'Page.captureScreenshot', {
      format: 'png',
      clip: {
        x: 0,
        y: 0,
        width: metrics.contentSize.width,
        height: metrics.contentSize.height,
        scale: 1,
      },
    })) as { data: string };

    return success(id, { screenshot: capture.data, format: 'png', encoding: 'base64' });
  }

  const capture = (await cdp(tabId, 'Page.captureScreenshot', {
    format: 'png',
  })) as { data: string };

  const pageState = await getPageState(tabId);
  return success(id, { screenshot: capture.data, format: 'png', encoding: 'base64' }, pageState);
}

async function resolveElement(
  tabId: number,
  params: { x?: number; y?: number; selector?: string; text?: string }
): Promise<{ x: number; y: number } | null> {
  if (params.x !== undefined && params.y !== undefined) {
    return { x: params.x, y: params.y };
  }

  if (params.selector) {
    const result = await cdp(tabId, 'Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(params.selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`,
      returnByValue: true,
    }) as { result: { value: unknown } };

    return result?.result?.value as { x: number; y: number } | null;
  }

  if (params.text) {
    const result = await cdp(tabId, 'Runtime.evaluate', {
      expression: `(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const target = ${JSON.stringify(params.text)}.toLowerCase();
        while (walker.nextNode()) {
          if (walker.currentNode.textContent?.toLowerCase().includes(target)) {
            const el = walker.currentNode.parentElement;
            if (el) {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) {
                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
              }
            }
          }
        }
        return null;
      })()`,
      returnByValue: true,
    }) as { result: { value: unknown } };

    return result?.result?.value as { x: number; y: number } | null;
  }

  return null;
}

async function doClick(
  id: string,
  tabId: number,
  params: { x?: number; y?: number; selector?: string; text?: string; button?: string; clickCount?: number }
): Promise<ActionResult> {
  const pos = await resolveElement(tabId, params);
  if (!pos) return error(id, 'Could not find element to click');

  const button = params.button === 'right' ? 'right' : params.button === 'middle' ? 'middle' : 'left';
  const clickCount = params.clickCount ?? 1;

  // Move mouse, then press, then release
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: pos.x,
    y: pos.y,
  });
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: pos.x,
    y: pos.y,
    button,
    clickCount,
  });
  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: pos.x,
    y: pos.y,
    button,
    clickCount,
  });

  await sleep(100); // Brief pause for page to react
  const pageState = await getPageState(tabId);
  return success(id, { clicked: { x: pos.x, y: pos.y }, button, clickCount }, pageState);
}

async function doType(
  id: string,
  tabId: number,
  params: { text: string; selector?: string; clear?: boolean; pressEnter?: boolean }
): Promise<ActionResult> {
  // Focus element if selector provided
  if (params.selector) {
    await cdp(tabId, 'Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(params.selector)})?.focus()`,
    });
    await sleep(50);
  }

  // Clear field if requested
  if (params.clear) {
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      modifiers: 2, // Ctrl
    });
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      modifiers: 2,
    });
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Backspace',
      code: 'Backspace',
    });
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Backspace',
      code: 'Backspace',
    });
    await sleep(50);
  }

  // Type each character using insertText for reliability
  await cdp(tabId, 'Input.insertText', { text: params.text });

  // Press Enter if requested
  if (params.pressEnter) {
    await sleep(50);
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    });
    await cdp(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
    });
  }

  await sleep(100);
  const pageState = await getPageState(tabId);
  return success(id, { typed: params.text, pressedEnter: !!params.pressEnter }, pageState);
}

async function doKeyPress(
  id: string,
  tabId: number,
  params: { key: string; modifiers?: string[] }
): Promise<ActionResult> {
  let modifierFlags = 0;
  if (params.modifiers?.includes('alt')) modifierFlags |= 1;
  if (params.modifiers?.includes('ctrl')) modifierFlags |= 2;
  if (params.modifiers?.includes('meta')) modifierFlags |= 4;
  if (params.modifiers?.includes('shift')) modifierFlags |= 8;

  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: params.key,
    modifiers: modifierFlags,
  });
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: params.key,
    modifiers: modifierFlags,
  });

  const pageState = await getPageState(tabId);
  return success(id, { key: params.key, modifiers: params.modifiers ?? [] }, pageState);
}

async function doScroll(
  id: string,
  tabId: number,
  params: { direction: string; amount?: number; selector?: string }
): Promise<ActionResult> {
  const amount = params.amount ?? 500;
  let deltaX = 0;
  let deltaY = 0;

  switch (params.direction) {
    case 'up': deltaY = -amount; break;
    case 'down': deltaY = amount; break;
    case 'left': deltaX = -amount; break;
    case 'right': deltaX = amount; break;
  }

  if (params.selector) {
    await cdp(tabId, 'Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(params.selector)})?.scrollBy(${deltaX}, ${deltaY})`,
    });
  } else {
    // Use Input.dispatchMouseEvent with wheel type
    await cdp(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 400,
      y: 300,
      deltaX,
      deltaY,
    });
  }

  await sleep(200);
  const pageState = await getPageState(tabId);
  return success(id, { scrolled: params.direction, amount }, pageState);
}

async function doNavigate(
  id: string,
  tabId: number,
  params: { url: string }
): Promise<ActionResult> {
  await cdp(tabId, 'Page.navigate', { url: params.url });

  // Wait for load event
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 10000);
    const listener = (
      source: chrome.debugger.Debuggee,
      method: string
    ) => {
      if (source.tabId === tabId && method === 'Page.loadEventFired') {
        chrome.debugger.onEvent.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      }
    };
    chrome.debugger.onEvent.addListener(listener);
    // Also enable page events
    cdp(tabId, 'Page.enable', {}).catch(() => {});
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
      const result = await cdp(tabId, 'Runtime.evaluate', {
        expression: `!!document.querySelector(${JSON.stringify(params.selector)})`,
        returnByValue: true,
      }) as { result: { value: boolean } };

      if (result?.result?.value) {
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
      const result = await cdp(tabId, 'Runtime.evaluate', {
        expression: `document.body?.innerText?.includes(${JSON.stringify(params.text)})`,
        returnByValue: true,
      }) as { result: { value: boolean } };

      if (result?.result?.value) {
        const pageState = await getPageState(tabId);
        return success(id, { found: params.text, elapsed: Date.now() - start }, pageState);
      }
      await sleep(200);
    }
    return error(id, `Timeout waiting for text: ${params.text}`);
  }

  if (params.navigation) {
    await sleep(2000); // Simple wait for navigation
    const pageState = await getPageState(tabId);
    return success(id, { waited: 'navigation' }, pageState);
  }

  return error(id, 'No wait condition specified');
}

async function doGetDom(
  id: string,
  tabId: number,
  params?: { simplified?: boolean; selector?: string }
): Promise<ActionResult> {
  const selector = params?.selector ?? 'body';
  const simplified = params?.simplified !== false; // Default to simplified

  if (simplified) {
    // Return a simplified representation: interactive elements with their text and roles
    const result = await cdp(tabId, 'Runtime.evaluate', {
      expression: `(() => {
        const root = document.querySelector(${JSON.stringify(selector)}) || document.body;
        const elements = [];
        const interactiveSelectors = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [onclick], [tabindex]';

        root.querySelectorAll(interactiveSelectors).forEach((el, i) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return;
          if (getComputedStyle(el).visibility === 'hidden') return;

          const item = {
            index: i,
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || '',
            text: (el.textContent || '').trim().slice(0, 100),
            type: el.getAttribute('type') || '',
            name: el.getAttribute('name') || '',
            id: el.id || '',
            href: el.getAttribute('href') || '',
            placeholder: el.getAttribute('placeholder') || '',
            value: (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) ? el.value.slice(0, 100) : '',
            ariaLabel: el.getAttribute('aria-label') || '',
            bounds: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          };
          elements.push(item);
        });

        // Also get text content summary
        const headings = [];
        root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
          headings.push({ tag: h.tagName, text: h.textContent?.trim().slice(0, 200) || '' });
        });

        return { elements, headings, textLength: root.innerText?.length || 0 };
      })()`,
      returnByValue: true,
    }) as { result: { value: unknown } };

    const pageState = await getPageState(tabId);
    return success(id, { dom: result?.result?.value ?? {} }, pageState);
  }

  // Full DOM: return outerHTML (truncated to prevent huge payloads)
  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression: `(() => {
      const root = document.querySelector(${JSON.stringify(selector)}) || document.body;
      const html = root.outerHTML;
      return html.length > 50000 ? html.slice(0, 50000) + '... [truncated]' : html;
    })()`,
    returnByValue: true,
  }) as { result: { value: string } };

  const pageState = await getPageState(tabId);
  return success(id, { html: result?.result?.value ?? '' }, pageState);
}

async function doGetPageInfo(id: string, tabId: number): Promise<ActionResult> {
  const pageState = await getPageState(tabId);

  // Get extra info
  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression: `({
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
    })`,
    returnByValue: true,
  }) as { result: { value: unknown } };

  return success(id, { pageInfo: result?.result?.value ?? {} }, pageState);
}

async function doExecuteJs(
  id: string,
  tabId: number,
  params: { expression: string }
): Promise<ActionResult> {
  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression: params.expression,
    returnByValue: true,
    awaitPromise: true,
  }) as { result: { value: unknown }; exceptionDetails?: { text: string } };

  if (result?.exceptionDetails) {
    return error(id, `JS error: ${result.exceptionDetails.text}`);
  }

  const pageState = await getPageState(tabId);
  return success(id, { result: result?.result?.value ?? null }, pageState);
}

async function doSelectOption(
  id: string,
  tabId: number,
  params: { selector: string; value?: string; text?: string }
): Promise<ActionResult> {
  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression: `(() => {
      const sel = document.querySelector(${JSON.stringify(params.selector)});
      if (!sel || sel.tagName !== 'SELECT') return { error: 'Not a select element' };
      const options = Array.from(sel.options);
      let found = false;
      for (const opt of options) {
        if (${params.value ? `opt.value === ${JSON.stringify(params.value)}` : 'false'} ||
            ${params.text ? `opt.text.includes(${JSON.stringify(params.text)})` : 'false'}) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          found = true;
          break;
        }
      }
      return { found, value: sel.value };
    })()`,
    returnByValue: true,
  }) as { result: { value: unknown } };

  const pageState = await getPageState(tabId);
  return success(id, { selected: result?.result?.value ?? {} }, pageState);
}

async function doHover(
  id: string,
  tabId: number,
  params: { x?: number; y?: number; selector?: string; text?: string }
): Promise<ActionResult> {
  const pos = await resolveElement(tabId, params);
  if (!pos) return error(id, 'Could not find element to hover');

  await cdp(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: pos.x,
    y: pos.y,
  });

  await sleep(100);
  const pageState = await getPageState(tabId);
  return success(id, { hovered: { x: pos.x, y: pos.y } }, pageState);
}

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
    id: t.id,
    url: t.url,
    title: t.title,
    active: t.active,
    windowId: t.windowId,
  }));
  return success(id, { tabs: tabList });
}

// ─── Tool Schema (for AI agent discovery) ────────────────────────────────────

export function getToolSchema() {
  return [
    {
      name: 'screenshot',
      description: 'Take a screenshot of the current page or a specific element. Returns base64-encoded PNG.',
      parameters: {
        type: 'object',
        properties: {
          fullPage: { type: 'boolean', description: 'Capture full scrollable page' },
          selector: { type: 'string', description: 'CSS selector to screenshot specific element' },
        },
      },
    },
    {
      name: 'click',
      description: 'Click on a page element by coordinates, CSS selector, or visible text.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X coordinate to click' },
          y: { type: 'number', description: 'Y coordinate to click' },
          selector: { type: 'string', description: 'CSS selector of element to click' },
          text: { type: 'string', description: 'Visible text of element to click' },
          button: { type: 'string', enum: ['left', 'right', 'middle'] },
          clickCount: { type: 'number', description: '1=single click, 2=double click' },
        },
      },
    },
    {
      name: 'type',
      description: 'Type text into the focused element or a specific element.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type' },
          selector: { type: 'string', description: 'CSS selector to focus before typing' },
          clear: { type: 'boolean', description: 'Clear field before typing' },
          pressEnter: { type: 'boolean', description: 'Press Enter after typing' },
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
          key: { type: 'string', description: 'Key name (Enter, Tab, Escape, ArrowDown, etc.)' },
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
          amount: { type: 'number', description: 'Pixels to scroll (default: 500)' },
          selector: { type: 'string', description: 'Scroll within this element' },
        },
        required: ['direction'],
      },
    },
    {
      name: 'navigate',
      description: 'Navigate to a URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to' },
        },
        required: ['url'],
      },
    },
    {
      name: 'wait',
      description: 'Wait for an element, text, navigation, or fixed time.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Wait for element matching selector' },
          text: { type: 'string', description: 'Wait for text to appear on page' },
          ms: { type: 'number', description: 'Wait fixed milliseconds' },
          navigation: { type: 'boolean', description: 'Wait for page navigation to complete' },
          timeout: { type: 'number', description: 'Max wait time in ms (default: 10000)' },
        },
      },
    },
    {
      name: 'get_dom',
      description: 'Get the DOM structure. By default returns simplified interactive elements. Set simplified=false for raw HTML.',
      parameters: {
        type: 'object',
        properties: {
          simplified: { type: 'boolean', description: 'Return simplified interactive elements (default: true)' },
          selector: { type: 'string', description: 'Scope to this CSS selector' },
        },
      },
    },
    {
      name: 'get_page_info',
      description: 'Get current page metadata: URL, title, dimensions, scroll position, form count, etc.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'execute_js',
      description: 'Execute JavaScript in the page context. Returns the result value.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'JavaScript expression to evaluate' },
        },
        required: ['expression'],
      },
    },
    {
      name: 'select_option',
      description: 'Select an option from a <select> dropdown.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of the select element' },
          value: { type: 'string', description: 'Option value to select' },
          text: { type: 'string', description: 'Option text to match' },
        },
        required: ['selector'],
      },
    },
    {
      name: 'hover',
      description: 'Move mouse over an element.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          selector: { type: 'string' },
          text: { type: 'string' },
        },
      },
    },
    {
      name: 'request_user',
      description: 'Ask the user to perform an action (e.g., sign in, solve CAPTCHA). AI pauses until user signals done.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Message explaining what the user needs to do' },
          timeout: { type: 'number', description: 'Auto-resume after ms (optional)' },
        },
        required: ['message'],
      },
    },
    {
      name: 'new_tab',
      description: 'Open a new browser tab.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open (default: about:blank)' },
        },
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
        properties: {
          tabId: { type: 'number', description: 'Tab ID to switch to' },
        },
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
