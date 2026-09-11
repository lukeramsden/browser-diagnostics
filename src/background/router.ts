import {
  LIMITS,
  PROTOCOL_VERSION,
  ProtocolError,
  agentEventEnvelopeSchema,
  newId,
  parseMessage,
  responseSchema,
  toStructuredError,
  uiRequestSchema,
  type AgentCommand,
  type AgentEventEnvelope,
  type AgentRequest,
  type Response,
  type Result,
  type SessionStatus,
  type StatusResult,
  type UiPush,
  type UiRequest,
  type Warning,
} from '../protocol';
import { SessionStore, newSessionRecord, type SessionRecord } from '../session/store';
import { compareSnapshots } from '../diagnostics/compare';
import { buildReport } from '../export/report';

/**
 * Background router. Stateless: every call
 * loads the session from the store, so a worker restart changes nothing.
 */

/** Describes who sent a message, abstracted from chrome.runtime.MessageSender. */
export interface SenderInfo {
  extensionId: string | undefined;
  /** Present for content scripts only. */
  tabId: number | undefined;
  frameId: number | undefined;
  documentId: string | undefined;
  origin: string | undefined;
  url: string | undefined;
}

export interface RouterDeps {
  store: SessionStore;
  ownExtensionId: string;
  /** manifest version, embedded in reports. */
  extensionVersion?: string;
  /** Inject agent.js into the tab's top frame. Rejects if activeTab has lapsed. */
  injectAgent(tabId: number): Promise<void>;
  /** Send a request to the agent in the tab's top frame and await its response. */
  sendToAgent(tabId: number, req: AgentRequest): Promise<unknown>;
  /** Get the tab's origin/title if we may see it, or null if the tab is gone/inaccessible. */
  describeTab(tabId: number): Promise<{ origin: string; title: string | null } | null>;
  /** Push a message to the UI page(s). Best effort. */
  notifyUi(push: UiPush): void;
  now(): number;
}

export class Router {
  constructor(private readonly deps: RouterDeps) {}

  /* ----------------------------------------------------------------------- */
  /* Session creation (action click)                                          */
  /* ----------------------------------------------------------------------- */

  async createSessionForTab(tabId: number): Promise<SessionRecord> {
    const info = await this.deps.describeTab(tabId);
    const sessionId = newId();
    const rec = newSessionRecord(sessionId, info ? { tabId, origin: info.origin, title: info.title } : { tabId, origin: 'unknown', title: null });
    if (!info || !/^https?:$/.test(safeProtocol(info.origin))) {
      rec.status = 'unsupportedPage';
      rec.statusDetail = 'Only http(s) pages can be inspected. Browser-internal pages, extension pages and file URLs are not supported.';
    }
    // One session per tab: clear any previous one so its content does not linger.
    const previous = await this.deps.store.sessionIdForTab(tabId);
    if (previous && previous !== sessionId) await this.deps.store.clear(previous);
    await this.deps.store.put(rec);
    return rec;
  }

  /* ----------------------------------------------------------------------- */
  /* Inbound message dispatch                                                 */
  /* ----------------------------------------------------------------------- */

  /** Returns a Response for requests, or null for events (no reply). */
  async handleMessage(raw: unknown, sender: SenderInfo): Promise<Response | null> {
    if (sender.extensionId !== this.deps.ownExtensionId) {
      // Not our extension. Ignore silently; never reply to strangers.
      return null;
    }
    const kind = (raw as { kind?: unknown } | null)?.kind;
    if (kind === 'uiRequest') {
      if (sender.tabId !== undefined && !(sender.url ?? '').startsWith(`chrome-extension://${this.deps.ownExtensionId}/`)) {
        // uiRequest kind from a content script: a page cannot do this, but a compromised
        // agent context could try. Refuse.
        return this.errorResponse(raw, new ProtocolError('untrustedSender', 'UI commands must come from an extension page'));
      }
      return this.handleUiRequest(raw);
    }
    if (kind === 'agentEvent') {
      await this.handleAgentEvent(raw, sender);
      return null;
    }
    return null;
  }

  private errorResponse(raw: unknown, err: unknown): Response {
    const r = (raw ?? {}) as Partial<UiRequest>;
    return {
      v: PROTOCOL_VERSION,
      kind: 'response',
      requestId: typeof r.requestId === 'string' ? r.requestId.slice(0, 64) : 'unknown0',
      sessionId: typeof r.sessionId === 'string' ? r.sessionId.slice(0, 64) : 'unknown0',
      generation: typeof r.generation === 'number' ? r.generation : 0,
      ok: false,
      error: toStructuredError(err),
      warnings: [],
    };
  }

  /* ----------------------------------------------------------------------- */
  /* UI requests                                                              */
  /* ----------------------------------------------------------------------- */

  async handleUiRequest(raw: unknown): Promise<Response> {
    let req: UiRequest;
    try {
      req = parseMessage(uiRequestSchema, raw);
    } catch (err) {
      return this.errorResponse(raw, err);
    }
    const base = { v: PROTOCOL_VERSION, kind: 'response', requestId: req.requestId, sessionId: req.sessionId } as const;
    try {
      const rec = await this.deps.store.require(req.sessionId);
      const { result, warnings } = await this.dispatchUi(req, rec);
      const after = await this.deps.store.get(req.sessionId);
      return { ...base, generation: after?.generation ?? rec.generation, ok: true, result, warnings };
    } catch (err) {
      const rec = await this.deps.store.get(req.sessionId);
      return { ...base, generation: rec?.generation ?? req.generation, ok: false, error: toStructuredError(err), warnings: [] };
    }
  }

  private async dispatchUi(req: UiRequest, rec: SessionRecord): Promise<{ result: Result; warnings: Warning[] }> {
    const p = req.payload;
    const ok = (warnings: Warning[] = []): { result: Result; warnings: Warning[] } => ({ result: { type: 'ok' }, warnings });

    switch (p.command) {
      case 'getStatus':
        return { result: { type: 'status', status: await this.status(rec) }, warnings: [] };

      case 'attach':
        return { result: { type: 'status', status: await this.status(await this.attach(rec)) }, warnings: [] };

      case 'detach':
        await this.detach(rec, 'notAttached', 'Detached by user.');
        return ok();

      case 'clearSession': {
        await this.detach(rec, 'notAttached', 'Cleared.').catch(() => undefined);
        await this.deps.store.clear(rec.sessionId);
        // Recreate an empty record so the UI can keep talking to the same session id.
        const fresh = newSessionRecord(rec.sessionId, rec.source);
        fresh.statusDetail = 'Session content cleared. Attach again to continue.';
        await this.deps.store.put(fresh);
        this.deps.notifyUi({ v: PROTOCOL_VERSION, kind: 'uiPush', sessionId: rec.sessionId, payload: { event: 'statusChanged' } });
        return ok();
      }

      case 'pickRoot': {
        this.requireAttached(rec);
        await this.agent(rec, { command: 'pickRoot' });
        return ok();
      }
      case 'cancelPick': {
        this.requireAttached(rec);
        await this.agent(rec, { command: 'cancelPick' });
        return ok();
      }
      case 'setRoot': {
        this.requireAttached(rec);
        const res = await this.agent(rec, { command: 'setRoot', selector: p.selector });
        if (res.result?.type !== 'rootState') throw new ProtocolError('internal', 'unexpected agent result');
        const root = { ...res.result.root, confirmed: false, userSelector: p.selector };
        await this.deps.store.update(rec.sessionId, (r) => {
          r.root = root;
          r.structure = null;
          r.observation.active = false;
          if (r.status === 'observing' || r.status === 'staleRoot') r.status = 'ready';
        });
        return { result: { type: 'rootState', root }, warnings: res.warnings };
      }
      case 'confirmRoot': {
        this.requireAttached(rec);
        if (!rec.root.attached) throw new ProtocolError('noRoot', 'select a root first');
        const res = await this.agent(rec, { command: 'describeRoot', includeSuggestedSelectors: false });
        if (res.result?.type !== 'rootState') throw new ProtocolError('internal', 'unexpected agent result');
        const root = { ...res.result.root, confirmed: true, userSelector: rec.root.userSelector };
        await this.deps.store.update(rec.sessionId, (r) => {
          r.root = root;
        });
        return { result: { type: 'rootState', root }, warnings: res.warnings };
      }
      case 'inspectStructure': {
        this.requireAttached(rec);
        if (!rec.root.attached) throw new ProtocolError('noRoot', 'select a root first');
        const res = await this.agent(rec, { command: 'inspectStructure', includeSuggestedSelectors: p.includeSuggestedSelectors });
        if (res.result?.type !== 'structure') throw new ProtocolError('internal', 'unexpected agent result');
        const summary = res.result.summary;
        await this.deps.store.update(rec.sessionId, (r) => {
          r.structure = summary;
        });
        return { result: { type: 'structure', summary }, warnings: res.warnings };
      }
      case 'setCaptureMode': {
        if (rec.observation.active) throw new ProtocolError('invalidRequest', 'stop observation before changing capture mode');
        await this.deps.store.update(rec.sessionId, (r) => {
          r.captureMode = p.mode;
        });
        return ok();
      }
      case 'setRecipe': {
        if (rec.observation.active) throw new ProtocolError('invalidRequest', 'stop observation before changing the recipe');
        await this.deps.store.update(rec.sessionId, (r) => {
          r.recipe = p.recipe;
          r.previewedFingerprint = null;
        });
        return ok();
      }
      case 'previewRecipe': {
        this.requireAttached(rec);
        this.requireConfirmedRoot(rec);
        if (!rec.recipe) throw new ProtocolError('invalidRecipe', 'no recipe set');
        const res = await this.agent(rec, { command: 'extract', recipe: rec.recipe, captureMode: rec.captureMode, trigger: 'preview' });
        if (res.result?.type !== 'snapshot') throw new ProtocolError('internal', 'unexpected agent result');
        const fp = previewFingerprint(rec);
        await this.deps.store.update(rec.sessionId, (r) => {
          r.previewedFingerprint = fp;
        });
        // Previews are not retained; the UI shows them once.
        return { result: res.result, warnings: res.warnings };
      }
      case 'startObservation': {
        this.requireAttached(rec);
        this.requireConfirmedRoot(rec);
        if (!rec.recipe) throw new ProtocolError('invalidRecipe', 'no recipe set');
        if (rec.captureMode === 'selectedFields' && rec.previewedFingerprint !== previewFingerprint(rec)) {
          // PLAN §8: preview is mandatory before observation with content enabled.
          throw new ProtocolError('invalidRequest', 'preview the current recipe with "selected fields" capture before observing with content enabled');
        }
        // Mark active *before* asking the agent: its first snapshot event can
        // arrive before the start response, and inactive sessions drop snapshots.
        await this.deps.store.update(rec.sessionId, (r) => {
          r.observation.active = true;
          r.observation.pausedReason = null;
          r.status = 'observing';
          r.statusDetail = null;
        });
        try {
          await this.agent(rec, { command: 'startObservation', recipe: rec.recipe, captureMode: rec.captureMode });
        } catch (err) {
          await this.deps.store.update(rec.sessionId, (r) => {
            if (r.status === 'observing') r.status = 'ready';
            r.observation.active = false;
          });
          throw err;
        }
        return ok();
      }
      case 'stopObservation': {
        if (rec.status === 'observing' || rec.observation.active) {
          await this.agent(rec, { command: 'stopObservation' }).catch(() => undefined);
        }
        await this.deps.store.update(rec.sessionId, (r) => {
          r.observation.active = false;
          if (r.status === 'observing') {
            r.status = 'pausedByUser';
            r.statusDetail = 'Observation stopped by user.';
          }
        });
        return ok();
      }
      case 'rescan': {
        this.requireAttached(rec);
        this.requireConfirmedRoot(rec);
        if (!rec.recipe) throw new ProtocolError('invalidRecipe', 'no recipe set');
        const res = await this.agent(rec, { command: 'extract', recipe: rec.recipe, captureMode: rec.captureMode, trigger: 'manual' });
        if (res.result?.type !== 'snapshot') throw new ProtocolError('internal', 'unexpected agent result');
        const warnings = [...res.warnings];
        await this.retainSnapshot(rec.sessionId, res.result.snapshot, warnings);
        return { result: res.result, warnings };
      }
      case 'getSnapshots':
        return { result: { type: 'snapshots', snapshots: rec.snapshots }, warnings: [] };

      case 'compareSnapshots': {
        const [from, to] = await Promise.all([this.deps.store.getSnapshot(rec.sessionId, p.fromSnapshotId), this.deps.store.getSnapshot(rec.sessionId, p.toSnapshotId)]);
        if (!from || !to) throw new ProtocolError('invalidRequest', 'unknown snapshot id');
        const comparison = compareSnapshots(from, to, rec.recipe);
        await this.deps.store.update(rec.sessionId, (r) => {
          r.comparisons = [...r.comparisons.filter((c) => !(c.fromSnapshotId === comparison.fromSnapshotId && c.toSnapshotId === comparison.toSnapshotId)), comparison].slice(-50);
        });
        return { result: { type: 'comparison', comparison }, warnings: comparison.warnings };
      }
      case 'buildReport': {
        const snapshots = p.options.includeSnapshots ? (await Promise.all(rec.snapshots.map((m) => this.deps.store.getSnapshot(rec.sessionId, m.snapshotId)))).filter((s): s is NonNullable<typeof s> => !!s) : [];
        const { report, serializedBytes, warnings } = buildReport(rec, snapshots, p.options, this.deps.extensionVersion ?? '0.0.0');
        return { result: { type: 'report', report, serializedBytes }, warnings };
      }
    }
  }

  private requireAttached(rec: SessionRecord): void {
    if (rec.status === 'notAttached' || rec.status === 'attaching') throw new ProtocolError('notAttached', 'attach to the source tab first');
    if (rec.status === 'staleDocument') throw new ProtocolError('wrongDocument', 'the source document changed; attach again');
    if (rec.status === 'permissionLost') throw new ProtocolError('permissionLost', 'access to the source tab was lost; click the extension action on the tab again');
    if (rec.status === 'unsupportedPage') throw new ProtocolError('unsupportedPage', 'this page cannot be inspected');
  }

  private requireConfirmedRoot(rec: SessionRecord): void {
    if (!rec.root.attached) throw new ProtocolError('noRoot', 'select a root first');
    if (!rec.root.confirmed) throw new ProtocolError('noRoot', 'confirm the root before extracting content');
  }

  /* ----------------------------------------------------------------------- */
  /* Attachment                                                               */
  /* ----------------------------------------------------------------------- */

  private async attach(rec: SessionRecord): Promise<SessionRecord> {
    if (!rec.source) throw new ProtocolError('unsupportedPage', 'session has no source tab');
    if (rec.status === 'unsupportedPage') throw new ProtocolError('unsupportedPage', rec.statusDetail ?? 'unsupported page');
    const tabId = rec.source.tabId;
    const info = await this.deps.describeTab(tabId);
    if (!info) {
      return this.deps.store.update(rec.sessionId, (r) => {
        r.status = 'permissionLost';
        r.statusDetail = 'The source tab is closed or no longer accessible.';
      });
    }
    if (info.origin !== rec.source.origin) {
      return this.deps.store.update(rec.sessionId, (r) => {
        r.status = 'permissionLost';
        r.statusDetail = 'The source tab navigated to a different origin. Click the extension action on it again to start a new session.';
      });
    }
    const generation = rec.generation + 1;
    await this.deps.store.update(rec.sessionId, (r) => {
      r.status = 'attaching';
      r.generation = generation;
      r.documentId = null;
      r.documentGeneration = null;
      r.root = { confirmed: false, description: null, userSelector: null, attached: false };
      r.structure = null;
      r.observation = { active: false, lastSnapshotAt: null, lastRecordCount: null, lastMissingIdentityCount: null, pausedReason: null };
    });
    try {
      await this.deps.injectAgent(tabId);
      const res = await this.sendAgent(tabId, rec.sessionId, generation, { command: 'hello' });
      if (res.result?.type !== 'agentHello') throw new ProtocolError('agentUnavailable', 'agent did not answer hello');
      const documentGeneration = res.result.documentGeneration;
      return await this.deps.store.update(rec.sessionId, (r) => {
        r.status = 'ready';
        r.statusDetail = null;
        r.documentGeneration = documentGeneration;
        r.source = { ...r.source!, title: info.title };
      });
    } catch (err) {
      const e = err instanceof ProtocolError ? err : new ProtocolError('permissionLost', `could not inject the agent: ${(err as Error)?.message?.slice(0, 200) ?? 'unknown error'}`);
      return this.deps.store.update(rec.sessionId, (r) => {
        r.status = e.code === 'permissionLost' ? 'permissionLost' : 'failure';
        r.statusDetail = e.message;
      });
    }
  }

  private async detach(rec: SessionRecord, status: SessionStatus, detail: string): Promise<void> {
    if (rec.source && rec.status !== 'notAttached' && rec.status !== 'permissionLost' && rec.status !== 'unsupportedPage') {
      await this.sendAgent(rec.source.tabId, rec.sessionId, rec.generation, { command: 'detach' }).catch(() => undefined);
    }
    await this.deps.store.update(rec.sessionId, (r) => {
      r.status = status;
      r.statusDetail = detail;
      r.documentId = null;
      r.documentGeneration = null;
      r.root = { confirmed: false, description: null, userSelector: null, attached: false };
      r.observation.active = false;
    });
    this.deps.notifyUi({ v: PROTOCOL_VERSION, kind: 'uiPush', sessionId: rec.sessionId, payload: { event: 'statusChanged' } });
  }

  private async agent(rec: SessionRecord, command: AgentCommand): Promise<Response> {
    if (!rec.source) throw new ProtocolError('notAttached', 'no source tab');
    return this.sendAgent(rec.source.tabId, rec.sessionId, rec.generation, command);
  }

  private async sendAgent(tabId: number, sessionId: string, generation: number, command: AgentCommand): Promise<Response> {
    const req: AgentRequest = { v: PROTOCOL_VERSION, kind: 'agentRequest', requestId: newId(), sessionId, generation, payload: command };
    let raw: unknown;
    try {
      raw = await this.deps.sendToAgent(tabId, req);
    } catch (err) {
      await this.markAgentGone(sessionId, (err as Error)?.message);
      throw new ProtocolError('agentUnavailable', 'the agent did not respond; the page may have reloaded or the tab closed');
    }
    if (raw === undefined) {
      await this.markAgentGone(sessionId, 'no listener');
      throw new ProtocolError('agentUnavailable', 'no agent in the source tab; attach again');
    }
    const res = parseMessage(responseSchema, raw);
    if (res.requestId !== req.requestId) throw new ProtocolError('internal', 'agent response id mismatch');
    if (!res.ok) {
      const code = res.error?.code ?? 'internal';
      if (code === 'staleGeneration' || code === 'staleSession') {
        await this.deps.store.update(sessionId, (r) => {
          r.status = 'staleDocument';
          r.statusDetail = 'The agent in the page belongs to a different attachment. Attach again.';
          r.observation.active = false;
        });
      }
      if (code === 'rootDetached') {
        await this.deps.store.update(sessionId, (r) => {
          r.status = 'staleRoot';
          r.statusDetail = 'The inspection root left the document. Select a root again.';
          r.root = { ...r.root, attached: false, confirmed: false };
          r.observation.active = false;
        });
      }
      throw new ProtocolError(code, res.error?.message ?? 'agent error', res.error?.details);
    }
    return res;
  }

  private async markAgentGone(sessionId: string, _why: string | undefined): Promise<void> {
    await this.deps.store
      .update(sessionId, (r) => {
        if (r.status === 'notAttached' || r.status === 'permissionLost') return;
        r.status = 'staleDocument';
        r.statusDetail = 'The agent is no longer reachable (page reloaded, navigated, or tab closed). Attach again.';
        r.observation.active = false;
        r.root = { ...r.root, attached: false, confirmed: false };
      })
      .catch(() => undefined);
    this.deps.notifyUi({ v: PROTOCOL_VERSION, kind: 'uiPush', sessionId, payload: { event: 'statusChanged' } });
  }

  /* ----------------------------------------------------------------------- */
  /* Agent events                                                             */
  /* ----------------------------------------------------------------------- */

  async handleAgentEvent(raw: unknown, sender: SenderInfo): Promise<void> {
    let env: AgentEventEnvelope;
    try {
      env = parseMessage(agentEventEnvelopeSchema, raw);
    } catch {
      return; // malformed: drop
    }
    const rec = await this.deps.store.get(env.sessionId);
    if (!rec || !rec.source) return;
    // Sender identity checks (PLAN §6): tab, frame, generation, document.
    if (sender.tabId !== rec.source.tabId) return;
    if (sender.frameId !== undefined && sender.frameId !== 0) return;
    if (sender.origin !== undefined && sender.origin !== rec.source.origin && sender.origin !== 'null') return;
    if (env.generation !== rec.generation) return; // stale agent from a previous attachment
    if (rec.documentId === null && sender.documentId) {
      await this.deps.store.update(rec.sessionId, (r) => {
        r.documentId = sender.documentId!;
      });
    } else if (rec.documentId !== null && sender.documentId && sender.documentId !== rec.documentId) {
      // Different document, same tab: a full navigation happened and someone re-ran the agent.
      await this.deps.store.update(rec.sessionId, (r) => {
        r.status = 'staleDocument';
        r.statusDetail = 'A message arrived from a different document than the one attached. Attach again.';
        r.observation.active = false;
      });
      this.deps.notifyUi({ v: PROTOCOL_VERSION, kind: 'uiPush', sessionId: rec.sessionId, payload: { event: 'statusChanged' } });
      return;
    }

    const p = env.payload;
    const push = (payload: UiPush['payload']) => this.deps.notifyUi({ v: PROTOCOL_VERSION, kind: 'uiPush', sessionId: rec.sessionId, payload });

    switch (p.event) {
      case 'pickResult': {
        const root = { ...p.root, confirmed: false };
        await this.deps.store.update(rec.sessionId, (r) => {
          r.root = root;
          r.structure = null;
          if (r.status === 'staleRoot') r.status = 'ready';
        });
        push({ event: 'pickResult', root });
        return;
      }
      case 'pickCancelled':
        push({ event: 'statusChanged' });
        return;
      case 'rootLost':
        await this.deps.store.update(rec.sessionId, (r) => {
          if (r.status === 'notAttached') return;
          r.status = 'staleRoot';
          r.statusDetail = `The inspection root was ${p.reason === 'navigation' ? 'invalidated by navigation' : p.reason}. Select a root again and reconfirm.`;
          r.root = { ...r.root, attached: false, confirmed: false };
          r.observation.active = false;
        });
        push({ event: 'statusChanged' });
        return;
      case 'navigation':
        // Same-document navigation. The agent has already dropped the root if there was one.
        return;
      case 'unloading':
        await this.deps.store.update(rec.sessionId, (r) => {
          if (r.status === 'notAttached') return;
          r.status = 'staleDocument';
          r.statusDetail = 'The source page is unloading (reload or navigation). Attach again once it has loaded.';
          r.observation.active = false;
          r.root = { ...r.root, attached: false, confirmed: false };
        });
        push({ event: 'statusChanged' });
        return;
      case 'snapshot': {
        if (!rec.observation.active) return; // late event after stop
        const warnings: Warning[] = [];
        await this.retainSnapshot(rec.sessionId, p.snapshot, warnings);
        return;
      }
      case 'observationPaused':
        await this.deps.store.update(rec.sessionId, (r) => {
          r.observation.active = false;
          r.observation.pausedReason = p.reason;
          r.status = 'pausedAtLimit';
          r.statusDetail = p.reason;
          r.activeWarnings = [...r.activeWarnings, ...p.warnings].slice(-50);
        });
        push({ event: 'statusChanged' });
        return;
    }
  }

  private async retainSnapshot(sessionId: string, snapshot: Parameters<SessionStore['putSnapshot']>[1], warnings: Warning[]): Promise<void> {
    const { limitReached } = await this.deps.store.putSnapshot(sessionId, snapshot);
    const missingIdentity = snapshot.records.filter((r) => r.identityKey === null).length;
    if (limitReached) {
      const w: Warning = { code: 'limitReached', message: `Retention limit reached (${LIMITS.maxSnapshotsRetained} snapshots or ${LIMITS.retainedSnapshotBytes} bytes). Observation paused; export or clear to continue.`, limit: 'retainedSnapshotBytes', limitValue: LIMITS.retainedSnapshotBytes };
      warnings.push(w);
      const rec = await this.deps.store.get(sessionId);
      if (rec?.source && rec.observation.active) {
        await this.sendAgent(rec.source.tabId, sessionId, rec.generation, { command: 'stopObservation' }).catch(() => undefined);
      }
      await this.deps.store.update(sessionId, (r) => {
        r.observation.active = false;
        r.observation.pausedReason = w.message;
        r.status = 'pausedAtLimit';
        r.statusDetail = w.message;
        r.activeWarnings = [...r.activeWarnings, w].slice(-50);
      });
    } else {
      await this.deps.store.update(sessionId, (r) => {
        r.observation.lastSnapshotAt = snapshot.takenAt;
        r.observation.lastRecordCount = snapshot.recordCount;
        r.observation.lastMissingIdentityCount = missingIdentity;
      });
    }
    this.deps.notifyUi({ v: PROTOCOL_VERSION, kind: 'uiPush', sessionId, payload: { event: 'snapshotAdded', snapshotId: snapshot.snapshotId } });
  }

  /* ----------------------------------------------------------------------- */
  /* Tab lifecycle                                                            */
  /* ----------------------------------------------------------------------- */

  async onTabRemoved(tabId: number): Promise<void> {
    const sessionId = await this.deps.store.sessionIdForTab(tabId);
    if (!sessionId) return;
    await this.deps.store
      .update(sessionId, (r) => {
        r.status = 'permissionLost';
        r.statusDetail = 'The source tab was closed. Retained diagnostics are still available for export until you clear the session.';
        r.observation.active = false;
        r.root = { ...r.root, attached: false, confirmed: false };
      })
      .catch(() => undefined);
    this.deps.notifyUi({ v: PROTOCOL_VERSION, kind: 'uiPush', sessionId, payload: { event: 'statusChanged' } });
  }

  async onTabNavigated(tabId: number): Promise<void> {
    const sessionId = await this.deps.store.sessionIdForTab(tabId);
    if (!sessionId) return;
    await this.deps.store
      .update(sessionId, (r) => {
        if (r.status === 'notAttached' || r.status === 'permissionLost' || r.status === 'unsupportedPage') return;
        r.status = 'staleDocument';
        r.statusDetail = 'The source tab started loading a new document. Attach again once it has loaded.';
        r.observation.active = false;
        r.root = { ...r.root, attached: false, confirmed: false };
      })
      .catch(() => undefined);
    this.deps.notifyUi({ v: PROTOCOL_VERSION, kind: 'uiPush', sessionId, payload: { event: 'statusChanged' } });
  }

  /* ----------------------------------------------------------------------- */
  /* Status projection                                                        */
  /* ----------------------------------------------------------------------- */

  async status(rec: SessionRecord): Promise<StatusResult> {
    const limits: Record<string, number> = {};
    for (const [k, v] of Object.entries(LIMITS)) limits[k] = v;
    return {
      sessionId: rec.sessionId,
      generation: rec.generation,
      status: rec.status,
      statusDetail: rec.statusDetail,
      source: rec.source,
      captureMode: rec.captureMode,
      root: rec.root,
      recipe: rec.recipe,
      structure: rec.structure,
      observation: {
        active: rec.observation.active,
        lastSnapshotAt: rec.observation.lastSnapshotAt,
        lastRecordCount: rec.observation.lastRecordCount,
        lastMissingIdentityCount: rec.observation.lastMissingIdentityCount,
        snapshotCount: rec.snapshots.length,
        retainedBytes: rec.retainedBytes,
        pausedReason: rec.observation.pausedReason,
      },
      limits,
      activeWarnings: rec.activeWarnings,
    };
  }
}

function previewFingerprint(rec: SessionRecord): string {
  return `${rec.captureMode}:${fnv(JSON.stringify(rec.recipe))}`;
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function safeProtocol(origin: string): string {
  try {
    return new URL(origin).protocol;
  } catch {
    return '';
  }
}
