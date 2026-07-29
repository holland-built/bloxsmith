import { test, expect } from '@playwright/test';

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
//    the UI surfaced. It's now rendered in the "Audit Log" card as one of
//    three non-overlapping states — intact, tampered, or could-not-verify —
//    and a fetch failure is folded into "could-not-verify" rather than
//    silently reading as "chain is fine".

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

test.describe('Audit Log — tamper-chain verdict', () => {
  test('chain_valid:true shows intact wording, not tamper wording', async ({ page }) => {
    await page.route('**/api/audit/log*', (route) =>
      fulfillJson(route, { entries: [], chain_valid: true, broken_index: null, chain_verify_error: null }),
    );
    await page.goto('/#audit');
    const card = page.getByText('Audit Log', { exact: true }).locator('..').locator('..');
    await expect(card.getByText(/chain intact/i)).toBeVisible();
    await expect(card.getByText(/chain tampered/i)).toHaveCount(0);
    await expect(card.getByText(/could not be verified/i)).toHaveCount(0);
  });

  test('chain_valid:false with broken_index:7 names the entry, not intact', async ({ page }) => {
    await page.route('**/api/audit/log*', (route) =>
      fulfillJson(route, { entries: [], chain_valid: false, broken_index: 7, chain_verify_error: null }),
    );
    await page.goto('/#audit');
    const card = page.getByText('Audit Log', { exact: true }).locator('..').locator('..');
    await expect(card.getByText(/chain tampered/i)).toBeVisible();
    await expect(card.getByText(/#7/)).toBeVisible();
    await expect(card.getByText(/chain intact/i)).toHaveCount(0);
  });

  test('chain_verify_error is worded as could-not-verify, not intact or tampered', async ({ page }) => {
    await page.route('**/api/audit/log*', (route) =>
      fulfillJson(route, {
        entries: [], chain_valid: null, broken_index: null,
        chain_verify_error: 'could not read audit log file',
      }),
    );
    await page.goto('/#audit');
    const card = page.getByText('Audit Log', { exact: true }).locator('..').locator('..');
    await expect(card.getByText(/could not be verified/i)).toBeVisible();
    await expect(card.getByText(/chain intact/i)).toHaveCount(0);
    await expect(card.getByText(/chain tampered/i)).toHaveCount(0);
  });

  test('a failed /api/audit/log fetch reads as could-not-verify, never as intact', async ({ page }) => {
    await page.route('**/api/audit/log*', (route) => route.abort('failed'));
    await page.goto('/#audit');
    const card = page.getByText('Audit Log', { exact: true }).locator('..').locator('..');
    await expect(card.getByText(/could not be verified/i)).toBeVisible();
    await expect(card.getByText(/chain intact/i)).toHaveCount(0);
  });
});
