import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures';
import { attachWithRoot, setRecipe, FIXTURE_RECIPE } from './helpers';
import type { Page } from '@playwright/test';

async function captureOne(ui: Page, mode: 'structureOnly' | 'selectedFields'): Promise<void> {
  await ui.locator('#tabs').getByRole('button', { name: 'Structure' }).click();
  await ui.getByRole('button', { name: 'Inspect structure' }).click();
  await expect(ui.locator('#section-structure .card').last()).toContainText('Structure summary');
  await setRecipe(ui, FIXTURE_RECIPE);
  if (mode === 'selectedFields') {
    await ui.getByLabel(/Selected fields/).check();
    await ui.getByRole('button', { name: /Preview extraction/ }).click();
    await expect(ui.locator('#section-recipe .card')).toContainText('record(s)');
  }
  await ui.locator('#tabs').getByRole('button', { name: 'Observe' }).click();
  await ui.getByRole('button', { name: 'Start observation' }).click();
  await expect(ui.locator('#snapshot-list tbody tr')).toHaveCount(1);
  await ui.getByRole('button', { name: 'Stop observation' }).click();
  await expect(ui.locator('#banner .status')).toHaveText('Paused by user');
}

async function buildAndSave(ui: Page): Promise<{ report: any; text: string }> {
  await ui.getByRole('button', { name: 'Build preview' }).click();
  await expect(ui.locator('#section-export .card')).toContainText('Preview —');
  const save = ui.getByRole('button', { name: 'Save this exact JSON' });
  await expect(save).toBeDisabled();
  const previewText = await ui.locator('#report-preview').textContent();
  await ui.locator('#export-confirm').check();
  const [download] = await Promise.all([ui.waitForEvent('download'), save.click()]);
  const text = readFileSync((await download.path())!, 'utf8');
  expect(text).toBe(previewText); // the saved file is exactly what was previewed
  return { report: JSON.parse(text), text };
}

test.describe('Phase 4: export and hardening', () => {
  test('default export from a selected-fields session contains no page text, selectors, URLs or title', async ({ harness }) => {
    const { ui } = await attachWithRoot(harness);
    await captureOne(ui, 'selectedFields');
    await ui.locator('#tabs').getByRole('button', { name: 'Export' }).click();
    // include snapshots but keep the default redaction (omit text, alias, day-only, omit URLs)
    await ui.getByLabel(/Snapshots with records/).check();
    const { report, text } = await buildAndSave(ui);
    for (const forbidden of ['hello', 'Ann', 'Bob', 'a-1', 'example.com', 'pwned', 'onerror', 'Fixture Messenger', 'unsent draft', 's3cret', '#log', 'article[role']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(report.schemaVersion).toBe(1);
    expect(report.reportKind).toBe('browser-diagnostics-report');
    expect(report.extensionVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(report.sourceSummary.origin).toBe('http://127.0.0.1:4173');
    expect(report.sourceSummary.tabTitleIncluded).toBe(false);
    expect(report.structureSummary.nodesVisited).toBeGreaterThan(0);
    expect(report.snapshots).toHaveLength(1);
    expect(report.snapshots[0].records).toHaveLength(9);
    expect(report.snapshots[0].records[0].fields.body).toMatchObject({ kind: 'text', value: null, omitted: true, sourceBytes: 5 });
    expect(report.snapshots[0].records[0].identity).toBe('record_1');
    expect(report.recipe).toBeNull();
    expect(report.sessionContext.root.userSelector).toBeNull();
    expect(report.redactionSummary.textValuesOmitted).toBeGreaterThan(0);
    expect(report.notice.join(' ')).toContain('not a synchronisation');
  });

  test('opting into text shows page strings as inert text in the preview and applies URL policy', async ({ harness }) => {
    const { ui } = await attachWithRoot(harness);
    await captureOne(ui, 'selectedFields');
    await ui.locator('#tabs').getByRole('button', { name: 'Export' }).click();
    await ui.getByLabel(/Snapshots with records/).check();
    await ui.getByLabel(/Omit all text values/).uncheck();
    await ui.getByLabel('URLs in values').selectOption('stripQuery');
    await ui.getByLabel('Timestamps').selectOption('keep');
    const { report, text } = await buildAndSave(ui);
    expect(text).toContain('<img src=x onerror=');
    expect(text).toContain('https://example.com/path');
    expect(text).not.toContain('q=secret');
    expect(text).not.toContain('#frag');
    expect(text).toContain('2024-01-01T10:00:00Z');
    // still no drafts, credentials, title or closed-shadow content
    for (const forbidden of ['unsent draft', 's3cret-password-value', 'tok-abc-123', 'Fixture Messenger', 'inside closed shadow root']) expect(text, forbidden).not.toContain(forbidden);
    // the UI rendered the hostile string as text: no injected image, title unchanged
    expect(await ui.title()).toBe('Browser Diagnostics');
    expect(await ui.locator('img').count()).toBe(0);
    expect(report.warnings.some((w: any) => w.message.includes('contains page text'))).toBe(true);
  });

  test('changing an option invalidates the preview; the recipe is only exported on request', async ({ harness }) => {
    const { ui } = await attachWithRoot(harness);
    await captureOne(ui, 'structureOnly');
    await ui.locator('#tabs').getByRole('button', { name: 'Export' }).click();
    await ui.getByRole('button', { name: 'Build preview' }).click();
    await expect(ui.locator('#section-export .card')).toContainText('recipe no');
    await ui.getByLabel(/Recipe and root selection/).check();
    await expect(ui.locator('#section-export .card')).toHaveCount(0);
    const { text } = await buildAndSave(ui);
    expect(text).toContain('article[role=\\"article\\"]');
    expect(text).toContain('"userSelector": "#log"');
  });

  test('clearing the session removes all captured content from storage and the report reflects it', async ({ harness }) => {
    const { ui } = await attachWithRoot(harness);
    await captureOne(ui, 'selectedFields');
    let all = JSON.stringify(await harness.sw.evaluate(() => chrome.storage.session.get(null)));
    expect(all).toContain('hello'); // content was retained while the user asked for it
    await ui.locator('#tabs').getByRole('button', { name: 'Session' }).click();
    await ui.getByRole('button', { name: 'Stop (detach)' }).click();
    await ui.getByRole('button', { name: 'Clear session content' }).click();
    await expect(ui.locator('#banner')).toContainText('snapshots 0/');
    all = JSON.stringify(await harness.sw.evaluate(() => chrome.storage.session.get(null)));
    for (const forbidden of ['hello', 'a-1', 'Ann']) expect(all, forbidden).not.toContain(forbidden);
    await ui.locator('#tabs').getByRole('button', { name: 'Export' }).click();
    await ui.getByLabel(/Snapshots with records/).check();
    await ui.getByRole('button', { name: 'Build preview' }).click();
    await expect(ui.locator('#section-export .card')).toContainText('snapshots 0');
  });

  test('oversized page content is truncated with a visible marker, never silently', async ({ harness }) => {
    const { fixture, ui } = await attachWithRoot(harness);
    await fixture.click('#btn-oversized');
    await setRecipe(ui, FIXTURE_RECIPE);
    await ui.getByLabel(/Selected fields/).check();
    await ui.getByRole('button', { name: /Preview extraction/ }).click();
    const card = ui.locator('#section-recipe .card');
    await expect(card).toContainText('10 record(s)');
    await expect(card).toContainText('truncated:');
    await expect(card).toContainText('…[truncated]');
  });
});
