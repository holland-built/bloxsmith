import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The setup checklist after the first Infoblox key: optional AI, demo server,
// logo and templates steps over a dashboard that already works. PLAN.md lists
// what "done" means; each test below is one of those lines.

type Page = import('@playwright/test').Page;

const json = (route: import('@playwright/test').Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const STATUS = {
  vaultMode: true, exists: true, unlocked: true, ready: true, active: 'baseline-tenant',
  tenants: [{ id: 'baseline-tenant', label: 'Baseline Tenant' }],
  llm: { base_url: '', hasKey: false, model: '' },
  inContainer: false,
};

async function world(page: Page, status: Record<string, unknown> = {}) {
  await installBaselineWorld(page);
  await page.route('**/api/vault/status', (r) => json(r, { ...STATUS, ...status }));
  await page.route('**/api/demo/status', (r) => json(r, { settings: { hasJoinToken: false }, problems: ['Set the Proxmox login'], steps: [], runs: [] }));
  await page.route('**/api/brand', (r) => json(r, { domain: '', name: '' }));
  await page.route('**/api/templates', (r) => json(r, [
    { name: 'amer/lab/site-amer-lab.yaml', type: 'site' },
    { name: 'emea/lab/site-emea-lab.yaml', type: 'site' },
  ]));
}

// What VaultGate sends after the first key; Settings is the other way in.
async function openChecklist(page: Page) {
  await page.goto('/#overview');
  await expect(page.locator('main h1')).toHaveText('Overview', { timeout: 20_000 });
  await page.evaluate(() => window.dispatchEvent(new Event('bx:open-setup')));
}

const checklist = (page: Page) => page.getByRole('dialog', { name: 'Finish setting up' });
const item = (page: Page, id: string) => page.locator(`[data-setup-item="${id}"]`);

test('1. passphrase, key, then the dashboard straight away, with the checklist on top', async ({ page }) => {
  let ready = false;
  await world(page);
  await page.route('**/api/vault/status', (r) => json(r, { ...STATUS, ready, tenants: ready ? STATUS.tenants : [] }));
  await page.route('**/api/vault/tenant', (r) => { ready = true; return json(r, { ok: true }); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Add your first connection' })).toBeVisible({ timeout: 20_000 });
  // The Groq box is gone: the AI step replaces it.
  await expect(page.locator('#vat-groq')).toHaveCount(0);
  await page.locator('#vat-key').fill('a-key');
  await page.getByRole('button', { name: 'Add connection' }).click();
  await expect(checklist(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('main h1')).toHaveText('Overview');
});

test('2. every item can be skipped, Finish closes it with items left, and it does not come back on reload', async ({ page }) => {
  await world(page);
  await openChecklist(page);
  await expect(checklist(page)).toBeVisible({ timeout: 20_000 });
  for (const id of ['ai', 'demo', 'brand']) {
    await item(page, id).getByRole('button', { name: /Set up|Change/ }).click();
    await item(page, id).getByRole('button', { name: 'Do this later' }).click();
    await expect(item(page, id).getByRole('button', { name: /Set up|Change/ })).toBeVisible();
  }
  // Templates have nothing to set up, only something to read.
  await item(page, 'templates').getByRole('button', { name: 'Details' }).click();
  await expect(item(page, 'templates')).toContainText('Templates come with each release');
  await item(page, 'templates').getByRole('button', { name: 'Hide' }).click();
  await expect(item(page, 'ai').locator('[data-setup-state]')).toHaveText('Not set up yet');
  await checklist(page).getByRole('button', { name: 'Finish' }).click();
  await expect(checklist(page)).toHaveCount(0);
  // Nothing is stored to reopen it: a reload opens the dashboard alone.
  await page.reload();
  await expect(page.locator('main h1')).toHaveText('Overview', { timeout: 20_000 });
  await expect(checklist(page)).toHaveCount(0);
});

test('3. Settings > Setup checklist reopens it, showing what is already set', async ({ page }) => {
  await world(page, { llm: { base_url: '', hasKey: true, model: '' } });
  await page.goto('/#overview');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Setup checklist' }).click();
  await expect(checklist(page)).toBeVisible({ timeout: 20_000 });
  await expect(item(page, 'ai').locator('[data-setup-state]')).toHaveText('✓ An AI provider is saved');
  await expect(item(page, 'templates').locator('[data-setup-state]')).toHaveText('✓ 2 site templates installed: amer, emea');
  await expect(item(page, 'demo').locator('[data-setup-state]')).toHaveText('Not set up yet');
});

test('4. in Docker the demo server item says it needs the desktop app', async ({ page }) => {
  await world(page, { inContainer: true });
  await openChecklist(page);
  await item(page, 'demo').getByRole('button', { name: 'Set up' }).click();
  await expect(item(page, 'demo').locator('[data-setup-docker]')).toContainText('needs the desktop version');
  await expect(item(page, 'demo').getByText('Proxmox SSH login')).toHaveCount(0);
});

test('5. a provider button fills in the address and model, and Test sends exactly those', async ({ page }) => {
  await world(page);
  let sent: Record<string, string> | null = null;
  await page.route('**/api/vault/llm-test', (r) => { sent = r.request().postDataJSON(); return json(r, { ok: true, model: 'gemini-3.5-flash-lite' }); });
  await openChecklist(page);
  await item(page, 'ai').getByRole('button', { name: 'Set up' }).click();
  await item(page, 'ai').getByRole('button', { name: 'Gemini' }).click();
  await expect(page.locator('#setup-ai-base')).toHaveValue('https://generativelanguage.googleapis.com/v1beta/openai');
  await expect(page.locator('#setup-ai-model')).toHaveValue('gemini-3.5-flash-lite');
  // Save stays off until a key is typed, so it can never blank a saved key.
  await expect(item(page, 'ai').getByRole('button', { name: 'Save AI provider' })).toBeDisabled();
  await page.locator('#setup-ai-key').fill('k');
  await item(page, 'ai').getByRole('button', { name: 'Test' }).click();
  await expect(item(page, 'ai').getByRole('status')).toContainText('It answered');
  expect(sent).toEqual({ key: 'k', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.5-flash-lite' });
});

test('5b. the Ollama button points at the host when the app runs in a container', async ({ page }) => {
  await world(page, { inContainer: true });
  await openChecklist(page);
  await item(page, 'ai').getByRole('button', { name: 'Set up' }).click();
  await item(page, 'ai').getByRole('button', { name: /Ollama/ }).click();
  await expect(page.locator('#setup-ai-base')).toHaveValue('http://host.docker.internal:11434/v1');
});

test('5c. after Save the AI item shows it is set, without reopening the checklist', async ({ page }) => {
  let saved = false;
  await world(page);
  await page.route('**/api/vault/status', (r) => json(r, { ...STATUS, llm: { base_url: '', hasKey: saved, model: '' } }));
  await page.route('**/api/vault/llm', (r) => { saved = true; return json(r, { ok: true }); });
  await openChecklist(page);
  await item(page, 'ai').getByRole('button', { name: 'Set up' }).click();
  await page.locator('#setup-ai-key').fill('k');
  await item(page, 'ai').getByRole('button', { name: 'Save AI provider' }).click();
  await expect(item(page, 'ai').locator('[data-setup-state]')).toHaveText('✓ An AI provider is saved');
});
