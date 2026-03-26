/**
 * Content script injected into every page.
 * Provides DOM-level helpers that the background service worker can call,
 * and annotates interactive elements for AI visibility.
 */

// ─── Element Annotation ──────────────────────────────────────────────────────

interface AnnotatedElement {
  index: number;
  tag: string;
  text: string;
  role: string;
  bounds: { x: number; y: number; w: number; h: number };
  selector: string;
}

let annotations: AnnotatedElement[] = [];
let overlayContainer: HTMLDivElement | null = null;

function generateSelector(el: Element): string {
  if (el.id) return `#${el.id}`;
  if (el.getAttribute('data-testid')) return `[data-testid="${el.getAttribute('data-testid')}"]`;
  if (el.getAttribute('name')) return `${el.tagName.toLowerCase()}[name="${el.getAttribute('name')}"]`;

  // Build a path
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      selector = `#${current.id}`;
      parts.unshift(selector);
      break;
    }
    const parent: Element | null = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (c: Element) => c.tagName === current!.tagName
      );
      if (siblings.length > 1) {
        const idx = siblings.indexOf(current!) + 1;
        selector += `:nth-of-type(${idx})`;
      }
    }
    parts.unshift(selector);
    current = parent;
  }
  return parts.join(' > ');
}

function annotateElements(): AnnotatedElement[] {
  const interactiveSelectors =
    'a, button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [onclick], [tabindex]:not([tabindex="-1"])';

  const elements = document.querySelectorAll(interactiveSelectors);
  const result: AnnotatedElement[] = [];

  elements.forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    if (getComputedStyle(el).visibility === 'hidden') return;
    if (getComputedStyle(el).display === 'none') return;

    result.push({
      index: i,
      tag: el.tagName.toLowerCase(),
      text: (el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 80),
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      selector: generateSelector(el),
    });
  });

  annotations = result;
  return result;
}

// ─── Visual Overlay (debug mode) ─────────────────────────────────────────────

function showOverlay() {
  removeOverlay();
  overlayContainer = document.createElement('div');
  overlayContainer.id = 'kiro-browser-use-overlay';
  overlayContainer.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:999999;';

  annotations.forEach((ann) => {
    const label = document.createElement('div');
    label.style.cssText = `
      position:fixed;
      left:${ann.bounds.x}px;
      top:${ann.bounds.y}px;
      width:${ann.bounds.w}px;
      height:${ann.bounds.h}px;
      border:2px solid rgba(59,130,246,0.5);
      background:rgba(59,130,246,0.08);
      pointer-events:none;
      box-sizing:border-box;
    `;

    const badge = document.createElement('span');
    badge.textContent = String(ann.index);
    badge.style.cssText = `
      position:absolute;
      top:-8px;left:-8px;
      background:#3b82f6;
      color:white;
      font-size:10px;
      font-weight:bold;
      padding:1px 4px;
      border-radius:8px;
      font-family:monospace;
    `;
    label.appendChild(badge);
    overlayContainer!.appendChild(label);
  });

  document.body.appendChild(overlayContainer);
}

function removeOverlay() {
  if (overlayContainer) {
    overlayContainer.remove();
    overlayContainer = null;
  }
}

// ─── Message Handling ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'annotate_elements':
      sendResponse({ elements: annotateElements() });
      break;
    case 'show_overlay':
      annotateElements();
      showOverlay();
      sendResponse({ shown: true });
      break;
    case 'hide_overlay':
      removeOverlay();
      sendResponse({ hidden: true });
      break;
    case 'get_page_text':
      sendResponse({
        text: document.body?.innerText?.slice(0, 20000) || '',
        title: document.title,
        url: location.href,
      });
      break;
    case 'find_element': {
      const { text, selector } = message;
      let el: Element | null = null;
      if (selector) {
        el = document.querySelector(selector);
      } else if (text) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const target = text.toLowerCase();
        while (walker.nextNode()) {
          if (walker.currentNode.textContent?.toLowerCase().includes(target)) {
            el = walker.currentNode.parentElement;
            break;
          }
        }
      }
      if (el) {
        const rect = el.getBoundingClientRect();
        sendResponse({
          found: true,
          bounds: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
          selector: generateSelector(el),
        });
      } else {
        sendResponse({ found: false });
      }
      break;
    }
    default:
      sendResponse({ error: 'Unknown message type' });
  }
  return true; // Keep channel open for async response
});

// Let background know we're loaded
chrome.runtime.sendMessage({ source: 'content', type: 'content_loaded', url: location.href }).catch(() => {});
