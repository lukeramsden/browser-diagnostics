import { test, expect } from './fixtures';
import { attachWithRoot, setRecipe, FIXTURE_RECIPE } from './helpers';

test.describe('Phase 2: extraction recipes', () => {
  test('structure-only preview withholds values; selected-fields preview matches ground truth', async ({ harness }) => {
    const { fixture, ui } = await attachWithRoot(harness);
    await setRecipe(ui, FIXTURE_RECIPE);

    // Structure-only preview: shapes, lengths and hashed identities only.
    await ui.getByRole('button', { name: /Preview extraction/ }).click();
    const card = ui.locator('#section-recipe .card');
    await expect(card).toContainText('9 record(s)');
    let text = await ui.locator('#section-recipe').innerText();
    for (const forbidden of ['hello', 'a-1', 'example.com', 'Ann', 'Bob', 'pwned']) expect(text, forbidden).not.toContain(forbidden);
    expect(text).toContain('[withheld');

    // Switch to selected fields and preview again.
    await ui.getByLabel(/Selected fields/).check();
    await ui.getByRole('button', { name: /Preview extraction/ }).click();
    await expect(card).toContainText('9 record(s)');
    text = await ui.locator('#section-recipe').innerText();
    const expected: Array<{ id: string; sender: string; body: string; at: string }> = await fixture.evaluate(() => (window as any).__fixture.expected('alpha'));
    for (const rec of expected) {
      expect(text).toContain(rec.id);
      expect(text).toContain(rec.sender);
      expect(text).toContain(rec.at);
    }
    // Unicode / multiline body preserved verbatim (textContent: innerText collapses whitespace)
    const raw = await ui.locator('#section-recipe').evaluate((e) => e.textContent ?? '');
    expect(raw).toContain('multi\nline\n\ttabbed — “quotes” 🎉 中文 עברית');
    // HTML injection payload appears as inert text; the UI title is unchanged
    expect(text).toContain('<img src=x onerror=');
    expect(await ui.title()).toBe('Browser Diagnostics');
    expect(await ui.locator('img').count()).toBe(0);
    // Hidden record is flagged not visible; link and attachment fields work
    await expect(card).toContainText('1 hidden');
    expect(text).toContain('https://example.com/path?q=secret#frag');
    // Drafts and credentials are never extracted, even in selected-fields mode
    for (const forbidden of ['unsent draft', 's3cret-password-value', 'tok-abc-123', 'inside closed shadow root']) expect(text, forbidden).not.toContain(forbidden);
    // The recipe's record selector does not cross into the open shadow root or the iframe by itself
    expect(text).not.toContain('shadow-1');
    expect(text).not.toContain('in-frame');
  });

  test('malformed recipes are rejected without being set; recipes cannot carry code', async ({ harness }) => {
    const { ui } = await attachWithRoot(harness);
    await ui.locator('#tabs').getByRole('button', { name: 'Recipe' }).click();
    await ui.getByLabel('Recipe JSON').fill('{ not json');
    await ui.getByRole('button', { name: 'Set recipe for this session' }).click();
    await expect(ui.locator('#section-recipe')).toContainText('Not valid JSON');
    await expect(ui.locator('#section-recipe')).toContainText('No recipe set');

    const evil = { ...FIXTURE_RECIPE, fields: { ...FIXTURE_RECIPE.fields, handler: { selector: ':scope', read: 'attribute', attribute: 'onclick' } }, transform: 'return document.cookie' };
    await ui.getByLabel('Recipe JSON').fill(JSON.stringify(evil));
    await ui.getByRole('button', { name: 'Set recipe for this session' }).click();
    await expect(ui.locator('#section-recipe')).toContainText('Recipe rejected');
    await expect(ui.locator('#section-recipe')).toContainText('fields.handler.attribute');
    await expect(ui.locator('#section-recipe')).toContainText('No recipe set');

    // Backdoor via direct message is also rejected by the background.
    const sessionId = new URL(ui.url()).searchParams.get('session')!;
    const res = await ui.evaluate((args) => chrome.runtime.sendMessage({ v: 1, kind: 'uiRequest', requestId: 'req_00000001', sessionId: args.id, generation: 0, payload: { command: 'setRecipe', recipe: args.evil } }), { id: sessionId, evil });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('invalidRequest');
  });

  test('recipe with no identity fields: records get no identity and repeated text is not merged', async ({ harness }) => {
    const { ui } = await attachWithRoot(harness, '#/c/noids');
    await setRecipe(ui, { ...FIXTURE_RECIPE, fields: { sender: FIXTURE_RECIPE.fields.sender, body: FIXTURE_RECIPE.fields.body }, identityFields: [] });
    await ui.getByLabel(/Selected fields/).check();
    await ui.getByRole('button', { name: /Preview extraction/ }).click();
    const card = ui.locator('#section-recipe .card');
    await expect(card).toContainText('3 record(s)');
    await expect(card).toContainText('3 record(s) without identity');
    await expect(card).toContainText('Recipe has no identityFields');
  });

  test('recipe JSON can be downloaded without the downloads permission', async ({ harness }) => {
    const { ui } = await attachWithRoot(harness);
    await ui.locator('#tabs').getByRole('button', { name: 'Recipe' }).click();
    await ui.getByLabel('Recipe JSON').fill(JSON.stringify(FIXTURE_RECIPE));
    const [download] = await Promise.all([ui.waitForEvent('download'), ui.getByRole('button', { name: 'Download recipe JSON' }).click()]);
    expect(download.suggestedFilename()).toBe('recipe-Fixture_messages.json');
    const path = await download.path();
    const { readFileSync } = await import('node:fs');
    expect(JSON.parse(readFileSync(path!, 'utf8')).name).toBe('Fixture messages');
  });
});
