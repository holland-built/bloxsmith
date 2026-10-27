import { test, expect, type Route } from '@playwright/test';
import { installBaselineWorld } from './page-fixtures';

// Settings > Integrations > AI provider: the AI tab's address, model and key.
// "Use Claude" fills Claude's OpenAI-style address; Test and Save send what
// was typed, and the key is never prefilled.

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/vault/status*', (route) => json(route, {
    active: 'sales', exists: true, ready: true, unlocked: true, vaultMode: true, hasGroq: true, hasAxur: false,
    llm: { base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', hasKey: true, model: 'gemini-x' },
    tenants: [{ id: 'sales', label: 'Example Sales' }], version: 'v3.104.0', writeAllowed: [],
  }));
});

test('Use Claude, Test, then Save send the typed provider, model and key', async ({ page }) => {
  const sent: Record<string, any> = {};
  await page.route('**/api/vault/llm-test', async (route) => { sent.test = route.request().postDataJSON(); return json(route, { ok: true, model: 'claude-sonnet-5-5' }); });
  await page.route('**/api/vault/llm', async (route) => { sent.save = route.request().postDataJSON(); return json(route, { ok: true }); });

  await page.goto('/#overview');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await sheet.getByRole('button', { name: 'Integrations', exact: true }).click();

  // What is stored shows; the key never does.
  await expect(sheet.getByLabel('Provider address')).toHaveValue('https://generativelanguage.googleapis.com/v1beta/openai');
  await expect(sheet.getByLabel('Model')).toHaveValue('gemini-x');
  await expect(sheet.getByLabel('API key', { exact: true })).toHaveValue('');
  await expect(sheet.getByRole('button', { name: 'Save AI provider' })).toBeDisabled();

  await sheet.getByRole('button', { name: 'Use Claude' }).click();
  await expect(sheet.getByLabel('Provider address')).toHaveValue('https://api.anthropic.com/v1');
  await expect(sheet.getByLabel('Model')).toHaveValue('claude-sonnet-5-5');
  await sheet.getByLabel('API key', { exact: true }).fill('test-key-not-real');

  await sheet.getByRole('button', { name: 'Test' }).click();
  await expect(sheet.getByText('It answered (model claude-sonnet-5-5). Save to use it.')).toBeVisible();
  expect(sent.test).toEqual({ key: 'test-key-not-real', base_url: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5' });

  await sheet.getByRole('button', { name: 'Save AI provider' }).click();
  await expect(sheet.getByText('Saved. The AI tab uses it from the next question.')).toBeVisible();
  expect(sent.save).toEqual({ key: 'test-key-not-real', base_url: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5' });
  await expect(sheet.getByLabel('API key', { exact: true })).toHaveValue('');
});

test('a failed test says what to check', async ({ page }) => {
  await page.route('**/api/vault/llm-test', (route) => json(route, { ok: false, error: 'LLM test failed' }));
  await page.goto('/#overview');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await sheet.getByRole('button', { name: 'Integrations', exact: true }).click();
  await sheet.getByLabel('API key', { exact: true }).fill('bad');
  await sheet.getByRole('button', { name: 'Test' }).click();
  await expect(sheet.getByRole('alert')).toHaveText('No answer. Check the key, the address and the model name.');
});
