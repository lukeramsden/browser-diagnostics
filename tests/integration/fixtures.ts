import { test as base, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const FIXTURE_URL = 'http://127.0.0.1:4173/';
const EXT_PATH = resolve(import.meta.dirname, '../../dist-test');

export interface Harness {
  context: BrowserContext;
  extensionId: string;
  sw: Worker;
  /** Open the fixture app in a tab and a diagnostics page bound to it (like clicking the action). */
  openSession(path?: string): Promise<{ fixture: Page; ui: Page; sessionId: string }>;
}

export const test = base.extend<{ harness: Harness }>({
  harness: async ({}, use) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'bd-pw-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
    });
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const extensionId = sw.url().split('/')[2]!;

    const harness: Harness = {
      context,
      extensionId,
      sw,
      async openSession(path = '') {
        const fixture = await context.newPage();
        await fixture.goto(FIXTURE_URL + path);
        await fixture.waitForSelector('#log article');
        const url = fixture.url();
        const sessionId: string = await sw.evaluate(async (u: string) => {
          const hooks = (globalThis as any).__diagnosticsTestHooks;
          const tabId = await hooks.findTabId(u);
          if (tabId === null) throw new Error('fixture tab not found');
          return hooks.openForTab(tabId);
        }, url);
        // openForTab creates a new tab with the UI; find it.
        const ui = await waitForPage(context, (p) => p.url().startsWith(`chrome-extension://${extensionId}/ui.html`));
        await ui.waitForSelector('#section-session button');
        return { fixture, ui, sessionId };
      },
    };
    await use(harness);
    await context.close();
    rmSync(userDataDir, { recursive: true, force: true });
  },
});

async function waitForPage(context: BrowserContext, pred: (p: Page) => boolean): Promise<Page> {
  const existing = context.pages().find(pred);
  if (existing) return existing;
  return new Promise((resolve) => {
    const onPage = (p: Page) => {
      const check = () => {
        if (pred(p)) {
          context.off('page', onPage);
          resolve(p);
        }
      };
      p.on('framenavigated', check);
      check();
    };
    context.on('page', onPage);
  });
}

export const expect = test.expect;

export async function statusText(ui: Page): Promise<string> {
  return (await ui.locator('#banner .status').textContent()) ?? '';
}
