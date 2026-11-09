import { type Page } from '@playwright/test';
import { test, expect } from './fixtures';

// The flow redesign of 2026-10-29, corrected on 2026-10-30, and Overview made a
// service board on 2026-11-09: the app opens on the board, every open issue on
// its service's row with the charts below, the everyday jobs sit in a rail (a bottom bar on a phone), and one box
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

test('with no page named, the app opens on Overview: the service board, with the charts below it', async ({ page }) => {
  await feeds(page, {
    incidents: [
      { key: 'dns-ttl-anomaly', category: 'dns-ttl-anomaly', count: 64, severity: 'warn' },
      { key: 'subnet-utilization', category: 'subnet-utilization', count: 1746, severity: 'crit' },
    ],
    hosts: [{ name: 'a', status: 'error' }, { name: 'b', status: 'online' }],
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Overview/);
  const board = page.locator('[data-board]');
  await expect(board).toBeVisible();
  // The graphs are on the first screen, not behind a click.
  await expect(page.locator('[data-panel-id]').first()).toBeVisible();
  // Each issue sits open on its own service's row; nothing is folded.
  await expect(page.locator('[data-inbox-row]')).toHaveCount(3);
  const hosts = board.locator('[data-board-row="Hosts"] [data-inbox-row="hosts-offline"]');
  const ipam = board.locator('[data-board-row="IPAM"] [data-inbox-row="subnet-utilization"]');
  const dns = board.locator('[data-board-row="DNS"] [data-inbox-row="dns-ttl-anomaly"]');
  await expect(hosts).toContainText('Critical');
  await expect(hosts).toContainText('1 of 2 hosts is not online');
  await expect(hosts.getByRole('link', { name: 'Ask the AI: Which hosts are not online?' })).toHaveAttribute('href', '#ai?q=Which%20hosts%20are%20not%20online%3F');
  await expect(ipam).toContainText('Critical');
  await expect(ipam).toContainText('1,746 subnets are filling up');
  await expect(ipam).toContainText('3 are 90% full or more');
  await expect(dns).toContainText('Warning');
  await expect(dns).toContainText('64 zones have DNS timing problems');
  await expect(board).not.toContainText('×');
  // The sentence is the link; there is no column of buttons.
  await expect(ipam.getByRole('link', { name: '1,746 subnets are filling up' })).toHaveAttribute('href', '#network?minUtil=70&focus=subnets');
  await expect(board.locator('a.bg-accent')).toHaveCount(0);
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
  const board = page.locator('[data-board]');
  await expect(board.locator('[data-board-row="DNS"]')).toContainText('602 of 602 DNS zones not signed (DNSSEC)', { timeout: 20_000 });
  const full = board.locator('[data-board-row="IPAM"] [data-inbox-row="subnet-utilization"]');
  await expect(full).toContainText('Windows Wireless is 80% full');
  await expect(full).toContainText('none at 90% yet');
  await expect(full).not.toContainText('0 are 90% full');
});

test('unsigned public zones are a grey Note below warnings, "Ask why" shows on hover, and the board folds to one line', async ({ page }) => {
  await feeds(page, {
    incidents: [
      { key: 'dnssec-unsigned', category: 'dnssec-unsigned', count: 1, severity: 'info', message: '1 dnssec unsigned' },
      { key: 'dns-ttl-anomaly', category: 'dns-ttl-anomaly', count: 64, severity: 'warn' },
    ],
    signals: [{ category: 'dnssec-unsigned', message: '3 of 4 DNS zones with public names unsigned (DNSSEC)', severity: 'info' }],
    hosts: [{ name: 'b', status: 'online' }],
  });
  await page.goto('/');
  const dns = page.locator('[data-board] [data-board-row="DNS"] [data-inbox-row]');
  await expect(dns).toHaveCount(2, { timeout: 20_000 });
  // Owner, 2026-11-09: only public zones need signing, and even that is minor.
  await expect(dns.nth(0)).toContainText('Warning');
  await expect(dns.nth(1)).toContainText('Note: 3 of 4 DNS zones with public names not signed (DNSSEC)');

  // "Ask why" is not printed on every line: hidden until the line is hovered.
  const ask = dns.nth(1).getByRole('link', { name: /^Ask the AI:/ });
  await expect(ask).toHaveCSS('opacity', '0');
  await dns.nth(1).hover();
  await expect(ask).toHaveCSS('opacity', '1');

  // The board folds to a one-line count, and stays folded after a reload.
  const toggle = page.getByRole('button', { name: 'Hide' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(page.locator('[data-board]')).toBeHidden();
  await expect(page.locator('[data-board-summary]')).toHaveText('DNS 1 warning, 1 note');
  await page.reload();
  await expect(page.locator('[data-board-summary]')).toHaveText('DNS 1 warning, 1 note', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Show' }).click();
  await expect(page.locator('[data-board]')).toBeVisible();
});

test('a quiet day says "none open" on every service row', async ({ page }) => {
  await feeds(page, { incidents: [], hosts: [{ name: 'b', status: 'online' }] });
  await page.goto('/');
  for (const name of ['DNS', 'DHCP', 'IPAM', 'Hosts', 'Security']) {
    await expect(page.locator(`[data-board] [data-board-row="${name}"]`)).toContainText('none open', { timeout: 20_000 });
  }
  await expect(page.locator('[data-inbox-row]')).toHaveCount(0);
  await expect(page.locator('[data-board] [data-board-row="Other"]')).toHaveCount(0);
});

test('the box looks up an address, and asks the AI a question once', async ({ page }) => {
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
  // Asked straight away, then the q leaves the address so a reload doesn't ask again.
  await expect(page.getByRole('log')).toContainText('Which hosts are offline?');
  await expect.poll(() => asked).toBe(1);
  await expect(page).toHaveURL(/#ai$/);
  await page.reload();
  await page.waitForTimeout(500);
  expect(asked).toBe(1);
});

test('the rail holds the five everyday jobs and marks where you are', async ({ page }) => {
  await feeds(page, {});
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#selfservice');
  const rail = page.locator('[data-job-rail]');
  await expect(rail.getByRole('link')).toHaveText(['Overview', 'Get an address', 'Automate', 'Daily report', 'Charts']);
  await expect(rail.getByRole('link', { name: 'Get an address' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('header').getByRole('link', { name: /Provision/ })).toHaveCount(0);
});

test('on a phone the jobs are a bar along the bottom, and All pages reaches every page', async ({ page }) => {
  await feeds(page, {});
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const bar = page.locator('[data-job-bar]');
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('link')).toHaveText(['Overview', 'Get an address', 'Automate', 'Daily report', 'Charts']);
  await expect(page.locator('[data-job-rail]')).toBeHidden();
  await page.getByRole('button', { name: 'All pages' }).click();
  await expect(page.getByRole('menuitem')).toHaveCount(19);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
});

test('See full subnets lands on the subnet table, not the charts above it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto('/#network?minUtil=90&focus=subnets');
  await expect(page.locator('[data-panel-id="network-exhaustion"]')).toBeInViewport();
});

test('while security events are still loading, the Security row does not say "none open"', async ({ page }) => {
  await feeds(page, { incidents: [], hosts: [{ name: 'b', status: 'online' }] });
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.unroute('**/api/hub/security*');
  await page.route('**/api/hub/security*', async (r) => {
    await held;
    await r.fulfill(json({ availability: 'ok', counts: { critical: 0, high: 0 } }));
  });
  await page.goto('/');
  const sec = page.locator('[data-board] [data-board-row="Security"]');
  await expect(sec).toContainText('Checking…');
  await page.waitForTimeout(500);
  await expect(sec).not.toContainText('none open');
  release();
  await expect(sec).toContainText('none open');
});

test('a second question from the header box while on the AI page is asked too', async ({ page }) => {
  await feeds(page, {});
  const asked: string[] = [];
  await page.route('**/api/query', (r) => { asked.push(r.request().postDataJSON().question); return r.fulfill(json({ answer: 'x' })); });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#ai?q=' + encodeURIComponent('Which hosts are offline?'));
  await expect.poll(() => asked).toEqual(['Which hosts are offline?']);
  const box = page.locator('header [data-onebox]');
  await box.fill('why are my subnets full?');
  await box.press('Enter');
  await expect.poll(() => asked).toEqual(['Which hosts are offline?', 'why are my subnets full?']);
});
