/**
 * Tiny DOM builder. All page-derived values pass through as text nodes
 * (`textContent`) — there is deliberately no innerHTML anywhere in the UI.
 */
type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | ((e: Event) => void)> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, '').toLowerCase(), v);
    else if (typeof v === 'boolean') {
      if (v) el.setAttribute(k, '');
    } else if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  append(el, ...children);
  return el;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function replace(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, ...children);
}

export function table(headers: string[], rows: Array<Array<string | number>>, numericCols: number[] = []): HTMLTableElement {
  const t = h('table');
  t.appendChild(h('thead', {}, h('tr', {}, ...headers.map((x) => h('th', {}, x)))));
  const body = h('tbody');
  for (const r of rows) body.appendChild(h('tr', {}, ...r.map((c, i) => h('td', { class: numericCols.includes(i) ? 'num' : '' }, String(c)))));
  t.appendChild(body);
  return t;
}

export function countTable(title: string, counts: Record<string, number>, limit = 40): HTMLElement {
  const rows = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, v]) => [k, v] as [string, number]);
  return h('div', {}, h('h3', {}, title), rows.length ? table(['name', 'count'], rows, [1]) : h('p', { class: 'note' }, 'none'));
}

export function warningList(warnings: Array<{ code: string; message: string }>): HTMLElement | null {
  if (!warnings.length) return null;
  return h('div', {}, ...warnings.map((w) => h('div', { class: 'warn' }, `${w.code}: ${w.message}`)));
}

export function errorBox(err: unknown): HTMLElement {
  const e = err as { code?: string; message?: string; details?: string[] };
  return h('div', { class: 'err' }, `${e.code ?? 'error'}: ${e.message ?? String(err)}`, e.details?.length ? h('ul', {}, ...e.details.map((d) => h('li', {}, d))) : null);
}

export function fmtTime(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toLocaleTimeString();
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}
