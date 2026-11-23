import { test, expect } from './fixtures';
import type { Page, Route } from '@playwright/test';
import { dataPayload, installBaselineWorld } from './page-fixtures';

// Each address Overview links to must land on only the failing items: a plain
// filter line with Show all, the list in view and focused, an honest word for
// nothing found or a failed read, at phone and desktop width, across a refresh
// and the Back button.

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const SIZES = [{ name: 'phone', width: 390, height: 844 }, { name: 'desktop', width: 1440, height: 900 }];

const SUBNETS = [
  { id: 's1', addr: '10.1.0.0', cidr: 24, name: 'a', site: 'x', total: 254, used: 180, util: 71 },
  { id: 's2', addr: '10.2.0.0', cidr: 24, name: 'b', site: 'x', total: 254, used: 250, util: 98 },
  { id: 's3', addr: '10.3.0.0', cidr: 30, name: 'tiny', site: 'x', total: 2, used: 2, util: 100 },
  { id: 's4', addr: '10.4.0.0', cidr: 24, name: 'c', site: 'x', total: 254, used: 25, util: 10 },
  { id: 's5', addr: '10.5.0.0', cidr: 24, name: 'd', site: 'x', total: 254, used: null, util: null },
];
const ZONES = [
  { id: 'z1', fqdn: 'clean.example.', view: 'v', records: 1, ttl: 3600, neg_ttl: 900, issues: [], anomaly: false, dnssec_status: 'SIGNED' },
  { id: 'z2', fqdn: 'low.example.', view: 'v', records: 1, ttl: 30, neg_ttl: 900, issues: ['TTL Too Low'], anomaly: true, dnssec_status: 'UNSIGNED' },
  { id: 'z3', fqdn: 'neg.example.', view: 'v', records: 1, ttl: 3600, neg_ttl: 7200, issues: ['High Neg-TTL'], anomaly: true, dnssec_status: 'SIGNED' },
  { id: 'z4', fqdn: '1.10.in-addr.arpa.', view: 'v', records: 1, ttl: 3600, neg_ttl: 900, issues: [], anomaly: false, dnssec_status: 'UNSIGNED' },
];
const DNSSEC = {
  status: 'ok',
  rows: [
    { id: 'z1', fqdn: 'clean.example.', view: 'v', dnssec_status: 'SIGNED', dnssec_signing_policy: 'p', public_name: true },
    { id: 'z2', fqdn: 'low.example.', view: 'v', dnssec_status: 'UNSIGNED', dnssec_signing_policy: '', public_name: true },
    { id: 'z3', fqdn: 'neg.example.', view: 'v', dnssec_status: 'SIGNED', dnssec_signing_policy: 'p', public_name: true },
    { id: 'z4', fqdn: '1.10.in-addr.arpa.', view: 'v', dnssec_status: 'UNSIGNED', dnssec_signing_policy: '', public_name: false },
  ],
};
const ev = (qname: string, severity: string, min: number) => ({
  event_time: new Date(Date.UTC(2026, 0, 1, 11, 59 - min)).toISOString(), qname, severity, policy_action: 'BLOCK',
  feed_name: 'f', threat_indicator: 'i', device: 'd', network: 'n',
});
// The plain read holds the newest 2 events; the counts cover all 5.
const PLAIN_HUB = {
  availability: 'ok', blocked: 5, logged: 0, returned: 2, counted: 5, complete: true, truncated: false, total: 5,
  counts: { critical: 1, high: 2, medium: 2, low: 0 },
  events: [ev('new-med.example', 'MEDIUM', 0), ev('new-high.example', 'HIGH', 1)],
};
const FULL_HUB = {
  ...PLAIN_HUB, returned: 3,
  events: [ev('new-high.example', 'HIGH', 1), ev('old-crit.example', 'CRITICAL', 20), ev('old-high.example', 'High', 30)],
};

async function world(page: Page) {
  await installBaselineWorld(page);
  await page.route('**/api/data*', (r) => json(r, { ...structuredClone(dataPayload()), subnets: SUBNETS, zones: ZONES }));
  await page.route('**/api/csp/dnssec*', (r) => json(r, DNSSEC));
  await page.route('**/api/hub/security*', (r) =>
    json(r, new URL(r.request().url()).searchParams.get('severity') === 'high' ? FULL_HUB : PLAIN_HUB));
}

const line = (page: Page, panel: string) => page.locator(`[data-panel-id="${panel}"] [data-landing-filter]`);
const rowsOf = (page: Page, panel: string) => page.locator(`[data-panel-id="${panel}"] tbody tr`);

// In view, not under the sticky header, and holding keyboard focus.
async function expectLanded(page: Page, panel: string) {
  const card = page.locator(`[data-panel-id="${panel}"]`);
  await expect(card).toBeFocused();
  await expect.poll(async () => {
    const box = await line(page, panel).boundingBox();
    const header = await page.evaluate(() => {
      const h = document.querySelector('header');
      return h ? h.getBoundingClientRect().bottom : 0;
    });
    const vh = page.viewportSize()!.height;
    return !!box && box.y >= header && box.y + box.height <= vh;
  }, { timeout: 5000 }).toBe(true);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

const CASES = [
  { name: 'subnets', hash: '#network?minUtil=70&links=1', panel: 'network-exhaustion', text: 'Showing 3 subnets 70% full or more, fullest first.', rows: ['10.3.0.0', '10.2.0.0', '10.1.0.0'], cleared: /#network$/ },
  { name: 'security', hash: '#security?severity=high', panel: 'security-triage-inbox', text: 'Showing 3 critical or high events, critical first.', rows: ['old-crit.example', 'new-high.example', 'old-high.example'], cleared: /#security$/ },
  { name: 'timing kind', hash: '#dns?issues=TTL%20Too%20Low', panel: 'dns-zones', text: /Showing 1 zone with this problem/, rows: ['low.example.'], cleared: /#dns$/ },
  { name: 'all timing', hash: '#dns?issues=1', panel: 'dns-zones', text: 'Showing 2 zones with DNS timing problems.', rows: ['low.example.', 'neg.example.'], cleared: /#dns$/ },
  { name: 'not signed', hash: '#dns?issues=dnssec', panel: 'dns-zones', text: 'Showing 1 public zone not signed.', rows: ['low.example.'], cleared: /#dns$/ },
];

for (const size of SIZES) {
  for (const c of CASES) {
    test(`${c.name} lands on only the failing items at ${size.name} width`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await world(page);
      await page.goto(`/${c.hash}`);
      await expect(line(page, c.panel)).toContainText(c.text);
      await expect(rowsOf(page, c.panel)).toHaveCount(c.rows.length);
      for (const [i, r] of c.rows.entries()) await expect(rowsOf(page, c.panel).nth(i)).toContainText(r);
      await expectLanded(page, c.panel);

      await page.reload();
      await expect(line(page, c.panel)).toContainText(c.text);
      await expect(rowsOf(page, c.panel)).toHaveCount(c.rows.length);
      await expectLanded(page, c.panel);

      await line(page, c.panel).getByRole('button', { name: 'Show all' }).click();
      await expect(page).toHaveURL(c.cleared);
      await expect(line(page, c.panel)).toHaveCount(0);

      await page.goBack();
      await expect(line(page, c.panel)).toContainText(c.text);
      await expect(rowsOf(page, c.panel)).toHaveCount(c.rows.length);
      await expectLanded(page, c.panel);
    });
  }
}

test('a failed read never claims there are none', async ({ page }) => {
  await world(page);
  await page.route('**/api/data*', (r) => json(r, { error: 'x' }, 500));
  await page.route('**/api/csp/dnssec*', (r) => json(r, { status: 'error', rows: [] }));
  await page.route('**/api/hub/security*', (r) => json(r, { availability: 'error', events: [], counts: { critical: 0, high: 0 } }));
  await page.goto('/#network?minUtil=70&links=1');
  await expect(line(page, 'network-exhaustion')).toContainText('Could not load subnets', { timeout: 30_000 });
  await page.goto('/#security?severity=high');
  await expect(line(page, 'security-triage-inbox')).toContainText('Could not load security events');
  await page.goto('/#dns?issues=dnssec');
  await expect(line(page, 'dns-zones')).toContainText('Could not load zones');
  await page.goto('/#dns?issues=1');
  await expect(line(page, 'dns-zones')).toContainText('Could not load zones', { timeout: 30_000 });
});

test('a filter that matches nothing says so', async ({ page }) => {
  await world(page);
  await page.route('**/api/data*', (r) => json(r, {
    ...structuredClone(dataPayload()),
    subnets: [SUBNETS[3]],
    zones: [ZONES[0]],
  }));
  await page.route('**/api/csp/dnssec*', (r) => json(r, { status: 'ok', rows: [DNSSEC.rows[0]] }));
  await page.route('**/api/hub/security*', (r) => json(r, { ...PLAIN_HUB, counts: { critical: 0, high: 0, medium: 2, low: 0 }, events: [ev('m.example', 'MEDIUM', 0)] }));
  await page.goto('/#network?minUtil=70&links=1');
  await expect(line(page, 'network-exhaustion')).toContainText('No subnets 70% full or more.');
  await page.goto('/#security?severity=high');
  await expect(line(page, 'security-triage-inbox')).toContainText('No critical or high events in the last hour.');
  await page.goto('/#dns?issues=dnssec');
  await expect(line(page, 'dns-zones')).toContainText('No public zones not signed.');
  await page.goto('/#dns?issues=1');
  await expect(line(page, 'dns-zones')).toContainText('No zones with DNS timing problems.');
});

// Panels above the list finish loading after it and grow. The list must still
// be in view once they have.
for (const c of CASES) {
  test(`${c.name} stays in view when panels above it load late, at phone width`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await world(page);
    const late = (glob: string) => page.route(glob, async (r) => {
      await new Promise((f) => setTimeout(f, 1200));
      await r.fallback();
    });
    for (const g of ['**/api/ipam/overlaps*', '**/api/csp/ipam-util*', '**/api/csp/threats*', '**/api/csp/dns-qps*', '**/api/csp/dns-health*', '**/api/dns-analytics*']) await late(g);
    await page.goto(`/${c.hash}`);
    await expect(line(page, c.panel)).toContainText(c.text);
    await page.waitForTimeout(2500);
    await expectLanded(page, c.panel);
  });
}
