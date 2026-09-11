import { describe, expect, it } from 'vitest';
import { buildReport, type ReportOptions } from '../../src/export/report';
import { newSessionRecord, type SessionRecord } from '../../src/session/store';
import type { ExtractedRecord, Recipe, Snapshot } from '../../src/protocol';

const recipe: Recipe = {
  schemaVersion: 1,
  name: 'r',
  recordSelector: 'article',
  fields: {
    id: { selector: ':scope', read: 'attribute', attribute: 'data-id', required: false, multiple: false },
    body: { selector: '.b', read: 'text', required: true, multiple: false },
    link: { selector: 'a', read: 'attribute', attribute: 'href', required: false, multiple: false },
    at: { selector: 'time', read: 'attribute', attribute: 'datetime', required: false, multiple: false },
  },
  identityFields: ['id'],
};

const text = (value: string) => ({ kind: 'text' as const, value, truncated: false, sourceBytes: new TextEncoder().encode(value).byteLength, redacted: false, matchCount: 1 });

function rec(index: number, id: string, body: string): ExtractedRecord {
  return { index, nodeHandle: index + 1, fields: { id: text(id), body: text(body), link: text('https://example.com/p/42?token=abc#frag'), at: text('2024-05-06T07:08:09Z') }, identityKey: `${id.length}:${id}`, identityHashed: false, contentFingerprint: 'fp', visible: true, missingRequired: [], ambiguous: [] };
}

function session(): { rec: SessionRecord; snaps: Snapshot[] } {
  const s = newSessionRecord('sess_0000001', { tabId: 1, origin: 'https://app.example', title: 'Secret conversation with Ann' });
  s.recipe = recipe;
  s.captureMode = 'selectedFields';
  s.status = 'pausedByUser';
  s.generation = 2;
  s.root = { attached: true, confirmed: true, userSelector: '#conv-9f8e', description: { tag: 'section', role: 'log', depthFromBody: 2, childElementCount: 3, descendantEstimate: 30, hasId: true, classCount: 1, dataAttributeCount: 1, inShadowRoot: false } };
  const snap: Snapshot = { snapshotId: 'snapA', generation: 2, takenAt: Date.UTC(2024, 4, 6, 7, 0, 0), trigger: 'manual', recordCount: 2, limitReached: false, durationMs: 3, records: [rec(0, 'msg-1', 'hello Ann'), rec(1, 'msg-2', 'hello <img src=x onerror=alert(1)>')], hiddenCount: 0, warnings: [], estimatedBytes: 1000 };
  const { records: _r, ...meta } = snap;
  s.snapshots = [meta];
  s.comparisons = [{ fromSnapshotId: 'snapA', toSnapshotId: 'snapB', identityReliable: true, identityCaveats: [], addedToView: [{ snapshotId: 'snapB', index: 2, identityKey: '5:msg-3' }], changed: [{ identityKey: '5:msg-1', changedFields: ['body'] }], removedFromView: [], duplicateIdentities: [], sameContentDifferentIdentity: [], missingIdentity: [], nodeReusedForDifferentIdentity: [], requiredFieldRegressions: [], unchangedCount: 1, warnings: [] }];
  return { rec: s, snaps: [snap] };
}

const defaults: ReportOptions = { includeStructure: true, includeRecipe: false, includeSnapshots: false, includeComparisons: true, omitText: true, aliasIdentifiers: true, timestamps: 'dayOnly', urls: 'omit', includeSuggestedSelectors: false };

describe('buildReport', () => {
  it('default report contains no page text, no selectors, no title and only the origin', () => {
    const { rec, snaps } = session();
    const { report } = buildReport(rec, snaps, defaults, '1.2.3');
    const json = JSON.stringify(report);
    for (const forbidden of ['hello', 'Ann', 'msg-1', 'conv-9f8e', 'example.com/p', 'Secret conversation', 'article', '.b']) expect(json, forbidden).not.toContain(forbidden);
    expect(report.schemaVersion).toBe(1);
    expect(report.reportKind).toBe('browser-diagnostics-report');
    expect(report.extensionVersion).toBe('1.2.3');
    expect(report.sourceSummary).toEqual({ origin: 'https://app.example', tabTitleIncluded: false });
    expect(report.recipe).toBeNull();
    expect(report.snapshots).toBeNull();
    expect(report.sessionContext.root.userSelector).toBeNull();
    expect(report.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(report.comparisonResults[0]!.addedToView[0]!.identityKey).toBe('record_1');
    expect(report.comparisonResults[0]!.changed[0]!.identityKey).toBe('record_2');
    expect(report.redactionSummary.aliasMapIncluded).toBe(false);
    expect(report.notice.join(' ')).toMatch(/not a synchronisation/);
  });

  it('snapshots with omitText keep lengths and structure but no values; identity is aliased consistently', () => {
    const { rec, snaps } = session();
    const { report } = buildReport(rec, snaps, { ...defaults, includeSnapshots: true });
    const json = JSON.stringify(report);
    expect(json).not.toContain('hello');
    expect(json).not.toContain('onerror');
    const r0 = report.snapshots![0]!.records[0]!;
    expect(r0.fields['body']).toEqual({ kind: 'text', value: null, omitted: true, truncated: false, sourceBytes: 9, matchCount: 1 });
    // same alias as the comparison referencing the same identity key
    expect(report.comparisonResults[0]!.changed[0]!.identityKey).toBe(r0.identity);
    expect(report.snapshots![0]!.takenAt).toBe('2024-05-06');
    expect(report.redactionSummary.textValuesOmitted).toBe(8);
  });

  it('with text kept, URL and timestamp policies apply to values and identity values are aliased', () => {
    const { rec, snaps } = session();
    const { report, warnings } = buildReport(rec, snaps, { ...defaults, includeSnapshots: true, omitText: false, urls: 'stripQuery', timestamps: 'dayOnly' });
    const r1 = report.snapshots![0]!.records[1]!;
    expect(r1.fields['body']).toMatchObject({ value: 'hello <img src=x onerror=alert(1)>', omitted: false });
    expect(r1.fields['link']).toMatchObject({ value: 'https://example.com/p/42', omitted: false });
    expect(r1.fields['at']).toMatchObject({ value: '2024-05-06' });
    expect(r1.fields['id']).toMatchObject({ value: 'id_2' });
    expect(JSON.stringify(report)).not.toContain('token=abc');
    expect(warnings.some((w) => w.message.includes('contains page text'))).toBe(true);

    const kept = buildReport(rec, snaps, { ...defaults, includeSnapshots: true, omitText: false, aliasIdentifiers: false, urls: 'keep', timestamps: 'keep' }).report;
    const k1 = kept.snapshots![0]!.records[1]!;
    expect(k1.fields['link']).toMatchObject({ value: 'https://example.com/p/42?token=abc#frag' });
    expect(k1.fields['at']).toMatchObject({ value: '2024-05-06T07:08:09Z' });
    expect(k1.identity).toBe('5:msg-2');

    const omitted = buildReport(rec, snaps, { ...defaults, includeSnapshots: true, omitText: false, urls: 'omit', timestamps: 'omit' }).report;
    const o1 = omitted.snapshots![0]!.records[1]!;
    expect(o1.fields['link']).toMatchObject({ value: null, omitted: true });
    expect(o1.fields['at']).toMatchObject({ value: null });
    expect(omitted.createdAt).toBeNull();
    expect(omitted.snapshots![0]!.takenAt).toBeNull();
  });

  it('applies the URL policy to URLs embedded in free text', () => {
    const { rec, snaps } = session();
    snaps[0]!.records[0]!.fields['body'] = text('see https://example.com/a/b?x=1#f and https://other.example/z now');
    const strip = buildReport(rec, snaps, { ...defaults, includeSnapshots: true, omitText: false, urls: 'stripQuery' }).report;
    expect(strip.snapshots![0]!.records[0]!.fields['body']).toMatchObject({ value: 'see https://example.com/a/b and https://other.example/z now' });
    const omit = buildReport(rec, snaps, { ...defaults, includeSnapshots: true, omitText: false, urls: 'omit' }).report;
    expect(omit.snapshots![0]!.records[0]!.fields['body']).toMatchObject({ value: 'see [url omitted] and [url omitted] now' });
    expect(omit.redactionSummary.urlsTransformed).toBeGreaterThanOrEqual(2);
  });

  it('includes recipe and root selector only when asked, with a warning', () => {
    const { rec, snaps } = session();
    const { report, warnings } = buildReport(rec, snaps, { ...defaults, includeRecipe: true });
    expect(report.recipe?.name).toBe('r');
    expect(report.sessionContext.root.userSelector).toBe('#conv-9f8e');
    expect(warnings.some((w) => w.message.includes('recipe is included'))).toBe(true);
  });

  it('refuses reports above the export size limit with a visible error', () => {
    const { rec, snaps } = session();
    const big = 'x'.repeat(8000);
    const many: Snapshot[] = Array.from({ length: 20 }, (_, i) => ({ ...snaps[0]!, snapshotId: `s${i}`, records: Array.from({ length: 200 }, (_, j) => ({ ...rec0(), index: j, fields: { body: text(big) } })) }));
    expect(() => buildReport(rec, many, { ...defaults, includeSnapshots: true, omitText: false })).toThrow(/export limit/);
    function rec0(): ExtractedRecord {
      return { index: 0, nodeHandle: 1, fields: {}, identityKey: null, identityHashed: false, contentFingerprint: 'f', visible: true, missingRequired: [], ambiguous: [] };
    }
  });
});
