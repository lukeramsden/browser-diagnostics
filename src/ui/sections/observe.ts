import type { App } from '../main';
import type { ComparisonResult, SnapshotMeta } from '../../protocol';
import { errorBox, h, replace, table, warningList } from '../dom';
import { hasPreviewedCurrentRecipe } from './recipe';

let snapshots: SnapshotMeta[] = [];
let fromId: string | null = null;
let toId: string | null = null;
let lastComparison: ComparisonResult | null = null;

export function renderObserve(app: App, el: HTMLElement): void {
  const s = app.status;
  const attached = !!s && ['ready', 'observing', 'pausedByUser', 'pausedAtLimit'].includes(s.status);
  const observing = !!s?.observation.active;
  const out = h('div');
  const list = h('div');

  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      replace(out, errorBox(err));
    }
  };
  const loadSnapshots = async () => {
    const { result } = await app.client.send({ command: 'getSnapshots' });
    if (result.type === 'snapshots') snapshots = result.snapshots;
    renderList();
  };
  const compare = () =>
    run(async () => {
      if (!fromId || !toId) return;
      const { result, warnings } = await app.client.send({ command: 'compareSnapshots', fromSnapshotId: fromId, toSnapshotId: toId });
      if (result.type === 'comparison') lastComparison = result.comparison;
      replace(out, warningList(warnings), renderComparison(lastComparison));
    });

  const renderList = () => {
    if (!snapshots.length) {
      replace(list, h('p', { class: 'note' }, 'No snapshots retained.'));
      return;
    }
    const rows = snapshots.map((m) => {
      const pick = (which: 'from' | 'to') => {
        if (which === 'from') fromId = m.snapshotId;
        else toId = m.snapshotId;
        renderList();
      };
      return h(
        'tr',
        {},
        h('td', {}, h('label', {}, h('input', { type: 'radio', name: 'from', checked: fromId === m.snapshotId, onChange: () => pick('from') }), ' A')),
        h('td', {}, h('label', {}, h('input', { type: 'radio', name: 'to', checked: toId === m.snapshotId, onChange: () => pick('to') }), ' B')),
        h('td', {}, m.snapshotId.slice(0, 8)),
        h('td', {}, new Date(m.takenAt).toLocaleTimeString()),
        h('td', {}, m.trigger),
        h('td', { class: 'num' }, String(m.recordCount)),
        h('td', { class: 'num' }, String(m.hiddenCount)),
        h('td', {}, m.limitReached ? 'LIMIT' : ''),
        h('td', { class: 'num' }, `${(m.estimatedBytes / 1024).toFixed(1)} KiB`),
        h('td', {}, `${m.warnings.length}`),
      );
    });
    const t = h('table', { id: 'snapshot-list' }, h('thead', {}, h('tr', {}, ...['A', 'B', 'id', 'time', 'trigger', 'records', 'hidden', 'limit', 'size', 'warnings'].map((x) => h('th', {}, x)))), h('tbody', {}, ...rows));
    replace(list, t, h('div', { class: 'row' }, h('button', { class: 'primary', disabled: !fromId || !toId || fromId === toId, onClick: () => void compare() }, 'Compare A → B')));
  };

  const start = () => run(async () => { await app.client.send({ command: 'startObservation' }); await app.refresh(); });
  const stop = () => run(async () => { await app.client.send({ command: 'stopObservation' }); await app.refresh(); });
  const rescan = () => run(async () => { await app.client.send({ command: 'rescan' }); await app.refresh(); });

  const needsPreview = s?.captureMode === 'selectedFields' && !hasPreviewedCurrentRecipe(app);
  const canStart = attached && !observing && !!s?.recipe && !!s?.root.confirmed && s.status !== 'pausedAtLimit';
  const retainedKiB = ((s?.observation.retainedBytes ?? 0) / 1024).toFixed(0);
  const maxKiB = ((s?.limits['retainedSnapshotBytes'] ?? 0) / 1024).toFixed(0);

  replace(
    el,
    h('h2', {}, 'Observe'),
    h('p', { class: 'note' }, 'Observation watches the confirmed root for DOM mutations and re-runs the recipe (debounced, at most about once per second), keeping a snapshot only when the extracted result changed. It sees what the page renders in this tab, in this view. It is not a synchronisation with the service behind the page: records that scroll out of a virtualised list are "removed from view", nothing more.'),
    h('div', { class: 'row' },
      h('button', { class: 'primary', disabled: !canStart, onClick: () => void start() }, 'Start observation'),
      h('button', { disabled: !observing, onClick: () => void stop() }, 'Stop observation'),
      h('button', { disabled: !observing, onClick: () => void rescan() }, 'Rescan now'),
    ),
    !s?.root.confirmed ? h('p', { class: 'note' }, 'Confirm a root first.') : !s?.recipe ? h('p', { class: 'note' }, 'Set a recipe first.') : null,
    needsPreview && !observing ? h('p', { class: 'warn' }, 'Capture mode is "selected fields": preview the current recipe in the Recipe tab before starting. The background refuses to start otherwise.') : null,
    s?.observation.pausedReason ? h('p', { class: 'warn' }, `Paused: ${s.observation.pausedReason}`) : null,
    h('p', { class: 'note' }, `Retention: ${s?.observation.snapshotCount ?? 0}/${s?.limits['maxSnapshotsRetained'] ?? '?'} snapshots, ${retainedKiB}/${maxKiB} KiB. When a limit is reached observation pauses; export or clear the session to continue.`),
    h('h3', {}, 'Snapshots'),
    list,
    out,
  );
  if (lastComparison) replace(out, renderComparison(lastComparison));
  if (attached || snapshots.length) void run(loadSnapshots);
  else {
    snapshots = [];
    renderList();
  }
}

function idText(id: string | null): string {
  if (id === null) return '— (none)';
  if (id.startsWith('h:')) return id.slice(0, 14) + '…';
  return id.replace(/\d+:/g, '').replaceAll('\u001f', ' ‖ ');
}

export function renderComparison(c: ComparisonResult | null): HTMLElement | null {
  if (!c) return null;
  const refs = (rs: Array<{ snapshotId: string; index: number; identityKey: string | null }>) => rs.slice(0, 50).map((r) => [r.snapshotId.slice(0, 8), r.index, idText(r.identityKey)]);
  return h(
    'div',
    { class: 'card' },
    h('h3', {}, `Comparison ${c.fromSnapshotId.slice(0, 8)} → ${c.toSnapshotId.slice(0, 8)}`),
    h('p', { class: c.identityReliable ? 'note' : 'warn' }, c.identityReliable ? 'Identity fields are usable for this comparison.' : 'Identity is NOT reliable for this comparison; treat added/removed/changed as hints.'),
    c.identityCaveats.length ? h('ul', {}, ...c.identityCaveats.map((x) => h('li', {}, x))) : null,
    warningList(c.warnings),
    h('p', {}, `Unchanged: ${c.unchangedCount} · Added to view: ${c.addedToView.length} · Removed from view: ${c.removedFromView.length} · Changed: ${c.changed.length} · Without identity: ${c.missingIdentity.length}`),
    c.addedToView.length ? h('details', { open: '' }, h('summary', {}, `Added to view (${c.addedToView.length})`), table(['snapshot', '#', 'identity'], refs(c.addedToView), [1])) : null,
    c.removedFromView.length ? h('details', { open: '' }, h('summary', {}, `Removed from view (${c.removedFromView.length}) — not deletion`), table(['snapshot', '#', 'identity'], refs(c.removedFromView), [1])) : null,
    c.changed.length ? h('details', { open: '' }, h('summary', {}, `Changed (${c.changed.length})`), table(['identity', 'fields'], c.changed.slice(0, 50).map((x) => [idText(x.identityKey), x.changedFields.join(', ')]))) : null,
    c.requiredFieldRegressions.length ? h('details', { open: '' }, h('summary', {}, `Required fields lost (${c.requiredFieldRegressions.length})`), table(['identity', 'fields'], c.requiredFieldRegressions.map((x) => [idText(x.identityKey), x.fields.join(', ')]))) : null,
    c.duplicateIdentities.length ? h('details', { open: '' }, h('summary', {}, `Duplicate identities (${c.duplicateIdentities.length})`), table(['snapshot', 'identity', 'count'], c.duplicateIdentities.map((x) => [x.snapshotId.slice(0, 8), idText(x.identityKey), x.count]), [2])) : null,
    c.sameContentDifferentIdentity.length ? h('details', { open: '' }, h('summary', {}, `Same content, different identity (${c.sameContentDifferentIdentity.length})`), table(['snapshot', 'fingerprint', 'identities'], c.sameContentDifferentIdentity.map((x) => [x.snapshotId.slice(0, 8), x.fingerprint, x.identityKeys.map(idText).join(' , ')]))) : null,
    c.nodeReusedForDifferentIdentity.length ? h('details', { open: '' }, h('summary', {}, `Node reused for a different record (${c.nodeReusedForDifferentIdentity.length})`), table(['node', 'was', 'now'], c.nodeReusedForDifferentIdentity.slice(0, 50).map((x) => [x.nodeHandle, idText(x.fromIdentity), idText(x.toIdentity)]), [0])) : null,
    c.missingIdentity.length ? h('details', {}, h('summary', {}, `Records without identity (${c.missingIdentity.length})`), table(['snapshot', '#', 'identity'], refs(c.missingIdentity), [1])) : null,
  );
}
