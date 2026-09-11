import { describe, expect, it } from 'vitest';
import { Router, type RouterDeps, type SenderInfo } from '../../src/background/router';
import { MemoryStorageArea, SessionStore } from '../../src/session/store';
import { PROTOCOL_VERSION, type AgentRequest, type Response, type UiCommandInput } from '../../src/protocol';

const EXT = 'ext-id';
const TAB = 7;
const ORIGIN = 'https://app.example';

function fakeAgent() {
  const calls: AgentRequest[] = [];
  let generation = 0;
  let sessionId: string | null = null;
  let rootConnected = true;
  const deps = {
    calls,
    setRootConnected(v: boolean) {
      rootConnected = v;
    },
    async sendToAgent(_tabId: number, req: AgentRequest): Promise<Response> {
      calls.push(req);
      const base = { v: PROTOCOL_VERSION, kind: 'response', requestId: req.requestId, sessionId: req.sessionId, generation } as const;
      if (req.payload.command === 'hello') {
        generation = req.generation;
        sessionId = req.sessionId;
        return { ...base, generation, ok: true, result: { type: 'agentHello', generation, documentGeneration: 'doc-gen-0001', href: `${ORIGIN}/x` }, warnings: [] };
      }
      if (req.sessionId !== sessionId) return { ...base, ok: false, error: { code: 'staleSession', message: 'x' }, warnings: [] };
      if (req.generation !== generation) return { ...base, ok: false, error: { code: 'staleGeneration', message: 'x' }, warnings: [] };
      if (req.payload.command === 'setRoot' || req.payload.command === 'describeRoot') {
        if (!rootConnected) return { ...base, ok: false, error: { code: 'rootDetached', message: 'gone' }, warnings: [] };
        return { ...base, ok: true, result: { type: 'rootState', root: { confirmed: false, description: { tag: 'div', role: null, depthFromBody: 1, childElementCount: 2, descendantEstimate: 5, hasId: false, classCount: 0, dataAttributeCount: 0, inShadowRoot: false }, userSelector: null, attached: true } }, warnings: [] };
      }
      if (req.payload.command === 'extract') {
        return { ...base, ok: true, result: { type: 'snapshot', snapshot: { snapshotId: 'snap0001', generation, takenAt: 1, trigger: req.payload.trigger, recordCount: 0, limitReached: false, durationMs: 1, records: [], hiddenCount: 0, warnings: [], estimatedBytes: 0 } }, warnings: [] };
      }
      if (req.payload.command === 'inspectStructure') {
        if (!rootConnected) return { ...base, ok: false, error: { code: 'rootDetached', message: 'gone' }, warnings: [] };
        return { ...base, ok: true, result: { type: 'structure', summary: emptySummary() }, warnings: [] };
      }
      return { ...base, ok: true, result: { type: 'ok' }, warnings: [] };
    },
  };
  return deps;
}

function emptySummary() {
  return { nodesVisited: 1, maxDepthReached: 0, durationMs: 1, limits: { maxNodes: 1, maxDepth: 1, maxMs: 1 }, limitReached: false, tagCounts: {}, roleCounts: {}, attributeNameCounts: {}, dataAttributeElementCount: 0, timeElementCount: 0, linkCount: 0, ariaLabelledCount: 0, visibleElementCount: 0, hiddenElementCount: 0, truncatedTextCandidates: 0, openShadowRootCount: 0, iframeCount: 0, sensitiveControlCount: 0, repeatedShapes: [], warnings: [] };
}

function setup(opts: { tabOrigin?: string | null } = {}) {
  const area = new MemoryStorageArea();
  const store = new SessionStore(area);
  const agent = fakeAgent();
  const pushes: unknown[] = [];
  let injected = 0;
  const deps: RouterDeps = {
    store,
    ownExtensionId: EXT,
    now: () => 1000,
    async injectAgent() {
      injected++;
    },
    sendToAgent: agent.sendToAgent,
    async describeTab() {
      if (opts.tabOrigin === null) return null;
      return { origin: opts.tabOrigin ?? ORIGIN, title: 'T' };
    },
    notifyUi(p) {
      pushes.push(p);
    },
    ...({} as object),
  };
  const router = new Router(deps);
  const uiSender: SenderInfo = { extensionId: EXT, tabId: undefined, frameId: undefined, documentId: undefined, origin: undefined, url: `chrome-extension://${EXT}/ui.html` };
  const agentSender = (over: Partial<SenderInfo> = {}): SenderInfo => ({ extensionId: EXT, tabId: TAB, frameId: 0, documentId: 'DOC1', origin: ORIGIN, url: `${ORIGIN}/x`, ...over });
  const ui = async (sessionId: string, payload: UiCommandInput) => (await router.handleMessage({ v: 1, kind: 'uiRequest', requestId: 'req_00000001', sessionId, generation: 0, payload }, uiSender))!;
  return { router, store, area, agent, pushes, ui, uiSender, agentSender, injected: () => injected };
}

describe('Router', () => {
  it('creates a session for a tab and marks non-http pages unsupported', async () => {
    const a = setup({ tabOrigin: 'chrome://extensions' });
    const rec = await a.router.createSessionForTab(TAB);
    expect(rec.status).toBe('unsupportedPage');
    const res = await a.ui(rec.sessionId, { command: 'attach' });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('unsupportedPage');
  });

  it('attaches with an incremented generation and records document generation', async () => {
    const a = setup();
    const rec = await a.router.createSessionForTab(TAB);
    const res = await a.ui(rec.sessionId, { command: 'attach' });
    expect(res.ok).toBe(true);
    if (res.result?.type !== 'status') throw new Error('bad');
    expect(res.result.status.status).toBe('ready');
    expect(res.result.status.generation).toBe(1);
    expect(a.injected()).toBe(1);
    const stored = await a.store.get(rec.sessionId);
    expect(stored?.documentGeneration).toBe('doc-gen-0001');
  });

  it('ignores messages from other extensions and refuses uiRequest from tabs', async () => {
    const a = setup();
    const rec = await a.router.createSessionForTab(TAB);
    expect(await a.router.handleMessage({ v: 1, kind: 'uiRequest', requestId: 'req_00000001', sessionId: rec.sessionId, generation: 0, payload: { command: 'getStatus' } }, { ...a.uiSender, extensionId: 'other' })).toBeNull();
    const res = await a.router.handleMessage({ v: 1, kind: 'uiRequest', requestId: 'req_00000001', sessionId: rec.sessionId, generation: 0, payload: { command: 'getStatus' } }, a.agentSender());
    expect(res?.ok).toBe(false);
    expect(res?.error?.code).toBe('untrustedSender');
  });

  it('rejects unknown sessions and refuses inspection before attach or root', async () => {
    const a = setup();
    const bad = await a.ui('nonexistent-session', { command: 'getStatus' });
    expect(bad.error?.code).toBe('noSession');
    const rec = await a.router.createSessionForTab(TAB);
    expect((await a.ui(rec.sessionId, { command: 'inspectStructure', includeSuggestedSelectors: false })).error?.code).toBe('notAttached');
    await a.ui(rec.sessionId, { command: 'attach' });
    expect((await a.ui(rec.sessionId, { command: 'inspectStructure', includeSuggestedSelectors: false })).error?.code).toBe('noRoot');
    expect((await a.ui(rec.sessionId, { command: 'previewRecipe' })).error?.code).toBe('noRoot');
  });

  it('requires root confirmation before content extraction', async () => {
    const a = setup();
    const rec = await a.router.createSessionForTab(TAB);
    await a.ui(rec.sessionId, { command: 'attach' });
    await a.ui(rec.sessionId, { command: 'setRoot', selector: 'main' });
    await a.ui(rec.sessionId, { command: 'setRecipe', recipe: { schemaVersion: 1, name: 'r', recordSelector: 'li', fields: { t: { selector: ':scope', read: 'text' } } } });
    const res = await a.ui(rec.sessionId, { command: 'previewRecipe' });
    expect(res.error?.code).toBe('noRoot');
    expect(res.error?.message).toMatch(/confirm/);
  });

  it('refuses content observation until the current recipe+mode has been previewed', async () => {
    const a = setup();
    const rec = await a.router.createSessionForTab(TAB);
    await a.ui(rec.sessionId, { command: 'attach' });
    await a.ui(rec.sessionId, { command: 'setRoot', selector: 'main' });
    await a.ui(rec.sessionId, { command: 'confirmRoot' });
    const recipe = { schemaVersion: 1 as const, name: 'r', recordSelector: 'li', fields: { t: { selector: ':scope', read: 'text' as const } } };
    await a.ui(rec.sessionId, { command: 'setRecipe', recipe });
    await a.ui(rec.sessionId, { command: 'setCaptureMode', mode: 'selectedFields' });
    let res = await a.ui(rec.sessionId, { command: 'startObservation' });
    expect(res.error?.message).toMatch(/preview/);
    expect((await a.ui(rec.sessionId, { command: 'previewRecipe' })).ok).toBe(true);
    // Changing the recipe invalidates the preview.
    await a.ui(rec.sessionId, { command: 'setRecipe', recipe: { ...recipe, name: 'r2' } });
    res = await a.ui(rec.sessionId, { command: 'startObservation' });
    expect(res.error?.message).toMatch(/preview/);
    await a.ui(rec.sessionId, { command: 'previewRecipe' });
    res = await a.ui(rec.sessionId, { command: 'startObservation' });
    expect(res.ok).toBe(true);
    expect((await a.store.get(rec.sessionId))?.status).toBe('observing');
    // Structure-only never needs a preview.
    await a.ui(rec.sessionId, { command: 'stopObservation' });
    await a.ui(rec.sessionId, { command: 'setCaptureMode', mode: 'structureOnly' });
    expect((await a.ui(rec.sessionId, { command: 'startObservation' })).ok).toBe(true);
  });

  it('drops agent events from the wrong tab, frame, or generation', async () => {
    const a = setup();
    const rec = await a.router.createSessionForTab(TAB);
    await a.ui(rec.sessionId, { command: 'attach' });
    const ev = (gen: number) => ({ v: 1, kind: 'agentEvent', sessionId: rec.sessionId, generation: gen, payload: { event: 'rootLost', reason: 'detached' } });
    await a.router.handleMessage(ev(1), a.agentSender({ tabId: 99 }));
    await a.router.handleMessage(ev(1), a.agentSender({ frameId: 3 }));
    await a.router.handleMessage(ev(0), a.agentSender());
    expect((await a.store.get(rec.sessionId))?.status).toBe('ready');
    await a.router.handleMessage(ev(1), a.agentSender());
    expect((await a.store.get(rec.sessionId))?.status).toBe('staleRoot');
  });

  it('binds documentId on first event and marks the session stale if it changes', async () => {
    const a = setup();
    const rec = await a.router.createSessionForTab(TAB);
    await a.ui(rec.sessionId, { command: 'attach' });
    const nav = { v: 1, kind: 'agentEvent', sessionId: rec.sessionId, generation: 1, payload: { event: 'navigation', sameDocument: true } };
    await a.router.handleMessage(nav, a.agentSender({ documentId: 'DOC1' }));
    expect((await a.store.get(rec.sessionId))?.documentId).toBe('DOC1');
    await a.router.handleMessage(nav, a.agentSender({ documentId: 'DOC2' }));
    expect((await a.store.get(rec.sessionId))?.status).toBe('staleDocument');
    expect((await a.ui(rec.sessionId, { command: 'inspectStructure', includeSuggestedSelectors: false })).error?.code).toBe('wrongDocument');
  });

  it('marks the root stale when the agent reports it detached', async () => {
    const a = setup();
    const rec = await a.router.createSessionForTab(TAB);
    await a.ui(rec.sessionId, { command: 'attach' });
    await a.ui(rec.sessionId, { command: 'setRoot', selector: 'main' });
    a.agent.setRootConnected(false);
    const res = await a.ui(rec.sessionId, { command: 'inspectStructure', includeSuggestedSelectors: false });
    expect(res.error?.code).toBe('rootDetached');
    const rec2 = await a.store.get(rec.sessionId);
    expect(rec2?.status).toBe('staleRoot');
    expect(rec2?.root.attached).toBe(false);
  });

  it('re-attaching after a stale document uses a new generation and old agent replies are rejected', async () => {
    const a = setup();
    const rec = await a.router.createSessionForTab(TAB);
    await a.ui(rec.sessionId, { command: 'attach' });
    await a.router.onTabNavigated(TAB);
    expect((await a.store.get(rec.sessionId))?.status).toBe('staleDocument');
    const res = await a.ui(rec.sessionId, { command: 'attach' });
    if (res.result?.type !== 'status') throw new Error('bad');
    expect(res.result.status.generation).toBe(2);
    // A stale event from generation 1 is ignored
    await a.router.handleMessage({ v: 1, kind: 'agentEvent', sessionId: rec.sessionId, generation: 1, payload: { event: 'rootLost', reason: 'detached' } }, a.agentSender());
    expect((await a.store.get(rec.sessionId))?.status).toBe('ready');
  });

  it('tab closure → permissionLost; attach refuses to move to another tab', async () => {
    const a = setup();
    const rec = await a.router.createSessionForTab(TAB);
    await a.ui(rec.sessionId, { command: 'attach' });
    await a.router.onTabRemoved(TAB);
    expect((await a.store.get(rec.sessionId))?.status).toBe('permissionLost');
    const res = await a.ui(rec.sessionId, { command: 'pickRoot' });
    expect(res.error?.code).toBe('permissionLost');
  });

  it('origin change on the source tab → permissionLost on attach', async () => {
    const a = setup();
    const rec = await a.router.createSessionForTab(TAB);
    (a.router as unknown as { deps: RouterDeps }).deps.describeTab = async () => ({ origin: 'https://elsewhere.example', title: null });
    const res = await a.ui(rec.sessionId, { command: 'attach' });
    if (res.result?.type !== 'status') throw new Error('bad');
    expect(res.result.status.status).toBe('permissionLost');
    expect(a.injected()).toBe(0);
  });

  it('clearSession removes every stored key for the session', async () => {
    const a = setup();
    const rec = await a.router.createSessionForTab(TAB);
    await a.ui(rec.sessionId, { command: 'attach' });
    await a.ui(rec.sessionId, { command: 'setRoot', selector: 'main' });
    await a.ui(rec.sessionId, { command: 'inspectStructure', includeSuggestedSelectors: false });
    expect((await a.store.get(rec.sessionId))?.structure).not.toBeNull();
    await a.ui(rec.sessionId, { command: 'clearSession' });
    const after = await a.store.get(rec.sessionId);
    expect(after?.structure).toBeNull();
    expect(after?.status).toBe('notAttached');
    expect(a.area.keys().filter((k) => k.startsWith('snapshot:'))).toEqual([]);
  });

  it('a second action click on the same tab replaces the previous session and clears it', async () => {
    const a = setup();
    const first = await a.router.createSessionForTab(TAB);
    const second = await a.router.createSessionForTab(TAB);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(await a.store.get(first.sessionId)).toBeNull();
    expect(await a.store.sessionIdForTab(TAB)).toBe(second.sessionId);
  });
});
