import { beforeEach, describe, expect, it } from 'vitest';
import { extract, safeText, _resetHandlesForTests } from '../../src/extraction/extract';
import { parseRecipe, type Recipe } from '../../src/protocol';

function mount(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

function recipe(over: Partial<Parameters<typeof parseRecipe>[0] & object> = {}): Recipe {
  const r = parseRecipe({
    schemaVersion: 1,
    name: 'fixture',
    recordSelector: 'article',
    fields: {
      recordId: { selector: ':scope', read: 'attribute', attribute: 'data-record-id' },
      sender: { selector: '.sender', read: 'text', required: true },
      body: { selector: '.body', read: 'text', required: true },
      at: { selector: 'time', read: 'attribute', attribute: 'datetime' },
      links: { selector: 'a', read: 'attribute', attribute: 'href', multiple: true },
      hasAttachment: { selector: '[data-attachment]', read: 'exists' },
      linkCount: { selector: 'a', read: 'count' },
    },
    identityFields: ['recordId'],
    ...over,
  });
  if (!r.ok) throw new Error(r.issues.join('; '));
  return r.recipe;
}

const msg = (id: string | null, sender: string, body: string, extra = '') => `<article ${id ? `data-record-id="${id}"` : ''}><span class="sender">${sender}</span><div class="body">${body}</div><time datetime="2024-01-01T00:00:00Z">t</time>${extra}</article>`;

const opts = { captureMode: 'selectedFields' as const, trigger: 'preview' as const, generation: 1 };

beforeEach(() => _resetHandlesForTests());

describe('extract', () => {
  it('extracts known records with source strings preserved', async () => {
    const root = mount(`<section>${msg('a-1', 'Ann', 'hello')}${msg('a-2', 'Bob', 'multi\nline\n\ttabbed — “quotes” 🎉 中文 עברית')}${msg('a-3', 'Ann', 'see <a href="https://x.example/p?q=1#f">l</a> and <a href="https://y.example">m</a>', '<div data-attachment="p">📎</div>')}</section>`);
    const snap = await extract(root, recipe(), opts);
    expect(snap.recordCount).toBe(3);
    expect(snap.limitReached).toBe(false);
    const [r1, r2, r3] = snap.records;
    expect(r1!.fields['recordId']).toMatchObject({ kind: 'text', value: 'a-1', redacted: false });
    expect(r1!.identityKey).toBe('3:a-1');
    expect(r1!.identityHashed).toBe(false);
    expect(r2!.fields['body']).toMatchObject({ kind: 'text', value: 'multi\nline\n\ttabbed — “quotes” 🎉 中文 עברית', truncated: false });
    expect(r3!.fields['links']).toMatchObject({ kind: 'textList', values: ['https://x.example/p?q=1#f', 'https://y.example'] });
    expect(r3!.fields['hasAttachment']).toEqual({ kind: 'exists', value: true, matchCount: 1 });
    expect(r3!.fields['linkCount']).toEqual({ kind: 'count', value: 2 });
    expect(r1!.fields['hasAttachment']).toEqual({ kind: 'exists', value: false, matchCount: 0 });
    expect(r1!.missingRequired).toEqual([]);
    expect(snap.records.map((r) => r.index)).toEqual([0, 1, 2]);
  });

  it('structure-only capture withholds text but keeps lengths and hashed identity', async () => {
    const root = mount(`<section>${msg('a-1', 'Ann', 'hello world')}${msg('a-2', 'Bob', 'hello world')}</section>`);
    const snap = await extract(root, recipe(), { ...opts, captureMode: 'structureOnly' });
    const json = JSON.stringify(snap);
    expect(json).not.toContain('hello');
    expect(json).not.toContain('Ann');
    expect(json).not.toContain('a-1');
    expect(snap.records[0]!.fields['body']).toMatchObject({ kind: 'text', value: '', redacted: true, sourceBytes: 11 });
    expect(snap.records[0]!.identityKey).toMatch(/^h:[0-9a-f]{32}$/);
    expect(snap.records[0]!.identityHashed).toBe(true);
    // same text, different ids → different identity, same fingerprint
    expect(snap.records[0]!.identityKey).not.toBe(snap.records[1]!.identityKey);
    expect(snap.records[0]!.contentFingerprint).not.toBe(snap.records[1]!.contentFingerprint); // sender differs
  });

  it('repeated text is not treated as identity', async () => {
    const root = mount(`<section>${msg(null, 'Ann', 'hello')}${msg(null, 'Ann', 'hello')}</section>`);
    const snap = await extract(root, recipe(), opts);
    expect(snap.records.every((r) => r.identityKey === null)).toBe(true);
    expect(snap.records[0]!.contentFingerprint).toBe(snap.records[1]!.contentFingerprint);
    expect(snap.records[0]!.nodeHandle).not.toBe(snap.records[1]!.nodeHandle);
    expect(snap.warnings.some((w) => w.message.includes('no extracted identity'))).toBe(true);
  });

  it('reports missing required fields, ambiguous matches and invalid selectors', async () => {
    const root = mount(`<section><article data-record-id="x"><span class="sender">A</span><span class="sender">B</span></article></section>`);
    const r = recipe({ fields: { sender: { selector: '.sender', read: 'text' }, body: { selector: '.body', read: 'text', required: true }, bad: { selector: '[[[', read: 'text' } }, identityFields: [] });
    const snap = await extract(root, r, opts);
    const rec = snap.records[0]!;
    expect(rec.fields['sender']).toMatchObject({ kind: 'text', value: 'A', matchCount: 2 });
    expect(rec.ambiguous).toEqual(['sender']);
    expect(rec.fields['body']).toEqual({ kind: 'missing', reason: 'noMatch', matchCount: 0 });
    expect(rec.missingRequired).toEqual(['body']);
    expect(rec.fields['bad']).toEqual({ kind: 'missing', reason: 'invalidSelector', matchCount: 0 });
    expect(snap.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['ambiguousMatch', 'missingRequired']));
  });

  it('never reads inputs, drafts, or their attributes', async () => {
    const root = mount(`<section><article data-record-id="x">
      <div class="body">visible <input value="pw-secret" data-secret="attr-secret"> <div contenteditable="true">draft-secret</div> <textarea>ta-secret</textarea> end</div>
      <input class="pw" type="password" value="pw2-secret" placeholder="ph-secret">
      <div class="ed" contenteditable>draft2-secret</div>
    </article></section>`);
    const r = recipe({
      fields: {
        body: { selector: '.body', read: 'text' },
        pw: { selector: '.pw', read: 'text' },
        pwAttr: { selector: '.pw', read: 'attribute', attribute: 'placeholder' },
        ed: { selector: '.ed', read: 'text' },
        inner: { selector: 'textarea', read: 'text' },
      },
      identityFields: [],
    });
    const snap = await extract(root, r, opts);
    const json = JSON.stringify(snap);
    for (const s of ['pw-secret', 'attr-secret', 'draft-secret', 'ta-secret', 'pw2-secret', 'ph-secret', 'draft2-secret']) expect(json).not.toContain(s);
    expect(snap.records[0]!.fields['body']).toMatchObject({ kind: 'text', value: 'visible    end' });
    expect(snap.records[0]!.fields['pw']).toMatchObject({ kind: 'missing', reason: 'sensitiveElement' });
    expect(snap.records[0]!.fields['pwAttr']).toMatchObject({ kind: 'missing', reason: 'sensitiveElement' });
    expect(snap.records[0]!.fields['ed']).toMatchObject({ kind: 'missing', reason: 'sensitiveElement' });
    expect(snap.records[0]!.fields['inner']).toMatchObject({ kind: 'missing', reason: 'sensitiveElement' });
  });

  it('refuses forbidden attributes even if a recipe object bypassed schema validation', async () => {
    const root = mount(`<section><article data-record-id="x" onclick="evil()"></article></section>`);
    const r = recipe({ identityFields: [] });
    (r.fields as Record<string, unknown>)['evil'] = { selector: ':scope', read: 'attribute', attribute: 'onclick', required: false, multiple: false };
    const snap = await extract(root, r, opts);
    expect(snap.records[0]!.fields['evil']).toMatchObject({ kind: 'missing', reason: 'forbiddenAttribute' });
    expect(JSON.stringify(snap)).not.toContain('evil()');
  });

  it('truncates long fields at the byte limit with a marker and preserves code points', async () => {
    const long = '😀'.repeat(5000); // 20 000 bytes
    const root = mount(`<section>${msg('a-1', 'Ann', long)}</section>`);
    const snap = await extract(root, recipe(), { ...opts, limits: { fieldMaxBytes: 1001 } });
    const f = snap.records[0]!.fields['body']!;
    expect(f.kind).toBe('text');
    if (f.kind !== 'text') throw new Error('expected text');
    expect(f.truncated).toBe(true);
    expect(f.sourceBytes).toBe(20000);
    expect(new TextEncoder().encode(f.value).byteLength).toBe(1000);
    expect(f.value).toBe('😀'.repeat(250));
    expect(snap.warnings.some((w) => w.code === 'truncated' && w.limit === 'fieldMaxBytes')).toBe(true);
  });

  it('caps record count and reports the limit', async () => {
    const root = mount(`<section>${Array.from({ length: 30 }, (_, i) => msg(`r-${i}`, 'A', 'b')).join('')}</section>`);
    const snap = await extract(root, recipe(), { ...opts, limits: { extractionMaxRecords: 10 } });
    expect(snap.recordCount).toBe(10);
    expect(snap.limitReached).toBe(true);
    expect(snap.warnings[0]).toMatchObject({ code: 'limitReached', limit: 'extractionMaxRecords', limitValue: 10 });
  });

  it('caps multi-valued fields', async () => {
    const root = mount(`<section>${msg('a-1', 'Ann', Array.from({ length: 10 }, (_, i) => `<a href="https://l/${i}">x</a>`).join(''))}</section>`);
    const snap = await extract(root, recipe(), { ...opts, limits: { multiValueMaxItems: 3 } });
    expect(snap.records[0]!.fields['links']).toMatchObject({ kind: 'textList', values: ['https://l/0', 'https://l/1', 'https://l/2'], truncated: true, matchCount: 10 });
  });

  it('records visibility and excludes the agent UI', async () => {
    // jsdom has no layout; pretend every element has a 1×1 box so the CSS/hidden checks decide.
    const proto = Element.prototype as unknown as { getClientRects: () => unknown; getBoundingClientRect: () => unknown };
    const origRects = proto.getClientRects;
    const origBox = proto.getBoundingClientRect;
    proto.getClientRects = () => [{}] as unknown as DOMRectList;
    proto.getBoundingClientRect = () => ({ width: 1, height: 1, top: 0, left: 0, right: 1, bottom: 1, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    try {
      await visibilityCase();
    } finally {
      proto.getClientRects = origRects;
      proto.getBoundingClientRect = origBox;
    }
  });

  async function visibilityCase() {
    const root = mount(`<section>${msg('a-1', 'Ann', 'shown')}<article data-record-id="a-2" hidden><span class="sender">B</span><div class="body">hid</div></article><article data-browser-diagnostics-ui="x"></article></section>`);
    const snap = await extract(root, recipe(), opts);
    expect(snap.recordCount).toBe(2);
    expect(snap.records[0]!.visible).toBe(true);
    expect(snap.records[1]!.visible).toBe(false);
    expect(snap.hiddenCount).toBe(1);
  }

  it('keeps node handles stable for the same element across extractions', async () => {
    const root = mount(`<section>${msg('a-1', 'Ann', 'x')}${msg('a-2', 'Bob', 'y')}</section>`);
    const s1 = await extract(root, recipe(), opts);
    root.firstElementChild!.remove();
    const s2 = await extract(root, recipe(), opts);
    expect(s2.records[0]!.nodeHandle).toBe(s1.records[1]!.nodeHandle);
  });

  it('warns when the root does not match recipe.rootSelector', async () => {
    const root = mount(`<section>${msg('a-1', 'Ann', 'x')}</section>`);
    const snap = await extract(root, recipe({ rootSelector: '#nope' }), opts);
    expect(snap.warnings.some((w) => w.message.includes('rootSelector'))).toBe(true);
  });

  it('safeText preserves whitespace and skips sensitive subtrees', () => {
    const el = mount('<p>a\n  b<input value="z"><span> c</span></p>');
    expect(safeText(el)).toBe('a\n  b c');
  });
});
