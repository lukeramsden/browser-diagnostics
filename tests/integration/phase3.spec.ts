import { test, expect } from './fixtures';
import { attachWithRoot, setRecipe, FIXTURE_RECIPE } from './helpers';
import type { Page } from '@playwright/test';

async function startObserving(ui: Page, expectedRows = 1): Promise<void> {
  await ui.locator('#tabs').getByRole('button', { name: 'Observe' }).click();
  await ui.getByRole('button', { name: 'Start observation' }).click();
  await expect(ui.locator('#banner .status')).toHaveText('Observing');
  await expect(ui.locator('#snapshot-list tbody tr')).toHaveCount(expectedRows);
}

async function pickAndCompare(ui: Page, fromRow: number, toRow: number): Promise<void> {
  const rows = ui.locator('#snapshot-list tbody tr');
  await rows.nth(fromRow).locator('input[name="from"]').check();
  await rows.nth(toRow).locator('input[name="to"]').check();
  await ui.getByRole('button', { name: 'Compare A → B' }).click();
  await expect(ui.locator('#section-observe .card')).toContainText('Comparison');
}

test.describe('Phase 3: observation and comparison', () => {
  test('mutations produce snapshots; comparison reports added/changed/removed-from-view without merging on text', async ({ harness }) => {
    const { fixture, ui } = await attachWithRoot(harness);
    await setRecipe(ui, FIXTURE_RECIPE);
    await startObserving(ui);
    const rows = ui.locator('#snapshot-list tbody tr');

    await fixture.click('#btn-edit');
    await expect(rows).toHaveCount(2, { timeout: 5000 });
    await fixture.click('#btn-incoming');
    await expect(rows).toHaveCount(3, { timeout: 5000 });
    await fixture.click('#btn-remove');
    await expect(rows).toHaveCount(4, { timeout: 5000 });

    await pickAndCompare(ui, 0, 3);
    const card = ui.locator('#section-observe .card');
    await expect(card).toContainText('Added to view: 1');
    await expect(card).toContainText('Removed from view: 1');
    await expect(card).toContainText('Changed: 1');
    await expect(card).toContainText('not deletion');
    // Structure-only: no page text anywhere in the observe tab
    const text = await ui.locator('#section-observe').innerText();
    for (const forbidden of ['hello', 'Ann', 'Bob', 'example.com']) expect(text, forbidden).not.toContain(forbidden);

    await ui.getByRole('button', { name: 'Stop observation' }).click();
    await expect(ui.locator('#banner .status')).toHaveText('Paused by user');
    // Snapshots are retained after stop; a further mutation adds none.
    await fixture.click('#btn-incoming');
    await fixture.waitForTimeout(1500);
    await expect(rows).toHaveCount(4);
  });

  test('identical text under different identities is reported, never merged', async ({ harness }) => {
    const { fixture, ui } = await attachWithRoot(harness, '#/c/beta');
    await setRecipe(ui, { ...FIXTURE_RECIPE, fields: { recordId: FIXTURE_RECIPE.fields.recordId, body: FIXTURE_RECIPE.fields.body } });
    await startObserving(ui);
    await fixture.click('#btn-incoming');
    await expect(ui.locator('#snapshot-list tbody tr')).toHaveCount(2, { timeout: 5000 });
    await pickAndCompare(ui, 0, 1);
    const card = ui.locator('#section-observe .card');
    await expect(card).toContainText('Unchanged: 3');
    await expect(card).toContainText('Same content, different identity (2)');
    await expect(card).toContainText('never used as identity');
  });

  test('virtualised node reuse is reported as node reuse and removed-from-view, never as edits', async ({ harness }) => {
    const { fixture, ui } = await attachWithRoot(harness, '#/c/virtual');
    await setRecipe(ui, FIXTURE_RECIPE);
    await startObserving(ui);
    await fixture.evaluate(() => {
      const log = document.getElementById('log')!;
      log.style.height = '100px';
      log.style.flex = 'none';
      log.scrollTop = 100; // 5 rows further
      log.dispatchEvent(new Event('scroll'));
    });
    const rows = ui.locator('#snapshot-list tbody tr');
    await expect(rows).toHaveCount(2, { timeout: 5000 });
    await pickAndCompare(ui, 0, 1);
    const card = ui.locator('#section-observe .card');
    await expect(card).toContainText('Node reused for a different record (10)');
    await expect(card).toContainText('Removed from view: 5');
    await expect(card).toContainText('Added to view: 5');
    await expect(card).toContainText('Changed: 0');
    await expect(card).toContainText('Identity fields are usable');
  });

  test('root replacement and page reload stop observation; re-attach does not resume it; old snapshots cannot be compared with new ones', async ({ harness }) => {
    const { fixture, ui } = await attachWithRoot(harness);
    await setRecipe(ui, FIXTURE_RECIPE);
    await startObserving(ui);

    await fixture.click('#btn-replace-root');
    await expect(ui.locator('#banner .status')).toHaveText('Stale root', { timeout: 5000 });
    await expect(ui.locator('#banner')).toContainText('inactive');

    // Re-select the (new) root, observe again, then reload the page.
    await ui.locator('#tabs').getByRole('button', { name: 'Structure' }).click();
    await ui.getByLabel('Root selector').fill('#log');
    await ui.getByRole('button', { name: 'Use selector' }).click();
    await ui.getByRole('button', { name: 'Confirm this root' }).click();
    await startObserving(ui, 2);
    await fixture.reload();
    await expect(ui.locator('#banner .status')).toHaveText('Stale document', { timeout: 5000 });
    await fixture.waitForSelector('#log article');
    await ui.locator('#tabs').getByRole('button', { name: 'Session' }).click();
    await ui.getByRole('button', { name: 'Attach again' }).click();
    await expect(ui.locator('#banner .status')).toHaveText('Ready for one-shot inspection');
    await expect(ui.locator('#banner')).toContainText('inactive');

    // Old snapshots (generation 1 and 2) are still listed but a new one cannot be compared across generations.
    await ui.locator('#tabs').getByRole('button', { name: 'Structure' }).click();
    await ui.getByLabel('Root selector').fill('#log');
    await ui.getByRole('button', { name: 'Use selector' }).click();
    await ui.getByRole('button', { name: 'Confirm this root' }).click();
    await startObserving(ui, 3);
    const rows = ui.locator('#snapshot-list tbody tr');
    await rows.nth(0).locator('input[name="from"]').check();
    await rows.nth(2).locator('input[name="to"]').check();
    await ui.getByRole('button', { name: 'Compare A → B' }).click();
    await expect(ui.locator('#section-observe')).toContainText('different attach generations');
  });

  test('observation continues across a service-worker restart, and stop/clear erases snapshots', async ({ harness }) => {
    const { fixture, ui } = await attachWithRoot(harness);
    await setRecipe(ui, FIXTURE_RECIPE);
    await startObserving(ui);
    await harness.sw.evaluate(() => (globalThis as any).close?.());
    await fixture.click('#btn-incoming');
    await ui.reload();
    await ui.locator('#tabs').getByRole('button', { name: 'Observe' }).click();
    await expect(ui.locator('#banner .status')).toHaveText('Observing');
    await expect(ui.locator('#snapshot-list tbody tr')).toHaveCount(2, { timeout: 5000 });

    await ui.locator('#tabs').getByRole('button', { name: 'Session' }).click();
    await ui.getByRole('button', { name: 'Stop (detach)' }).click();
    await ui.getByRole('button', { name: 'Clear session content' }).click();
    await expect(ui.locator('#banner')).toContainText('snapshots 0/');
    const stored = await harness.sw.evaluate(async () => Object.keys(await chrome.storage.session.get(null)));
    expect(stored.filter((k) => k.startsWith('snapshot:'))).toEqual([]);
    const all = JSON.stringify(await harness.sw.evaluate(() => chrome.storage.session.get(null)));
    expect(all).not.toContain('a-1');
  });

  test('retention limit pauses observation with limitReached rather than truncating', async ({ harness }) => {
    test.setTimeout(120_000);
    const { fixture, ui } = await attachWithRoot(harness);
    await setRecipe(ui, FIXTURE_RECIPE);
    await startObserving(ui);
    const max = 20;
    for (let i = 0; i < max; i++) {
      await fixture.click('#btn-incoming');
      await fixture.waitForTimeout(1300);
    }
    await expect(ui.locator('#banner .status')).toHaveText('Paused at a resource limit', { timeout: 15_000 });
    await expect(ui.locator('#banner')).toContainText('Retention limit reached');
    await ui.locator('#tabs').getByRole('button', { name: 'Observe' }).click();
    await expect(ui.getByRole('button', { name: 'Start observation' })).toBeDisabled();
    await expect(ui.locator('#snapshot-list tbody tr')).toHaveCount(max);
  });
});
