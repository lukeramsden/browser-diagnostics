import { AGENT_MARKER_ATTR, isAgentUi } from './dom';
import { describeElement } from './root';

/**
 * Element picker. Installs a hover highlight and consumes the selection click
 * in the capture phase so the page's own handlers are (usually) not run.
 * Everything installed here is removed by `dispose()`; when no picker is
 * active nothing of ours remains in the page.
 *
 * Caveat shown to the user: capture-phase interception is not a guarantee.
 * Pages that listen on `pointerdown` at the window level with capture, or
 * that act on `mousedown`, may still react.
 */
export class Picker {
  private overlay: HTMLDivElement;
  private label: HTMLDivElement;
  private hovered: Element | null = null;
  private disposed = false;
  private readonly listeners: Array<[EventTarget, string, EventListener, AddEventListenerOptions]> = [];

  constructor(
    private readonly doc: Document,
    private readonly onPick: (el: Element) => void,
    private readonly onCancel: () => void,
  ) {
    this.overlay = doc.createElement('div');
    this.overlay.setAttribute(AGENT_MARKER_ATTR, 'picker-overlay');
    this.overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #0a84ff;background:rgba(10,132,255,0.12);box-sizing:border-box;left:0;top:0;width:0;height:0;transition:none;';
    this.label = doc.createElement('div');
    this.label.setAttribute(AGENT_MARKER_ATTR, 'picker-label');
    this.label.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;background:#111;color:#fff;font:12px/1.4 system-ui,sans-serif;padding:4px 8px;border-radius:4px;max-width:60vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;left:0;top:0;';
    this.label.textContent = 'Click an element to select it as the inspection root. Esc cancels.';
    doc.documentElement.appendChild(this.overlay);
    doc.documentElement.appendChild(this.label);

    const opts: AddEventListenerOptions = { capture: true, passive: false };
    this.listen(doc, 'mousemove', (e) => this.onMove(e as MouseEvent), { capture: true, passive: true });
    this.listen(doc, 'pointerdown', (e) => this.swallow(e), opts);
    this.listen(doc, 'mousedown', (e) => this.swallow(e), opts);
    this.listen(doc, 'mouseup', (e) => this.swallow(e), opts);
    this.listen(doc, 'pointerup', (e) => this.swallow(e), opts);
    this.listen(doc, 'click', (e) => this.onClick(e as MouseEvent), opts);
    this.listen(doc, 'auxclick', (e) => this.swallow(e), opts);
    this.listen(doc, 'contextmenu', (e) => this.swallow(e), opts);
    this.listen(doc, 'keydown', (e) => this.onKey(e as KeyboardEvent), opts);
    this.listen(doc.defaultView ?? doc, 'scroll', () => this.reposition(), { capture: true, passive: true });
    this.listen(doc.defaultView ?? doc, 'resize', () => this.reposition(), { capture: true, passive: true });
  }

  private listen(target: EventTarget, type: string, fn: EventListener, opts: AddEventListenerOptions): void {
    target.addEventListener(type, fn, opts);
    this.listeners.push([target, type, fn, opts]);
  }

  private targetFrom(e: Event): Element | null {
    const path = e.composedPath();
    const first = path.find((n): n is Element => n instanceof Element && !isAgentUi(n));
    return first ?? null;
  }

  private onMove(e: MouseEvent): void {
    const el = this.targetFrom(e);
    if (!el || el === this.hovered) return;
    this.hovered = el;
    this.reposition();
    const d = describeElement(el);
    // Structural description only: no id/class/text values.
    this.label.textContent = `<${d.tag}${d.role ? ` role=${d.role}` : ''}> children=${d.childElementCount} descendants≈${d.descendantEstimate}${d.hasId ? ' has-id' : ''}${d.dataAttributeCount ? ` data-attrs=${d.dataAttributeCount}` : ''} — click to select, Esc to cancel`;
  }

  private reposition(): void {
    if (!this.hovered) return;
    const r = this.hovered.getBoundingClientRect();
    this.overlay.style.left = `${r.left}px`;
    this.overlay.style.top = `${r.top}px`;
    this.overlay.style.width = `${r.width}px`;
    this.overlay.style.height = `${r.height}px`;
    const labelTop = r.top > 28 ? r.top - 26 : r.bottom + 4;
    this.label.style.left = `${Math.max(0, r.left)}px`;
    this.label.style.top = `${labelTop}px`;
  }

  private swallow(e: Event): void {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  private onClick(e: MouseEvent): void {
    this.swallow(e);
    const el = this.targetFrom(e);
    if (!el) return;
    this.dispose();
    this.onPick(el);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      this.swallow(e);
      this.dispose();
      this.onCancel();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [t, type, fn, opts] of this.listeners) t.removeEventListener(type, fn, opts);
    this.listeners.length = 0;
    this.overlay.remove();
    this.label.remove();
    this.hovered = null;
  }

  get active(): boolean {
    return !this.disposed;
  }
}
