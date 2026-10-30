import { test, expect, type Page } from '@playwright/test';

// The flow redesign of 2026-10-29, corrected on 2026-10-30: the app opens on
// Overview's graphs, with a short "Needs a look" strip above them (a NOC screen
// has to show the graphs without a click), the everyday jobs sit in a rail (a bottom bar on a phone), and one box
// takes both lookups and questions. Measured before: 2 clicks and 1,814 rows to
// see what was wrong; the main button opened the admin subnet builder.

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function feeds(page: Page, { incidents, hosts, sec, signals }: { incidents?: unknown[] | null; hosts?: unknown[]; sec?: unknown; signals?: unknown[] }) {
  await page.route('**/api/incidents', (r) =>
    incidents === null ? r.fulfill({ status: 500, body: 'boom' }) : r.fulfill(json({ incidents: incidents ?? [], signals: signals ?? [] })),
  );
  await page.route('**/api/hub/security*', (r) => r.fulfill(json(sec ?? { availability: 'ok', counts: { critical: 0, high: 0 } })));
  await page.route('**/api/data', (r) =>
    r.fulfill(json({ _meta: { hosts: 'ok' }, _totals: { hosts: (hosts ?? []).length, subnets: 10, subnetsCrit: 3, subnetsWarn: 5 }, hosts: hosts ?? [] })),
  );
}

test('with no page named, the app opens on Overview: the graphs, with Needs a look above them', async ({ page }) => {
  await feeds(page, {
    incidents: [
      { key: 'dns-ttl-anomaly', category: 'dns-ttl-anomaly', count: 64, severity: 'warn' },
      { key: 'subnet-utilization', category: 'subnet-utilization', count: 1746, severity: 'crit' },
    ],
    hosts: [{ name: 'a', status: 'error' }, { name: 'b', status: 'online' }],
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Overview/);
  await expect(page.getByRole('heading', { name: /^Needs a look/ })).toBeVisible();
  // The graphs are on the first screen, not behind a click.
  await expect(page.locator('[data-panel-id]').first()).toBeVisible();
  const rows = page.locator('[data-inbox-row]');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('1 of 2 hosts is offline');
  await expect(rows.nth(1)).toContainText('1,746 subnets are filling up');
  await expect(rows.nth(1)).toContainText('3 are 90% full or more');
  await expect(rows.nth(2)).toContainText('64 zones have DNS timing problems');
  await expect(page.locator('[data-needs-a-look]')).not.toContainText('×');
  // The sentence is the link; there is no column of buttons.
  await expect(rows.nth(1).getByRole('link', { name: '1,746 subnets are filling up' })).toHaveAttribute('href', '#network?minUtil=90&focus=subnets');
  await expect(page.locator('[data-needs-a-look] a.bg-accent')).toHaveCount(0);
  await expect(rows.nth(0).getByRole('link', { name: /Ask the AI: Which hosts are offline/ })).toHaveAttribute('href', '#ai?q=Which%20hosts%20are%20offline%3F');
});

test('an incident made of one finding says the finding itself, not "1 ×"', async ({ page }) => {
  await feeds(page, {
    incidents: [
      { key: 'dnssec-unsigned', category: 'dnssec-unsigned', count: 1, severity: 'warn', message: '1 dnssec unsigned' },
      { key: 'subnet-utilization', category: 'subnet-utilization', count: 1, severity: 'warn', message: '1 subnet utilization' },
    ],
    signals: [
      { category: 'dnssec-unsigned', message: '602 of 602 DNS zones unsigned (DNSSEC)', severity: 'warn' },
      { category: 'subnet-utilization', message: 'Windows Wireless at 80% utilization', severity: 'warn' },
    ],
    hosts: [{ name: 'b', status: 'online' }],
  });
  await page.route('**/api/data', (r) =>
    r.fulfill(json({ _meta: { hosts: 'ok' }, _totals: { hosts: 1, subnets: 10, subnetsCrit: 0, subnetsWarn: 1 }, hosts: [{ name: 'b', status: 'online' }] })),
  );
  await page.goto('/');
  const box = page.locator('[data-needs-a-look]');
  await expect(box).toContainText('602 of 602 DNS zones not signed (DNSSEC)');
  await expect(box).toContainText('Windows Wireless is 80% full');
  await expect(box).toContainText('none at 90% yet');
  await expect(box).not.toContainText('0 are 90% full');
});

test('a quiet day says so in one line', async ({ page }) => {
  await feeds(page, { incidents: [], hosts: [{ name: 'b', status: 'online' }] });
  await page.goto('/');
  await expect(page.locator('[data-needs-a-look]')).toContainText('nothing right now');
  await expect(page.locator('[data-inbox-row]')).toHaveCount(0);
});

test('a feed that fails is named, never read as nothing wrong', async ({ page }) => {
  await feeds(page, { incidents: null, hosts: [{ name: 'b', status: 'online' }] });
  await page.goto('/');
  await expect(page.getByText(/Couldn't check incidents/)).toBeVisible();
  await expect(page.locator('[data-needs-a-look]')).not.toContainText('nothing right now');
});

test('the box looks up an address, and sends a question to the AI typed in but not sent', async ({ page }) => {
  await feeds(page, {});
  let asked = 0;
  await page.route('**/api/query', (r) => { asked++; return r.fulfill(json({ answer: 'x' })); });
  await page.goto('/');
  const box = page.locator('[data-onebox]');
  await box.fill('10.80.0.5');
  await expect(page.getByText('Enter: Look it up')).toBeVisible();
  await box.press('Enter');
  await expect(page).toHaveURL(/#dossier\?q=10\.80\.0\.5$/);

  await page.goto('/#overview');
  await page.locator('[data-onebox]').fill('Which hosts are offline?');
  await page.locator('[data-onebox]').press('Enter');
  await expect(page).toHaveURL(/#ai\?q=/);
  await expect(page.getByPlaceholder('Ask about your network…')).toHaveValue('Which hosts are offline?');
  expect(asked).toBe(0);
});

test('the rail holds the four everyday jobs and marks where you are', async ({ page }) => {
  await feeds(page, {});
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#selfservice');
  const rail = page.locator('[data-job-rail]');
  await expect(rail.getByRole('link')).toHaveText(['Overview', 'Get an address', 'Daily report', 'Charts']);
  await expect(rail.getByRole('link', { name: 'Get an address' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('header').getByRole('link', { name: /Provision/ })).toHaveCount(0);
});

test('on a phone the jobs are a bar along the bottom, and All pages reaches every page', async ({ page }) => {
  await feeds(page, {});
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const bar = page.locator('[data-job-bar]');
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('link')).toHaveText(['Overview', 'Get an address', 'Daily report', 'Charts']);
  await expect(page.locator('[data-job-rail]')).toBeHidden();
  await page.getByRole('button', { name: 'All pages' }).click();
  await expect(page.getByRole('menuitem')).toHaveCount(17);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
});

test('See full subnets lands on the subnet table, not the charts above it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto('/#network?minUtil=90&focus=subnets');
  await expect(page.locator('[data-panel-id="network-exhaustion"]')).toBeInViewport();
});

test('while security events are still loading, Needs a look does not say nothing', async ({ page }) => {
  await feeds(page, { incidents: [], hosts: [{ name: 'b', status: 'online' }] });
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.unroute('**/api/hub/security*');
  await page.route('**/api/hub/security*', async (r) => {
    await held;
    await r.fulfill(json({ availability: 'ok', counts: { critical: 0, high: 0 } }));
  });
  await page.goto('/');
  const strip = page.locator('[data-needs-a-look]');
  await expect(strip).toContainText('Checking…');
  await page.waitForTimeout(500);
  await expect(strip).not.toContainText('nothing right now');
  release();
  await expect(strip).toContainText('nothing right now');
});

test('a second question from the header box replaces the first in the AI box', async ({ page }) => {
  await feeds(page, {});
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#ai?q=' + encodeURIComponent('Which hosts are offline?'));
  const ask = page.getByRole('textbox', { name: 'Ask about your network' });
  await expect(ask).toHaveValue('Which hosts are offline?');
  const box = page.locator('header [data-onebox]');
  await box.fill('why are my subnets full?');
  await box.press('Enter');
  await expect(ask).toHaveValue('why are my subnets full?');
});
