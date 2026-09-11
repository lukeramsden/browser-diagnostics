import { z } from 'zod';
import {
  LIMITS,
  ProtocolError,
  captureModeSchema,
  estimateBytes,
  generationSchema,
  idSchema,
  recipeSchema,
  rootStateSchema,
  sessionSnapshotMetaSchema,
  sessionStatusSchema,
  snapshotSchema,
  sourceSummarySchema,
  structureSummarySchema,
  warningSchema,
  comparisonResultSchema,
  type Snapshot,
  type SnapshotMeta,
} from '../protocol';

/**
 * Session store.
 *
 * Everything lives in chrome.storage.session, which is in-memory, cleared on
 * extension reload/browser restart, and not exposed to content scripts. The
 * background worker is stateless: it reads the record on every message.
 *
 * Snapshot records (which may contain page text when capture is enabled) are
 * stored under separate keys so that status reads stay small and so clearing
 * can enumerate them precisely.
 */

export const sessionRecordSchema = z.object({
  sessionId: idSchema,
  createdAt: z.number().int(),
  source: sourceSummarySchema.nullable(),
  status: sessionStatusSchema,
  statusDetail: z.string().max(500).nullable(),
  /** Incremented on every successful attach. */
  generation: generationSchema,
  /** MessageSender.documentId bound at attach; null until the agent's first event. */
  documentId: z.string().max(64).nullable(),
  /** Agent's own per-document-instance ID. */
  documentGeneration: z.string().max(64).nullable(),
  captureMode: captureModeSchema,
  root: rootStateSchema,
  recipe: recipeSchema.nullable(),
  /** Fingerprint of recipe+captureMode last previewed; observation with content requires a match. */
  previewedFingerprint: z.string().max(64).nullable(),
  structure: structureSummarySchema.nullable(),
  observation: z.object({
    active: z.boolean(),
    lastSnapshotAt: z.number().int().nullable(),
    lastRecordCount: z.number().int().nullable(),
    lastMissingIdentityCount: z.number().int().nullable(),
    pausedReason: z.string().max(300).nullable(),
  }),
  snapshots: z.array(sessionSnapshotMetaSchema).max(LIMITS.maxSnapshotsRetained + 1),
  retainedBytes: z.number().int().nonnegative(),
  comparisons: z.array(comparisonResultSchema).max(50),
  activeWarnings: z.array(warningSchema).max(50),
});
export type SessionRecord = z.infer<typeof sessionRecordSchema>;

const SESSION_PREFIX = 'session:';
const SNAPSHOT_PREFIX = 'snapshot:';
const TAB_INDEX_PREFIX = 'tabSession:';

const sessionKey = (id: string) => `${SESSION_PREFIX}${id}`;
const snapshotKey = (sessionId: string, snapshotId: string) => `${SNAPSHOT_PREFIX}${sessionId}:${snapshotId}`;
const tabKey = (tabId: number) => `${TAB_INDEX_PREFIX}${tabId}`;

/** Minimal storage-area interface so the store is unit-testable without Chrome. */
export interface StorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  getBytesInUse?(keys?: string | string[] | null): Promise<number>;
}

export function newSessionRecord(sessionId: string, source: SessionRecord['source']): SessionRecord {
  return {
    sessionId,
    createdAt: Date.now(),
    source,
    status: 'notAttached',
    statusDetail: null,
    generation: 0,
    documentId: null,
    documentGeneration: null,
    captureMode: 'structureOnly',
    root: { confirmed: false, description: null, userSelector: null, attached: false },
    recipe: null,
    previewedFingerprint: null,
    structure: null,
    observation: { active: false, lastSnapshotAt: null, lastRecordCount: null, lastMissingIdentityCount: null, pausedReason: null },
    snapshots: [],
    retainedBytes: 0,
    comparisons: [],
    activeWarnings: [],
  };
}

export class SessionStore {
  /**
   * Per-session write lock. Handlers run concurrently in the worker (an agent
   * event can arrive while an attach is in flight), and read-modify-write
   * against storage would otherwise lose updates.
   */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly area: StorageArea) {}

  private async locked<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const chained = prev.then(() => gate);
    this.locks.set(sessionId, chained);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(sessionId) === chained) this.locks.delete(sessionId);
    }
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    const items = await this.area.get(sessionKey(sessionId));
    const raw = items[sessionKey(sessionId)];
    if (raw === undefined) return null;
    const parsed = sessionRecordSchema.safeParse(raw);
    if (!parsed.success) {
      // Corrupt state is treated as absent rather than trusted.
      await this.area.remove(sessionKey(sessionId));
      return null;
    }
    return parsed.data;
  }

  async require(sessionId: string): Promise<SessionRecord> {
    const rec = await this.get(sessionId);
    if (!rec) throw new ProtocolError('noSession', 'no such session');
    return rec;
  }

  async put(rec: SessionRecord): Promise<void> {
    const items: Record<string, unknown> = { [sessionKey(rec.sessionId)]: rec };
    if (rec.source) items[tabKey(rec.source.tabId)] = rec.sessionId;
    await this.setChecked(items);
  }

  /** Apply a pure update to a session record and persist. */
  async update(sessionId: string, fn: (rec: SessionRecord) => SessionRecord | void): Promise<SessionRecord> {
    return this.locked(sessionId, async () => {
      const rec = await this.require(sessionId);
      const next = fn(rec) ?? rec;
      await this.put(next);
      return next;
    });
  }

  async sessionIdForTab(tabId: number): Promise<string | null> {
    const items = await this.area.get(tabKey(tabId));
    const v = items[tabKey(tabId)];
    return typeof v === 'string' ? v : null;
  }

  async putSnapshot(sessionId: string, snapshot: Snapshot): Promise<{ meta: SnapshotMeta; retainedBytes: number; limitReached: boolean }> {
    return this.locked(sessionId, () => this.putSnapshotUnlocked(sessionId, snapshot));
  }

  private async putSnapshotUnlocked(sessionId: string, snapshot: Snapshot): Promise<{ meta: SnapshotMeta; retainedBytes: number; limitReached: boolean }> {
    const rec = await this.require(sessionId);
    const bytes = estimateBytes(snapshot);
    const { records: _records, ...meta } = { ...snapshot, estimatedBytes: bytes };
    const nextCount = rec.snapshots.length + 1;
    const nextBytes = rec.retainedBytes + bytes;
    const limitReached = nextCount > LIMITS.maxSnapshotsRetained || nextBytes > LIMITS.retainedSnapshotBytes;
    if (limitReached) {
      return { meta, retainedBytes: rec.retainedBytes, limitReached: true };
    }
    await this.setChecked({ [snapshotKey(sessionId, snapshot.snapshotId)]: { ...snapshot, estimatedBytes: bytes } });
    rec.snapshots.push(meta);
    rec.retainedBytes = nextBytes;
    await this.put(rec);
    return { meta, retainedBytes: nextBytes, limitReached: false };
  }

  async getSnapshot(sessionId: string, snapshotId: string): Promise<Snapshot | null> {
    const items = await this.area.get(snapshotKey(sessionId, snapshotId));
    const raw = items[snapshotKey(sessionId, snapshotId)];
    if (raw === undefined) return null;
    const parsed = snapshotSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  /** Remove all retained content for a session. */
  async clear(sessionId: string): Promise<void> {
    const rec = await this.get(sessionId);
    const keys: string[] = [sessionKey(sessionId)];
    if (rec) {
      for (const s of rec.snapshots) keys.push(snapshotKey(sessionId, s.snapshotId));
      if (rec.source) keys.push(tabKey(rec.source.tabId));
    }
    // Also sweep any orphaned snapshot keys for this session.
    const all = await this.area.get(null);
    for (const k of Object.keys(all)) {
      if (k.startsWith(`${SNAPSHOT_PREFIX}${sessionId}:`) && !keys.includes(k)) keys.push(k);
    }
    await this.area.remove(keys);
  }

  /** Drop snapshot content but keep metadata list empty; used on stale document. */
  async clearSnapshots(sessionId: string): Promise<void> {
    await this.locked(sessionId, async () => {
      const rec = await this.require(sessionId);
      const keys = rec.snapshots.map((s) => snapshotKey(sessionId, s.snapshotId));
      if (keys.length) await this.area.remove(keys);
      rec.snapshots = [];
      rec.retainedBytes = 0;
      rec.comparisons = [];
      await this.put(rec);
    });
  }

  async bytesInUse(): Promise<number | null> {
    if (!this.area.getBytesInUse) return null;
    try {
      return await this.area.getBytesInUse(null);
    } catch {
      return null;
    }
  }

  private async setChecked(items: Record<string, unknown>): Promise<void> {
    try {
      await this.area.set(items);
    } catch (err) {
      throw new ProtocolError('storageQuota', 'session storage write failed (quota?)', [String((err as Error)?.name ?? 'Error')]);
    }
  }
}

/** In-memory StorageArea for tests. */
export class MemoryStorageArea implements StorageArea {
  private data = new Map<string, unknown>();
  constructor(private readonly quotaBytes = Infinity) {}
  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const list = keys === null ? [...this.data.keys()] : Array.isArray(keys) ? keys : [keys];
    for (const k of list) if (this.data.has(k)) out[k] = structuredClone(this.data.get(k));
    return out;
  }
  async set(items: Record<string, unknown>): Promise<void> {
    const next = new Map(this.data);
    for (const [k, v] of Object.entries(items)) next.set(k, structuredClone(v));
    let total = 0;
    for (const [k, v] of next) total += k.length + estimateBytes(v);
    if (total > this.quotaBytes) throw new Error('QUOTA_BYTES quota exceeded');
    this.data = next;
  }
  async remove(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.data.delete(k);
  }
  async getBytesInUse(): Promise<number> {
    let total = 0;
    for (const [k, v] of this.data) total += k.length + estimateBytes(v);
    return total;
  }
  keys(): string[] {
    return [...this.data.keys()];
  }
}
