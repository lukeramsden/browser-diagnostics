import { expect, type Harness } from './fixtures';
import type { Page } from '@playwright/test';

export const FIXTURE_RECIPE = {
  schemaVersion: 1,
  name: 'Fixture messages',
  recordSelector: 'article[role="article"]',
  fields: {
    recordId: { selector: ':scope', read: 'attribute', attribute: 'data-record-id' },
    sender: { selector: '.sender', read: 'text', required: true },
    body: { selector: '.body', read: 'text', required: true },
    at: { selector: 'time', read: 'attribute', attribute: 'datetime' },
    links: { selector: '.body a', read: 'attribute', attribute: 'href', multiple: true },
    attachment: { selector: '[data-attachment]', read: 'exists' },
  },
  identityFields: ['recordId'],
};

export async function attachWithRoot(harness: Harness, path = '', selector = '#log'): Promise<{ fixture: Page; ui: Page; sessionId: string }> {
  const s = await harness.openSession(path);
  await s.ui.getByRole('button', { name: 'Attach', exact: true }).click();
  await expect(s.ui.locator('#banner .status')).toHaveText('Ready for one-shot inspection');
  await s.ui.locator('#tabs').getByRole('button', { name: 'Structure' }).click();
  await s.ui.getByLabel('Root selector').fill(selector);
  await s.ui.getByRole('button', { name: 'Use selector' }).click();
  await s.ui.getByRole('button', { name: 'Confirm this root' }).click();
  await expect(s.ui.locator('#section-structure')).toContainText('Root (confirmed)');
  return s;
}

export async function setRecipe(ui: Page, recipe: unknown): Promise<void> {
  await ui.locator('#tabs').getByRole('button', { name: 'Recipe' }).click();
  await ui.getByLabel('Recipe JSON').fill(JSON.stringify(recipe));
  await ui.getByRole('button', { name: 'Set recipe for this session' }).click();
  await expect(ui.locator('#section-recipe')).toContainText('Session recipe:');
}

