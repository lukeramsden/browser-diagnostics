import type { App } from '../main';
import { parseRecipe, type FieldValue, type Recipe, type Snapshot } from '../../protocol';
import { errorBox, h, replace, table, warningList } from '../dom';
import { downloadJson } from '../download';

const EXAMPLE: Recipe = {
  schemaVersion: 1,
  name: 'Example records',
  recordSelector: '[data-example="record"]',
  fields: {
    recordId: { selector: ':scope', read: 'attribute', attribute: 'data-record-id', required: false, multiple: false },
    body: { selector: '.body', read: 'text', required: true, multiple: false },
    timestamp: { selector: 'time', read: 'attribute', attribute: 'datetime', required: false, multiple: false },
  },
  identityFields: ['recordId'],
};

let editorText: string | null = null;
let lastPreview: Snapshot | null = null;
let previewedRecipeJson: string | null = null;

export function hasPreviewedCurrentRecipe(app: App): boolean {
  return !!app.status?.recipe && previewedRecipeJson === JSON.stringify(app.status.recipe);
}

export function renderRecipe(app: App, el: HTMLElement): void {
  const s = app.status;
  const attached = !!s && ['ready', 'observing', 'pausedByUser', 'pausedAtLimit'].includes(s.status);
  const out = h('div');
  const editor = h('textarea', { 'aria-label': 'Recipe JSON', spellcheck: 'false', rows: '18' }) as HTMLTextAreaElement;
  editor.value = editorText ?? (s?.recipe ? JSON.stringify(s.recipe, null, 2) : JSON.stringify(EXAMPLE, null, 2));
  editor.addEventListener('input', () => (editorText = editor.value));

  const validation = h('div');
  const validate = (): Recipe | null => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(editor.value);
    } catch (e) {
      replace(validation, h('div', { class: 'err' }, `Not valid JSON: ${(e as Error).message}`));
      return null;
    }
    const r = parseRecipe(parsed);
    if (!r.ok) {
      replace(validation, h('div', { class: 'err' }, 'Recipe rejected:'), h('ul', {}, ...r.issues.map((i) => h('li', {}, i))));
      return null;
    }
    replace(validation, h('div', { class: 'note' }, `Valid: "${r.recipe.name}", ${Object.keys(r.recipe.fields).length} field(s), identity: ${r.recipe.identityFields.join(', ') || 'none (records cannot be tracked between snapshots)'}`));
    return r.recipe;
  };

  const setRecipe = async () => {
    const recipe = validate();
    if (!recipe) return;
    try {
      await app.client.send({ command: 'setRecipe', recipe });
      editorText = JSON.stringify(recipe, null, 2);
      await app.refresh();
    } catch (err) {
      replace(out, errorBox(err));
    }
  };
  const clearRecipe = async () => {
    try {
      await app.client.send({ command: 'setRecipe', recipe: null });
      editorText = null;
      lastPreview = null;
      await app.refresh();
    } catch (err) {
      replace(out, errorBox(err));
    }
  };
  const setMode = async (mode: 'structureOnly' | 'selectedFields') => {
    try {
      await app.client.send({ command: 'setCaptureMode', mode });
      await app.refresh();
    } catch (err) {
      replace(out, errorBox(err));
    }
  };
  const preview = async () => {
    replace(out, h('p', { class: 'note' }, 'Extracting…'));
    try {
      const { result, warnings } = await app.client.send({ command: 'previewRecipe' });
      if (result.type === 'snapshot') {
        lastPreview = result.snapshot;
        previewedRecipeJson = JSON.stringify(s?.recipe ?? null);
      }
      replace(out, warningList(warnings), renderSnapshot(lastPreview, s?.recipe ?? null));
    } catch (err) {
      replace(out, errorBox(err));
    }
  };

  const modeStructure = h('input', { type: 'radio', name: 'mode', value: 'structureOnly', onChange: () => void setMode('structureOnly') }) as HTMLInputElement;
  const modeFields = h('input', { type: 'radio', name: 'mode', value: 'selectedFields', onChange: () => void setMode('selectedFields') }) as HTMLInputElement;
  modeStructure.checked = s?.captureMode !== 'selectedFields';
  modeFields.checked = s?.captureMode === 'selectedFields';
  const modeLocked = !!s?.observation.active;
  modeStructure.disabled = modeFields.disabled = modeLocked;

  replace(
    el,
    h('h2', {}, 'Recipe'),
    h('p', { class: 'note' }, 'A recipe is selectors only: a record selector, per-field selectors and a read operation (text, a named attribute, exists, count). It cannot contain code, regular expressions or property paths, and it cannot change what the extension is allowed to access. Pasted recipes are inert until you set them and explicitly run a preview.'),
    h('div', { class: 'grid2' },
      h('div', {},
        h('h3', {}, 'Editor'),
        editor,
        validation,
        h('div', { class: 'row' },
          h('button', { onClick: () => validate() }, 'Validate'),
          h('button', { class: 'primary', disabled: modeLocked, onClick: () => void setRecipe() }, 'Set recipe for this session'),
          h('button', { disabled: modeLocked || !s?.recipe, onClick: () => void clearRecipe() }, 'Clear recipe'),
          h('button', { onClick: () => { const r = validate(); if (r) downloadJson(`recipe-${r.name.replace(/[^\w-]+/g, '_')}.json`, r); } }, 'Download recipe JSON'),
        ),
        s?.recipe ? h('p', { class: 'note' }, `Session recipe: "${s.recipe.name}" (${Object.keys(s.recipe.fields).length} fields).`) : h('p', { class: 'note' }, 'No recipe set for this session.'),
      ),
      h('div', {},
        h('h3', {}, 'Capture mode'),
        h('label', { class: 'chk' }, modeStructure, 'Structure only — field values are withheld; only presence, length, match counts and a hashed identity are captured.'),
        h('label', { class: 'chk' }, modeFields, 'Selected fields — the text/attribute values of the recipe fields are captured and shown here. They stay in this extension\'s session storage until you clear them or export.'),
        h('p', { class: 'warn' }, 'Selectors can match more than you expect (for example a container that also holds another person\'s message). Always preview before observing with "selected fields" enabled; observation is refused until the current recipe has been previewed.'),
        modeLocked ? h('p', { class: 'note' }, 'Stop observation to change the recipe or capture mode.') : null,
        h('h3', {}, 'Preview'),
        h('div', { class: 'row' }, h('button', { class: 'primary', disabled: !attached || !s?.recipe || !s?.root.confirmed, onClick: () => void preview() }, 'Preview extraction (one-shot, not retained)')),
        !s?.root.confirmed ? h('p', { class: 'note' }, 'Select and confirm a root in the Structure tab first.') : null,
      ),
    ),
    out,
  );
  if (lastPreview && s?.recipe) replace(out, renderSnapshot(lastPreview, s.recipe));
}

export function fieldCell(f: FieldValue): string {
  switch (f.kind) {
    case 'text':
      return f.redacted ? `[withheld · ${f.sourceBytes} B${f.matchCount > 1 ? ` · ${f.matchCount} matches` : ''}]` : `${f.value}${f.truncated ? ' …[truncated]' : ''}${f.matchCount > 1 ? ` [${f.matchCount} matches]` : ''}`;
    case 'textList':
      return f.redacted ? `[withheld · ${f.values.length} values · ${f.sourceBytes} B]` : `${f.values.join(' | ')}${f.truncated ? ' …[truncated]' : ''}`;
    case 'exists':
      return f.value ? `yes (${f.matchCount})` : 'no';
    case 'count':
      return String(f.value);
    case 'missing':
      return `[missing: ${f.reason}${f.matchCount ? ` · ${f.matchCount} matches` : ''}]`;
  }
}

export function renderSnapshot(snap: Snapshot | null, recipe: Recipe | null): HTMLElement | null {
  if (!snap || !recipe) return null;
  const fieldNames = Object.keys(recipe.fields);
  const rows = snap.records.slice(0, 50).map((r) => [
    r.index,
    r.identityKey === null ? '— (none)' : r.identityHashed ? r.identityKey.slice(0, 14) + '…' : r.identityKey.replace(/\d+:/g, '').replaceAll('\u001f', ' ‖ '),
    r.visible ? 'yes' : 'no',
    r.nodeHandle,
    ...fieldNames.map((n) => fieldCell(r.fields[n]!)),
    [...r.missingRequired.map((m) => `missing ${m}`), ...r.ambiguous.map((a) => `ambiguous ${a}`)].join('; '),
  ]);
  return h(
    'div',
    { class: 'card' },
    h('h3', {}, `Snapshot ${snap.snapshotId.slice(0, 8)} — ${snap.recordCount} record(s)${snap.limitReached ? ' (LIMIT REACHED)' : ''}, ${snap.hiddenCount} hidden, ${snap.durationMs} ms, trigger: ${snap.trigger}`),
    warningList(snap.warnings),
    h('p', { class: 'note' }, `Identity = ${recipe.identityFields.join(' + ') || 'none'}. ${snap.records.filter((r) => r.identityKey === null).length} record(s) without identity. Node handle is a temporary DOM identity for this document only.`),
    table(['#', 'identity', 'visible', 'node', ...fieldNames, 'diagnostics'], rows, [0, 3]),
    snap.records.length > 50 ? h('p', { class: 'note' }, `Showing the first 50 of ${snap.records.length} records.`) : null,
  );
}
