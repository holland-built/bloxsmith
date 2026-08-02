import { test, expect } from './fixtures';

// Overview's Host Status donut used to fold the backend's literal "unknown"
// status (go/internal/dashboard/norm.go, shipped in v3.49.0) into its catch-all
// "Other" slice, while Infra's donut already broke it out. On the live tenant
// that read as `Unknown 2% / Other 8%` on Infra and a single `Other 10%` on
// Overview — the same 532 hosts described two different ways depending on which
// screen you were looking at.
//
// Route-interception style is lifted from failure-not-absence-4.spec.ts: the
// host list is crafted here rather than taken from the tenant, so the test
// states the input it is grading and the arithmetic below is checkable by eye.

function fulfillJson(route: import('@playwright/test').Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

const OK_META = {
  subnets: 'ok', leases: 'ok', dnsViews: 'ok', zones: 'ok',
  hosts: 'ok', secPolicies: 'ok', feeds: 'ok', auditLogs: 'ok',
};

function dataPayload(hosts: unknown[]) {
  return {
    subnets: [], leases: [], zones: [], dnsViews: [], secPolicies: [], feeds: [], auditLogs: [],
    hosts,
    _totals: { hosts: hosts.length },
    _meta: OK_META,
  };
}

// Same vault pin failure-not-absence-4.spec.ts uses: a transient failure of
// /api/vault/status swaps the whole dashboard for "Vault status unavailable",
// which would read here as a panel regression it is not.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/vault/status*', (route) => fulfillJson(route, { vaultMode: false, ready: true }));
});

const CARD = 'xpath=ancestor::div[contains(@class,"bg-card")]';
function hostStatusCard(page: import('@playwright/test').Page) {
  return page.locator('h2', { hasText: 'Host Status' }).first().locator(CARD);
}
/** One legend row: swatch <i>, name <span class="flex-1">, percentage <b>. */
function legendRow(page: import('@playwright/test').Page, name: string) {
  return hostStatusCard(page).getByText(name, { exact: true }).locator('..');
}

// 10 hosts, deliberately chosen so every bucket lands on a distinct, whole
// percentage of the loaded rows:
//   Active 5 (50%) · Degraded 1 (10%) · Offline 1 (10%) · Unknown 2 (20%) · Other 1 (10%)
// Before the fix, Unknown and Other shared one slice at 30%.
const MIXED_HOSTS = [
  { id: 'a1', name: 'app-01', ip: '10.8.0.1', status: 'online', type: 'bloxone' },
  { id: 'a2', name: 'app-02', ip: '10.8.0.2', status: 'online', type: 'bloxone' },
  { id: 'a3', name: 'app-03', ip: '10.8.0.3', status: 'online', type: 'bloxone' },
  { id: 'a4', name: 'app-04', ip: '10.8.0.4', status: 'active', type: 'bloxone' },
  { id: 'a5', name: 'app-05', ip: '10.8.0.5', status: 'up', type: 'bloxone' },
  { id: 'd1', name: 'deg-01', ip: '10.8.0.6', status: 'degraded', type: 'bloxone' },
  { id: 'o1', name: 'off-01', ip: '10.8.0.7', status: 'down', type: 'bloxone' },
  { id: 'u1', name: 'nostatus-01', ip: '10.8.0.8', status: 'unknown', type: 'bloxone' },
  { id: 'u2', name: 'nostatus-02', ip: '10.8.0.9', status: 'unknown', type: 'bloxone' },
  { id: 'p1', name: 'pending-01', ip: '10.8.0.10', status: 'pending', type: 'bloxone' },
];

// The same estate with the two unreported hosts replaced by reported ones:
//   Active 4 (80%) · Other 1 (20%) · Unknown 0 — which must render as NO row.
const NO_UNKNOWN_HOSTS = [
  { id: 'a1', name: 'app-01', ip: '10.8.0.1', status: 'online', type: 'bloxone' },
  { id: 'a2', name: 'app-02', ip: '10.8.0.2', status: 'online', type: 'bloxone' },
  { id: 'a3', name: 'app-03', ip: '10.8.0.3', status: 'online', type: 'bloxone' },
  { id: 'a4', name: 'app-04', ip: '10.8.0.4', status: 'online', type: 'bloxone' },
  { id: 'p1', name: 'pending-01', ip: '10.8.0.5', status: 'pending', type: 'bloxone' },
];

test.describe('Overview → Host Status donut (hosts reported as "unknown")', () => {
  test('unknown hosts get their own slice, and Other stops counting them', async ({ page }) => {
    await page.route('**/api/data*', (route) => fulfillJson(route, dataPayload(MIXED_HOSTS)));
    await page.goto('/#overview');

    const card = hostStatusCard(page);
    await expect(card.getByText('Unknown', { exact: true })).toBeVisible();

    // 1. Unknown carries the two unreported hosts.
    await expect(legendRow(page, 'Unknown').locator('b')).toHaveText('20%');

    // 2. Other carries ONLY the genuinely-other host (pending). 30% was the
    //    merged figure this fix removes — asserting its absence is what stops a
    //    build that renders an Unknown row while still double-counting.
    const other = legendRow(page, 'Other');
    await expect(other.locator('b')).toHaveText('10%');
    await expect(other.getByText('30%', { exact: true })).toHaveCount(0);

    // The rest of the donut is untouched by the split.
    await expect(legendRow(page, 'Active').locator('b')).toHaveText('50%');
    await expect(legendRow(page, 'Degraded').locator('b')).toHaveText('10%');
    await expect(legendRow(page, 'Offline').locator('b')).toHaveText('10%');

    // Severity order matches Infra's bucket order — Unknown above Other, since
    // "we were not told" is a thing to go and check and "pending" is not.
    await expect(card.locator('span.text-muted.flex-1')).toHaveText(['Active', 'Degraded', 'Offline', 'Unknown', 'Other']);
  });

  test('the Unknown swatch is the same colour Infra paints it', async ({ page }) => {
    // The point of the change is that an operator comparing the two screens
    // sees ONE fact. A matching count in a different colour still reads as two
    // different things, so the colour is compared across tabs rather than
    // hard-coded here (which would only restate Overview to itself).
    await page.route('**/api/data*', (route) => fulfillJson(route, dataPayload(MIXED_HOSTS)));

    const swatch = () => legendRow(page, 'Unknown').locator('i').first();
    const colourOf = () => swatch().evaluate((el) => getComputedStyle(el).backgroundColor);

    await page.goto('/#infra');
    await expect(swatch()).toBeVisible();
    const infraColour = await colourOf();

    await page.goto('/#overview');
    await expect(swatch()).toBeVisible();
    expect(await colourOf()).toBe(infraColour);

    // And the two screens agree on the number, not just the hue.
    await expect(legendRow(page, 'Unknown').locator('b')).toHaveText('20%');
  });

  test('an estate with no unknown hosts shows no Unknown slice at all', async ({ page }) => {
    // An empty bucket rendered as "Unknown 0%" would be a permanent row
    // claiming a measurement nobody took — the donut only ever shows buckets
    // that actually hold hosts.
    await page.route('**/api/data*', (route) => fulfillJson(route, dataPayload(NO_UNKNOWN_HOSTS)));
    await page.goto('/#overview');

    const card = hostStatusCard(page);
    await expect(card.getByText('Active', { exact: true })).toBeVisible();
    await expect(card.getByText('Unknown', { exact: true })).toHaveCount(0);
    await expect(card.getByText('0%', { exact: true })).toHaveCount(0);
    await expect(card.locator('span.text-muted.flex-1')).toHaveText(['Active', 'Other']);

    // The surviving buckets still add up over the loaded rows.
    await expect(legendRow(page, 'Active').locator('b')).toHaveText('80%');
    await expect(legendRow(page, 'Other').locator('b')).toHaveText('20%');
  });
});
