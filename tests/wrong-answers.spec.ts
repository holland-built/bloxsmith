import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { dataPayload, installBaselineWorld } from './page-fixtures';

// Seven places where the screen said something the data did not. Each was found
// by reading the code in the 2026-10-03 review, confirmed, and fixed; each test
// here fails on the commit before the fix.
//
//   1. A status with a healthy word INSIDE another word was painted green:
//      "Setup failed" (up), "Inactive" (active), "Unsuccessful" (success).
//   2. Daily's capacity list showed a subnet nobody measured as 0% used with 0
//      free: the top of a list ranked by least free space, under a Healthy pill.
//   3. The portal audit table painted a row with no result green.
//   4. A supplier with no credential count blanked the whole Security tab.
//   5. Addresses sorted as text: 10.1.2.10 before 10.1.2.9.
//   6. Infra's heading carried a green "Operational" pill that only knew
//      maintenance mode was off; it said so beside offline hosts.
//   7. Provision painted the role badge in status colours, so a viewer was
//      shown in the red this app uses for a failure.

const fulfillJson = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

// The colour a token resolves to on this page, read the way the cell reads it.
async function tokenColour(page: Page, token: string, prop: 'backgroundColor' | 'color' = 'backgroundColor') {
  return page.evaluate(
    ([t, p]) => {
      const probe = document.createElement('span');
      probe.style[p as 'color'] = `var(${t})`;
      document.body.appendChild(probe);
      const c = getComputedStyle(probe)[p as 'color'];
      probe.remove();
      return c;
    },
    [token, prop],
  );
}

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

test('a status that merely contains a healthy word is not painted green', async ({ page }) => {
  const payload = structuredClone(dataPayload()) as { hosts: Array<Record<string, string>> };
  payload.hosts = [
    { id: 'h1', ip: '10.0.0.1', name: 'host-setup', status: 'Setup failed', type: 'onprem' },
    { id: 'h2', ip: '10.0.0.2', name: 'host-inactive', status: 'Inactive', type: 'onprem' },
    { id: 'h3', ip: '10.0.0.3', name: 'host-online', status: 'online', type: 'onprem' },
  ];
  await page.route('**/api/data', (route) => fulfillJson(route, payload));
  await page.goto('/#infra');

  const inventory = page.locator('[data-panel-id="infra-host-inventory"]');
  const pill = (text: string) => inventory.getByText(text, { exact: true });
  await expect(pill('Setup failed')).toBeVisible({ timeout: 20_000 });

  const bg = (text: string) => pill(text).evaluate((el) => getComputedStyle(el).backgroundColor);
  const crit = await tokenColour(page, '--pill-crit-bg');
  const ok = await tokenColour(page, '--pill-ok-bg');
  const neutral = await tokenColour(page, '--pill-neutral-bg');
  // Guard the comparison itself: three tokens that resolved to one colour would
  // make every assertion below pass against anything.
  expect(new Set([crit, ok, neutral]).size).toBe(3);

  expect(await bg('Setup failed'), '"Setup failed" is a failure').toBe(crit);
  expect(await bg('Inactive'), '"Inactive" is not a claim of health').toBe(neutral);
  expect(await bg('online'), 'a plain healthy status keeps its colour').toBe(ok);
});

test('Daily: a subnet nobody measured is Unknown and last, not 0% and first', async ({ page }) => {
  const payload = structuredClone(dataPayload()) as { subnets: Array<Record<string, unknown>> };
  payload.subnets = [
    { id: 's-unmeasured', addr: '10.99.0.0', cidr: 24, name: 'not-measured', site: 'baseline-site', total: null, used: null, util: null },
    { id: 's-tight', addr: '10.30.0.0', cidr: 24, name: 'tight', site: 'baseline-site', total: 254, used: 249, util: 98 },
    { id: 's-roomy', addr: '10.10.0.0', cidr: 24, name: 'roomy', site: 'baseline-site', total: 254, used: 25, util: 10 },
  ];
  await page.route('**/api/data', (route) => fulfillJson(route, payload));
  await page.goto('/#daily');

  const panel = page.locator('[data-panel-id="daily-top-capacity-risks"]');
  const rows = panel.locator('tbody tr');
  await expect(rows).toHaveCount(3, { timeout: 20_000 });
  // Least free space first: 5 free, then 229, and the one with no figure last.
  await expect(rows.nth(0)).toContainText('10.30.0.0');
  await expect(rows.nth(1)).toContainText('10.10.0.0');
  await expect(rows.nth(2)).toContainText('10.99.0.0');
  await expect(rows.nth(2)).toContainText('Unknown');
  await expect(rows.nth(2)).toContainText('—');
  await expect(rows.nth(2).getByText('0%', { exact: true })).toHaveCount(0);
});

test('Audit: a portal row with no result is not painted as a success', async ({ page }) => {
  const row = (over: Record<string, string>) => ({
    action: 'UPDATE', resource: 'addressservice', result: 'success', user: 'actor', who_kind: 'user', who_role: 'admin',
    ts: '2026-01-01T10:00:00Z', ...over,
  });
  await page.route('**/api/csp-audit*', (route) =>
    fulfillJson(route, {
      status: 'ok', truncated: false, count: 2,
      rows: [row({ id: 'r-ok', resource: 'res-with-result' }), row({ id: 'r-none', resource: 'res-without-result', result: '' })],
    }),
  );
  await page.goto('/#audit');

  const table = page.locator('[data-panel-id="audit-csp-portal"]');
  const resultCell = (resource: string) => table.locator('tr', { hasText: resource }).locator('td').last().locator('span').first();
  await expect(resultCell('res-with-result')).toHaveText('success', { timeout: 20_000 });
  await expect(resultCell('res-without-result')).toHaveText('—');

  const ok = await tokenColour(page, '--color-ok', 'color');
  const colour = (resource: string) => resultCell(resource).evaluate((el) => getComputedStyle(el).color);
  expect(await colour('res-with-result')).toBe(ok);
  expect(await colour('res-without-result'), 'a missing result must not be the success colour').not.toBe(ok);
});

test('Security: a supplier with no credential count shows a dash and the tab still renders', async ({ page }) => {
  await page.route('**/api/axur*', (route) =>
    fulfillJson(route, {
      configured: true, customer: 'BASELINE', total_credentials: 7, not_entitled: false,
      vendors: [
        { name: 'supplier-counted', asset_key: 'A', credentials: 7, types_affected: 3 },
        { name: 'supplier-uncounted', asset_key: 'B', types_affected: 1 },
      ],
    }),
  );
  await page.goto('/#security');

  const panel = page.locator('[data-panel-id]').filter({ has: page.getByRole('heading', { name: 'Axur Supplier Risk' }) });
  const uncounted = panel.locator('tr', { hasText: 'supplier-uncounted' });
  await expect(uncounted).toBeVisible({ timeout: 20_000 });
  await expect(uncounted).toContainText('—');
  await expect(panel.locator('tr', { hasText: 'supplier-counted' })).toContainText('7');
  // The tab is still there: the throw used to replace all of it with the
  // "This tab could not load" box.
  await expect(page.getByText('This tab could not load')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Security', level: 1 })).toBeVisible();
});

test('addresses sort by their numbers when the Network heading is clicked', async ({ page }) => {
  const payload = structuredClone(dataPayload()) as { subnets: Array<Record<string, unknown>>; _totals: Record<string, unknown> };
  const mk = (addr: string, util: number) => ({ id: `s-${addr}`, addr, cidr: 24, name: addr, site: 'baseline-site', total: 254, used: Math.round((254 * util) / 100), util });
  // Four addresses that differ only in a last part of one, two and three
  // digits, because that is where a text compare goes wrong: it reads .100
  // before .20 and .9 after both. Their text order and its reverse are both
  // different from counting order and ITS reverse, so no direction of the old
  // sort can pass by accident. The utilisations make the table's default
  // order (fullest first) a fifth order again, so "nothing happened" fails too.
  payload.subnets = [mk('10.1.2.10', 20), mk('10.1.2.9', 40), mk('10.1.2.100', 10), mk('10.1.2.20', 30)];
  payload._totals = { ...payload._totals, subnets: 4, subnetsCrit: 0, subnetsWarn: 0 };
  await page.route('**/api/data', (route) => fulfillJson(route, payload));
  // The Network tab's subnet table, whose sort went through the shared text
  // compare. (Overview's and Infra's address columns had comparators of their
  // own and were already right.)
  await page.goto('/#network');

  const table = page.locator('[data-panel-id="network-exhaustion"]');
  await expect(table.locator('tbody tr')).toHaveCount(4, { timeout: 20_000 });
  const firstColumn = async () => (await table.locator('tbody tr td:first-child').allInnerTexts()).map((t) => t.trim().split('/')[0]);
  expect(await firstColumn()).toEqual(['10.1.2.9', '10.1.2.20', '10.1.2.10', '10.1.2.100']);
  await table.locator('th').getByRole('button', { name: /Network/ }).click();
  const order = await firstColumn();
  // Either direction is fine for the first click; what must hold is that the
  // order is numeric, so 10.1.2.9 and 10.1.2.10 are neighbours in counting order.
  const numeric = ['10.1.2.9', '10.1.2.10', '10.1.2.20', '10.1.2.100'];
  expect([numeric, [...numeric].reverse()]).toContainEqual(order);
});

test('Infra: maintenance being off is not reported as "Operational"', async ({ page }) => {
  // The baseline estate has one degraded and one offline host, and maintenance
  // is off. The absence below only counts once the maintenance read has landed
  // and been drawn: checked sooner, "not there" is also true of a pill that has
  // not rendered yet, and the test would pass on the old code. So wait for the
  // BODY (waitForResponse resolves on the headers), then two frames for React
  // to draw what it was handed. Run three times against v3.87.0: failed three
  // times.
  const answered = page.waitForResponse('**/api/csp/maintenance');
  await page.goto('/#infra');
  await (await answered).finished();
  await expect(page.getByRole('button', { name: 'Offline 1' })).toBeVisible({ timeout: 20_000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  await expect(page.getByText('Operational', { exact: true })).toHaveCount(0);
});

test('Infra: maintenance being on is still said', async ({ page }) => {
  await page.route('**/api/csp/maintenance', (route) => fulfillJson(route, { status: 'ok', enabled: true }));
  await page.goto('/#infra');
  await expect(page.getByText('Maintenance ON', { exact: true })).toBeVisible({ timeout: 20_000 });
});

for (const role of ['viewer', 'operator', 'admin']) {
  test(`Provision: the ${role} role badge is neutral, not a status colour`, async ({ page }) => {
    await page.route('**/api/whoami*', (route) =>
      fulfillJson(route, { actor: 'baseline', role, tenant: 'baseline-tenant', token_auth: false }),
    );
    await page.goto('/#provision');
    const badge = page.getByText(role.toUpperCase(), { exact: true });
    await expect(badge).toBeVisible({ timeout: 20_000 });

    const neutral = await tokenColour(page, '--pill-neutral-bg');
    const statuses = await Promise.all(
      ['--pill-ok-bg', '--pill-warn-bg', '--pill-crit-bg'].map((t) => tokenColour(page, t)),
    );
    // Guard the comparison: a neutral that resolved to one of the status
    // colours would make the assertion below pass against the old badge.
    expect(statuses).not.toContain(neutral);

    await expect.poll(() => badge.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(neutral);
    expect(await badge.evaluate((el) => getComputedStyle(el).color)).toBe(await tokenColour(page, '--pill-neutral-fg', 'color'));
  });
}
