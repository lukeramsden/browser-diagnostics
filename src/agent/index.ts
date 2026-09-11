/**
 * Content agent. Runs in the isolated world of
 * the selected top-level document. Owns every interaction with that document.
 *
 * Built as a single IIFE (see vite.agent.config.ts) and injected with
 * chrome.scripting.executeScript({ files: ['agent.js'] }).
 */
import {
  PROTOCOL_VERSION,
  ProtocolError,
  agentRequestSchema,
  newId,
  parseMessage,
  toStructuredError,
  type AgentEvent,
  type AgentRequest,
  type Response,
  type Result,
  type RootState,
  type Warning,
} from '../protocol';
import { describeElement, suggestSelectors } from './root';
import { inspectStructure } from './structure';
import { Picker } from './picker';
import { Observer } from './observer';
import { extract } from '../extraction/extract';

interface AgentState {
  sessionId: string | null;
  generation: number;
  documentGeneration: string;
  root: Element | null;
  userSelector: string | null;
  picker: Picker | null;
  observer: Observer | null;
  rootWatcher: MutationObserver | null;
  lastHref: string;
  navigationListenersInstalled: boolean;
}

declare global {
  interface Window {
    __browserDiagnosticsAgent?: { installed: true; version: number };
  }
}

(function main() {
  // Re-injection guard: executeScript may run this file more than once per document.
  if (window.__browserDiagnosticsAgent) return;
  window.__browserDiagnosticsAgent = { installed: true, version: PROTOCOL_VERSION };

  const state: AgentState = {
    sessionId: null,
    generation: 0,
    documentGeneration: newId(),
    root: null,
    userSelector: null,
    picker: null,
    observer: null,
    rootWatcher: null,
    lastHref: location.href,
    navigationListenersInstalled: false,
  };

  /* ----------------------------------------------------------------------- */
  /* Outbound                                                                 */
  /* ----------------------------------------------------------------------- */

  function emit(payload: AgentEvent): void {
    if (!state.sessionId) return;
    const env = { v: PROTOCOL_VERSION, kind: 'agentEvent', sessionId: state.sessionId, generation: state.generation, payload } as const;
    try {
      void chrome.runtime.sendMessage(env).catch(() => {
        /* background may be restarting; events are best-effort */
      });
    } catch {
      /* extension context invalidated (reload) — nothing we can do */
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Root lifecycle                                                           */
  /* ----------------------------------------------------------------------- */

  function rootState(includeSuggested = false): RootState {
    const root = state.root;
    const base: RootState = {
      confirmed: false, // confirmation is a session-side fact; the agent never asserts it
      description: root && root.isConnected ? describeElement(root) : null,
      userSelector: state.userSelector,
      attached: !!root && root.isConnected,
    };
    if (includeSuggested && root && root.isConnected) base.suggestedSelectors = suggestSelectors(root);
    return base;
  }

  function requireRoot(): Element {
    if (!state.root) throw new ProtocolError('noRoot', 'no inspection root selected');
    if (!state.root.isConnected) {
      dropRoot('detached');
      throw new ProtocolError('rootDetached', 'inspection root is no longer in the document');
    }
    return state.root;
  }

  function setRootElement(el: Element, userSelector: string | null): void {
    stopObservation();
    state.root = el;
    state.userSelector = userSelector;
    watchRoot();
  }

  function dropRoot(reason: 'detached' | 'replaced' | 'navigation'): void {
    if (!state.root) return;
    stopObservation();
    state.root = null;
    state.rootWatcher?.disconnect();
    state.rootWatcher = null;
    emit({ event: 'rootLost', reason });
  }

  /** Detect root removal/replacement without scanning content. */
  function watchRoot(): void {
    state.rootWatcher?.disconnect();
    const mo = new MutationObserver(() => {
      if (state.root && !state.root.isConnected) dropRoot('detached');
    });
    mo.observe(document, { childList: true, subtree: true });
    state.rootWatcher = mo;
  }

  /* ----------------------------------------------------------------------- */
  /* Navigation detection                                                     */
  /* ----------------------------------------------------------------------- */

  function checkNavigation(): void {
    if (location.href !== state.lastHref) {
      state.lastHref = location.href;
      emit({ event: 'navigation', sameDocument: true });
      if (state.root) dropRoot('navigation');
    }
  }

  function installNavigationListeners(): void {
    if (state.navigationListenersInstalled) return;
    state.navigationListenersInstalled = true;
    window.addEventListener('popstate', checkNavigation, true);
    window.addEventListener('hashchange', checkNavigation, true);
    const nav = (window as unknown as { navigation?: EventTarget }).navigation;
    if (nav) {
      // Navigation API: fires for pushState/replaceState too. Defer so href has updated.
      nav.addEventListener('navigatesuccess', () => setTimeout(checkNavigation, 0));
      nav.addEventListener('currententrychange', () => setTimeout(checkNavigation, 0));
    }
    window.addEventListener('pagehide', () => {
      stopObservation();
      emit({ event: 'unloading' });
    });
  }

  /* ----------------------------------------------------------------------- */
  /* Picker                                                                   */
  /* ----------------------------------------------------------------------- */

  function cancelPicker(): void {
    state.picker?.dispose();
    state.picker = null;
  }

  function startPicker(): void {
    cancelPicker();
    state.picker = new Picker(
      document,
      (el) => {
        state.picker = null;
        setRootElement(el, null);
        emit({ event: 'pickResult', root: rootState(true) });
      },
      () => {
        state.picker = null;
        emit({ event: 'pickCancelled' });
      },
    );
  }

  /* ----------------------------------------------------------------------- */
  /* Observation                                                              */
  /* ----------------------------------------------------------------------- */

  function stopObservation(): void {
    state.observer?.stop();
    state.observer = null;
  }

  /* ----------------------------------------------------------------------- */
  /* Command handling                                                         */
  /* ----------------------------------------------------------------------- */

  async function handle(req: AgentRequest): Promise<{ result: Result; warnings: Warning[] }> {
    const p = req.payload;
    const warnings: Warning[] = [];
    checkNavigation();

    switch (p.command) {
      case 'hello': {
        state.sessionId = req.sessionId;
        state.generation = req.generation;
        installNavigationListeners();
        // The reply cannot carry sender.documentId; an agent-initiated event can.
        queueMicrotask(() => emit({ event: 'navigation', sameDocument: true }));
        return { result: { type: 'agentHello', generation: state.generation, documentGeneration: state.documentGeneration, href: location.href }, warnings };
      }
      case 'pickRoot':
        startPicker();
        return { result: { type: 'ok' }, warnings };
      case 'cancelPick':
        cancelPicker();
        return { result: { type: 'ok' }, warnings };
      case 'setRoot': {
        let matches: NodeListOf<Element>;
        try {
          matches = document.querySelectorAll(p.selector);
        } catch {
          throw new ProtocolError('invalidSelector', 'selector is not valid CSS');
        }
        if (matches.length === 0) throw new ProtocolError('invalidSelector', 'selector matches no element');
        if (matches.length > 1) warnings.push({ code: 'ambiguousMatch', message: `Selector matches ${matches.length} elements; the first in document order was used.` });
        setRootElement(matches[0]!, p.selector);
        return { result: { type: 'rootState', root: rootState(false) }, warnings };
      }
      case 'describeRoot':
        requireRoot();
        return { result: { type: 'rootState', root: rootState(p.includeSuggestedSelectors) }, warnings };
      case 'inspectStructure': {
        const root = requireRoot();
        const summary = await inspectStructure(root);
        return { result: { type: 'structure', summary }, warnings: summary.warnings };
      }
      case 'extract': {
        const root = requireRoot();
        const snapshot = await extract(root, p.recipe, { captureMode: p.captureMode, trigger: p.trigger, generation: state.generation });
        return { result: { type: 'snapshot', snapshot }, warnings: snapshot.warnings };
      }
      case 'startObservation': {
        const root = requireRoot();
        stopObservation();
        state.observer = new Observer(root, p.recipe, p.captureMode, state.generation, {
          onSnapshot: (snapshot) => emit({ event: 'snapshot', snapshot }),
          onPaused: (reason, w) => emit({ event: 'observationPaused', reason, warnings: w }),
          onRootLost: () => dropRoot('detached'),
        });
        await state.observer.start();
        return { result: { type: 'ok' }, warnings };
      }
      case 'stopObservation':
        stopObservation();
        return { result: { type: 'ok' }, warnings };
      case 'detach': {
        cancelPicker();
        stopObservation();
        state.rootWatcher?.disconnect();
        state.rootWatcher = null;
        state.root = null;
        state.userSelector = null;
        state.sessionId = null;
        return { result: { type: 'ok' }, warnings };
      }
    }
  }

  chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    // Only our own extension may talk to the agent.
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    let req: AgentRequest;
    try {
      req = parseMessage(agentRequestSchema, raw);
    } catch {
      return false; // not for us / malformed: let other listeners (none) handle
    }
    const reply = (r: Response) => {
      try {
        sendResponse(r);
      } catch {
        /* channel closed */
      }
    };
    const base = { v: PROTOCOL_VERSION, kind: 'response', requestId: req.requestId, sessionId: req.sessionId, generation: state.generation } as const;

    if (req.payload.command !== 'hello') {
      if (state.sessionId !== req.sessionId) {
        reply({ ...base, ok: false, error: { code: 'staleSession', message: 'agent is bound to a different session' }, warnings: [] });
        return true;
      }
      if (req.generation !== state.generation) {
        reply({ ...base, ok: false, error: { code: 'staleGeneration', message: 'agent generation mismatch' }, warnings: [] });
        return true;
      }
    }

    handle(req)
      .then(({ result, warnings }) => reply({ ...base, generation: state.generation, ok: true, result, warnings }))
      .catch((err: unknown) => reply({ ...base, generation: state.generation, ok: false, error: toStructuredError(err), warnings: [] }));
    return true;
  });
})();
