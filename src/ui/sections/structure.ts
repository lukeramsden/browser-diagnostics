import type { App } from '../main';
import type { RootState, StructureSummary } from '../../protocol';
import { countTable, errorBox, h, replace, table, warningList } from '../dom';

let lastSummary: StructureSummary | null = null;
let lastRoot: RootState | null = null;

/** Unsent selector text, preserved across re-renders. */
let selectorDraft: string | null = null;

export function renderStructure(app: App, el: HTMLElement): void {
  const s = app.status;
  const attached = !!s && ['ready', 'observing', 'pausedByUser', 'pausedAtLimit', 'staleRoot'].includes(s.status);
  const out = h('div');
  const selectorInput = h('input', { type: 'text', placeholder: 'CSS selector for the inspection root, e.g. main [role="log"]', 'aria-label': 'Root selector' }) as HTMLInputElement;
  // Status pushes re-render the whole section; keep what the user typed.
  selectorInput.value = selectorDraft ?? s?.root.userSelector ?? '';
  selectorInput.addEventListener('input', () => (selectorDraft = selectorInput.value));
  const includeSuggested = h('input', { type: 'checkbox' }) as HTMLInputElement;

  const fail = (err: unknown) => replace(out, errorBox(err));

  const pick = async () => {
    try {
      await app.client.send({ command: 'pickRoot' });
      replace(out, h('p', { class: 'note' }, 'Picker active in the source tab. Hover to highlight, click to select, Esc to cancel. Switch to that tab now.'));
    } catch (err) {
      fail(err);
    }
  };
  const setRoot = async () => {
    try {
      const selector = selectorInput.value.trim();
      if (!selector) return;
      selectorDraft = null;
      const { result, warnings } = await app.client.send({ command: 'setRoot', selector });
      if (result.type === 'rootState') lastRoot = result.root;
      lastSummary = null;
      await app.refresh();
      if (warnings.length) out.prepend(warningList(warnings)!);
    } catch (err) {
      fail(err);
    }
  };
  const confirm = async () => {
    try {
      await app.client.send({ command: 'confirmRoot' });
      await app.refresh();
    } catch (err) {
      fail(err);
    }
  };
  const inspect = async () => {
    replace(out, h('p', { class: 'note' }, 'Inspecting…'));
    try {
      const { result } = await app.client.send({ command: 'inspectStructure', includeSuggestedSelectors: includeSuggested.checked });
      if (result.type === 'structure') lastSummary = result.summary;
      if (includeSuggested.checked) {
        const r = await app.client.send({ command: 'confirmRoot' }).catch(() => null);
        if (r?.result.type === 'rootState') lastRoot = r.result.root;
      }
      await app.refresh();
    } catch (err) {
      fail(err);
    }
  };

  const root = s?.root ?? null;
  const d = root?.description ?? null;

  replace(
    el,
    h('h2', {}, 'Structure'),
    h('h3', {}, '1. Select an inspection root'),
    h('p', { class: 'note' }, 'Nothing is inspected outside the root. Pick it in the page, or enter a selector. The picker consumes the selecting click where it can, but a page may still react to the hover or press.'),
    h('div', { class: 'row' }, h('button', { disabled: !attached, onClick: () => void pick() }, 'Pick inspection root in page'), h('button', { disabled: !attached, onClick: () => void app.client.send({ command: 'cancelPick' }).then(() => app.refresh(), fail) }, 'Cancel picker')),
    h('div', { class: 'row' }, selectorInput, h('button', { disabled: !attached, onClick: () => void setRoot() }, 'Use selector')),
    d
      ? h(
          'div',
          { class: 'card' },
          h('h3', {}, root!.confirmed ? 'Root (confirmed)' : 'Root (selected — confirm before extracting content)'),
          table(
            ['property', 'value'],
            [
              ['tag', d.tag],
              ['role', d.role ?? '—'],
              ['depth from body', d.depthFromBody],
              ['direct children', d.childElementCount],
              ['descendants (≈, capped)', d.descendantEstimate],
              ['has id', d.hasId ? 'yes' : 'no'],
              ['class count', d.classCount],
              ['data-* attributes', d.dataAttributeCount],
              ['inside open shadow root', d.inShadowRoot ? 'yes' : 'no'],
              ['user selector', root!.userSelector ?? '(picked in page)'],
            ],
          ),
          root!.suggestedSelectors?.length
            ? h(
                'div',
                {},
                h('h3', {}, 'Suggested selectors (may contain page values)'),
                table(
                  ['selector', 'matches', 'contains page values'],
                  root!.suggestedSelectors.map((x) => [x.selector, x.matchCount, x.containsPageValues ? 'yes' : 'no']),
                  [1],
                ),
              )
            : null,
          h('div', { class: 'row' }, h('button', { class: 'primary', disabled: root!.confirmed || !attached, onClick: () => void confirm() }, root!.confirmed ? 'Root confirmed' : 'Confirm this root')),
        )
      : h('p', { class: 'note' }, attached ? 'No root selected yet.' : 'Attach to the source tab first (Session tab).'),
    h('h3', {}, '2. Inspect structure'),
    h('label', { class: 'chk' }, includeSuggested, 'Also return suggested selectors for the root (these embed IDs/classes/data values from the page)'),
    h('div', { class: 'row' }, h('button', { class: 'primary', disabled: !attached || !root?.attached, onClick: () => void inspect() }, 'Inspect structure')),
    out,
    renderSummary(lastSummary ?? s?.structure ?? null),
  );
}

function renderSummary(sum: StructureSummary | null): HTMLElement | null {
  if (!sum) return null;
  return h(
    'div',
    { class: 'card' },
    h('h3', {}, 'Structure summary (no page content)'),
    warningList(sum.warnings),
    table(
      ['metric', 'value'],
      [
        ['elements visited', sum.nodesVisited],
        ['max depth reached', sum.maxDepthReached],
        ['duration (ms)', sum.durationMs],
        ['limit reached', sum.limitReached ? `YES — limits: ${sum.limits.maxNodes} nodes / depth ${sum.limits.maxDepth} / ${sum.limits.maxMs} ms` : `no (limits: ${sum.limits.maxNodes} nodes / depth ${sum.limits.maxDepth} / ${sum.limits.maxMs} ms)`],
        ['visible elements', sum.visibleElementCount],
        ['hidden elements', sum.hiddenElementCount],
        ['text-truncation candidates', sum.truncatedTextCandidates],
        ['<time> elements', sum.timeElementCount],
        ['links with href', sum.linkCount],
        ['aria-label(ledby) elements', sum.ariaLabelledCount],
        ['elements with data-* attrs', sum.dataAttributeElementCount],
        ['sensitive controls (inputs, editors…)', sum.sensitiveControlCount],
        ['open shadow roots entered', sum.openShadowRootCount],
        ['iframes (not entered)', sum.iframeCount],
      ],
    ),
    h(
      'div',
      { class: 'grid2' },
      countTable('Tags', sum.tagCounts),
      countTable('Roles', sum.roleCounts),
      countTable('Attribute names (values omitted)', sum.attributeNameCounts, 60),
      h(
        'div',
        {},
        h('h3', {}, 'Repeated sibling shapes (candidate record containers)'),
        sum.repeatedShapes.length ? table(['shape (tag > child tags)', 'occurrences', 'parents', 'depth'], sum.repeatedShapes.map((r) => [r.shape, r.occurrences, r.parentCount, r.depth]), [1, 2, 3]) : h('p', { class: 'note' }, 'none with ≥3 repeats'),
      ),
    ),
  );
}
