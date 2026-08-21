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

// THE AUDIT TAB IS NO LONGER A SUBJECT HERE, and the DNS block below now
// carries the third case it used to own.
//
// Audit was the original example for all three: it asked for exactly one slice,
// so it was the cleanest place to prove narrowing. Issue #168 is that the slice
// it was asking for — `auditLogs` — is the INFOBLOX PORTAL audit feed, and the
// panels rendering it were labelled as this app's own actions. Those panels now
// read `/api/audit/log` and the tab does not call `/api/data` at all, so the
// three tests here had no subject: they mocked a payload nothing fetches and
// asserted wording nothing renders.
//
// The RULE they protect is untouched and still matters for every tab that does
// read a slice. It is proven below on `zones` instead, including the
// empty-is-not-an-outage half that only lived in the Audit block. Deleting
// without moving that case would have quietly dropped coverage of the exact
// confusion this file exists for: a quiet feed reading as a broken one.
//
// tests/feed-unavailable.spec.ts covers the same three states for the Audit
// panels against their new endpoint.

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

  test('a genuinely empty zones feed still renders the empty state, not an outage', async ({ page }) => {
    // The other half of the same rule, and the case this file nearly lost when
    // the Audit block above was retired: narrowing must not turn a quiet feed
    // into a fake outage. `empty` is a real answer ("you have none"); a missing
    // slice is not.
    await page.route('**/api/data*', (route) => {
      const url = route.request().url();
      if (url.includes('only=')) {
        return fulfillJson(route, {
          zones: [], dnsViews: [{ id: 'v1', name: 'default' }],
          _meta: { zones: 'empty', dnsViews: 'ok' },
        });
      }
      return fulfillJson(route, FULL_PAYLOAD);
    });
    await page.goto('/#dns');

    const table = page.locator('text=DNS Zones').first().locator('..').locator('..');
    await expect(table.getByText('no data', { exact: true })).toBeVisible();
    await expect(table.getByText(/dns zones feed unavailable/i)).toHaveCount(0);
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
