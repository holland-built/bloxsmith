import { test, expect } from './fixtures';

// Server contract (shipped alongside this spec): /api/data now carries a
// per-feed `_meta` status — "ok" | "empty" | "error" — keyed by the same
// names as the data keys in the same payload (subnets, hosts, auditLogs, …).
// Before this, a failed read still returned an empty array for that key, so
// the panel rendered its normal empty state and the user read "broken feed"
// as "you have none". These specs prove three different panels now tell
// those two cases apart: an "error" status renders explicit unavailable
// wording (never the zero-count "no data" language), while "empty" still
// renders the ordinary empty state, and "ok" renders real rows.

function fulfillJson(route: import('@playwright/test').Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

function dataPayload(overrides: { hosts?: unknown[]; subnets?: unknown[]; auditLogs?: unknown[]; meta: Record<string, string> }) {
  return {
    subnets: overrides.subnets ?? [],
    leases: [],
    hosts: overrides.hosts ?? [],
    zones: [],
    dnsViews: [],
    secPolicies: [],
    feeds: [],
    auditLogs: overrides.auditLogs ?? [],
    _totals: {},
    _meta: overrides.meta,
  };
}

test.describe('Overview → Host Status panel (hosts feed)', () => {
  test('hosts feed error renders unavailable wording, not "no data"', async ({ page }) => {
    await page.route('**/api/data*', (route) =>
      fulfillJson(route, dataPayload({ hosts: [], meta: { hosts: 'error' } })),
    );
    await page.goto('/#overview');
    const card = page.locator('text=Host Status').locator('..').locator('..');
    await expect(card.getByText(/hosts feed unavailable/i)).toBeVisible();
    await expect(card.getByText(/^no data$/i)).toHaveCount(0);
  });

  test('hosts feed empty renders the normal empty state', async ({ page }) => {
    await page.route('**/api/data*', (route) =>
      fulfillJson(route, dataPayload({ hosts: [], meta: { hosts: 'empty' } })),
    );
    await page.goto('/#overview');
    const card = page.locator('text=Host Status').locator('..').locator('..');
    await expect(card.getByText(/^no data$/i)).toBeVisible();
    await expect(card.getByText(/hosts feed unavailable/i)).toHaveCount(0);
  });

  test('hosts feed ok renders host rows', async ({ page }) => {
    await page.route('**/api/data*', (route) =>
      fulfillJson(route, dataPayload({
        hosts: [{ name: 'host-a', status: 'online' }, { name: 'host-b', status: 'offline' }],
        meta: { hosts: 'ok' },
      })),
    );
    await page.goto('/#overview');
    const card = page.locator('text=Host Status').locator('..').locator('..');
    await expect(card.getByText('Active')).toBeVisible();
    await expect(card.getByText(/hosts feed unavailable/i)).toHaveCount(0);
    await expect(card.getByText(/^no data$/i)).toHaveCount(0);
  });
});

test.describe('Network → Utilization Distribution panel (subnets feed)', () => {
  test('subnets feed error renders unavailable wording, not "no data"', async ({ page }) => {
    await page.route('**/api/data*', (route) =>
      fulfillJson(route, dataPayload({ subnets: [], meta: { subnets: 'error' } })),
    );
    await page.goto('/#network');
    const card = page.locator('text=Utilization Distribution').locator('..').locator('..');
    await expect(card.getByText(/subnets feed unavailable/i)).toBeVisible();
    await expect(card.getByText(/^no data$/i)).toHaveCount(0);
  });

  test('subnets feed empty renders the normal empty state', async ({ page }) => {
    await page.route('**/api/data*', (route) =>
      fulfillJson(route, dataPayload({ subnets: [], meta: { subnets: 'empty' } })),
    );
    await page.goto('/#network');
    const card = page.locator('text=Utilization Distribution').locator('..').locator('..');
    await expect(card.getByText(/^no data$/i)).toBeVisible();
    await expect(card.getByText(/subnets feed unavailable/i)).toHaveCount(0);
  });

  test('subnets feed ok renders the utilization chart', async ({ page }) => {
    await page.route('**/api/data*', (route) =>
      fulfillJson(route, dataPayload({
        subnets: [{ addr: '10.0.0.0/24', cidr: 24, util: 42 }, { addr: '10.0.1.0/24', cidr: 24, util: 91 }],
        meta: { subnets: 'ok' },
      })),
    );
    await page.goto('/#network');
    const card = page.locator('text=Utilization Distribution').locator('..').locator('..');
    await expect(card.getByText(/2 loaded/i)).toBeVisible();
    await expect(card.getByText(/subnets feed unavailable/i)).toHaveCount(0);
    await expect(card.getByText(/^no data$/i)).toHaveCount(0);
  });
});

// THIS BLOCK MOVED SOURCE, and that is the point of the rewrite.
//
// It used to drive `/api/data`'s `auditLogs` feed, because that is what the
// Activity Summary rendered. That feed is the INFOBLOX PORTAL audit log at
// `_limit: 100` (go/internal/dashboard/dashboard.go), and issue #168 is that the
// panel was summarising it under this app's own name. The panel now reads
// `/api/audit/log` — the signed local chain — so the three states have to be
// proven against that endpoint or they prove nothing about what is on screen.
//
// The middle case was the one that had gone quietly false. With `/api/data`
// mocked and `/api/audit/log` left alone, `scripts/e2e.sh` blanks the
// credentials and the real handler answers with an empty chain, so the panel
// rendered its empty state and the assertion passed — for a reason that had
// nothing to do with the payload the test was constructing. It passed while the
// two either side of it failed.
function auditLogPayload(entries: unknown[]) {
  return {
    entries,
    chain_valid: true,
    chain_state: 'intact',
    chain_detail: '',
    chain_verify_error: null,
    broken_index: null,
    broken_reason: null,
    append_failures: 0,
  };
}

// Epoch SECONDS, which is what the chain writes. Fixed, not derived from the
// clock, so the row is the same on every run.
const CHAIN_ENTRIES = [
  { actor: 'alice', event: 'provision-subnet', ts: 1785196800, detail: { subnet: '10.0.0.0' }, hash: 'h1', prev_hash: '', seq: 0 },
  { actor: 'bob', event: 'write-refused-read-only', ts: 1785196860, detail: { reason: 'tenant-read-only' }, hash: 'h2', prev_hash: 'h1', seq: 1 },
];

test.describe('Audit → Activity Summary panel (audit chain)', () => {
  test('a failed read renders unavailable wording, not "no data"', async ({ page }) => {
    await page.route('**/api/audit/log', (route) => route.fulfill({ status: 500, body: 'upstream down' }));
    await page.goto('/#audit');
    const card = page.locator('text=Activity Summary').locator('..').locator('..');
    await expect(card.getByText(/audit log unavailable/i)).toBeVisible();
    await expect(card.getByText(/^no data$/i)).toHaveCount(0);
  });

  test('a chain that read cleanly and holds nothing renders the normal empty state', async ({ page }) => {
    await page.route('**/api/audit/log', (route) => fulfillJson(route, auditLogPayload([])));
    await page.goto('/#audit');
    const card = page.locator('text=Activity Summary').locator('..').locator('..');
    await expect(card.getByText(/^no data$/i)).toBeVisible();
    await expect(card.getByText(/audit log unavailable/i)).toHaveCount(0);
  });

  test('entries render as a tally by event kind', async ({ page }) => {
    await page.route('**/api/audit/log', (route) => fulfillJson(route, auditLogPayload(CHAIN_ENTRIES)));
    await page.goto('/#audit');
    const card = page.locator('text=Activity Summary').locator('..').locator('..');
    await expect(card.getByText(/2 recorded events/i)).toBeVisible();
    // The kinds themselves, not just the count: a tally that lost its grouping
    // would still print "2 recorded events" over a blank panel.
    await expect(card.getByText(/provision-subnet/i)).toBeVisible();
    await expect(card.getByText(/write-refused-read-only/i)).toBeVisible();
    await expect(card.getByText(/audit log unavailable/i)).toHaveCount(0);
    await expect(card.getByText(/^no data$/i)).toHaveCount(0);
  });

  test('a short read says the list is incomplete', async ({ page }) => {
    // The pair of fields added in go/internal/server/state.go. Nothing else on
    // the page distinguishes "two entries" from "two entries and three the
    // reader could not decode".
    await page.route('**/api/audit/log', (route) =>
      fulfillJson(route, { ...auditLogPayload(CHAIN_ENTRIES), skipped_lines: 3 }),
    );
    await page.goto('/#audit');
    const card = page.locator('text=Activity Summary').locator('..').locator('..');
    await expect(card.getByText(/this list is incomplete/i)).toBeVisible();
    await expect(card.getByText(/3 lines on disk could not be decoded/i)).toBeVisible();
  });
});
