import { test, expect } from './fixtures';

// Bounded retry inside useApi (ui/src/lib/api.js): a transient failure on a
// non-polling feed is asked again — 3 attempts total, ~2s then ~8s with full
// jitter x(0.5-1.5) — so a blip heals itself instead of leaving the panel on
// FeedUnavailable until the user reloads the page.
//
// The panel under test is Security -> "Lookalike Domains", fed by
// `useApi('/api/lookalikes')` at ui/src/tabs/Security.jsx:34. It was chosen
// because it passes NO `poll` option. A polling panel would re-load on its own
// 30s interval whatever the retry code did, so it can only prove that time
// passed; this one has exactly one re-entry path, and that path is the feature.
// It also renders three plainly different states off the same route — the
// FeedUnavailable panel, a real DataTable, and an "N detected" count — so
// "recovered" is read off real content rather than off the absence of an error.

function fulfillJson(route: import('@playwright/test').Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** A hard backend failure: useApi() sets .error and leaves .data null. */
function dead(route: import('@playwright/test').Route) {
  return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
}

/** Vault-locked, the one 503 that is handled and early-returned before the throw. */
function locked(route: import('@playwright/test').Route) {
  return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ locked: true }) });
}

// Two rows, not one: DataTable hides a column whose non-empty cells are all
// identical, so a single-row fixture can drop the very column being asserted.
const HEALTHY = {
  domains: [
    { lookalike: 'paypa1-secure.example', target: 'paypal.example', suspicious: true },
    { lookalike: 'goog1e-mail.example', target: 'google.example', suspicious: false },
  ],
  targets: ['paypal.example', 'google.example'],
};

// Worst case to the third and final attempt: 2000x1.5 + 8000x1.5 = 15s of
// scheduled waits, plus the requests themselves. Everything below is sized off
// that one number rather than off a guessed round figure.
const MAX_RETRY_WINDOW_MS = 15_000;
// Held open after the budget is spent, to catch a fourth request that the
// bound is supposed to make impossible. Nothing is scheduled in this window,
// so any request landing in it is the bug.
const OVERRUN_GUARD_MS = 12_000;

// Same pin failure-not-absence-4.spec.ts uses, for the same reason: a transient
// /api/vault/status failure swaps the whole dashboard for "Vault status
// unavailable", and none of these specs grade the vault gate.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/vault/status*', (route) => fulfillJson(route, { vaultMode: false, ready: true }));
});

const CARD = 'xpath=ancestor::div[contains(@class,"bg-card")]';
function card(page: import('@playwright/test').Page, title: string | RegExp) {
  return page.locator('h2', { hasText: title }).first().locator(CARD);
}

// ---------- 1. A transient failure recovers without a page reload ----------

test.describe('Lookalike Domains (/api/lookalikes fails twice, then answers)', () => {
  test('the panel ends up showing real rows, and the page was never reloaded', async ({ page }) => {
    // Two failures + one success + up to 15s of retry waits, against a live
    // dev server also serving the rest of the Security tab.
    test.setTimeout(90_000);

    let requests = 0;
    await page.route('**/api/lookalikes*', (route) => {
      requests += 1;
      return requests <= 2 ? dead(route) : fulfillJson(route, HEALTHY);
    });

    await page.goto('/#security');
    const panel = card(page, 'Lookalike Domains');
    await expect(panel.getByText('Lookalike domain feed unavailable')).toBeVisible();

    // A sentinel on the window object, planted after the only navigation this
    // test performs. It survives every client-side re-render and cannot
    // survive a reload, so it is the whole "no reload" claim in one value —
    // stronger than counting navigation events, because it also fails if the
    // app reloads itself by any route a listener would miss.
    await page.evaluate(() => { (window as any).__feedRecoverySentinel = 'planted'; });

    await expect(panel.getByText('paypa1-secure.example')).toBeVisible({ timeout: MAX_RETRY_WINDOW_MS + 15_000 });
    await expect(panel.getByText('goog1e-mail.example')).toBeVisible();
    // The count re-reads as a measurement: "—  detected" means nothing was measured.
    await expect(panel.getByText('2 detected', { exact: true })).toBeVisible();
    await expect(panel.locator('[data-feed-unavailable]')).toHaveCount(0);

    expect(await page.evaluate(() => (window as any).__feedRecoverySentinel)).toBe('planted');
    expect(requests, 'initial attempt + 2 retries, the third of which succeeded').toBe(3);
  });
});

// ---------- 2. A permanently dead feed stops, and offers a way back ----------

test.describe('Lookalike Domains (/api/lookalikes permanently dead)', () => {
  test('stops after exactly 3 requests, then Try again recovers the panel', async ({ page }) => {
    // 15s of retry waits + a 12s overrun guard + the manual retry afterwards.
    test.setTimeout(150_000);

    let requests = 0;
    let healthy = false;
    await page.route('**/api/lookalikes*', (route) => {
      requests += 1;
      return healthy ? fulfillJson(route, HEALTHY) : dead(route);
    });

    await page.goto('/#security');
    const panel = card(page, 'Lookalike Domains');
    await expect(panel.getByText('Lookalike domain feed unavailable')).toBeVisible();

    await expect
      .poll(() => requests, {
        message: 'attempts made against a route that never answers',
        timeout: MAX_RETRY_WINDOW_MS + 15_000,
        intervals: [250],
      })
      .toBe(3);

    // The bound is the point: an unbounded retry would also reach 3.
    await page.waitForTimeout(OVERRUN_GUARD_MS);
    expect(requests, 'the attempt budget is spent — nothing may be scheduled after it').toBe(3);

    // Terminal state has to leave the user somewhere to go. Keyboard-first,
    // because a div with an onClick would pass a click and fail this.
    const tryAgain = panel.getByRole('button', { name: /try again/i });
    await expect(tryAgain).toBeVisible({ timeout: 15_000 });
    await tryAgain.focus();
    await expect(tryAgain).toBeFocused();

    healthy = true;
    await page.keyboard.press('Enter');

    await expect(panel.getByText('paypa1-secure.example')).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByText('2 detected', { exact: true })).toBeVisible();
    await expect(panel.locator('[data-feed-unavailable]')).toHaveCount(0);
    expect(requests, '3 automatic attempts, then exactly one more the user asked for').toBe(4);
  });
});

// ---------- 3. Vault-locked is an answer, not a failure ----------

test.describe('Lookalike Domains (/api/lookalikes answers 503 {locked:true})', () => {
  test('is requested exactly once — a locked vault is never retried', async ({ page }) => {
    test.setTimeout(90_000);

    let requests = 0;
    await page.route('**/api/lookalikes*', (route) => {
      requests += 1;
      return locked(route);
    });

    await page.goto('/#security');
    const panel = card(page, 'Lookalike Domains');
    await expect(panel).toBeVisible();

    // Long enough that both scheduled retries would have landed by now if the
    // vault-locked branch fell through to the error path.
    await page.waitForTimeout(MAX_RETRY_WINDOW_MS + 5_000);
    expect(requests, 'locked is a final answer — asking again cannot change it').toBe(1);

    // It never reaches .catch at all, so `error` stays null and the panel never
    // enters the failed state the retry scheduler reads.
    await expect(panel.locator('[data-feed-unavailable]')).toHaveCount(0);
  });
});
