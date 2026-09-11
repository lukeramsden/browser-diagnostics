import { LIMITS } from '../protocol/limits';
import type { RootDescription, SuggestedSelector } from '../protocol';
import { countDescendants, depthFromBody, isInShadowRoot } from './dom';

/** Content-free description of an element. Safe for structure-only reports. */
export function describeElement(el: Element): RootDescription {
  let dataCount = 0;
  for (const a of el.attributes) if (a.name.startsWith('data-')) dataCount++;
  return {
    tag: el.tagName.toLowerCase().slice(0, 64),
    role: el.getAttribute('role')?.slice(0, 64) ?? null,
    depthFromBody: depthFromBody(el),
    childElementCount: el.childElementCount,
    descendantEstimate: countDescendants(el, LIMITS.structureMaxNodes),
    hasId: el.hasAttribute('id'),
    classCount: el.classList.length,
    dataAttributeCount: dataCount,
    inShadowRoot: isInShadowRoot(el),
  };
}

const cssEscape = (s: string): string => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/([^\w-])/g, '\\$1'));

function matchCount(root: ParentNode, selector: string): number {
  try {
    return root.querySelectorAll(selector).length;
  } catch {
    return -1;
  }
}

/**
 * Suggested selectors for an element, from most to least specific. Any
 * selector that embeds an id, class or attribute value is flagged
 * `containsPageValues` so the UI/export can treat it as sensitive.
 */
export function suggestSelectors(el: Element, max = 5): SuggestedSelector[] {
  const doc = (el.getRootNode() as Document | ShadowRoot) ?? el.ownerDocument;
  const out: SuggestedSelector[] = [];
  const push = (selector: string, containsPageValues: boolean) => {
    if (selector.length > LIMITS.selectorMaxLength) return;
    if (out.some((s) => s.selector === selector)) return;
    const n = matchCount(doc, selector);
    if (n <= 0) return;
    out.push({ selector, matchCount: n, containsPageValues });
  };

  const id = el.getAttribute('id');
  if (id) push(`#${cssEscape(id)}`, true);

  // data-testid style attributes are common stable hooks
  for (const a of el.attributes) {
    if (a.name.startsWith('data-') && a.value.length > 0 && a.value.length <= 64) {
      push(`[${a.name}="${a.value.replace(/["\\]/g, '\\$&')}"]`, true);
      if (out.length >= max) break;
    }
  }
  // attribute presence only (no value): not page-content
  for (const a of el.attributes) {
    if (a.name.startsWith('data-')) {
      push(`${el.tagName.toLowerCase()}[${a.name}]`, false);
      if (out.length >= max) break;
    }
  }
  const role = el.getAttribute('role');
  if (role) push(`${el.tagName.toLowerCase()}[role="${role.replace(/["\\]/g, '\\$&')}"]`, false);

  if (el.classList.length) {
    const cls = [...el.classList].slice(0, 3).map((c) => `.${cssEscape(c)}`).join('');
    push(`${el.tagName.toLowerCase()}${cls}`, true);
  }

  // Structural path (nth-child), values-free but brittle.
  push(structuralPath(el), false);
  return out.slice(0, max);
}

export function structuralPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  let hops = 0;
  while (cur && cur !== cur.ownerDocument.body && hops < 12) {
    const parent: Element | null = cur.parentElement;
    if (!parent) break;
    const idx = Array.prototype.indexOf.call(parent.children, cur) + 1;
    parts.unshift(`${cur.tagName.toLowerCase()}:nth-child(${idx})`);
    cur = parent;
    hops++;
  }
  return (cur === el.ownerDocument.body ? 'body > ' : '') + parts.join(' > ');
}
