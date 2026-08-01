import { test, expect } from './fixtures';

// Per-tab slice selection on /api/data (?only=auditLogs, ?only=zones).
//
// The tabs that read one slice no longer wait for the whole twelve-call
// aggregate. That introduces one new way to lie: the payload can now arrive
// WITHOUT a slice in it, and every panel in this app draws "no rows and status
// is not 'error'" as <Empty/> — literally "no data", i.e. "you have none".
//
// These specs are the browser-level proof that it cannot happen:
//  - a slice the tab ASKED for that does not come back renders the feed's
//    unavailable notice, never the empty state;
//  - the tab really does ask narrowly (so a slice it never declared is never
//    in its payload to be rendered at all).
//
// Note on scope, so nobody reads more into a green run than it proves: the
// header's connection pill still polls the FULL /api/data every 60s from every
// tab, so the aggregate is still built. This is about what the TAB waits for.

function fulfillJson(route: import('@playwright/test').Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

// The full payload ConnStatus (and the unmigrated tabs) still read.
const FULL_PAYLOAD = {
  subnets: [], leases: [], hosts: [], zones: [], dnsViews: [], secPolicies: [], feeds: [],
  auditLogs: [],
  _totals: { degraded: false },
  _meta: {
    subnets: 'ok', leases: 'ok', dnsViews: 'ok', zones: 'ok',
    hosts: 'ok', secPolicies: 'ok', feeds: 'ok', auditLogs: 'ok',
  },
};

const AUDIT_ROW = {
  ts: '2026-08-01T10:00:00Z', user: 'narrowed@example.com',
  action: 'CREATE', resource: 'ipam/subnet', result: 'success',
};

test.describe('Audit tab on a narrowed /api/data', () => {
  test('a requested slice that does not come back says the feed is unavailable, never "no data"', async ({ page }) => {
    // The tab asked for auditLogs. The server answered without it. Nobody
    // learned whether this tenant has audit activity, so the panel must not
    // claim it has none.
    await page.route('**/api/data*', (route) => {
      const url = route.request().url();
      if (url.includes('only=')) {
        return fulfillJson(route, { zones: [], _meta: { zones: 'ok' } }); // auditLogs absent
      }
      return fulfillJson(route, FULL_PAYLOAD);
    });
    await page.goto('/#audit');

    const summary = page.locator('text=Activity Summary').locator('..').locator('..');
    await expect(summary.getByText(/audit log feed unavailable/i)).toBeVisible();
    await expect(summary.getByText('no data', { exact: true })).toHaveCount(0);

    const table = page.locator('text=Audit Log').first().locator('..').locator('..');
    await expect(table.getByText(/audit log feed unavailable/i)).toBeVisible();
  });

  test('a genuinely empty audit feed still renders the empty state, not an outage', async ({ page }) => {
    // The other half of the same rule: narrowing must not turn a quiet feed
    // into a fake outage.
    await page.route('**/api/data*', (route) => {
      const url = route.request().url();
      if (url.includes('only=')) {
        return fulfillJson(route, { auditLogs: [], _meta: { auditLogs: 'empty' } });
      }
      return fulfillJson(route, FULL_PAYLOAD);
    });
    await page.goto('/#audit');

    const summary = page.locator('text=Activity Summary').locator('..').locator('..');
    await expect(summary.getByText('no data', { exact: true })).toBeVisible();
    await expect(summary.getByText(/audit log feed unavailable/i)).toHaveCount(0);
  });

  test('the tab fetches ?only=auditLogs and renders from that response', async ({ page }) => {
    // The bare /api/data mock carries NO audit rows; only the narrowed URL
    // does. Seeing the row proves the tab read the narrowed response — if it
    // reverted to the full payload it would render the empty state instead.
    const narrowedUrls: string[] = [];
    await page.route('**/api/data*', (route) => {
      const url = route.request().url();
      if (url.includes('only=')) {
        narrowedUrls.push(url);
        return fulfillJson(route, { auditLogs: [AUDIT_ROW], _meta: { auditLogs: 'ok' } });
      }
      return fulfillJson(route, FULL_PAYLOAD);
    });
    await page.goto('/#audit');

    const table = page.locator('text=Audit Log').first().locator('..').locator('..');
    await expect(table.getByText('narrowed@example.com')).toBeVisible();
    expect(narrowedUrls.length).toBeGreaterThan(0);
    expect(narrowedUrls.some((u) => /only=auditLogs(&|$)/.test(u))).toBe(true);
    // Exactly the declared slice — no extra slice smuggled into the URL.
    for (const u of narrowedUrls) {
      expect(new URL(u).searchParams.get('only')).toBe('auditLogs');
    }
  });
});

test.describe('DNS tab on a narrowed /api/data', () => {
  test('a requested zones slice that does not come back says the feed is unavailable', async ({ page }) => {
    await page.route('**/api/data*', (route) => {
      const url = route.request().url();
      if (url.includes('only=')) {
        return fulfillJson(route, { auditLogs: [], _meta: { auditLogs: 'ok' } }); // zones absent
      }
      return fulfillJson(route, FULL_PAYLOAD);
    });
    await page.goto('/#dns');

    const table = page.locator('text=DNS Zones').first().locator('..').locator('..');
    await expect(table.getByText(/dns zones feed unavailable/i)).toBeVisible();
    await expect(table.getByText('no data', { exact: true })).toHaveCount(0);
  });

  test('the tab fetches ?only=zones and renders zones from that response', async ({ page }) => {
    const narrowedUrls: string[] = [];
    await page.route('**/api/data*', (route) => {
      const url = route.request().url();
      if (url.includes('only=')) {
        narrowedUrls.push(url);
        return fulfillJson(route, {
          zones: [{ fqdn: 'narrowed.example.com', view: 'default', records: 3, ttl: 3600, issues: [] }],
          dnsViews: [{ id: 'v1', name: 'default' }],
          _meta: { zones: 'ok', dnsViews: 'ok' },
        });
      }
      return fulfillJson(route, FULL_PAYLOAD);
    });
    await page.goto('/#dns');

    const table = page.locator('text=DNS Zones').first().locator('..').locator('..');
    await expect(table.getByText('narrowed.example.com')).toBeVisible();
    expect(narrowedUrls.some((u) => new URL(u).searchParams.get('only') === 'zones')).toBe(true);
  });
});
