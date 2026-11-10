import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// On a DASHBOARD_TOKEN deployment the server refuses every POST/PUT/PATCH/DELETE
// to /api/ that lacks X-Auth-Token (httpx.WriteGuard -> WriteOK). The routes
// below do the same: 403 with the server's own message unless the header
// carries the token. About twenty writes used bare fetch() and never sent it,
// so on a token deployment they all failed while working fine without a token.
// ui/src/lib/authFetch.guard.test.js keeps bare writes out of the source; these
// check that the header reaches the request in a real browser.

const TOKEN = 's3cret';
const FORBIDDEN = 'forbidden — write not authorized';

type Route = import('@playwright/test').Route;
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// Answers like WriteGuard on a token deployment, and records what each write sent.
function tokenServer(seen: (string | undefined)[], ok: unknown) {
  return (route: Route) => {
    const got = route.request().headers()['x-auth-token'];
    seen.push(got);
    return got === TOKEN ? json(route, ok) : json(route, { error: FORBIDDEN }, 403);
  };
}

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
  await page.addInitScript((t) => localStorage.setItem('dashToken', t), TOKEN);
});

test('Resolve on an IQ action carries the token, so a token deployment accepts it', async ({ page }) => {
  const seen: (string | undefined)[] = [];
  await page.route('**/api/actions/**/status', (route) =>
    route.request().method() === 'POST' ? tokenServer(seen, { ok: true })(route) : route.fallback());

  await page.goto('/#incidents');
  await page.getByRole('button', { name: 'Resolve' }).first().click();

  await expect.poll(() => seen).toEqual([TOKEN]);
  await expect(page.getByText('operator required')).toHaveCount(0);
  await expect(page.getByText(/failed \(403\)/)).toHaveCount(0);
});

test('unlocking the vault carries the token, so a token deployment opens it', async ({ page }) => {
  let unlocked = false;
  const seen: (string | undefined)[] = [];
  await page.route('**/api/vault/status', (route) =>
    json(route, { vaultMode: true, exists: true, unlocked, ready: false, tenants: [] }));
  await page.route('**/api/vault/unlock', (route) => {
    const ok = route.request().headers()['x-auth-token'] === TOKEN;
    if (ok) unlocked = true;
    return tokenServer(seen, { ok: true })(route);
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Unlock vault' })).toBeVisible({ timeout: 20_000 });
  await page.locator('#vu-pass').fill('passphrase');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();

  await expect.poll(() => seen).toEqual([TOKEN]);
  await expect(page.getByText(FORBIDDEN)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Unlock vault' })).toHaveCount(0);
});

test('saving demo server settings carries the token and says Saved', async ({ page }) => {
  // DemoSettingsForm called authFetch() and then r.json() on its answer, but
  // authFetch returns {status, ok, data}, not a Response, so every save showed
  // "r.json is not a function" whatever the server said.
  const seen: (string | undefined)[] = [];
  await page.route('**/api/demo/status', (route) =>
    json(route, { settings: { pve: 'root@10.0.0.2', hasJoinToken: false }, problems: [], steps: [], runs: [], unlocked: true }));
  await page.route('**/api/vault/demo', tokenServer(seen, { ok: true, problems: [] }));

  await page.goto('/#demo');
  await page.getByRole('button', { name: 'Save settings' }).click();

  await expect.poll(() => seen).toEqual([TOKEN]);
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
});
