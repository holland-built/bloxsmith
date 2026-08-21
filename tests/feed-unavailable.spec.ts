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

  // ---- the newest-N cap (issue #169) ---------------------------------------
  //
  // The four tests above are NOT touched, and that is a deliberate part of this
  // change: every one of them posts a payload with no `truncated` key at all,
  // which is what a tab held open across a deploy (or any cached response)
  // sends. They keep passing untouched, so the new gating is proven backwards
  // compatible by tests written before it existed rather than by assertion.
  //
  // What the three below cover is the state the server can now produce
  // (go/internal/server/state.go:145-154, cap `auditLogReturnCap` = 2000):
  // `entries` is the newest page, `total` is the log, and BOTH audit panels
  // compute in the browser over the page while presenting it as the log.
  //
  // Panels are addressed by `data-panel-id` rather than by climbing from their
  // title text. `text=Audit Log` is a case-insensitive substring match, so it
  // also matches "Audit log unavailable" — the string this very tab renders in
  // one of the states under test.
  const AUDIT_LOG_CARD = '[data-panel-id="audit-log"]';
  const SUMMARY_CARD = '[data-panel-id="audit-activity-summary"]';

  // A total far above the two entries sent, so the sentence has to name a
  // figure that exists nowhere in the entries array and cannot be produced by
  // counting rows on screen.
  const TRUNCATED_TOTAL = 400;
  const truncatedAuditLog = (entries: unknown[]) => ({
    ...auditLogPayload(entries),
    // Derived, never a literal `2`: a test whose `returned` disagrees with the
    // array it ships is asserting against a payload the server cannot send.
    returned: entries.length,
    total: TRUNCATED_TOTAL,
    truncated: true,
  });

  // The sentence lib/auditChain.js:truncationNote actually builds, split into
  // the two halves worth pinning: the counts, and the clause about the filter's
  // reach. A looser regex (say /showing/i) would pass on any panel copy that
  // happened to contain the word, which is how a warning gets "proven" by text
  // that is not the warning.
  const truncationCounts = new RegExp(
    `Showing the newest ${CHAIN_ENTRIES.length} of ${TRUNCATED_TOTAL} entries`,
  );
  const truncationScope = /the filter and search below cover only what is shown here, not the rest of the log/;
  // The third half-clause, pinned separately because it answers a different
  // question and can be lost on its own. The cap's stated mitigation is
  // /api/audit/export, and `grep -rn "audit/export" ui/src tests docs README.md`
  // returns nothing: no Export control exists in this app. panelHelp.js records
  // "not downloadable" as intent, so the note points at the log on disk and at
  // the command that locates it, the way ChainVerdict's OfflineCheckHint does.
  const truncationWhereTheRestIs =
    /which stays on the server in audit_log\.jsonl \(bloxsmith audit verify prints its path\)/;

  test('a truncated payload says so on BOTH audit panels', async ({ page }) => {
    await page.route('**/api/audit/log', (route) => fulfillJson(route, truncatedAuditLog(CHAIN_ENTRIES)));
    await page.goto('/#audit');

    // Both, because both compute over the page: the table filters and sorts it,
    // and the summary tallies it. A note on only one of them leaves the other
    // presenting a page-scoped number with nothing beside it saying so.
    for (const sel of [AUDIT_LOG_CARD, SUMMARY_CARD]) {
      const card = page.locator(sel);
      await expect(card.getByText(truncationCounts)).toBeVisible();
      await expect(card.getByText(truncationScope)).toBeVisible();
      await expect(card.getByText(truncationWhereTheRestIs)).toBeVisible();
    }

    // The summary's own chip still counts the rows it was handed. It is the
    // page, the note above it says so, and it must not have quietly become
    // `total` — the rows underneath still sum to this number.
    await expect(page.locator(SUMMARY_CARD).getByText(/2 recorded events/i)).toBeVisible();
  });

  test('on a truncated payload a no-match filter says the search had a horizon', async ({ page }) => {
    // THE LIE THIS FIXES. Filtering happens in the browser over the newest page,
    // so a query matching nothing there rendered a bare "no entries match" while
    // matches sat further back in the log. The empty state was a claim about the
    // log made from a page.
    await page.route('**/api/audit/log', (route) => fulfillJson(route, truncatedAuditLog(CHAIN_ENTRIES)));
    await page.goto('/#audit');

    const card = page.locator(AUDIT_LOG_CARD);
    // Placeholder matched without its ellipsis so the assertion does not hinge
    // on one non-ASCII character in the markup.
    await card.getByPlaceholder('Filter').fill('zzz-matches-nothing-on-this-page');

    await expect(
      card.getByText(
        new RegExp(`The filter searched only the newest ${CHAIN_ENTRIES.length} entries shown here, and older entries were not searched`),
      ),
    ).toBeVisible();
    // And NOT the bare sentence: exact match, because the truncated wording
    // starts with those same three words and a substring check would pass on it.
    await expect(card.getByText('no entries match', { exact: true })).toHaveCount(0);
  });

  test('an untruncated payload adds no warning, and its no-match state stays bare', async ({ page }) => {
    // `truncated: false` explicitly, which is what the server sends whenever the
    // log is under the cap (measured live 2026-08-21: 838 entries, cap 2000).
    // The four tests above already cover the other untruncated shape, a payload
    // with no `truncated` key at all.
    await page.route('**/api/audit/log', (route) =>
      fulfillJson(route, {
        ...auditLogPayload(CHAIN_ENTRIES),
        returned: CHAIN_ENTRIES.length,
        total: CHAIN_ENTRIES.length,
        truncated: false,
      }),
    );
    await page.goto('/#audit');

    // Nothing new on screen. tests/page-baseline.spec.ts-snapshots/audit.aria.yml
    // is a committed accessibility snapshot of this page in exactly this state,
    // so any string that leaks into it here breaks that baseline.
    for (const sel of [AUDIT_LOG_CARD, SUMMARY_CARD]) {
      const card = page.locator(sel);
      await expect(card.getByText(/Showing the newest/)).toHaveCount(0);
      await expect(card.getByText(truncationScope)).toHaveCount(0);
      await expect(card.getByText(truncationWhereTheRestIs)).toHaveCount(0);
    }

    const card = page.locator(AUDIT_LOG_CARD);
    await card.getByPlaceholder('Filter').fill('zzz-matches-nothing-on-this-page');
    await expect(card.getByText('no entries match', { exact: true })).toBeVisible();
    await expect(card.getByText(/older entries were not searched/)).toHaveCount(0);
  });
});
