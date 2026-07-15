import { test, expect } from '@playwright/test';

// Feature 6 — time-as-preset (`last:Nh`/`last:Nd`/`last:Nm`). A BQL predicate,
// NOT a global topbar control (a global time picker was rejected in debate: it
// would re-break the deep-link hash, snapshot keys, and saved-view definitions).
// `last` aliases onto the same synthetic `age` field deriveSchema already
// detects from the Security triage table's `event_time` column (index.html
// ~1210 builtin aliases, ~1198-1208 ageKey detection) — so `last:Nh` rides the
// EXISTING ageMatch comparator (~1272), no new predicate branch.
//
// This worktree's normal :8080 target is a Docker image build owned by a
// concurrent session; point this spec at a locally-run `server.py` instance
// instead (same pattern as palette-actions.spec.ts / copy-link.spec.ts).
test.use({ baseURL: process.env.NOC_BASE || 'http://localhost:8091' });

// Timestamps computed relative to the real Date.now() at test run time (never
// a fixed wall-clock), so the "last:24h" / "last:7d" windows are always correct
// regardless of when this spec runs.
function buildSecurity() {
  const now = Date.now();
  const H = 3600000, M = 60000, D = 86400000;
  return {
    counts: { critical: 0, high: 0, medium: 0, low: 3 },
    blocked: 0, logged: 3, total: 3,
    events: [
      { severity: 'low', qname: 'recent.example', policy_action: 'log', feed_name: 'f1', device: 'd1',
        event_time: new Date(now - 10 * M).toISOString() },   // 10 min ago
      { severity: 'low', qname: 'fresh.example', policy_action: 'log', feed_name: 'f2', device: 'd2',
        event_time: new Date(now - 1 * H).toISOString() },    // 1h ago
      { severity: 'low', qname: 'stale.example', policy_action: 'log', feed_name: 'f3', device: 'd3',
        event_time: new Date(now - 10 * D).toISOString() },   // 10 days ago — out of window for last:24h AND last:7d
    ],
  };
}

// The #security page renders MANY DataTables now (threat feeds, named lists,
// security policies, roaming countries, hosts inventory — all fed by
// /api/hub/domains, which this spec deliberately does NOT mock). A bare
// `table.dt tbody tr` matches every row on the page (754 against a real
// tenant), not just the triage inbox this spec is about.
//
// Scope to the triage table instead. DataTable stamps each row with
// `id="<tableId>-r-<i>"` (rowIdOf), and the triage inbox is the only table
// built with tableId="triage" — so the row id prefix is a stable anchor.
const ROWS = 'table.dt tbody tr[id^="triage-r-"]';
// ...and its search box is the .dt-filter in the same DataTable wrapper: the
// element that owns a .dt-toolbar directly AND contains the triage rows.
const FILTER = 'div:has(> .dt-toolbar):has(tr[id^="triage-r-"]) .dt-filter';

async function mockSecurity(page) {
  await page.route('**/api/hub/security', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildSecurity()) })
  );
}

test('typing last:24h in the search box filters to recent rows and excludes the out-of-window row', async ({ page }) => {
  await mockSecurity(page);
  await page.goto('/#security');

  const rows = page.locator(ROWS);
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: 'stale.example' })).toHaveCount(1);

  const filter = page.locator(FILTER);
  await filter.fill('last:24h');

  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'recent.example' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'fresh.example' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'stale.example' })).toHaveCount(0);
});

test('palette "Last 24h" preset injects last:24h into the active table search and narrows it', async ({ page }) => {
  await mockSecurity(page);
  await page.goto('/#security');

  const rows = page.locator(ROWS);
  await expect(rows).toHaveCount(3);

  await page.keyboard.press('Meta+k');
  const input = page.locator('.palette-in');
  await expect(input).toBeVisible();
  await input.fill('last 24h');

  // hasText does case-insensitive substring matching, which would also match
  // the typed "Ask: last 24h" / "Block domain: last 24h" rows — anchor on the
  // exact label span instead.
  const item = page.locator('.pal-row').filter({ has: page.locator('span', { hasText: /^Last 24h$/ }) });
  await expect(item).toBeVisible();
  await item.click();

  // Palette closes after running the action.
  await expect(page.locator('.palette-in')).toHaveCount(0);

  // Same input F4 (typeahead) uses — the token rides the normal query path.
  const filter = page.locator(FILTER);
  await expect(filter).toHaveValue('last:24h');

  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'stale.example' })).toHaveCount(0);
});

test('palette "Last 7d" preset includes the 1h/10m rows but still excludes the 10-day-old row', async ({ page }) => {
  await mockSecurity(page);
  await page.goto('/#security');

  const rows = page.locator(ROWS);
  await expect(rows).toHaveCount(3);

  await page.keyboard.press('Meta+k');
  const input = page.locator('.palette-in');
  await expect(input).toBeVisible();
  await input.fill('last 7d');

  const item = page.locator('.pal-row').filter({ has: page.locator('span', { hasText: /^Last 7d$/ }) });
  await expect(item).toBeVisible();
  await item.click();

  const filter = page.locator(FILTER);
  await expect(filter).toHaveValue('last:7d');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'stale.example' })).toHaveCount(0);
});
