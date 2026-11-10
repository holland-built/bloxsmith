import { test, expect } from './fixtures';

// Two regressions closed in the Audit tab (ui/src/tabs/Audit.jsx):
//
// 1. CSP Portal Audit used to sit on "enter a search to query the CSP audit
//    feed" until the user guessed to click Search, even though an empty
//    query returns the last 500 rows of real activity (csp.go CSPAudit adds
//    no _filter clause when q is blank). It now loads on mount; the search
//    box filters that same feed.
//
// 2. /api/audit/log carries a tamper verdict for the local Bloxsmith audit
//    chain (chain_valid / broken_index / chain_verify_error) that nothing in
//    the UI surfaced. It's rendered as one of three non-overlapping states —
//    intact, tampered, or not verified — and a fetch failure is folded into
//    "not verified" rather than silently reading as "chain is fine".
//
// 3. (2026-11-10) The verdict was the palest line on the page, inside the
//    Audit Log card. It is now the headline tile at the top of the page, in a
//    region named "Can you trust this log", and each state carries its own
//    data-verdict (ok / crit / warn) so a broken or unknown log can never be
//    styled like an intact one.

function fulfillJson(route: import('@playwright/test').Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

const CSP_ROW = {
  ts: '2026-07-28T12:00:00Z',
  user: 'alice@example.com',
  who_kind: 'person',
  action: 'UPDATE',
  resource: 'zone/corp.example.com',
  result: 'success',
};

test.describe('CSP Portal Audit — loads on mount', () => {
  test('rows render on arrival, without clicking Search', async ({ page }) => {
    await page.route('**/api/csp-audit*', (route) =>
      fulfillJson(route, { rows: [CSP_ROW], count: 1, truncated: false, status: 'ok' }),
    );
    await page.goto('/#audit');
    const card = page.getByText('CSP Portal Audit', { exact: true }).locator('..').locator('..');
    // No fill(), no click() — the row must already be there.
    await expect(card.getByText('alice@example.com')).toBeVisible();
    await expect(card.getByText('zone/corp.example.com')).toBeVisible();
  });

  test('status:"error" on the mount-time load still shows unavailable wording', async ({ page }) => {
    await page.route('**/api/csp-audit*', (route) =>
      fulfillJson(route, { rows: [], count: 0, truncated: false, status: 'error' }),
    );
    await page.goto('/#audit');
    const card = page.getByText('CSP Portal Audit', { exact: true }).locator('..').locator('..');
    await expect(card.getByText(/CSP audit feed unavailable/i)).toBeVisible();
  });

  test('a genuinely empty feed on mount gets its own wording, not the error one', async ({ page }) => {
    await page.route('**/api/csp-audit*', (route) =>
      fulfillJson(route, { rows: [], count: 0, truncated: false, status: 'ok' }),
    );
    await page.goto('/#audit');
    const card = page.getByText('CSP Portal Audit', { exact: true }).locator('..').locator('..');
    await expect(card.getByText(/nothing here yet/i)).toBeVisible();
    await expect(card.getByText(/CSP audit feed unavailable/i)).toHaveCount(0);
  });
});

test.describe('Audit — the trust verdict leads the page', () => {
  const trust = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Can you trust this log' });
  const verdict = (page: import('@playwright/test').Page) => trust(page).locator('[data-verdict]');

  test('chain_valid:true shows intact wording, not tamper wording', async ({ page }) => {
    await page.route('**/api/audit/log*', (route) =>
      fulfillJson(route, { entries: [], chain_valid: true, broken_index: null, chain_verify_error: null }),
    );
    await page.goto('/#audit');
    await expect(trust(page).getByText(/^Intact$/)).toBeVisible();
    await expect(verdict(page)).toHaveAttribute('data-verdict', 'ok');
    await expect(trust(page).getByText(/tampered/i)).toHaveCount(0);
    await expect(trust(page).getByText(/not verified/i)).toHaveCount(0);
    // No total in the reply: the count is unknown, never a verified 0.
    await expect(trust(page)).not.toContainText('0 entries checked');
    await expect(trust(page)).toContainText('Count of entries not reported');
  });

  // The verdict is the headline: above the panels, saying how many entries it
  // covers. Fails on the old page, where it was a grey line inside the card.
  test('the verdict sits above the panels and says how many entries it covers', async ({ page }) => {
    const entries = [1, 2, 3].map((n) => ({ actor: 'op', detail: {}, event: 'write-authorized', hash: `h${n}`, prev_hash: '', seq: n, ts: 1767254400 + n }));
    await page.route('**/api/audit/log*', (route) =>
      fulfillJson(route, { entries, returned: 3, total: 3, truncated: false, chain_valid: true, broken_index: null, chain_verify_error: null, append_failures: 0 }),
    );
    await page.goto('/#audit');
    await expect(trust(page)).toContainText('3 entries checked');
    await expect(trust(page)).toContainText('bloxsmith audit verify');
    const box = await trust(page).boundingBox();
    const log = await page.getByRole('heading', { name: 'Audit Log', level: 2 }).boundingBox();
    expect(box && log && box.y + box.height <= log.y, 'the trust strip is above the Audit Log panel').toBeTruthy();
    // The intact word is the biggest text on the strip, not a pale caption.
    const size = await trust(page).getByText(/^Intact$/).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(22);
  });

  test('chain_valid:false with broken_index:7 names the entry, not intact', async ({ page }) => {
    await page.route('**/api/audit/log*', (route) =>
      fulfillJson(route, { entries: [], chain_valid: false, broken_index: 7, chain_verify_error: null }),
    );
    await page.goto('/#audit');
    await expect(trust(page).getByText(/^Tampered$/)).toBeVisible();
    await expect(trust(page).getByText(/#7/)).toBeVisible();
    await expect(verdict(page)).toHaveAttribute('data-verdict', 'crit');
    await expect(trust(page).getByText(/intact/i)).toHaveCount(0);
  });

  test('chain_verify_error is worded as not verified, not intact or tampered', async ({ page }) => {
    await page.route('**/api/audit/log*', (route) =>
      fulfillJson(route, {
        entries: [], chain_valid: null, broken_index: null,
        chain_verify_error: 'could not read audit log file',
      }),
    );
    await page.goto('/#audit');
    await expect(trust(page).getByText(/^Not verified$/)).toBeVisible();
    await expect(verdict(page)).toHaveAttribute('data-verdict', 'warn');
    await expect(trust(page).getByText(/intact/i)).toHaveCount(0);
    await expect(trust(page).getByText(/tampered/i)).toHaveCount(0);
  });

  // The keyed chain can reach "tampered" for more than one reason — a forged
  // entry, a truncated tail, an altered seal — and "broken at entry #7" alone
  // does not tell an operator which. broken_reason must reach the screen.
  test('broken_reason is shown alongside the entry number', async ({ page }) => {
    await page.route('**/api/audit/log*', (route) =>
      fulfillJson(route, {
        entries: [], chain_valid: false, broken_index: 3, chain_verify_error: null,
        broken_reason: 'the log holds 3 entries but the sealed head records 5 — 2 were removed from the end',
      }),
    );
    await page.goto('/#audit');
    await expect(trust(page).getByText(/^Tampered$/)).toBeVisible();
    await expect(trust(page).getByText(/removed from the end/i)).toBeVisible();
  });

  // Likewise not-verified covers a lost key, a rotated key and an unreadable
  // file. Showing only the state would leave the operator unable to tell a
  // wiped config directory from a real problem.
  test('the not-verified reason is shown, not just the state', async ({ page }) => {
    await page.route('**/api/audit/log*', (route) =>
      fulfillJson(route, {
        entries: [], chain_valid: false, broken_index: null,
        chain_verify_error: 'entries are signed with audit key 1122334455667788 but this process holds 99aabbccddeeff00',
      }),
    );
    await page.goto('/#audit');
    await expect(trust(page).getByText(/^Not verified$/)).toBeVisible();
    await expect(trust(page).getByText(/signed with audit key/i)).toBeVisible();
    await expect(trust(page).getByText(/tampered/i)).toHaveCount(0);
  });

  test('a failed /api/audit/log fetch reads as not verified, never as intact', async ({ page }) => {
    await page.route('**/api/audit/log*', (route) => route.abort('failed'));
    await page.goto('/#audit');
    await expect(trust(page).getByText(/^Not verified$/)).toBeVisible();
    await expect(verdict(page)).toHaveAttribute('data-verdict', 'warn');
    await expect(trust(page).getByText(/intact/i)).toHaveCount(0);
  });

  // Records the server could not write are their own tile, red when there are
  // any, and a missing counter (an older server) is a dash, never a calm 0.
  test('append failures show as a red count; a missing counter is a dash', async ({ page }) => {
    let body: Record<string, unknown> = { entries: [], chain_valid: true, broken_index: null, chain_verify_error: null, append_failures: 2, last_append_failure: { event: 'write-authorized', error: 'disk full' } };
    await page.route('**/api/audit/log*', (route) => fulfillJson(route, body));
    await page.goto('/#audit');
    const tile = trust(page).locator('[data-failures]');
    await expect(tile).toHaveAttribute('data-failures', '2');
    await expect(tile).toHaveClass(/\bcrit\b/);
    await expect(tile).toContainText('Change allowed');
    await expect(tile).toContainText('since the app started');
    body = { entries: [], chain_valid: true, broken_index: null, chain_verify_error: null };
    await page.reload();
    await expect(trust(page).getByText('not reported', { exact: true })).toBeVisible();
    await expect(trust(page).locator('[data-failures]')).toHaveCount(0);
  });
});
