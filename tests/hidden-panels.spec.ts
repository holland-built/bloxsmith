import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Every /api/ response is faked from tests/page-fixtures.ts.
//
// This file sat in playwright.config.ts's LINUX_CI_UNPROVEN_SPECS, described as
// failing on ubuntu for "platform layout/timing" reasons. That description was
// never measured — the one run behind it (31499474048) had NO TENANT as well as
// a different OS, so it could not tell the two apart. Running these same tests
// on macOS through scripts/e2e.sh, which also has no tenant, reproduced most of
// the failures: the missing data was doing the work, not the platform.
test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

// P7 — auto-hide panels for services this tenant does not own.
//
// Backend contract (go/internal/dashboard/hub.go, FetchServiceInventory, served
// at GET /api/service-inventory): the distinct service_type set from
// /api/infra/v1/detail_services, with THREE availability states —
//   ok      service_types is complete; [] means the tenant genuinely owns none
//   error   the read failed; service_types is null, never []
//   partial the read hit the 500-row limit, so an absent type is
//           indistinguishable from a truncated one
//
// Hiding is the only place in this app where a feed makes UI disappear rather
// than say it is broken, so these specs spend most of their length on the cases
// that must hide NOTHING. A dead inventory feed rendering as "you don't own
// this" is the failure-reads-as-safety bug hub.go:42-45 documents, wearing a
// different hat.

function fulfillJson(route: import('@playwright/test').Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

function inventory(page: import('@playwright/test').Page, body: unknown) {
  return page.route('**/api/service-inventory', (route) => fulfillJson(route, body));
}

// This tenant's real answer, minus whichever types a given case is testing.
const OWNS_NO_DNS = { availability: 'ok', service_types: ['dfp', 'dhcp', 'discovery', 'ntp', 'orpheus'] };
const OWNS_NO_SECURITY = { availability: 'ok', service_types: ['dhcp', 'discovery', 'dns', 'ntp'] };
const OWNS_NO_DHCP = { availability: 'ok', service_types: ['dfp', 'discovery', 'dns', 'ntp', 'orpheus'] };
const OWNS_NOTHING = { availability: 'ok', service_types: [] };
const READ_FAILED = { availability: 'error', service_types: null, reason: 'service inventory feed unavailable' };
const TRUNCATED = {
  availability: 'partial',
  service_types: ['dhcp', 'discovery'],
  reason: 'inventory truncated at the 500-row limit — an absent service type may exist but not be listed',
};
const NULL_TYPES = { availability: 'ok', service_types: null };

const hiddenRow = (page: import('@playwright/test').Page) => page.getByTestId('hidden-panels');
const showAnyway = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: 'show anyway' });

test.describe('a service the tenant does not own', () => {
  test('DNS panels are unmounted, a hidden row explains it, and "show anyway" brings them back', async ({ page }) => {
    await inventory(page, OWNS_NO_DNS);
    await page.goto('/#dns');

    // Both dns|ndns panels are gone — not empty, not "unavailable": absent.
    await expect(page.getByText('DNS Query Rate — 24h')).toHaveCount(0);
    await expect(page.getByText('DNS Services', { exact: true })).toHaveCount(0);

    // ...and something on screen says so, naming the service, never a count.
    const rows = hiddenRow(page);
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('1 panel hidden');
    await expect(rows.first()).toContainText('no DNS service detected');

    // Panels this tenant DOES own are untouched by its neighbour hiding.
    await expect(page.getByText('DNS Zones').first()).toBeVisible();

    // The escape hatch mounts them, and they then render exactly as normal.
    await showAnyway(page).first().click();
    await expect(page.getByText('DNS Query Rate — 24h')).toBeVisible();
    await expect(page.getByText('DNS Services', { exact: true })).toBeVisible();
    await expect(hiddenRow(page)).toHaveCount(0);
  });

  test('the three hub-backed Security panels hide as one group, and the rest of the tab stays', async ({ page }) => {
    await inventory(page, OWNS_NO_SECURITY);
    await page.goto('/#security');

    const row = hiddenRow(page);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('3 panels hidden');
    await expect(row).toContainText('no threat-defense service detected');
    await expect(page.getByText('Threat Events — by Severity')).toHaveCount(0);
    await expect(page.getByText('Response Summary')).toHaveCount(0);
    await expect(page.getByText('Triage Inbox')).toHaveCount(0);

    // Unmapped Security panels are not part of the group and must not move.
    //
    // CTEM is matched by its HEADING, not by its text. getByText is a
    // case-insensitive substring match, so `getByText('CTEM Exposure')` also
    // matches this panel's own error state, "CTEM exposure feed unavailable" —
    // two elements, and a strict-mode violation — on any day the CTEM feed is
    // down. What this line is actually asserting is that the panel is still on
    // the tab, which is true whether its feed is up or not, so the feed state
    // has no business deciding whether it passes.
    //
    // Found on 2026-08-10, when the code split changed the mount timing enough
    // that the panel had already resolved to its error state by the time this
    // ran, instead of still showing a skeleton. The ambiguity was always there;
    // the timing is only what made it show up.
    await expect(page.getByText('Lookalike Domains')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'CTEM Exposure' })).toBeVisible();

    await showAnyway(page).click();
    await expect(page.getByText('Threat Events — by Severity')).toBeVisible();
    await expect(page.getByText('Response Summary')).toBeVisible();
    await expect(page.getByText('Triage Inbox')).toBeVisible();
  });

  test('DHCP Leases hides on Network without disturbing the IPAM panels', async ({ page }) => {
    await inventory(page, OWNS_NO_DHCP);
    await page.goto('/#network');

    await expect(hiddenRow(page)).toContainText('no DHCP service detected');
    await expect(page.getByText('DHCP Leases')).toHaveCount(0);
    await expect(page.getByText('Utilization Distribution')).toBeVisible();
    await expect(page.getByText('IPAM Spaces — Top Used')).toBeVisible();
  });

  test('"show anyway" is sticky for the session — navigating away and back keeps them shown', async ({ page }) => {
    await inventory(page, OWNS_NO_DNS);
    await page.goto('/#dns');
    await showAnyway(page).first().click();
    await expect(page.getByText('DNS Query Rate — 24h')).toBeVisible();

    await page.goto('/#network');
    await page.goto('/#dns');
    await expect(page.getByText('DNS Query Rate — 24h')).toBeVisible();
    await expect(hiddenRow(page)).toHaveCount(0);
  });
});

test.describe('fail open — every non-authoritative answer hides nothing', () => {
  test('a dead inventory feed hides nothing on any of the three tabs', async ({ page }) => {
    await inventory(page, READ_FAILED);

    await page.goto('/#dns');
    await expect(page.getByText('DNS Query Rate — 24h')).toBeVisible();
    await expect(page.getByText('DNS Services', { exact: true })).toBeVisible();
    await expect(hiddenRow(page)).toHaveCount(0);

    await page.goto('/#security');
    await expect(page.getByText('Threat Events — by Severity')).toBeVisible();
    await expect(hiddenRow(page)).toHaveCount(0);

    await page.goto('/#network');
    await expect(page.getByText('DHCP Leases')).toBeVisible();
    await expect(hiddenRow(page)).toHaveCount(0);
  });

  test('a truncated (partial) inventory hides nothing, even for a type it did not list', async ({ page }) => {
    // TRUNCATED lists neither dns nor ndns — under an "ok" that would hide both
    // DNS panels. At the row limit their absence proves nothing.
    await inventory(page, TRUNCATED);
    await page.goto('/#dns');
    await expect(page.getByText('DNS Query Rate — 24h')).toBeVisible();
    await expect(page.getByText('DNS Services', { exact: true })).toBeVisible();
    await expect(hiddenRow(page)).toHaveCount(0);
  });

  test('service_types: null hides nothing', async ({ page }) => {
    await inventory(page, NULL_TYPES);
    await page.goto('/#dns');
    await expect(page.getByText('DNS Query Rate — 24h')).toBeVisible();
    await expect(hiddenRow(page)).toHaveCount(0);
  });

  test('an inventory request still in flight hides nothing while it waits', async ({ page }) => {
    // The answer that WOULD hide both DNS panels, delayed past first paint.
    // Nothing may disappear on the strength of an answer nobody has yet.
    await page.route('**/api/service-inventory', async (route) => {
      await new Promise((r) => setTimeout(r, 4000));
      return fulfillJson(route, OWNS_NO_DNS);
    });
    await page.goto('/#dns');
    await expect(page.getByText('DNS Query Rate — 24h')).toBeVisible({ timeout: 3000 });
    await expect(hiddenRow(page)).toHaveCount(0);
    // And once it lands, the panels do hide — proving the wait above was the
    // in-flight state and not a broken route.
    await expect(hiddenRow(page)).toHaveCount(2, { timeout: 10000 });
  });

  test('a 500 from the inventory route hides nothing', async ({ page }) => {
    await page.route('**/api/service-inventory', (route) => route.fulfill({ status: 500, body: 'boom' }));
    await page.goto('/#dns');
    await expect(page.getByText('DNS Query Rate — 24h')).toBeVisible();
    await expect(hiddenRow(page)).toHaveCount(0);
  });
});

test.describe('blast radius', () => {
  test('Overview is untouched even when the tenant authoritatively owns nothing', async ({ page }) => {
    // OWNS_NOTHING is the maximal-hide answer: every mapped group on every
    // other tab collapses. Overview is the critical path and opts out entirely.
    const seen: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/service-inventory')) seen.push(r.url());
    });
    await inventory(page, OWNS_NOTHING);
    await page.goto('/#overview');

    await expect(page.getByText('Host Status')).toBeVisible();
    await expect(page.getByText('Top Subnets by Utilization')).toBeVisible();
    await expect(hiddenRow(page)).toHaveCount(0);
    // Overview does not even ask: no tab on the critical path consumes the hook.
    expect(seen).toEqual([]);
  });

  test('the inventory is read once per page load, never on the 30s panel poll', async ({ page }) => {
    // Security's feeds poll every 30s (Security.jsx). Ownership is not a
    // 30s-scale fact and must not join that loop.
    test.setTimeout(90_000);
    const seen: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/service-inventory')) seen.push(r.url());
    });
    await inventory(page, OWNS_NO_SECURITY);
    await page.goto('/#security');
    await expect(hiddenRow(page)).toHaveCount(1);

    // Past two poll ticks.
    await page.waitForTimeout(65_000);
    expect(seen.length).toBe(1);
  });
});
