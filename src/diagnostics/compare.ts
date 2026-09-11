import { ProtocolError, type ComparisonResult, type ExtractedRecord, type FieldValue, type Recipe, type Snapshot, type Warning } from '../protocol';

/**
 * Pure snapshot comparison.
 *
 * Rules that are deliberately conservative:
 * - Records are matched only on extracted identity. Text is never used to
 *   match; identical text under different identities is reported as a
 *   finding, not merged.
 * - Records without identity are listed, never paired.
 * - Duplicate identities within a snapshot make identity unreliable; the
 *   added/removed/changed lists are still produced but flagged.
 * - "Removed from view" means absent from the second snapshot. Nothing here
 *   can know whether the page deleted it or merely stopped rendering it.
 */
export function compareSnapshots(from: Snapshot, to: Snapshot, recipe: Recipe | null): ComparisonResult {
  if (from.generation !== to.generation) {
    throw new ProtocolError('invalidRequest', 'snapshots come from different attach generations (different documents); they cannot be compared');
  }
  const warnings: Warning[] = [];
  const caveats: string[] = [];
  let identityReliable = true;

  if (!recipe || recipe.identityFields.length === 0) {
    identityReliable = false;
    caveats.push('The recipe has no identityFields; no record can be matched between snapshots.');
  }
  const hashed = [...from.records, ...to.records].some((r) => r.identityHashed);
  if (hashed) caveats.push('Identity keys are hashes (structure-only capture); matching works but values are not shown.');

  const ref = (s: Snapshot, r: ExtractedRecord) => ({ snapshotId: s.snapshotId, index: r.index, identityKey: r.identityKey });

  const missingIdentity = [...from.records.filter((r) => r.identityKey === null).map((r) => ref(from, r)), ...to.records.filter((r) => r.identityKey === null).map((r) => ref(to, r))];
  if (missingIdentity.length) {
    const share = missingIdentity.length / Math.max(1, from.records.length + to.records.length);
    caveats.push(`${missingIdentity.length} record(s) have no identity and were not matched.`);
    if (share > 0.5) {
      identityReliable = false;
      caveats.push('More than half of the records lack identity; the identity fields do not describe this view.');
    }
  }

  const dupes = [...duplicates(from), ...duplicates(to)];
  if (dupes.length) {
    identityReliable = false;
    caveats.push(`Identity is not unique within a snapshot (${dupes.length} duplicated key(s)). Added/removed/changed lists may pair the wrong records.`);
  }

  // Low cardinality: many records, few distinct identities.
  for (const s of [from, to]) {
    const withId = s.records.filter((r) => r.identityKey !== null);
    const distinct = new Set(withId.map((r) => r.identityKey)).size;
    if (withId.length >= 4 && distinct <= withId.length / 2) {
      identityReliable = false;
      caveats.push(`Snapshot ${s.snapshotId.slice(0, 8)}: only ${distinct} distinct identities across ${withId.length} records; the identity fields are low-cardinality.`);
    }
  }

  const fromById = firstByIdentity(from);
  const toById = firstByIdentity(to);

  const addedToView = to.records.filter((r) => r.identityKey !== null && !fromById.has(r.identityKey)).map((r) => ref(to, r));
  const removedFromView = from.records.filter((r) => r.identityKey !== null && !toById.has(r.identityKey)).map((r) => ref(from, r));

  const changed: ComparisonResult['changed'] = [];
  const requiredFieldRegressions: ComparisonResult['requiredFieldRegressions'] = [];
  let unchangedCount = 0;
  for (const [id, a] of fromById) {
    const b = toById.get(id);
    if (!b) continue;
    const changedFields = diffFields(a.fields, b.fields);
    // Redacted values compare equal; fall back to the content fingerprint.
    if (!changedFields.length && a.contentFingerprint !== b.contentFingerprint) changedFields.push('(content)');
    if (changedFields.length) changed.push({ identityKey: id, changedFields });
    else unchangedCount++;
    const regressed = b.missingRequired.filter((f) => !a.missingRequired.includes(f));
    if (regressed.length) requiredFieldRegressions.push({ identityKey: id, fields: regressed });
  }

  const sameContentDifferentIdentity = [...sameContent(from), ...sameContent(to)];
  if (sameContentDifferentIdentity.length) {
    warnings.push({ code: 'other', message: `${sameContentDifferentIdentity.length} group(s) of records share identical extracted content under different identities. They were kept separate; text is never used as identity.` });
  }

  const nodeReusedForDifferentIdentity: ComparisonResult['nodeReusedForDifferentIdentity'] = [];
  const fromByNode = new Map(from.records.map((r) => [r.nodeHandle, r]));
  for (const b of to.records) {
    const a = fromByNode.get(b.nodeHandle);
    if (a && a.identityKey !== b.identityKey) nodeReusedForDifferentIdentity.push({ nodeHandle: b.nodeHandle, fromIdentity: a.identityKey, toIdentity: b.identityKey });
  }
  if (nodeReusedForDifferentIdentity.length) {
    warnings.push({ code: 'other', message: `${nodeReusedForDifferentIdentity.length} DOM node(s) now show a different record than before (virtualised list or node reuse). Position and node identity are not record identity.` });
  }

  if (from.limitReached || to.limitReached) {
    warnings.push({ code: 'limitReached', message: 'At least one snapshot hit a capture limit; records beyond the limit are unknown, so "removed from view" may be incomplete.' });
  }
  if (removedFromView.length) {
    warnings.push({ code: 'other', message: '"Removed from view" means no longer rendered in the observed root. It does not mean the page deleted anything.' });
  }
  if (!identityReliable) warnings.push({ code: 'identityUnreliable', message: 'Identity could not be trusted for this comparison; see identityCaveats.' });

  return {
    fromSnapshotId: from.snapshotId,
    toSnapshotId: to.snapshotId,
    identityReliable,
    identityCaveats: caveats.slice(0, 20),
    addedToView,
    changed,
    removedFromView,
    duplicateIdentities: dupes,
    sameContentDifferentIdentity,
    missingIdentity,
    nodeReusedForDifferentIdentity,
    requiredFieldRegressions,
    unchangedCount,
    warnings: warnings.slice(0, 50),
  };
}

function firstByIdentity(s: Snapshot): Map<string, ExtractedRecord> {
  const m = new Map<string, ExtractedRecord>();
  for (const r of s.records) if (r.identityKey !== null && !m.has(r.identityKey)) m.set(r.identityKey, r);
  return m;
}

function duplicates(s: Snapshot): ComparisonResult['duplicateIdentities'] {
  const counts = new Map<string, number>();
  for (const r of s.records) if (r.identityKey !== null) counts.set(r.identityKey, (counts.get(r.identityKey) ?? 0) + 1);
  return [...counts].filter(([, c]) => c > 1).map(([identityKey, count]) => ({ snapshotId: s.snapshotId, identityKey, count }));
}

function sameContent(s: Snapshot): ComparisonResult['sameContentDifferentIdentity'] {
  const groups = new Map<string, Set<string>>();
  for (const r of s.records) {
    if (r.identityKey === null) continue;
    const g = groups.get(r.contentFingerprint) ?? new Set();
    g.add(r.identityKey);
    groups.set(r.contentFingerprint, g);
  }
  return [...groups].filter(([, ids]) => ids.size > 1).map(([fingerprint, ids]) => ({ snapshotId: s.snapshotId, fingerprint, identityKeys: [...ids].slice(0, 50) }));
}

function diffFields(a: Record<string, FieldValue>, b: Record<string, FieldValue>): string[] {
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const n of names) if (JSON.stringify(a[n] ?? null) !== JSON.stringify(b[n] ?? null)) out.push(n);
  return out.sort();
}
