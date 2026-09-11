import { test, expect, statusText } from './fixtures';

test.describe('Phase 1: attachment and structure inspection', () => {
  test('manifest of the built extension has only the documented permissions', async ({ harness }) => {
    const manifest = await harness.sw.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.permissions?.sort()).toEqual(['activeTab', 'scripting', 'storage']);
    // Test build only: fixture host access replaces the activeTab user gesture.
    expect(manifest.host_permissions).toEqual(['http://127.0.0.1/*', 'http://localhost/*']);
  });

  test('attach, select root, inspect structure without leaking content, detach, clear', async ({ harness }) => {
    const { fixture, ui } = await harness.openSession();

    await expect(ui.locator('#banner .status')).toHaveText('Not attached');
    await ui.getByRole('button', { name: 'Attach', exact: true }).click();
    await expect(ui.locator('#banner .status')).toHaveText('Ready for one-shot inspection');

    // Agent installed, but nothing of ours is visible in the page when no picker is active.
    expect(await fixture.locator('[data-browser-diagnostics-ui]').count()).toBe(0);

    await ui.locator('#tabs').getByRole('button', { name: 'Structure' }).click();
    await ui.getByLabel('Root selector').fill('#log');
    await ui.getByRole('button', { name: 'Use selector' }).click();
    await expect(ui.locator('#section-structure')).toContainText('Root (selected');
    await ui.getByRole('button', { name: 'Confirm this root' }).click();
    await expect(ui.locator('#section-structure')).toContainText('Root (confirmed)');

    await ui.getByRole('button', { name: 'Inspect structure' }).click();
    const card = ui.locator('#section-structure .card').last();
    await expect(card).toContainText('Structure summary');
    await expect(card).toContainText('article');
    await expect(card).toContainText('data-record-id');

    // Structure-only: no message text, ids, urls, or sensitive control values anywhere in the UI.
    const uiText = await ui.locator('body').innerText();
    for (const forbidden of ['hello', 'a-1', 'example.com', 's3cret-password-value', 'tok-abc-123', 'unsent draft', 'pwned', 'Ann', 'Bob']) {
      expect(uiText, `UI must not contain "${forbidden}"`).not.toContain(forbidden);
    }
    // Injection payload from the page did not execute in the fixture or the UI.
    expect(await fixture.title()).not.toBe('pwned');
    expect(await ui.title()).toBe('Browser Diagnostics');

    // The iframe is reported as a boundary, and the closed shadow root is invisible.
    await expect(card).toContainText('iframes (not entered)');

    // Detach: status back to not attached; nothing of ours remains in the page.
    await ui.locator('#tabs').getByRole('button', { name: 'Session' }).click();
    await ui.getByRole('button', { name: 'Stop (detach)' }).click();
    await expect(ui.locator('#banner .status')).toHaveText('Not attached');
    expect(await fixture.locator('[data-browser-diagnostics-ui]').count()).toBe(0);

    // Clear: storage for the session holds no structure summary afterwards.
    await ui.getByRole('button', { name: 'Clear session content' }).click();
    await expect(ui.locator('#banner')).toContainText('cleared');
    const sessionId = new URL(ui.url()).searchParams.get('session')!;
    const rec = await harness.sw.evaluate((id) => (globalThis as any).__diagnosticsTestHooks.getSession(id), sessionId);
    expect(rec.structure).toBeNull();
    expect(rec.snapshots).toEqual([]);
  });

  test('picker selects a root and removes itself; Escape cancels cleanly', async ({ harness }) => {
    const { fixture, ui } = await harness.openSession();
    await ui.getByRole('button', { name: 'Attach', exact: true }).click();
    await expect(ui.locator('#banner .status')).toHaveText('Ready for one-shot inspection');
    await ui.locator('#tabs').getByRole('button', { name: 'Structure' }).click();

    // Cancel path
    await ui.getByRole('button', { name: 'Pick inspection root in page' }).click();
    await fixture.bringToFront();
    await expect(fixture.locator('[data-browser-diagnostics-ui="picker-overlay"]')).toHaveCount(1);
    await fixture.keyboard.press('Escape');
    await expect(fixture.locator('[data-browser-diagnostics-ui]')).toHaveCount(0);

    // Pick path: clicking a conversation link must select it, not navigate.
    await ui.getByRole('button', { name: 'Pick inspection root in page' }).click();
    await fixture.bringToFront();
    const link = fixture.locator('a[data-conv="beta"]');
    await link.hover();
    await expect(fixture.locator('[data-browser-diagnostics-ui="picker-label"]')).toContainText('<a');
    await link.click();
    await expect(fixture.locator('[data-browser-diagnostics-ui]')).toHaveCount(0);
    expect(fixture.url()).not.toContain('beta'); // click was consumed
    await expect(ui.locator('#section-structure')).toContainText('Root (selected');
    await expect(ui.locator('#section-structure')).toContainText('(picked in page)');
  });

  test('same-document navigation invalidates the root; reload makes the document stale', async ({ harness }) => {
    const { fixture, ui } = await harness.openSession();
    await ui.getByRole('button', { name: 'Attach', exact: true }).click();
    await ui.locator('#tabs').getByRole('button', { name: 'Structure' }).click();
    await ui.getByLabel('Root selector').fill('#log');
    await ui.getByRole('button', { name: 'Use selector' }).click();
    await expect(ui.locator('#section-structure')).toContainText('Root (selected');

    await fixture.click('#btn-push'); // history.pushState
    await expect(ui.locator('#banner .status')).toHaveText('Stale root');

    await ui.getByLabel('Root selector').fill('#log');
    await ui.getByRole('button', { name: 'Use selector' }).click();
    await expect(ui.locator('#banner .status')).toHaveText('Ready for one-shot inspection');

    await fixture.reload();
    await expect(ui.locator('#banner .status')).toHaveText('Stale document');
    // Inspection is refused until re-attached (UI disables it; router rejects it too).
    await expect(ui.getByRole('button', { name: 'Inspect structure' })).toBeDisabled();
    const sessionId = new URL(ui.url()).searchParams.get('session')!;
    const res = await ui.evaluate(
      (id) => chrome.runtime.sendMessage({ v: 1, kind: 'uiRequest', requestId: 'req_00000001', sessionId: id, generation: 0, payload: { command: 'inspectStructure', includeSuggestedSelectors: false } }),
      sessionId,
    );
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('wrongDocument');

    await ui.locator('#tabs').getByRole('button', { name: 'Session' }).click();
    await ui.getByRole('button', { name: 'Attach again' }).click();
    await expect(ui.locator('#banner .status')).toHaveText('Ready for one-shot inspection');
  });

  test('closing the source tab reports permission lost and does not attach elsewhere', async ({ harness }) => {
    const { fixture, ui } = await harness.openSession();
    await ui.getByRole('button', { name: 'Attach', exact: true }).click();
    await expect(ui.locator('#banner .status')).toHaveText('Ready for one-shot inspection');
    const other = await harness.context.newPage();
    await other.goto('http://127.0.0.1:4173/');
    await fixture.close();
    await expect(ui.locator('#banner .status')).toHaveText('Permission lost');
    // The attach button is disabled; even a forced request must be refused.
    await expect(ui.getByRole('button', { name: 'Attach again' })).toBeDisabled();
    const sessionId = new URL(ui.url()).searchParams.get('session')!;
    const res = await ui.evaluate((id) => chrome.runtime.sendMessage({ v: 1, kind: 'uiRequest', requestId: 'req_00000001', sessionId: id, generation: 0, payload: { command: 'attach' } }), sessionId);
    expect(res.ok).toBe(true);
    expect(res.result.status.status).toBe('permissionLost');
    await expect(ui.locator('#banner .status')).toHaveText('Permission lost');
    expect(await other.locator('[data-browser-diagnostics-ui]').count()).toBe(0);
    expect(await other.evaluate(() => (window as any).__browserDiagnosticsAgent)).toBeUndefined();
  });

  test('session state survives a service-worker restart', async ({ harness }) => {
    const { ui } = await harness.openSession();
    await ui.getByRole('button', { name: 'Attach', exact: true }).click();
    await ui.locator('#tabs').getByRole('button', { name: 'Structure' }).click();
    await ui.getByLabel('Root selector').fill('#log');
    await ui.getByRole('button', { name: 'Use selector' }).click();
    await ui.getByRole('button', { name: 'Confirm this root' }).click();
    await expect(ui.locator('#section-structure')).toContainText('Root (confirmed)');

    // Stop the worker; the next message must rebuild everything from storage.
    await harness.sw.evaluate(() => (globalThis as any).close?.());
    await ui.reload();
    await expect(ui.locator('#banner .status')).toHaveText('Ready for one-shot inspection');
    await ui.locator('#tabs').getByRole('button', { name: 'Structure' }).click();
    await expect(ui.locator('#section-structure')).toContainText('Root (confirmed)');
    await ui.getByRole('button', { name: 'Inspect structure' }).click();
    await expect(ui.locator('#section-structure .card').last()).toContainText('Structure summary');
  });
});
