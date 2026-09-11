/**
 * Resource limits. These are conservative starting values.
 * Every report that is bounded by one of these must expose the value it used,
 * so a reader can tell "complete" from "complete up to the limit".
 */
export const LIMITS = {
  /** Structural traversal */
  structureMaxNodes: 5_000,
  structureMaxDepth: 30,
  /** Milliseconds of synchronous work before the agent yields to the page. */
  traversalSliceMs: 12,
  /** Hard wall-clock cap for a single traversal or extraction pass. */
  traversalMaxMs: 3_000,

  /** Extraction */
  extractionMaxRecords: 200,
  recipeMaxFields: 20,
  recipeMaxSelectorLength: 512,
  recipeMaxNameLength: 120,
  recipeMaxAttributeNameLength: 64,
  /** Bytes (UTF-8) of a single text field before it is truncated. */
  fieldMaxBytes: 8 * 1024,
  /** Maximum values returned by a multi-valued field. */
  multiValueMaxItems: 50,

  /** Observation */
  mutationDebounceMs: 300,
  /** Minimum gap between two rescans regardless of mutation rate. */
  rescanMinIntervalMs: 1_000,
  maxSnapshotsRetained: 20,
  /** Serialized-bytes budget for all retained snapshots in a session. */
  retainedSnapshotBytes: 4 * 1024 * 1024,

  /** Transport: reject any single message envelope larger than this. */
  messageMaxBytes: 1 * 1024 * 1024,
  /** Nested payload validation depth. */
  payloadMaxDepth: 12,

  /** Export */
  exportMaxBytes: 8 * 1024 * 1024,
  /** Picker / selector suggestions */
  selectorMaxLength: 512,
  /** Elements per single-record preview shown in the UI. */
  previewMaxRecords: 50,
} as const;

export type Limits = typeof LIMITS;
