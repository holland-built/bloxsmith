import { test, expect } from './fixtures';
import type { Page, Route } from '@playwright/test';

// The Assets tab's failure and unknown-total branches, which nothing graded.
//
// WHAT WENT WRONG (holland-built/bloxsmith#141). A mutation round deleted the
// guards in ui/src/tabs/Assets.jsx that separate "this feed could not be read"
// from "this tenant has nothing", and separate "we were not told the total"
// from "the total is zero". Two of those breaks survived the whole existing
// suite: Break 1 removed the `d?.availability === 'error'` half of the
// `unavailable` check on all three panels (L180, L290, L440), and Break 5 made
// an unknown total render as the number 0 (L236, L292). 63 assets-related
// tests ran against the broken tree and all 63 passed. That is the measured
// fact this file exists to change — not a suspicion that coverage was thin, but
// a count of tests that watched the regression go by.
//
// WHY THEY ALL PASSED, and therefore what this file has to do differently. The
// existing assets specs (assets-cold-load, assets-table-width) both feed the
// tab a HEALTHY body and then assert on the rows that come back. A guard that
// only fires on an error body is invisible to a test that never sends one, and
// a `total: null` branch is invisible to a test that always sends a number. So
// every test here stubs a body the server really emits on a bad day — an
// `availability: 'error'` envelope, or `total: null` from a count query that
// failed while the list query did not (go/internal/dashboard/assets.go's
// assetTotal returns Go nil for both, which marshals to JSON null).
//
// WHY EVERY FAILURE TEST HAS A HEALTHY TWIN. The cheapest wrong "fix" for a
// failure test is to route every state through FeedUnavailable — the panel then
// says the feed is down no matter what, and a file of failure-only tests goes
// green on a build that can no longer show an asset at all. So each twin
// asserts REAL POSITIVE CONTENT (50 rows, the Workstation chip, `1–50 of 2,375`,
// the OS field) as well as the absence of any data-feed-unavailable attribute.
// Both halves are load-bearing and neither may be dropped as redundant.
//
// WHY THE LITERALS ARE HAND-WRITTEN. `48` is written `48`, not
// `Math.ceil(2375 / 50)`. An expected value computed with the same arithmetic
// the component uses agrees with the component even when both are wrong, which
// is the one thing an assertion must not do. The two dash characters are
// copied out of Assets.jsx rather than typed: the row-range separator is EN
// DASH U+2013 (L363) and the two failure copies are EM DASH U+2014 (L245,
// L476). A typed hyphen would make these tests born-red against correct code.

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

// ---------- fixture bodies: the shapes assets.go actually puts on the wire ----------

// PAGE_SIZE is 50 (Assets.jsx:29), so a full page 0 spans rows 1–50 exactly.
// The names are distinct because the detail card's title is the clicked row's
// name (L459), and Group 5 clicks the first row.
const ROWS = Array.from({ length: 50 }, (_, i) => ({
  cqid: `fp-${i}`,
  last_seen: '2026-08-10T17:54:44.000',
  name: `host-${i}.example.internal`,
  provider: 'AWS',
  type: 'Workstation',
  vendor: 'Dell Inc.',
}));

const ASSETS_OK = {
  availability: 'ok', dir: 'desc', has_more: true, page: 0, page_size: 50,
  sort: 'last_seen', total: 2375, rows: ROWS,
};
// assetsUnavailable (assets.go:244-256) verbatim. total is nil and has_more is
// false on the wire, and the Go comment above it says why in the terms this
// whole file is about: "0 is a fact about the tenant and this payload knows no
// facts about the tenant."
const ASSETS_ERROR = {
  availability: 'error', reason: 'asset inventory read failed (upstream cube error)',
  dir: 'desc', page: 0, page_size: 50, sort: 'last_seen',
  rows: [], total: null, has_more: false,
};

// The list-side twin of FILTERS_NO_TOTAL: the page of rows came back, the count
// query did not. It carries the full 50 rows because the range label only
// renders when rows.length > 0 (L361) — a rowless fixture would assert nothing.
const ASSETS_NO_TOTAL = {
  availability: 'ok', dir: 'desc', has_more: true, page: 0, page_size: 50,
  sort: 'last_seen', total: null, rows: ROWS,
};

const FILTERS_OK = {
  availability: 'ok', total: 2375,
  types: [{ label: 'Workstation', count: 1103 }, { label: 'Laptop', count: 166 }],
};
// assetFiltersUnavailable (assets.go:600-605) verbatim: an EMPTY types array and
// a nil total ride along with the error flag. Carrying `types: []` matters for
// how the test below is read — it is what makes the "no Workstation chip"
// assertion unable to fail, and therefore not the assertion doing the work.
const FILTERS_ERROR = {
  types: [], total: null,
  availability: 'error', reason: 'asset filter read failed (upstream cube error)',
};
// The exact "the count query failed, the list did not" state Assets.jsx
// L233-235 describes. `total: null` is carried explicitly rather than left off:
// assets.go:662 emits the key with assetTotal's nil in it, so an absent key is a
// body the server never sends. Both `null` and `undefined` fail the
// `typeof === 'number'` test at L236, so the branch is the same either way —
// sending null is what makes this a test of the real response.
const FILTERS_NO_TOTAL = {
  availability: 'ok',
  total: null,
  types: [{ label: 'Workstation', count: 1103 }, { label: 'Laptop', count: 166 }],
};

// cqid rides along on the wire (assets.go:739-747) even though the panel renders
// only the five fields below it — the detail object is the row's identity plus
// its sparse fields, not just the fields.
const DETAIL_OK = {
  availability: 'ok',
  detail: {
    cqid: 'fp-0',
    os: 'Ubuntu 22.04.4 LTS', ip_addresses: '10.0.14.221',
    mac_addresses: '02:5d:6f:8a:11:03', model: 't3.medium', location: 'us-east-1a',
  },
};

// `detail: null` is carried explicitly on both of these: assets.go:703 and :736
// emit the key alongside the availability flag, so a fixture that omits it is a
// shape this server never sends.
const DETAIL_ERROR = {
  detail: null, availability: 'error', reason: 'asset detail read failed (upstream cube error)',
};
const DETAIL_EMPTY = { detail: null, availability: 'empty' };

// ---------- routing ----------

// Every test routes ALL THREE endpoints, including the ones it is not grading.
// An unrouted endpoint reaches the e2e server, which runs against
// INFOBLOX_URL=https://csp.invalid (scripts/e2e.sh) and answers with its own
// availability-error shape after its own latency — so the panel next to the one
// under test would be rendering a body this file did not choose, on a schedule
// it does not control. Defaulting the other two to healthy keeps each test's
// input entirely on this page.
//
// The globs are disjoint: `**/api/csp/assets*` does not match `asset-filters`
// or `asset-detail`, because there is no `s` after `asset` in either.
async function routeAssets(
  page: Page,
  o: { assets?: unknown; filters?: unknown; detail?: unknown } = {},
) {
  await page.route('**/api/csp/assets*', (r) => fulfillJson(r, o.assets ?? ASSETS_OK));
  await page.route('**/api/csp/asset-filters*', (r) => fulfillJson(r, o.filters ?? FILTERS_OK));
  await page.route('**/api/csp/asset-detail*', (r) => fulfillJson(r, o.detail ?? DETAIL_OK));
}

// Cards are located by panelId, not by title. ui.jsx:2278 puts data-panel-id on
// the very div that carries bg-card, so the attribute selector IS the card — no
// ancestor hop and no .first() quietly choosing between two matches. It also
// keeps the locator off fixture data: the detail card's title is the clicked
// row's name, so a title-based locator would couple card identity to ROWS[0].
const panel = (page: Page, id: string) => page.locator(`[data-panel-id="${id}"]`);

// None of these tests grade the vault gate, and a transient failure of
// /api/vault/status replaces the whole dashboard with "Vault status
// unavailable" — the same pin failure-not-absence-4.spec.ts carries, for the
// same reason: an unrelated outage must not read as an asset-panel regression.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/vault/status*', (route) => fulfillJson(route, { vaultMode: false, ready: true }));
});

// ---------- 1. the inventory list read fails ----------

test.describe('Assets → inventory list (availability:"error")', () => {
  test('a failed inventory read says the feed is unavailable, never "no assets discovered"', async ({ page }) => {
    await routeAssets(page, { assets: ASSETS_ERROR });
    await page.goto('/#assets');

    const list = panel(page, 'assets-list');
    await expect(list.locator('[data-feed-unavailable="Asset inventory unavailable"]')).toBeVisible();
    await expect(list.getByText('Asset inventory unavailable')).toBeVisible();

    // THE ASSERTION WITH TEETH. `rows: []` arrives on the error body too, so
    // once L290's guard stops firing the same fixture falls through to L375-376
    // and the panel tells the operator this tenant owns no assets. That is the
    // regression, stated as the copy it produces.
    await expect(list.getByText('no assets discovered for this tenant')).toHaveCount(0);
    await expect(list.locator('tbody tr')).toHaveCount(0);
  });

  test('a healthy inventory read renders its 50 rows and claims no failure', async ({ page }) => {
    await routeAssets(page);
    await page.goto('/#assets');

    const list = panel(page, 'assets-list');
    // 50 is the whole page: DataTable renders sorted.slice(0, rowCap) with
    // rowCap = PAGE_SIZE and no virtualization, so every row is in the DOM.
    await expect(list.locator('tbody tr')).toHaveCount(50);
    await expect(list.getByText('host-0.example.internal')).toBeVisible();

    await expect(list.locator('[data-feed-unavailable]')).toHaveCount(0);
    await expect(list.getByText('no assets discovered for this tenant')).toHaveCount(0);
  });
});

// ---------- 2. the filter-chip read fails ----------

test.describe('Assets → filter bar (availability:"error")', () => {
  test('a failed filter read says the feed is unavailable, never "no asset types recorded"', async ({ page }) => {
    await routeAssets(page, { filters: FILTERS_ERROR });
    await page.goto('/#assets');

    const bar = panel(page, 'assets-filter-bar');
    await expect(bar.locator('[data-feed-unavailable="Asset filter feed unavailable"]')).toBeVisible();

    // THE ASSERTION WITH TEETH, and it is the line directly below, not the one
    // after it. FILTERS_ERROR carries `types: []` exactly as the server does, so
    // once L180's guard stops firing this body falls through to the L249-250
    // branch and the panel states as fact that the tenant has no asset types.
    await expect(bar.getByText('no asset types recorded for this tenant')).toHaveCount(0);
    // Belt and braces, and honestly labelled as such: with `types: []` on the
    // wire no chip can render on this path in EITHER the correct or the broken
    // build, so this line cannot fail and must not be mistaken for the guard.
    // It is kept because it costs nothing and would catch a fixture edit that
    // quietly started sending types on an error body.
    await expect(bar.getByRole('button', { name: /Workstation/ })).toHaveCount(0);
  });

  test('a healthy filter read renders its chips and claims no failure', async ({ page }) => {
    await routeAssets(page);
    await page.goto('/#assets');

    const bar = panel(page, 'assets-filter-bar');
    const workstation = bar.getByRole('button', { name: /Workstation/ });
    await expect(workstation).toBeVisible();
    // Unpressed, i.e. the chip is an offer and not an active filter — the state
    // a "route everything through FeedUnavailable" build cannot produce.
    await expect(workstation).toHaveAttribute('aria-pressed', 'false');
    await expect(bar.getByText('1,103')).toBeVisible();
    await expect(bar.getByRole('button', { name: /Laptop/ })).toBeVisible();

    await expect(bar.locator('[data-feed-unavailable]')).toHaveCount(0);
    await expect(bar.getByText('no asset types recorded for this tenant')).toHaveCount(0);
  });
});

// ---------- 3. the filter bar's total is unknown ----------

test.describe('Assets → filter bar total (unknown is not zero)', () => {
  test('an unreported total says the count query failed, and never prints 0', async ({ page }) => {
    await routeAssets(page, { filters: FILTERS_NO_TOTAL });
    await page.goto('/#assets');

    const bar = panel(page, 'assets-filter-bar');
    await expect(
      bar.getByText('total unavailable — the count query failed, the list below did not'),
    ).toBeVisible();
    // The chips still render, and that IS the state being described: the count
    // query died and the type query did not. A test that only checked the
    // warning line would pass on a build that had lost the chips as well.
    await expect(bar.getByRole('button', { name: /Workstation/ })).toBeVisible();

    await expect(bar.getByText('assets discovered')).toHaveCount(0);
    await expect(bar.getByText('0', { exact: true })).toHaveCount(0);
  });

  test('a real total is printed as a number, with no unavailable wording', async ({ page }) => {
    await routeAssets(page);
    await page.goto('/#assets');

    const bar = panel(page, 'assets-filter-bar');
    await expect(bar.getByText('2,375', { exact: true })).toBeVisible();
    await expect(bar.getByText('assets discovered')).toBeVisible();
    await expect(bar.getByText(/total unavailable/)).toHaveCount(0);
  });
});

// ---------- 4. the inventory feed's total is unknown ----------

// THE EXACT-MATCH toBeVisible LINES ARE THE DISCRIMINATOR — not the toHaveCount(0)
// lines under them. Page 0 of 50 rows makes the range label's whole text `1–50`,
// so `getByText('1–50', { exact: true })` fails the moment ` of 0` is appended.
// A substring match would pass on both the correct render and the regression.
//
// The `/1–50 of/` and `/Page 1 of/` counts below are IMPLIED by that: on a single
// label element the bare and suffixed forms are mutually exclusive, so those lines
// can only fire if the panel renders the label twice. They stay as a cheap guard
// against exactly that — but if anyone ever trims this test, the exact-match
// visibility assertions are the ones that must survive.
test.describe('Assets → range label + pager (unknown is not zero)', () => {
  test('an unreported total leaves the range and page bare, and never says "of 0"', async ({ page }) => {
    await routeAssets(page, { assets: ASSETS_NO_TOTAL });
    await page.goto('/#assets');

    const list = panel(page, 'assets-list');
    await expect(list.getByText('1–50', { exact: true })).toBeVisible();
    await expect(list.getByText('Page 1', { exact: true })).toBeVisible();
    // has_more on its own must keep paging alive (L409-410). A build that
    // needed a total to offer Next would strand the operator on page 1 of a
    // list it just told them has more.
    await expect(list.getByRole('button', { name: 'Next →' })).toBeEnabled();

    await expect(list.getByText(/of 0/)).toHaveCount(0);
    await expect(list.getByText(/1–50 of/)).toHaveCount(0);
    await expect(list.getByText(/Page 1 of/)).toHaveCount(0);
  });

  test('a known total is printed in both the range and the page count', async ({ page }) => {
    await routeAssets(page);
    await page.goto('/#assets');

    const list = panel(page, 'assets-list');
    await expect(list.getByText('1–50 of 2,375', { exact: true })).toBeVisible();
    // 48 is hand-written: 2,375 assets at 50 a page is 48 pages, the last one
    // partial. Deriving it with Math.ceil here would agree with the component
    // even if the component's own arithmetic were wrong.
    await expect(list.getByText('Page 1 of 48', { exact: true })).toBeVisible();

    // Implied by the two exact-match assertions above, for the reason given at
    // the top of this describe: kept as a duplicate-label guard, not as the
    // thing that catches a dropped total.
    await expect(list.getByText('1–50', { exact: true })).toHaveCount(0);
    await expect(list.getByText('Page 1', { exact: true })).toHaveCount(0);
  });
});

// ---------- 5. the row detail: three states that must not collapse into two ----------

// The detail panel is the one place in the tab where "the read broke" and "the
// asset is gone" are genuinely different events with different next steps — an
// asset can be decommissioned between the page load and the click, and telling
// someone the feed is down when the machine was simply deleted sends them to
// debug the wrong system. Assets.jsx keeps them apart at L469 and L471; these
// three tests keep all three outcomes distinguishable.
//
// The detail card only mounts after a row click (L152), so each test opens the
// list first. Sorting is server-side (L343-346), so the served order is the
// rendered order and the first row is ROWS[0].
async function openFirstRow(page: Page) {
  await page.goto('/#assets');
  await panel(page, 'assets-list').locator('tbody tr').first().click();
  const detail = panel(page, 'assets-detail');
  await expect(detail).toBeVisible();
  return detail;
}

test.describe('Assets → detail (three states)', () => {
  test('a failed detail read says the feed is unavailable, not that the asset is gone', async ({ page }) => {
    await routeAssets(page, { detail: DETAIL_ERROR });
    const detail = await openFirstRow(page);

    await expect(detail.locator('[data-feed-unavailable="Asset detail unavailable"]')).toBeVisible();

    await expect(detail.getByText(/this asset no longer exists/)).toHaveCount(0);
    // No field grid either: a dl of "not recorded" rows is the third wrong
    // answer here, and it reads as an asset nobody has ever written anything
    // down about rather than as a lookup that failed.
    await expect(detail.getByText('OS', { exact: true })).toHaveCount(0);
  });

  test('a deleted asset says it was removed, and claims no feed failure', async ({ page }) => {
    await routeAssets(page, { detail: DETAIL_EMPTY });
    const detail = await openFirstRow(page);

    await expect(
      detail.getByText('this asset no longer exists — it was removed since the list loaded'),
    ).toBeVisible();

    await expect(detail.locator('[data-feed-unavailable]')).toHaveCount(0);
    await expect(detail.getByText('not recorded')).toHaveCount(0);
  });

  test('a healthy detail read renders its fields and claims no failure', async ({ page }) => {
    await routeAssets(page);
    const detail = await openFirstRow(page);

    for (const label of ['OS', 'IP addresses', 'MAC addresses']) {
      await expect(detail.getByText(label, { exact: true })).toBeVisible();
    }
    for (const value of ['Ubuntu 22.04.4 LTS', '10.0.14.221', '02:5d:6f:8a:11:03']) {
      await expect(detail.getByText(value, { exact: true })).toBeVisible();
    }

    await expect(detail.locator('[data-feed-unavailable]')).toHaveCount(0);
    await expect(detail.getByText(/this asset no longer exists/)).toHaveCount(0);
  });
});
