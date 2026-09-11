import { z } from 'zod';
import { LIMITS } from './limits';
import { warningSchema } from './common';

/* ---------------------------------------------------------------------------
 * Root / document identity
 * ------------------------------------------------------------------------- */

/**
 * Describes a root without page content. `tag` and `role` are low-cardinality;
 * counts are aggregates. Suggested selectors live in a separate opt-in field
 * because they can contain IDs/classes.
 */
export const rootDescriptionSchema = z.object({
  tag: z.string().max(64),
  role: z.string().max(64).nullable(),
  depthFromBody: z.number().int().nonnegative(),
  childElementCount: z.number().int().nonnegative(),
  descendantEstimate: z.number().int().nonnegative(),
  hasId: z.boolean(),
  classCount: z.number().int().nonnegative(),
  dataAttributeCount: z.number().int().nonnegative(),
  inShadowRoot: z.boolean(),
});
export type RootDescription = z.infer<typeof rootDescriptionSchema>;

/** Opt-in: may contain page-derived tokens (id, class, data-* values). */
export const suggestedSelectorSchema = z.object({
  selector: z.string().max(LIMITS.selectorMaxLength),
  /** How many elements in the document match. 1 is ideal. */
  matchCount: z.number().int().nonnegative(),
  containsPageValues: z.boolean(),
});
export type SuggestedSelector = z.infer<typeof suggestedSelectorSchema>;

/* ---------------------------------------------------------------------------
 * Structure summary
 * ------------------------------------------------------------------------- */

const countMap = z.record(z.string().max(64), z.number().int().nonnegative());

export const structureSummarySchema = z.object({
  nodesVisited: z.number().int().nonnegative(),
  maxDepthReached: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  limits: z.object({
    maxNodes: z.number().int(),
    maxDepth: z.number().int(),
    maxMs: z.number().int(),
  }),
  limitReached: z.boolean(),
  tagCounts: countMap,
  roleCounts: countMap,
  /** Only allowlisted attribute *names*; values are never included. */
  attributeNameCounts: countMap,
  /** Count of elements with at least one data-* attribute (names not listed unless allowlisted). */
  dataAttributeElementCount: z.number().int().nonnegative(),
  timeElementCount: z.number().int().nonnegative(),
  linkCount: z.number().int().nonnegative(),
  ariaLabelledCount: z.number().int().nonnegative(),
  /** Elements considered visible per docs/validation-guide.md definition. */
  visibleElementCount: z.number().int().nonnegative(),
  hiddenElementCount: z.number().int().nonnegative(),
  /** Elements whose text is clipped by CSS overflow (heuristic). */
  truncatedTextCandidates: z.number().int().nonnegative(),
  openShadowRootCount: z.number().int().nonnegative(),
  iframeCount: z.number().int().nonnegative(),
  sensitiveControlCount: z.number().int().nonnegative(),
  /**
   * Repeated subtree signatures: a signature is a tag-shape hash (no content),
   * with how many siblings share it. Candidates for "record containers".
   */
  repeatedShapes: z
    .array(
      z.object({
        /** Shape signature, e.g. "div>div,span,time" — tag names only. */
        shape: z.string().max(200),
        occurrences: z.number().int().positive(),
        /** Number of distinct parents where this shape repeats. */
        parentCount: z.number().int().positive(),
        depth: z.number().int().nonnegative(),
      }),
    )
    .max(50),
  warnings: z.array(warningSchema).max(50),
});
export type StructureSummary = z.infer<typeof structureSummarySchema>;

/* ---------------------------------------------------------------------------
 * Extraction
 * ------------------------------------------------------------------------- */

export const fieldValueSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    /** Empty when `redacted` (structure-only capture). */
    value: z.string().max(LIMITS.fieldMaxBytes * 4), // bytes ≤ limit; chars may be fewer
    truncated: z.boolean(),
    /** UTF-8 length of the source string before truncation/redaction. */
    sourceBytes: z.number().int().nonnegative(),
    /** True when capture mode withheld the value; only length/presence is known. */
    redacted: z.boolean(),
    /** Number of elements the selector matched inside the record. */
    matchCount: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('textList'),
    values: z.array(z.string().max(LIMITS.fieldMaxBytes * 4)).max(LIMITS.multiValueMaxItems),
    truncated: z.boolean(),
    sourceBytes: z.number().int().nonnegative(),
    redacted: z.boolean(),
    matchCount: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal('exists'), value: z.boolean(), matchCount: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('count'), value: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal('missing'),
    reason: z.enum(['noMatch', 'attributeAbsent', 'sensitiveElement', 'forbiddenAttribute', 'invalidSelector']),
    matchCount: z.number().int().nonnegative(),
  }),
]);
export type FieldValue = z.infer<typeof fieldValueSchema>;

export const extractedRecordSchema = z.object({
  /** Position within this snapshot (0-based, document order). */
  index: z.number().int().nonnegative(),
  /**
   * Temporary DOM node handle. Unique per attached document generation; never
   * a source record ID. Used only to detect node reuse between snapshots.
   */
  nodeHandle: z.number().int().nonnegative(),
  fields: z.record(z.string().max(64), fieldValueSchema),
  /**
   * Joined identity-field values, or null if any identity field is missing or
   * the recipe has no identity fields. In structure-only capture this is a
   * hash of the values, so identity can be compared without retaining them.
   */
  identityKey: z.string().max(4096).nullable(),
  /** True when identityKey is a hash rather than the source values. */
  identityHashed: z.boolean(),
  /** Stable hash of all field text; diagnostic only, never identity. */
  contentFingerprint: z.string().max(64),
  visible: z.boolean(),
  /** Which required fields were missing. */
  missingRequired: z.array(z.string().max(64)).max(LIMITS.recipeMaxFields),
  /** Fields whose selector matched more than once for a single-valued read. */
  ambiguous: z.array(z.string().max(64)).max(LIMITS.recipeMaxFields),
});
export type ExtractedRecord = z.infer<typeof extractedRecordSchema>;

export const snapshotSchema = z.object({
  snapshotId: z.string().max(64),
  /** Attachment/document generation the snapshot came from. */
  generation: z.number().int().nonnegative(),
  takenAt: z.number().int().nonnegative(), // epoch ms
  trigger: z.enum(['preview', 'manual', 'mutation', 'observationStart']),
  recordCount: z.number().int().nonnegative(),
  /** True if more records matched than were captured. */
  limitReached: z.boolean(),
  durationMs: z.number().nonnegative(),
  /** Records include text only when capture mode allows it. */
  records: z.array(extractedRecordSchema).max(LIMITS.extractionMaxRecords),
  /** Count of records matched but not visible. */
  hiddenCount: z.number().int().nonnegative(),
  warnings: z.array(warningSchema).max(50),
  /** Approximate serialized size, used for retention accounting. */
  estimatedBytes: z.number().int().nonnegative(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

/* ---------------------------------------------------------------------------
 * Comparison
 * ------------------------------------------------------------------------- */

const recordRef = z.object({ snapshotId: z.string().max(64), index: z.number().int().nonnegative(), identityKey: z.string().max(4096).nullable() });

export const comparisonResultSchema = z.object({
  fromSnapshotId: z.string().max(64),
  toSnapshotId: z.string().max(64),
  /** False when identity cannot be trusted (missing/low-cardinality identity fields). */
  identityReliable: z.boolean(),
  identityCaveats: z.array(z.string().max(300)).max(20),
  addedToView: z.array(recordRef).max(LIMITS.extractionMaxRecords),
  changed: z.array(z.object({ identityKey: z.string().max(4096), changedFields: z.array(z.string().max(64)) })).max(LIMITS.extractionMaxRecords),
  /** Present before, absent now. Explicitly not deletion. */
  removedFromView: z.array(recordRef).max(LIMITS.extractionMaxRecords),
  duplicateIdentities: z.array(z.object({ snapshotId: z.string().max(64), identityKey: z.string().max(4096), count: z.number().int() })).max(LIMITS.extractionMaxRecords),
  sameContentDifferentIdentity: z.array(z.object({ snapshotId: z.string().max(64), fingerprint: z.string().max(64), identityKeys: z.array(z.string().max(4096)).max(50) })).max(LIMITS.extractionMaxRecords),
  missingIdentity: z.array(recordRef).max(LIMITS.extractionMaxRecords),
  nodeReusedForDifferentIdentity: z.array(z.object({ nodeHandle: z.number().int(), fromIdentity: z.string().max(4096).nullable(), toIdentity: z.string().max(4096).nullable() })).max(LIMITS.extractionMaxRecords),
  requiredFieldRegressions: z.array(z.object({ identityKey: z.string().max(4096), fields: z.array(z.string().max(64)) })).max(LIMITS.extractionMaxRecords),
  /** Records with the same identity in both snapshots and no field changes. */
  unchangedCount: z.number().int().nonnegative(),
  warnings: z.array(warningSchema).max(50),
});
export type ComparisonResult = z.infer<typeof comparisonResultSchema>;
