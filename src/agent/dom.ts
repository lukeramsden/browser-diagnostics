/**
 * Small DOM helpers shared by inspection and extraction. All functions are
 * pure with respect to the page: they never mutate it.
 */

/** Attribute set by the agent on its own UI so traversal can skip it. */
export const AGENT_MARKER_ATTR = 'data-browser-diagnostics-ui';

export function isAgentUi(el: Element): boolean {
  return el.hasAttribute(AGENT_MARKER_ATTR);
}

/**
 * Visibility definition (documented in docs/validation-guide.md):
 * an element is "visible" if it is connected, has no `hidden` attribute,
 * its computed `display` is not `none`, `visibility` is not `hidden`/`collapse`,
 * and it has a non-zero client rect. It does NOT check viewport intersection,
 * opacity or overlap: off-screen but rendered elements count as visible.
 */
export function isVisible(el: Element): boolean {
  if (!el.isConnected) return false;
  if ((el as HTMLElement).hidden) return false;
  const win = el.ownerDocument.defaultView;
  if (!win) return false;
  const style = win.getComputedStyle(el);
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  const rects = el.getClientRects();
  if (rects.length === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0;
}

/** Heuristic: the element clips text via overflow and its content overflows. */
export function isTextTruncated(el: Element): boolean {
  const win = el.ownerDocument.defaultView;
  if (!win) return false;
  const style = win.getComputedStyle(el);
  const clips = style.textOverflow === 'ellipsis' || (style.overflow === 'hidden' && style.whiteSpace === 'nowrap') || style.getPropertyValue('-webkit-line-clamp') !== 'none' && style.getPropertyValue('-webkit-line-clamp') !== '';
  if (!clips) return false;
  const h = el as HTMLElement;
  return h.scrollWidth > h.clientWidth + 1 || h.scrollHeight > h.clientHeight + 1;
}

/** Elements whose text we never read: drafts, credentials, form data, code. */
export const SENSITIVE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'OBJECT', 'EMBED']);

export function isSensitiveControl(el: Element): boolean {
  if (SENSITIVE_TAGS.has(el.tagName)) return true;
  const ce = el.getAttribute('contenteditable');
  if (ce !== null && ce.toLowerCase() !== 'false') return true;
  return false;
}

/** True if `el` or any ancestor (within its tree) is a sensitive control. */
export function withinSensitiveControl(el: Element): boolean {
  let cur: Element | null = el;
  while (cur) {
    if (isSensitiveControl(cur)) return true;
    cur = cur.parentElement;
  }
  return false;
}

export function depthFromBody(el: Element): number {
  let d = 0;
  let cur: Element | null = el;
  const body = el.ownerDocument.body;
  while (cur && cur !== body) {
    d++;
    const parent: Node | null = cur.parentNode;
    if (parent instanceof ShadowRoot) cur = parent.host;
    else cur = cur.parentElement;
  }
  return d;
}

export function isInShadowRoot(el: Element): boolean {
  return el.getRootNode() instanceof ShadowRoot;
}

/** Cheap bounded descendant count. */
export function countDescendants(el: Element, max: number): number {
  let n = 0;
  const walker = el.ownerDocument.createTreeWalker(el, 1 /* SHOW_ELEMENT */);
  while (walker.nextNode()) {
    if (++n >= max) return n;
  }
  return n;
}

export function safeQuerySelectorAll(root: ParentNode, selector: string): Element[] | null {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return null;
  }
}

export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/** Truncate `s` so its UTF-8 length is ≤ maxBytes without splitting a code point. */
export function truncateUtf8(s: string, maxBytes: number): { value: string; truncated: boolean } {
  if (utf8Length(s) <= maxBytes) return { value: s, truncated: false };
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (utf8Length(s.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  let cut = s.slice(0, lo);
  // Don't end on a high surrogate.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { value: cut, truncated: true };
}

/** FNV-1a 32-bit, hex. Diagnostic fingerprint only; not cryptographic. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
