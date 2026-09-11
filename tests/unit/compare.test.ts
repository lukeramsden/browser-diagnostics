import { describe, expect, it } from 'vitest';
import { compareSnapshots } from '../../src/diagnostics/compare';
import type { ExtractedRecord, Recipe, Snapshot } from '../../src/protocol';

const recipe: Recipe = { schemaVersion: 1, name: 'r', recordSelector: 'li', fields: { id: { selector: ':scope', read: 'attribute', attribute: 'data-id', required: false, multiple: false }, body: { selector: '.b', read: 'text', required: true, multiple: false } }, identityFields: ['id'] };

function rec(index: number, id: string | null, body: string, node = index + 1, over: Partial<ExtractedRecord> = {}): ExtractedRecord {
  return {
    index,
    nodeHandle: node,
    fields: { id: id === null ? { kind: 'missing', reason: 'attributeAbsent', matchCount: 1 } : { kind: 'text', value: id, truncated: false, sourceBytes: id.length, redacted: false, matchCount: 1 }, body: { kind: 'text', value: body, truncated: false, sourceBytes: body.length, redacted: false, matchCount: 1 } },
    identityKey: id,
    identityHashed: false,
    contentFingerprint: `fp-${id ?? ''}-${body}`,
    visible: true,
    missingRequired: [],
    ambiguous: [],
    ...over,
  };
}

function snap(id: string, records: ExtractedRecord[], over: Partial<Snapshot> = {}): Snapshot {
  return { snapshotId: id, generation: 1, takenAt: 1, trigger: 'manual', recordCount: records.length, limitReached: false, durationMs: 1, records, hiddenCount: 0, warnings: [], estimatedBytes: 0, ...over };
}

describe('compareSnapshots', () => {
  it('reports added, removed-from-view, changed and unchanged by identity only', () => {
    const a = snap('A', [rec(0, 'x', 'one'), rec(1, 'y', 'two'), rec(2, 'z', 'three')]);
    const b = snap('B', [rec(0, 'y', 'two'), rec(1, 'z', 'THREE'), rec(2, 'w', 'four')]);
    const c = compareSnapshots(a, b, recipe);
    expect(c.identityReliable).toBe(true);
    expect(c.addedToView.map((r) => r.identityKey)).toEqual(['w']);
    expect(c.removedFromView.map((r) => r.identityKey)).toEqual(['x']);
    expect(c.changed).toEqual([{ identityKey: 'z', changedFields: ['body'] }]);
    expect(c.unchangedCount).toBe(1);
    expect(c.warnings.some((w) => w.message.includes('does not mean the page deleted'))).toBe(true);
  });

  it('never merges records on text: same text, different ids stay separate; same text, no ids are unmatched', () => {
    const a = snap('A', [rec(0, 'x', 'same'), rec(1, 'y', 'same')]);
    const b = snap('B', [rec(0, 'x', 'same'), rec(1, 'y', 'same'), rec(2, null, 'same'), rec(3, null, 'same')]);
    // fingerprints ignore the id here to simulate identical content
    for (const s of [a, b]) for (const r of s.records) r.contentFingerprint = 'fp-same';
    const c = compareSnapshots(a, b, recipe);
    expect(c.unchangedCount).toBe(2);
    expect(c.addedToView).toEqual([]);
    expect(c.missingIdentity.map((r) => [r.snapshotId, r.index])).toEqual([['B', 2], ['B', 3]]);
    expect(c.sameContentDifferentIdentity).toEqual(expect.arrayContaining([{ snapshotId: 'A', fingerprint: 'fp-same', identityKeys: ['x', 'y'] }]));
    expect(c.identityReliable).toBe(true); // 2 of 6 lack identity: reported, not fatal
  });

  it('flags duplicate and low-cardinality identities as unreliable', () => {
    const a = snap('A', [rec(0, 'ann', 'a'), rec(1, 'ann', 'b'), rec(2, 'bob', 'c'), rec(3, 'bob', 'd')]);
    const b = snap('B', [rec(0, 'ann', 'a'), rec(1, 'bob', 'c')]);
    const c = compareSnapshots(a, b, recipe);
    expect(c.identityReliable).toBe(false);
    expect(c.duplicateIdentities).toEqual([{ snapshotId: 'A', identityKey: 'ann', count: 2 }, { snapshotId: 'A', identityKey: 'bob', count: 2 }]);
    expect(c.identityCaveats.join(' ')).toMatch(/low-cardinality/);
    expect(c.warnings.some((w) => w.code === 'identityUnreliable')).toBe(true);
  });

  it('detects node reuse for a different identity (virtualised lists)', () => {
    const a = snap('A', [rec(0, 'm1', 'a', 10), rec(1, 'm2', 'b', 11)]);
    const b = snap('B', [rec(0, 'm2', 'b', 10), rec(1, 'm3', 'c', 11)]);
    const c = compareSnapshots(a, b, recipe);
    expect(c.nodeReusedForDifferentIdentity).toEqual([{ nodeHandle: 10, fromIdentity: 'm1', toIdentity: 'm2' }, { nodeHandle: 11, fromIdentity: 'm2', toIdentity: 'm3' }]);
    expect(c.removedFromView.map((r) => r.identityKey)).toEqual(['m1']);
    expect(c.addedToView.map((r) => r.identityKey)).toEqual(['m3']);
    expect(c.unchangedCount).toBe(1);
  });

  it('reports required-field regressions and limit caveats', () => {
    const a = snap('A', [rec(0, 'x', 'one')]);
    const b = snap('B', [rec(0, 'x', 'one', 1, { missingRequired: ['body'] })], { limitReached: true });
    const c = compareSnapshots(a, b, recipe);
    expect(c.requiredFieldRegressions).toEqual([{ identityKey: 'x', fields: ['body'] }]);
    expect(c.warnings.some((w) => w.code === 'limitReached')).toBe(true);
  });

  it('refuses to compare across attach generations and without identity fields is unreliable', () => {
    const a = snap('A', [rec(0, 'x', 'one')]);
    expect(() => compareSnapshots(a, snap('B', [], { generation: 2 }), recipe)).toThrow(/different attach generations/);
    const c = compareSnapshots(a, snap('B', [rec(0, 'x', 'one')]), { ...recipe, identityFields: [] });
    expect(c.identityReliable).toBe(false);
    expect(c.identityCaveats[0]).toMatch(/no identityFields/);
  });
});
