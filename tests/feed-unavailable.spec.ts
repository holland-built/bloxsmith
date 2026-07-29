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

test.describe('Audit → Activity Summary panel (auditLogs feed)', () => {
  test('auditLogs feed error renders unavailable wording, not "no data"', async ({ page }) => {
    await page.route('**/api/data*', (route) =>
      fulfillJson(route, dataPayload({ auditLogs: [], meta: { auditLogs: 'error' } })),
    );
    await page.goto('/#audit');
    const card = page.locator('text=Activity Summary').locator('..').locator('..');
    await expect(card.getByText(/audit log feed unavailable/i)).toBeVisible();
    await expect(card.getByText(/^no data$/i)).toHaveCount(0);
  });

  test('auditLogs feed empty renders the normal empty state', async ({ page }) => {
    await page.route('**/api/data*', (route) =>
      fulfillJson(route, dataPayload({ auditLogs: [], meta: { auditLogs: 'empty' } })),
    );
    await page.goto('/#audit');
    const card = page.locator('text=Activity Summary').locator('..').locator('..');
    await expect(card.getByText(/^no data$/i)).toBeVisible();
    await expect(card.getByText(/audit log feed unavailable/i)).toHaveCount(0);
  });

  test('auditLogs feed ok renders event rows', async ({ page }) => {
    await page.route('**/api/data*', (route) =>
      fulfillJson(route, dataPayload({
        auditLogs: [
          { ts: '2026-07-28T00:00:00Z', user: 'alice', action: 'CREATE', resource: 'zone/a', result: 'success' },
          { ts: '2026-07-28T00:01:00Z', user: 'bob', action: 'DELETE', resource: 'zone/b', result: 'success' },
        ],
        meta: { auditLogs: 'ok' },
      })),
    );
    await page.goto('/#audit');
    const card = page.locator('text=Activity Summary').locator('..').locator('..');
    await expect(card.getByText(/last 2 events/i)).toBeVisible();
    await expect(card.getByText(/audit log feed unavailable/i)).toHaveCount(0);
    await expect(card.getByText(/^no data$/i)).toHaveCount(0);
  });
});
