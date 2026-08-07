import { test, expect } from './fixtures';

// P4, the DOM half. The unit half — the 24 h window, the grouping, the four
// notability categories and the midpoint-split actor rule — is proved without a
// browser in ui/src/lib/changes.test.js under `cd ui && npm test`. What only a
// browser can show is that Changes.jsx actually renders those shapes: that a
// row outside the window never reaches the page, that rows sit under a group
// header for their resource, that the cap banner appears exactly when
// `truncated` is true, and that all four band cells are on screen with a state
// of their own.
//
// NOT YET RUN. `#changes` is registered in ui/src/App.jsx by the item-4 stitch,
// which is a different agent's change; until that lands every goto('/#changes')
// falls through App.jsx's unknown-hash rule to the Overview tab and these specs
// fail for a reason that has nothing to do with Changes.jsx. Run them with the
// rest of the suite once the tab is registered.
//
// Every payload below is faked with page.route, so nothing here depends on what
// the live tenant happened to be doing.

const HOUR = 60 * 60 * 1000;

function fulfillJson(route: import('@playwright/test').Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

// The row shape measured from the live server on 2026-08-06:
// action, id, resource, result, ts, user, who_kind, who_role. The timestamp is
// `ts` — `created_at` is the upstream ordering param and is not a field here.
function row(over: Partial<Record<string, string>> & { ts: string; id: string }) {
  return {
    action: 'UPDATE',
    resource: 'addressservice',
    result: 'success',
    user: 'provider_id.aaaa',
    who_kind: 'service',
    who_role: 'ib-x-cloud-discovery-admin',
    ...over,
  };
}

const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();

// A past instant whose LOCAL hour is out of hours (>= 20:00 or < 08:00) and
// which is still inside the last 24 h. Twelve of any 24 consecutive hours are
// out of hours, so this always finds one wherever the runner's clock is set.
function outOfHoursAgoIso(): string {
  for (let h = 1; h < 24; h++) {
    const d = new Date(Date.now() - h * HOUR);
    const hour = d.getHours();
    if (hour >= 20 || hour < 8) return d.toISOString();
  }
  throw new Error('no out-of-hours instant inside the last 24 h — impossible, check the clock');
}

// Six hours of span (so the midpoint split has an earlier half to compare
// against), three actors, one deletion and one failure.
//
// The out-of-hours row is deliberately NOT in here. Its timestamp has to land
// on a local hour outside 08:00–20:00, which on some runner clocks is 20 h ago
// — that would stretch the span, drag the midpoint back past 6 h, and change
// which actors count as new. The out-of-hours case gets its own payload below
// so this one's midpoint stays where it can be worked out by hand: earliest
// 6 h ago, latest ~now, so the split sits at about 3 h ago.
function liveWindow(over: { truncated?: boolean } = {}) {
  const rows = [
    row({ id: 'r1', ts: agoIso(6 * HOUR), user: 'actor-old', resource: 'auth_zone' }),
    row({ id: 'r2', ts: agoIso(5 * HOUR), user: 'actor-both', resource: 'addressservice' }),
    row({ id: 'r3', ts: agoIso(4 * HOUR), user: 'actor-old', action: 'DELETE', resource: 'dnsrecord' }),
    row({ id: 'r4', ts: agoIso(3 * HOUR - 60 * 1000), user: 'actor-both', resource: 'subnetservice' }),
    row({ id: 'r5', ts: agoIso(1 * HOUR), user: 'actor-new', result: 'failed: denied', resource: 'addressservice' }),
    row({ id: 'r6', ts: agoIso(2 * 60 * 1000), user: 'actor-both', resource: 'addressservice' }),
  ];
  return { count: rows.length, rows, status: 'ok', truncated: over.truncated ?? false };
}

const band = (page: import('@playwright/test').Page, key: string) =>
  page.locator(`[data-changes-cell="${key}"]`);

const feedTable = (page: import('@playwright/test').Page) =>
  page.getByRole('table', { name: /changed objects/i });

test.describe('#changes — what changed in the last 24 hours', () => {
  test('(a) a row outside the 24 h window never reaches the page', async ({ page }) => {
    const payload = liveWindow();
    payload.rows.push(
      row({ id: 'too-old', ts: agoIso(30 * HOUR), resource: 'resource-from-last-week' }),
      // Ahead of the browser clock, so also not "within the last 24 hours".
      row({ id: 'future', ts: new Date(Date.now() + HOUR).toISOString(), resource: 'resource-from-the-future' }),
    );
    await page.route('**/api/csp-audit*', (route) => fulfillJson(route, payload));
    await page.goto('/#changes');

    await expect(page.locator('[data-changes-group]').first()).toBeVisible();
    await expect(page.getByText('resource-from-last-week')).toHaveCount(0);
    await expect(page.getByText('resource-from-the-future')).toHaveCount(0);
    // The span bar counts only what is listed, so it must not count the two.
    await expect(page.locator('[data-changes-span]')).toContainText('6');
  });

  test('(b) rows are grouped by resource, one header per resource', async ({ page }) => {
    await page.route('**/api/csp-audit*', (route) => fulfillJson(route, liveWindow()));
    await page.goto('/#changes');

    const groups = page.locator('[data-changes-group]');
    await expect(groups).toHaveCount(4); // addressservice, subnetservice, dnsrecord, auth_zone
    await expect(page.locator('[data-changes-group="addressservice"]')).toContainText('3 rows');
    await expect(page.locator('[data-changes-group="dnsrecord"]')).toContainText('1 row');
  });

  test('(c) the cap banner is in the DOM exactly when truncated is true', async ({ page }) => {
    await page.route('**/api/csp-audit*', (route) => fulfillJson(route, liveWindow({ truncated: true })));
    await page.goto('/#changes');

    const banner = page.locator('[data-changes-cap]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('500');
    await expect(banner).toContainText(/most recent/i);
    // The screen must never claim it is showing the whole day's activity.
    await expect(banner).not.toContainText(/everything/i);
  });

  test('(c) an untruncated response shows no cap banner', async ({ page }) => {
    await page.route('**/api/csp-audit*', (route) => fulfillJson(route, liveWindow({ truncated: false })));
    await page.goto('/#changes');

    await expect(page.locator('[data-changes-group]').first()).toBeVisible();
    await expect(page.locator('[data-changes-cap]')).toHaveCount(0);
  });

  test('(d) all four notability categories render, each with a state of its own', async ({ page }) => {
    await page.route('**/api/csp-audit*', (route) => fulfillJson(route, liveWindow()));
    await page.goto('/#changes');

    for (const key of ['deletions', 'failures', 'outOfHours', 'newActors']) {
      await expect(band(page, key)).toBeVisible();
      await expect(band(page, key)).toHaveAttribute('data-state', /populated|none|unknown/);
    }
    await expect(band(page, 'deletions')).toHaveAttribute('data-state', 'populated');
    await expect(band(page, 'failures')).toHaveAttribute('data-state', 'populated');
    // outOfHours is intentionally left to /populated|none/ above: this payload
    // is pinned to the last six hours, and whether those hours are out of hours
    // depends on the runner's own clock. The dedicated case is below.
  });

  test('(d) an out-of-hours row is counted and flagged', async ({ page }) => {
    const rows = [
      row({ id: 'o1', ts: outOfHoursAgoIso(), user: 'actor-a' }),
      row({ id: 'o2', ts: agoIso(2 * 60 * 1000), user: 'actor-a' }),
    ];
    await page.route('**/api/csp-audit*', (route) =>
      fulfillJson(route, { count: rows.length, rows, status: 'ok', truncated: false }),
    );
    await page.goto('/#changes');

    await expect(band(page, 'outOfHours')).toHaveAttribute('data-state', 'populated');
    await expect(page.getByText('OOH').first()).toBeVisible();
  });

  test('(d) an empty category says "None" rather than disappearing', async ({ page }) => {
    const rows = [
      row({ id: 'q1', ts: agoIso(6 * HOUR), user: 'actor-a' }),
      row({ id: 'q2', ts: agoIso(3 * HOUR), user: 'actor-a' }),
      row({ id: 'q3', ts: agoIso(10 * 60 * 1000), user: 'actor-a' }),
    ];
    await page.route('**/api/csp-audit*', (route) =>
      fulfillJson(route, { count: rows.length, rows, status: 'ok', truncated: false }),
    );
    await page.goto('/#changes');

    await expect(band(page, 'deletions')).toHaveAttribute('data-state', 'none');
    await expect(band(page, 'deletions')).toContainText('None');
    await expect(band(page, 'deletions')).toContainText('0');
  });

  test('the out-of-hours caption states the 20:00–08:00 local rule in words', async ({ page }) => {
    await page.route('**/api/csp-audit*', (route) => fulfillJson(route, liveWindow()));
    await page.goto('/#changes');

    const cell = band(page, 'outOfHours');
    await expect(cell).toContainText('20:00');
    await expect(cell).toContainText('08:00');
    await expect(cell).toContainText(/local/i);
  });

  test('the new-actor rule reports the actor that only appears in the recent half', async ({ page }) => {
    await page.route('**/api/csp-audit*', (route) => fulfillJson(route, liveWindow()));
    await page.goto('/#changes');

    const cell = band(page, 'newActors');
    await expect(cell).toHaveAttribute('data-state', 'populated');
    await expect(cell).toContainText('actor-new');
    // actor-both acted in both halves and actor-old only in the earlier one.
    await expect(cell).not.toContainText('actor-both');
    await expect(cell).not.toContainText('actor-old');
    await expect(cell).toContainText(/half/i);
  });

  test('the 500-row cap makes the new-actor answer "not enough history", not a zero', async ({ page }) => {
    await page.route('**/api/csp-audit*', (route) => fulfillJson(route, liveWindow({ truncated: true })));
    await page.goto('/#changes');

    const cell = band(page, 'newActors');
    await expect(cell).toHaveAttribute('data-state', 'unknown');
    await expect(cell).toContainText(/not enough history in this window/i);
    // A 0 in the number lane would be read as "no new actors", which is the
    // misreading this whole guard exists to prevent.
    await expect(cell).toContainText('—');
  });

  test('under two hours of data is also "not enough history"', async ({ page }) => {
    const rows = [
      row({ id: 's1', ts: agoIso(40 * 60 * 1000), user: 'actor-a' }),
      row({ id: 's2', ts: agoIso(5 * 60 * 1000), user: 'actor-b' }),
    ];
    await page.route('**/api/csp-audit*', (route) =>
      fulfillJson(route, { count: rows.length, rows, status: 'ok', truncated: false }),
    );
    await page.goto('/#changes');

    const cell = band(page, 'newActors');
    await expect(cell).toHaveAttribute('data-state', 'unknown');
    await expect(cell).toContainText(/not enough history in this window/i);
  });

  test('a failed upstream read renders unavailable wording, never an empty window', async ({ page }) => {
    // csp.go answers HTTP 200 with {rows:[],count:0,status:"error"} when the
    // portal read fails. "Nothing changed in the last 24 hours" would be a lie
    // the size of the whole tenant.
    await page.route('**/api/csp-audit*', (route) =>
      fulfillJson(route, { count: 0, rows: [], status: 'error', truncated: false }),
    );
    await page.goto('/#changes');

    await expect(page.getByText(/csp audit feed unavailable/i).first()).toBeVisible();
    await expect(page.getByText(/nothing changed in the last 24 hours/i)).toHaveCount(0);
    // No band either: four "None" cells would answer four questions nobody
    // could actually ask.
    await expect(page.locator('[data-changes-band]')).toHaveCount(0);
  });

  test('a healthy but silent window is empty, not unavailable', async ({ page }) => {
    await page.route('**/api/csp-audit*', (route) =>
      fulfillJson(route, { count: 0, rows: [], status: 'ok', truncated: false }),
    );
    await page.goto('/#changes');

    await expect(page.getByText(/nothing changed in the last 24 hours/i)).toBeVisible();
    await expect(page.getByText(/csp audit feed unavailable/i)).toHaveCount(0);
  });

  test('the request asks the server for the last 24 h', async ({ page }) => {
    let requested = '';
    await page.route('**/api/csp-audit*', (route) => {
      requested = route.request().url();
      return fulfillJson(route, liveWindow());
    });
    await page.goto('/#changes');
    await expect(page.locator('[data-changes-group]').first()).toBeVisible();

    const since = new URL(requested).searchParams.get('since');
    expect(since).not.toBeNull();
    const sinceMs = Date.parse(since as string);
    const age = Date.now() - sinceMs;
    // 24 h back, give or take the seconds the page took to load.
    expect(age).toBeGreaterThan(23.9 * HOUR);
    expect(age).toBeLessThan(24.1 * HOUR);
  });

  // ---- accessibility audit, 2026-08-07 ----
  //
  // Measured before the fix: the feed held 0 tables, 0 lists and 0 role="row",
  // and its whole aria snapshot was a single text run — "2026-08-07 04:36:47
  // UPDATE success actor-both service OOH" with no column name attached to any
  // value, and group names as plain divs nothing could jump to.

  test('(e) the feed is a table whose columns are named in order', async ({ page }) => {
    await page.route('**/api/csp-audit*', (route) => fulfillJson(route, liveWindow()));
    await page.goto('/#changes');

    const feed = page.getByRole('table', { name: /changed objects/i });
    await expect(feed).toBeVisible();

    // Seven headers, in the locked order from the design. The first lane is the
    // colour rail, which has no visible label, so it carries a screen-reader-only
    // one — a nameless column would leave its cells announced against nothing.
    const headers = feed.getByRole('columnheader');
    await expect(headers).toHaveCount(7);
    await expect(headers.nth(0)).toHaveText('Severity');
    await expect(headers.nth(1)).toHaveText('Local time');
    await expect(headers.nth(2)).toHaveText('Op');
    await expect(headers.nth(3)).toHaveText('Result');
    await expect(headers.nth(4)).toHaveText('Actor');
    await expect(headers.nth(5)).toHaveText('Kind');
    await expect(headers.nth(6)).toHaveText('Flags');
  });

  test('(e) each value in a row sits at the column index its header sits at', async ({ page }) => {
    await page.route('**/api/csp-audit*', (route) => fulfillJson(route, liveWindow()));
    await page.goto('/#changes');

    // r3 — the only DELETE in the payload, so this locator cannot drift onto
    // another row. Its fields are hand-written from liveWindow() above, never
    // read back out of the page.
    // A regex, not a bare string: `hasText: 'DELETE'` matches case-insensitively,
    // which would also catch the dnsrecord group header's "1 deleted".
    const deleted = page.getByRole('row').filter({ hasText: /DELETE/ });
    await expect(deleted).toHaveCount(1);
    const cells = deleted.getByRole('cell');
    await expect(cells.nth(2)).toHaveText('DELETE');
    await expect(cells.nth(3)).toHaveText('success');
    await expect(cells.nth(4)).toHaveText('actor-old');
    await expect(cells.nth(5)).toHaveText('service');

    // aria-colindex is what makes that alignment a promise rather than a
    // coincidence of source order, and it is 1-based.
    await expect(cells.nth(2)).toHaveAttribute('aria-colindex', '3');
    await expect(cells.nth(4)).toHaveAttribute('aria-colindex', '5');
    await expect(feedTable(page)).toHaveAttribute('aria-colcount', '7');
  });

  test('(e) every resource group is a heading a screen reader can jump to', async ({ page }) => {
    await page.route('**/api/csp-audit*', (route) => fulfillJson(route, liveWindow()));
    await page.goto('/#changes');

    // The four resources in liveWindow(), each named once at level 3 under the
    // "Changed objects" card heading. Scoped to the feed so a heading added
    // elsewhere on the page cannot make this count wrong.
    const headings = feedTable(page).getByRole('heading', { level: 3 });
    await expect(headings).toHaveCount(4);
    for (const resource of ['addressservice', 'subnetservice', 'dnsrecord', 'auth_zone']) {
      await expect(feedTable(page).getByRole('heading', { level: 3, name: resource })).toBeVisible();
    }

    // And each group is its own labelled row group, so the rows underneath a
    // heading are bound to it rather than merely following it.
    await expect(page.getByRole('rowgroup', { name: /^addressservice/ })).toHaveCount(1);
  });

  test('(f) the cap region exists before the message does', async ({ page }) => {
    // Held open until the test releases it, so the page is observed in the
    // state where the answer has not arrived yet.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/csp-audit*', async (route) => {
      await held;
      return fulfillJson(route, liveWindow({ truncated: true }));
    });
    await page.goto('/#changes');

    // Still loading: the live region is already in the DOM, and empty.
    const region = page.locator('[data-changes-cap-region]');
    await expect(region).toHaveCount(1);
    await expect(region).toHaveAttribute('role', 'status');
    await expect(region).toHaveText('');
    await expect(page.locator('[data-changes-cap]')).toHaveCount(0);

    release();

    // The message lands INSIDE the region that was already there — the region
    // is not created carrying it.
    await expect(region.locator('[data-changes-cap]')).toBeVisible();
    await expect(region).toContainText('500');
  });

  test('(f) the cap region stays in place on an untruncated response', async ({ page }) => {
    await page.route('**/api/csp-audit*', (route) => fulfillJson(route, liveWindow({ truncated: false })));
    await page.goto('/#changes');

    await expect(page.locator('[data-changes-group]').first()).toBeVisible();
    const region = page.locator('[data-changes-cap-region]');
    await expect(region).toHaveCount(1);
    await expect(region).toHaveText('');
  });

  test('(f) the unknown answer is a word, not only an em-dash', async ({ page }) => {
    await page.route('**/api/csp-audit*', (route) => fulfillJson(route, liveWindow({ truncated: true })));
    await page.goto('/#changes');

    const cell = band(page, 'newActors');
    await expect(cell).toHaveAttribute('data-state', 'unknown');
    // The dash is still what the eye sees.
    await expect(cell.locator('[aria-hidden="true"]')).toHaveText('—');
    // An em-dash on its own is announced as nothing at all, so the number lane
    // also carries the word the dash stands for.
    await expect(cell.locator('.sr-only')).toHaveText('Not answered');
  });
});
