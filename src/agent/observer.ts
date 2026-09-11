import { LIMITS } from '../protocol/limits';
import type { CaptureMode, Recipe, Snapshot, Warning } from '../protocol';
import { extract } from '../extraction/extract';
import { isAgentUi } from './dom';

export interface ObserverCallbacks {
  onSnapshot: (s: Snapshot) => void;
  onPaused: (reason: string, warnings: Warning[]) => void;
  onRootLost: () => void;
}

export interface ObserverOptions {
  debounceMs?: number;
  minIntervalMs?: number;
  /** Consecutive time-limited extractions before pausing. */
  maxConsecutiveTimeouts?: number;
}

/**
 * Mutation-driven observation of one root.
 *
 * A MutationObserver only tells us the subtree *may* have changed. We debounce
 * bursts, enforce a minimum gap between rescans so a mutation storm cannot
 * starve the page, ignore our own UI, and emit a snapshot only when the
 * extracted result differs from the previous one. Nothing here reads content
 * outside `extract()`.
 */
export class Observer {
  private mo: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastScanAt = 0;
  private scanning = false;
  private pendingWhileScanning = false;
  private stopped = false;
  private consecutiveTimeouts = 0;
  private lastSignature: string | null = null;
  private readonly debounceMs: number;
  private readonly minIntervalMs: number;
  private readonly maxConsecutiveTimeouts: number;
  /** Rescans that produced an identical result (reported, not retained). */
  unchangedRescans = 0;
  snapshotsEmitted = 0;

  constructor(
    private readonly root: Element,
    private readonly recipe: Recipe,
    private readonly captureMode: CaptureMode,
    private readonly generation: number,
    private readonly cb: ObserverCallbacks,
    opts: ObserverOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? LIMITS.mutationDebounceMs;
    this.minIntervalMs = opts.minIntervalMs ?? LIMITS.rescanMinIntervalMs;
    this.maxConsecutiveTimeouts = opts.maxConsecutiveTimeouts ?? 3;
  }

  async start(): Promise<void> {
    if (this.mo) return;
    this.mo = new MutationObserver((records) => this.onMutations(records));
    this.mo.observe(this.root, { childList: true, subtree: true, characterData: true, attributes: true });
    await this.scan('observationStart');
  }

  stop(): void {
    this.stopped = true;
    this.mo?.disconnect();
    this.mo = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Explicit rescan regardless of mutations. */
  async rescan(): Promise<Snapshot | null> {
    return this.scan('manual', true);
  }

  private onMutations(records: MutationRecord[]): void {
    if (this.stopped) return;
    if (!this.root.isConnected) {
      this.stop();
      this.cb.onRootLost();
      return;
    }
    // Ignore mutations caused by our own UI (picker overlay etc.).
    const relevant = records.some((r) => {
      const t = r.target instanceof Element ? r.target : r.target.parentElement;
      if (!t) return true;
      if (isAgentUi(t) || t.closest(`[data-browser-diagnostics-ui]`)) return false;
      for (const n of r.addedNodes) if (n instanceof Element && isAgentUi(n)) return false;
      return true;
    });
    if (!relevant) return;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return; // already pending: coalesce
    const sinceLast = Date.now() - this.lastScanAt;
    const wait = Math.max(this.debounceMs, this.minIntervalMs - sinceLast);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.scan('mutation');
    }, wait);
  }

  private async scan(trigger: Snapshot['trigger'], force = false): Promise<Snapshot | null> {
    if (this.stopped) return null;
    if (this.scanning) {
      this.pendingWhileScanning = true;
      return null;
    }
    if (!this.root.isConnected) {
      this.stop();
      this.cb.onRootLost();
      return null;
    }
    this.scanning = true;
    this.lastScanAt = Date.now();
    try {
      const snap = await extract(this.root, this.recipe, { captureMode: this.captureMode, trigger, generation: this.generation });
      if (this.stopped) return null;
      const timedOut = snap.warnings.some((w) => w.code === 'limitReached' && w.limit === 'traversalMaxMs');
      this.consecutiveTimeouts = timedOut ? this.consecutiveTimeouts + 1 : 0;
      if (this.consecutiveTimeouts >= this.maxConsecutiveTimeouts) {
        this.stop();
        this.cb.onPaused(`Extraction hit the ${LIMITS.traversalMaxMs} ms limit ${this.consecutiveTimeouts} times in a row; observation paused to protect the page. Narrow the root or recipe.`, [
          { code: 'limitReached', message: 'repeated extraction time limit', limit: 'traversalMaxMs', limitValue: LIMITS.traversalMaxMs },
        ]);
        return snap;
      }
      const sig = signature(snap);
      if (!force && trigger === 'mutation' && sig === this.lastSignature) {
        this.unchangedRescans++;
        return null;
      }
      this.lastSignature = sig;
      this.snapshotsEmitted++;
      this.cb.onSnapshot(snap);
      return snap;
    } finally {
      this.scanning = false;
      if (this.pendingWhileScanning) {
        this.pendingWhileScanning = false;
        this.schedule();
      }
    }
  }
}

/** Cheap change signature: identity, fingerprint, node and visibility per record. */
function signature(s: Snapshot): string {
  return s.records.map((r) => `${r.nodeHandle}|${r.identityKey ?? ''}|${r.contentFingerprint}|${r.visible ? 1 : 0}|${r.missingRequired.join(',')}`).join('\n') + `\n#${s.limitReached}`;
}
