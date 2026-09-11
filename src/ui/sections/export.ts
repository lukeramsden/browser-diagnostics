import type { App } from '../main';
import { errorBox, h, replace, warningList } from '../dom';
import { downloadJson } from '../download';
import type { Report } from '../../export/report';

interface Options {
  includeStructure: boolean;
  includeRecipe: boolean;
  includeSnapshots: boolean;
  includeComparisons: boolean;
  omitText: boolean;
  aliasIdentifiers: boolean;
  timestamps: 'keep' | 'dayOnly' | 'omit';
  urls: 'omit' | 'originOnly' | 'stripQuery' | 'keep';
  includeSuggestedSelectors: boolean;
}

const opts: Options = { includeStructure: true, includeRecipe: false, includeSnapshots: false, includeComparisons: true, omitText: true, aliasIdentifiers: true, timestamps: 'dayOnly', urls: 'omit', includeSuggestedSelectors: false };
let preview: { report: Report; bytes: number; optionsJson: string } | null = null;

export function renderExport(app: App, el: HTMLElement): void {
  const s = app.status;
  const out = h('div');

  const chk = (key: keyof Options & ('includeStructure' | 'includeRecipe' | 'includeSnapshots' | 'includeComparisons' | 'omitText' | 'aliasIdentifiers'), label: string, note?: string) => {
    const input = h('input', { type: 'checkbox', checked: opts[key], onChange: (e) => { opts[key] = (e.target as HTMLInputElement).checked; preview = null; app.render(); } });
    return h('label', { class: 'chk' }, input, label, note ? h('span', { class: 'note' }, ` — ${note}`) : null);
  };
  const sel = <K extends 'timestamps' | 'urls'>(key: K, label: string, choices: Array<[Options[K], string]>) => {
    const select = h('select', { 'aria-label': label, onChange: (e) => { opts[key] = (e.target as HTMLSelectElement).value as Options[K]; preview = null; app.render(); } }) as HTMLSelectElement;
    for (const [v, text] of choices) {
      const o = h('option', { value: v }, text) as HTMLOptionElement;
      o.selected = opts[key] === v;
      select.append(o);
    }
    return h('label', { class: 'chk' }, `${label}: `, select);
  };

  const build = async () => {
    replace(out, h('p', { class: 'note' }, 'Building preview…'));
    try {
      const { result, warnings } = await app.client.send({ command: 'buildReport', options: { ...opts } });
      if (result.type !== 'report') throw new Error('unexpected result');
      preview = { report: result.report as Report, bytes: result.serializedBytes, optionsJson: JSON.stringify(opts) };
      replace(out, warningList(warnings), renderPreview());
    } catch (err) {
      preview = null;
      replace(out, errorBox(err));
    }
  };

  const renderPreview = (): HTMLElement | null => {
    if (!preview || preview.optionsJson !== JSON.stringify(opts)) return null;
    const rep = preview.report;
    const rs = rep.redactionSummary;
    const pre = h('pre', { id: 'report-preview' }, JSON.stringify(rep, null, 2));
    const confirm = h('input', { type: 'checkbox', id: 'export-confirm' }) as HTMLInputElement;
    const save = h('button', { class: 'primary', disabled: true, onClick: () => downloadJson(`browser-diagnostics-${rep.createdAt ?? 'report'}-${rep.sessionContext.generation}.json`, rep) }, 'Save this exact JSON') as HTMLButtonElement;
    confirm.addEventListener('change', () => (save.disabled = !confirm.checked));
    return h(
      'div',
      { class: 'card' },
      h('h3', {}, `Preview — ${(preview.bytes / 1024).toFixed(1)} KiB`),
      h('p', {}, `Contents: structure ${rep.structureSummary ? 'yes' : 'no'} · recipe ${rep.recipe ? 'yes' : 'no'} · snapshots ${rep.snapshots ? rep.snapshots.length : 'no'} · comparisons ${rep.comparisonResults.length} · warnings ${rep.warnings.length}`),
      h('p', {}, `Redaction: ${rs.textValuesOmitted} text value(s) omitted · ${rs.identifiersAliased} identifier(s) aliased · ${rs.urlsTransformed} URL(s) transformed · ${rs.timestampsTransformed} timestamp(s) reduced`),
      h('p', { class: 'warn' }, rs.caveat),
      h('details', {}, h('summary', {}, 'Full JSON that will be saved'), pre),
      h('label', { class: 'chk' }, confirm, 'I have reviewed the preview above and want to save exactly this file.'),
      h('div', { class: 'row' }, save),
    );
  };

  replace(
    el,
    h('h2', {}, 'Export'),
    h('p', { class: 'note' }, 'Export builds an allowlisted report from the session — never a dump of internal state. Choose what to include, build a preview, review the exact JSON, then save. Files you save are outside this extension\'s control; clearing the session does not delete them.'),
    h('div', { class: 'grid2' },
      h('div', {},
        h('h3', {}, 'Include'),
        chk('includeStructure', 'Structure summary', 'aggregates only: tag/role/attribute-name counts, repeated shapes'),
        chk('includeComparisons', 'Comparison results', 'identity keys follow the alias setting'),
        chk('includeSnapshots', 'Snapshots with records', s?.captureMode === 'selectedFields' ? 'this session captured field text; see "omit text"' : 'structure-only: values are already withheld'),
        chk('includeRecipe', 'Recipe and root selection', 'selectors may embed page identifiers'),
      ),
      h('div', {},
        h('h3', {}, 'Redaction'),
        chk('omitText', 'Omit all text values', 'keeps lengths, counts and presence'),
        chk('aliasIdentifiers', 'Alias identifiers', 'stable within this file only; the alias map is never exported'),
        sel('timestamps', 'Timestamps', [['omit', 'omit'], ['dayOnly', 'day only (YYYY-MM-DD)'], ['keep', 'keep exact']]),
        sel('urls', 'URLs in values', [['omit', 'omit'], ['originOnly', 'origin only'], ['stripQuery', 'strip query and fragment'], ['keep', 'keep']]),
      ),
    ),
    h('p', { class: 'note' }, 'The source is always recorded as origin only (scheme + host), never the path, query, fragment or tab title.'),
    h('div', { class: 'row' }, h('button', { class: 'primary', disabled: !s, onClick: () => void build() }, 'Build preview')),
    out,
  );
  const existing = renderPreview();
  if (existing) replace(out, existing);
}
