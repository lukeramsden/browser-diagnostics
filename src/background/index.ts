/**
 * Background service worker entry. Thin wiring around Router: all decisions
 * live in router.ts so they can be unit-tested; this file only adapts Chrome
 * APIs. No in-memory state that matters survives here (PLAN §4).
 */
import { Router, type SenderInfo } from './router';
import { SessionStore } from '../session/store';
import type { UiPush } from '../protocol';

const store = new SessionStore(chrome.storage.session);

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const router = new Router({
  store,
  ownExtensionId: chrome.runtime.id,
  extensionVersion: chrome.runtime.getManifest().version,
  now: () => Date.now(),
  async injectAgent(tabId) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['agent.js'] });
  },
  async sendToAgent(tabId, req) {
    return chrome.tabs.sendMessage(tabId, req, { frameId: 0 });
  },
  async describeTab(tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      // Without the "tabs" permission, url/title are only populated while we
      // hold (activeTab) host access to this tab. Missing url ⇒ no access.
      const origin = originOf(tab.url);
      if (!origin) return null;
      return { origin, title: tab.title ?? null };
    } catch {
      return null;
    }
  },
  notifyUi(push: UiPush) {
    // Extension pages listen on runtime.onMessage; content scripts ignore uiPush.
    chrome.runtime.sendMessage(push).catch(() => undefined);
  },
});

function senderInfo(sender: chrome.runtime.MessageSender): SenderInfo {
  return {
    extensionId: sender.id,
    tabId: sender.tab?.id,
    frameId: sender.frameId,
    documentId: sender.documentId,
    origin: sender.origin,
    url: sender.url,
  };
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const kind = (raw as { kind?: unknown } | null)?.kind;
  if (kind !== 'uiRequest' && kind !== 'agentEvent') return false;
  router
    .handleMessage(raw, senderInfo(sender))
    .then((res) => {
      if (res) sendResponse(res);
    })
    .catch(() => {
      /* handleMessage never throws for valid kinds; guard anyway */
    });
  return kind === 'uiRequest';
});

async function openForTab(tabId: number): Promise<string> {
  const rec = await router.createSessionForTab(tabId);
  const url = chrome.runtime.getURL(`ui.html?session=${encodeURIComponent(rec.sessionId)}`);
  await chrome.tabs.create({ url });
  return rec.sessionId;
}

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  void openForTab(tab.id);
});

chrome.tabs.onRemoved.addListener((tabId) => void router.onTabRemoved(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A new document is loading in the tab. `status: 'loading'` fires on full
  // navigations and reloads; same-document navigations are detected by the agent.
  if (changeInfo.status === 'loading') void router.onTabNavigated(tabId);
});

// Test-only harness (PLAN §13 "explicitly documented harness path"). Compiled
// out of the production build: see vite.config.ts and docs/validation-guide.md.
if (import.meta.env.VITE_TEST_HOOKS === 'true') {
  (globalThis as unknown as { __diagnosticsTestHooks: unknown }).__diagnosticsTestHooks = {
    openForTab,
    getSession: (id: string) => store.get(id),
    /** Find the fixture tab. Works in the test build because it has host access to 127.0.0.1. */
    async findTabId(urlPrefix: string): Promise<number | null> {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => (x.url ?? '').startsWith(urlPrefix));
      return t?.id ?? null;
    },
  };
}
