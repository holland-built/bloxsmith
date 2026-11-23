import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { FIXED_NOW, installBaselineWorld } from './page-fixtures';

// What the morning briefing may say to a customer. Each test sets up a state
// where a careless summary would overstate the result: a headline that misses
// an open incident, "None" over unknown history, or an unknown outcome called
// a failure.

const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const nowS = FIXED_NOW.getTime() / 1000;
const DAY = 86400;
const agoIso = (minutes: number) => new Date(FIXED_NOW.getTime() - minutes * 60000).toISOString();
const verdict = (page: Page) => page.locator('[data-verdict]');
const fact = (page: Page, label: string) => page.locator('.br-fact', { hasText: label });
const incident = (key: string, severity: string, seen: number | undefined) => ({ key, category: key, severity, count: 2, message: `${key} incident`, first_detected_at: seen });
const HEALTHY = [
  { name: 'DNS', status: 'ok', meta: '2/2 up', availability: 'ok' },
  { name: 'DHCP', status: 'ok', meta: '2/2 up', availability: 'ok' },
  { name: 'Security', status: 'ok', meta: '2/2 up', availability: 'ok' },
];

// Every service healthy and every feed read, with only the given incidents open.
async function healthyWorld(page: Page, incidents: unknown[]) {
  await installBaselineWorld(page);
  await page.route('**/api/hub/health*', (r) => json(r, HEALTHY));
  await page.route('**/api/hub/security*', (r) => json(r, { availability: 'ok', counts: { critical: 0, high: 0 } }));
  await page.route('**/api/incidents', (r) => json(r, { incidents, signals: [] }));
  await page.route('**/api/data', (r) => json(r, {
    _meta: { hosts: 'ok', subnets: 'ok', leases: 'ok' },
    _totals: { hosts: 1, subnets: 10, subnetsCrit: 0, subnetsWarn: 0 },
    hosts: [{ name: 'host-a', status: 'online' }], subnets: [], leases: [],
  }));
}

test('a critical incident outside the five services still sets the headline', async ({ page }) => {
  await healthyWorld(page, [incident('capacity', 'crit', nowS - 3 * DAY)]);
  await page.goto('/#overview');
  await expect(page.locator('[data-problem="capacity"]')).toBeVisible({ timeout: 20_000 });
  await expect(verdict(page)).toHaveText('Action required');
});

test('a warning incident outside the five services asks for review', async ({ page }) => {
  await healthyWorld(page, [incident('capacity', 'warn', nowS - 3 * DAY)]);
  await page.goto('/#overview');
  await expect(page.locator('[data-problem="capacity"]')).toBeVisible({ timeout: 20_000 });
  await expect(verdict(page)).toHaveText('Review recommended');
});

test('"None" is said when every source was read and every open problem has a date', async ({ page }) => {
  await healthyWorld(page, [incident('dns-ttl-anomaly', 'warn', nowS - 3 * DAY)]);
  await page.goto('/#overview');
  await expect(fact(page, 'New issues')).toContainText('None in the last 24 hours', { timeout: 20_000 });
});

test('an undated health-check problem stops "None" being claimed', async ({ page }) => {
  await healthyWorld(page, [incident('dns-ttl-anomaly', 'warn', nowS - 3 * DAY)]);
  await page.route('**/api/hub/health*', (r) => json(r, [HEALTHY[0], { name: 'DHCP', status: 'crit', statusLabel: 'critical', meta: '1 error · 1/2 up', availability: 'ok' }, HEALTHY[2]]));
  await page.goto('/#overview');
  await expect(page.locator('[data-problem="svc-DHCP"]')).toBeVisible({ timeout: 20_000 });
  await expect(fact(page, 'New issues')).toContainText('dated issues');
  await expect(fact(page, 'New issues')).not.toContainText('None in the last 24 hours');
});

test('a source that failed stops "None" being claimed', async ({ page }) => {
  await healthyWorld(page, [incident('dns-ttl-anomaly', 'warn', nowS - 3 * DAY)]);
  await page.route('**/api/hub/security*', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"down"}' }));
  await page.goto('/#overview');
  await expect(page.locator('[data-problem="dns-ttl-anomaly"]')).toBeVisible({ timeout: 20_000 });
  await expect(fact(page, 'New issues')).toContainText('Not yet available');
  await expect(fact(page, 'New issues')).not.toContainText('None in the last 24 hours');
});

test('an unknown change outcome is never called failed', async ({ page }) => {
  await healthyWorld(page, []);
  const row = (id: number, result: unknown) => ({ id: `r${id}`, ts: agoIso(10 + id), user: 'admin@example.com', who_kind: 'person', action: 'update', resource: 'dns/zone', result });
  await page.route('**/api/csp-audit*', (r) => json(r, { status: 'ok', truncated: false, count: 6, rows: [row(1, 'success'), row(2, 'failure'), row(3, 'failure'), row(4, 'failure'), row(5, ''), row(6, undefined)] }));
  await page.goto('/#overview');
  await expect(fact(page, 'Changes')).toContainText('6 changes, 6 by users, 3 failed, 2 with no result reported', { timeout: 20_000 });
});

test('a capped change log states the period it covers, never a full day', async ({ page }) => {
  await healthyWorld(page, []);
  const rows = [5, 45].map((m, i) => ({ id: `r${i}`, ts: agoIso(m), user: 'admin@example.com', who_kind: 'person', action: 'update', resource: 'dns/zone', result: 'success' }));
  await page.route('**/api/csp-audit*', (r) => json(r, { status: 'ok', truncated: true, count: 500, rows }));
  await page.goto('/#overview');
  await expect(fact(page, 'Changes').locator('.br-label')).toContainText('Changes (last 45 min only)', { timeout: 20_000 });
  await expect(fact(page, 'Changes').locator('> span:last-child')).toHaveText('2 changes, 2 by users');
  await expect(fact(page, 'Changes').locator('.br-label')).not.toContainText('Changes (last 24 hours)');
});

test('a capped change log with no usable dates does not say nothing changed', async ({ page }) => {
  await healthyWorld(page, []);
  await page.route('**/api/csp-audit*', (r) => json(r, { status: 'ok', truncated: true, count: 500, rows: [{ id: 'r1', ts: 'not a date', result: 'success' }] }));
  await page.goto('/#overview');
  await expect(fact(page, 'Changes').locator('> span:last-child')).toHaveText('Period covered could not be determined', { timeout: 20_000 });
});

// ---------- the server's own "no answer" values (normAudit, FetchHubHealth) ----------

const auditRow = (id: number, result: string) => ({ id: `a${id}`, ts: agoIso(10 + id), user: 'admin@example.com', who_kind: 'person', who_role: '', action: 'UPDATE', resource: 'dns/zone', result });
const partialRow = (name: string, status = 'ok', meta = '2/2 online') => ({ name, status, statusLabel: status === 'ok' ? 'healthy' : 'critical', meta, availability: 'partial', reason: 'service inventory truncated at the 500-row limit' });
const errorRows = () => ['DNS', 'DHCP', 'Security'].map((name) => ({ name, status: 'error', statusLabel: 'unavailable', meta: 'information unavailable', availability: 'error', reason: 'Service inventory information is unavailable' }));
const oldIncident = () => incident('dns-ttl-anomaly', 'warn', nowS - 3 * DAY);

test('the server\'s literal "unknown" result is no result reported, never failed', async ({ page }) => {
  await healthyWorld(page, []);
  await page.route('**/api/csp-audit*', (r) => json(r, { status: 'ok', truncated: false, count: 5, rows: [auditRow(1, 'success'), auditRow(2, 'failure'), auditRow(3, 'failure'), auditRow(4, 'unknown'), auditRow(5, 'unknown')] }));
  await page.goto('/#overview');
  await expect(fact(page, 'Changes').locator('> span:last-child')).toHaveText('5 changes, 5 by users, 2 failed, 2 with no result reported', { timeout: 20_000 });
});

test('health rows with availability "error" stop "None" being claimed', async ({ page }) => {
  await healthyWorld(page, [oldIncident()]);
  await page.route('**/api/hub/health*', (r) => json(r, errorRows()));
  await page.goto('/#overview');
  await expect(page.locator('[data-problem="dns-ttl-anomaly"]')).toBeVisible({ timeout: 20_000 });
  await expect(fact(page, 'New issues').locator('> span:last-child')).toHaveText('Not yet available. Some sources could not be read.');
});

test('a partial service list never reads as all services healthy', async ({ page }) => {
  await healthyWorld(page, []);
  await page.route('**/api/hub/health*', (r) => json(r, [HEALTHY[0], partialRow('DHCP'), HEALTHY[2]]));
  await page.goto('/#overview');
  await expect(verdict(page)).toHaveText('Status unconfirmed', { timeout: 20_000 });
});

test('a partial source with a warning stays unconfirmed, and a critical problem still wins', async ({ page }) => {
  await healthyWorld(page, []);
  await page.route('**/api/hub/health*', (r) => json(r, [HEALTHY[0], partialRow('DHCP', 'warn', '1 stopped · 1/2 up'), HEALTHY[2]]));
  await page.goto('/#overview');
  await expect(verdict(page)).toHaveText('Status unconfirmed', { timeout: 20_000 });
  await page.unroute('**/api/hub/health*');
  await page.route('**/api/hub/health*', (r) => json(r, [HEALTHY[0], partialRow('DHCP', 'crit', '1 error · 1/2 up'), HEALTHY[2]]));
  await page.reload();
  await expect(verdict(page)).toHaveText('Action required', { timeout: 20_000 });
});

test('incidents built from a failed feed do not read as all healthy', async ({ page }) => {
  await healthyWorld(page, []);
  await page.route('**/api/incidents', (r) => json(r, { incidents: [], signals: [], signals_total: 0, signals_truncated: false, _meta: { subnets: 'error', zones: 'ok', leases: 'ok' }, signals_degraded: true, snoozes: {} }));
  await page.goto('/#overview');
  await expect(verdict(page)).toHaveText('Status unconfirmed', { timeout: 20_000 });
});

test('a sampled security feed does not read as all healthy', async ({ page }) => {
  await healthyWorld(page, []);
  await page.route('**/api/hub/security*', (r) => json(r, { availability: 'ok', counts: { critical: 0, high: 0, medium: 0, low: 0 }, returned: 500, truncated: true, events: [] }));
  await page.goto('/#overview');
  await expect(verdict(page)).toHaveText('Status unconfirmed', { timeout: 20_000 });
});

test('part of the hosts, or short whole-network counts, do not read as all healthy', async ({ page }) => {
  await healthyWorld(page, []);
  await page.route('**/api/data', (r) => json(r, { _meta: { hosts: 'ok', subnets: 'ok', leases: 'ok' }, _totals: { hosts: 40, subnets: 10, subnetsCrit: 0, subnetsWarn: 0, degraded: false }, hosts: [{ name: 'host-a', status: 'online' }], subnets: [], leases: [] }));
  await page.goto('/#overview');
  await expect(verdict(page)).toHaveText('Status unconfirmed', { timeout: 20_000 });
  await page.unroute('**/api/data');
  await page.route('**/api/data', (r) => json(r, { _meta: { hosts: 'ok', subnets: 'ok', leases: 'ok' }, _totals: { hosts: 1, subnets: 10, subnetsCrit: 0, subnetsWarn: 0, degraded: true }, hosts: [{ name: 'host-a', status: 'online' }], subnets: [], leases: [] }));
  await page.reload();
  await expect(verdict(page)).toHaveText('Status unconfirmed', { timeout: 20_000 });
});

test('a failed site-list read stops "None" being claimed', async ({ page }) => {
  await healthyWorld(page, [oldIncident()]);
  await page.route('**/api/lists/proposals*', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"down"}' }));
  await page.goto('/#overview');
  await expect(page.locator('[data-problem="dns-ttl-anomaly"]')).toBeVisible({ timeout: 20_000 });
  await expect(fact(page, 'New issues').locator('> span:last-child')).toHaveText('Not yet available. Some sources could not be read.');
});
