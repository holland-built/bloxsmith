import { test, expect, type Route } from '@playwright/test';
import { installBaselineWorld } from './page-fixtures';

// Settings > Integrations > AI provider: the AI tab's address, model and key.
// The "Claude" provider button fills Claude's OpenAI-style address; Test and Save send what
// was typed, and the key is never prefilled.

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/vault/status*', (route) => json(route, {
    active: 'sales', exists: true, ready: true, unlocked: true, vaultMode: true, hasGroq: true, hasAxur: false,
    llm: { base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', hasKey: true, model: 'gemini-x', effort: 'low' },
    tenants: [{ id: 'sales', label: 'Example Sales' }], version: 'v3.104.0', writeAllowed: [],
  }));
});

test('the Claude button, Test, then Save send the typed provider, model and key', async ({ page }) => {
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
  // A key is saved, so Save works without typing it again.
  await expect(sheet.getByRole('button', { name: 'Save AI provider' })).toBeEnabled();

  await sheet.getByRole('button', { name: 'Claude', exact: true }).click();
  await expect(sheet.getByLabel('Provider address')).toHaveValue('https://api.anthropic.com/v1');
  await expect(sheet.getByLabel('Model')).toHaveValue('claude-sonnet-5-5');
  await sheet.getByLabel('API key', { exact: true }).fill('test-key-not-real');

  await sheet.getByRole('button', { name: 'Test' }).click();
  // The stored effort (Low) goes along, and Claude's note says it has no effect there.
  await expect(sheet.getByText('It answered (model claude-sonnet-5-5). Claude ignores the effort setting. Save to use it.')).toBeVisible();
  expect(sent.test).toEqual({ key: 'test-key-not-real', base_url: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5', effort: 'low' });

  await sheet.getByRole('button', { name: 'Save AI provider' }).click();
  await expect(sheet.getByText('Saved. The AI tab uses it from the next question.')).toBeVisible();
  expect(sent.save).toEqual({ key: 'test-key-not-real', base_url: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5', effort: 'low' });
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

test('Find models lists the models the provider offers, and the chosen effort is tested and saved', async ({ page }) => {
  const sent: Record<string, any> = {};
  await page.route('**/api/vault/llm-models', async (route) => { sent.list = route.request().postDataJSON(); return json(route, { ok: true, models: ['gemini-a', 'gemini-b'] }); });
  await page.route('**/api/vault/llm-test', async (route) => { sent.test = route.request().postDataJSON(); return json(route, { ok: true, model: 'gemini-b' }); });
  await page.route('**/api/vault/llm', async (route) => { sent.save = route.request().postDataJSON(); return json(route, { ok: true }); });

  await page.goto('/#overview');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await sheet.getByRole('button', { name: 'Integrations', exact: true }).click();

  // The stored effort shows. A key is saved, so Find models works before one is typed.
  await expect(sheet.getByLabel('Effort')).toHaveValue('low');
  await expect(sheet.getByRole('button', { name: 'Find models' })).toBeEnabled();
  await sheet.getByLabel('API key', { exact: true }).fill('test-key-not-real');
  await sheet.getByRole('button', { name: 'Find models' }).click();
  expect(sent.list).toEqual({ key: 'test-key-not-real', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai' });
  await expect(sheet.getByText('Found 2 models. Pick one from the list.')).toBeVisible();

  await sheet.getByLabel('Models this provider offers').selectOption('gemini-b');
  await expect(sheet.getByLabel('Model', { exact: true })).toHaveValue('gemini-b');
  await sheet.getByLabel('Effort').selectOption('high');

  await sheet.getByRole('button', { name: 'Test' }).click();
  await expect(sheet.getByText('It answered (model gemini-b). Save to use it.')).toBeVisible();
  expect(sent.test).toEqual({ key: 'test-key-not-real', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-b', effort: 'high' });
  await sheet.getByRole('button', { name: 'Save AI provider' }).click();
  await expect(sheet.getByText('Saved. The AI tab uses it from the next question.')).toBeVisible();
  expect(sent.save).toEqual({ key: 'test-key-not-real', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-b', effort: 'high' });
});

test('a failed model list says to type the name instead', async ({ page }) => {
  await page.route('**/api/vault/llm-models', (route) => json(route, { ok: false, error: 'could not list models' }));
  await page.goto('/#overview');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await sheet.getByRole('button', { name: 'Integrations', exact: true }).click();
  await sheet.getByLabel('API key', { exact: true }).fill('bad');
  await sheet.getByRole('button', { name: 'Find models' }).click();
  await expect(sheet.getByRole('alert')).toHaveText('Could not get the list. Check the key and the address, or type the model name.');
});

test('with no key saved or typed, Find models stays off', async ({ page }) => {
  await page.route('**/api/vault/status*', (route) => json(route, {
    active: 'sales', exists: true, ready: true, unlocked: true, vaultMode: true, hasGroq: false, hasAxur: false,
    llm: { base_url: '', hasKey: false, model: '' },
    tenants: [{ id: 'sales', label: 'Example Sales' }], version: 'v3.104.0', writeAllowed: [],
  }));
  await page.goto('/#overview');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await sheet.getByRole('button', { name: 'Integrations', exact: true }).click();
  await expect(sheet.getByRole('button', { name: 'Find models' })).toBeDisabled();
  await expect(sheet.getByRole('button', { name: 'Save AI provider' })).toBeDisabled();
  await expect(sheet.getByRole('button', { name: 'Test' })).toBeDisabled();
  await sheet.getByLabel('API key', { exact: true }).fill('k');
  await expect(sheet.getByRole('button', { name: 'Find models' })).toBeEnabled();
});

test('with a key saved, changing the effort saves without typing the key again', async ({ page }) => {
  let saved: any = null;
  await page.route('**/api/vault/llm', async (route) => { saved = route.request().postDataJSON(); return json(route, { ok: true }); });
  await page.goto('/#overview');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await sheet.getByRole('button', { name: 'Integrations', exact: true }).click();
  await sheet.getByLabel('Effort').selectOption('medium');
  await sheet.getByRole('button', { name: 'Save AI provider' }).click();
  await expect(sheet.getByText('Saved. The AI tab uses it from the next question.')).toBeVisible();
  expect(saved).toEqual({ key: '', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-x', effort: 'medium' });
});

test('switching provider with the key box empty asks for that provider key', async ({ page }) => {
  await page.route('**/api/vault/llm', (route) => json(route, { ok: false, error: 'new address needs its key' }));
  await page.goto('/#overview');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await sheet.getByRole('button', { name: 'Integrations', exact: true }).click();
  await sheet.getByRole('button', { name: 'Claude', exact: true }).click();
  await sheet.getByRole('button', { name: 'Save AI provider' }).click();
  await expect(sheet.getByRole('alert')).toHaveText('This is a different provider than the saved one. Paste its API key to save.');
});
