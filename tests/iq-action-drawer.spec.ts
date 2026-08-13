import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The Infoblox IQ action detail drawer and the resolve/reopen write, neither of
// which had ANY browser test. `grep -rl "api/actions/" tests/` returned nothing
// before this file.
//
// The gap was easy to miss because the surrounding coverage looks complete. The
// Go side of the write is tested twice over — internal/server/writelock.go gates
// POST /api/actions/{id}/status to operator+, and tenant_write_audit_test.go
// proves both outcomes are audited. The page-baseline spec covers the Incidents
// tab. But the baseline stops at page load, and the drawer only exists after a
// click, so the whole read-detail-then-write path sat between the two.
//
// Everything is served from tests/page-fixtures.ts, so this runs on CI with no
// tenant, like the rest of the suite since 2026-08-13.

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

const FIRST = { id: 'baseline-action-1', title: 'Baseline suspicious domain' };

async function openSocQueue(page: import('@playwright/test').Page) {
  await page.goto('/#incidents');
  await expect(page.locator('h1').first()).toBeVisible();
  return page.getByRole('button', { name: FIRST.title });
}

test('clicking an IQ action opens the drawer and shows that action, not another', async ({ page }) => {
  const row = await openSocQueue(page);
  await expect(row).toBeVisible();
  await row.click();

  const drawer = page.getByRole('heading', { name: 'Action detail' });
  await expect(drawer).toBeVisible();

  // The drawer renders every field of the action as a definition list. Assert on
  // values unique to baseline-action-1 — the second fixture action is deliberately
  // different in title, priority and status, so a drawer wired to the wrong id
  // (or to the list's first row regardless of what was clicked) fails here rather
  // than passing on a coincidence.
  const body = page.getByRole('dialog').or(page.locator('.fixed.inset-0.z-50'));
  await expect(body).toContainText(FIRST.id);
  await expect(body).toContainText(FIRST.title);
  await expect(body).toContainText('baseline.example');
  await expect(body).not.toContainText('Baseline resolved lookup');
});

test('the drawer closes and leaves the queue behind it intact', async ({ page }) => {
  const row = await openSocQueue(page);
  await row.click();
  await expect(page.getByRole('heading', { name: 'Action detail' })).toBeVisible();

  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('heading', { name: 'Action detail' })).toHaveCount(0);
  // The row is still there and still clickable — closing must not unmount the
  // panel underneath it.
  await expect(page.getByRole('button', { name: FIRST.title })).toBeVisible();
});

test('a refused resolve names the reason instead of failing bare', async ({ page }) => {
  // TWO routes registered here rather than in page-fixtures.ts, and the delay is
  // load-bearing.
  //
  // installBaselineWorld matches on METHOD as well as path and ABORTS anything
  // unmatched, so a POST would otherwise be aborted and the UI would show a
  // network error — not the 403 branch this test exists for. Playwright matches
  // handlers newest-first, so this one wins over the catch-all installed in
  // beforeEach.
  //
  // The delay is what makes the pending state observable. Without it the 403
  // lands before the assertion runs and `saving…` can never be caught, so the
  // test would silently prove only half of what it claims.
  let release: (() => void) | undefined;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/actions/**/status', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    await held;
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'operator required' }) });
  });

  await page.goto('/#incidents');
  await expect(page.locator('h1').first()).toBeVisible();

  // baseline-action-1 is active, so its control offers Resolve.
  const resolve = page.getByRole('button', { name: 'Resolve' }).first();
  await expect(resolve).toBeVisible();
  await resolve.click();

  // In flight: the button says so and refuses a second click, which is what
  // stops a double click reporting an outcome twice.
  await expect(page.getByRole('button', { name: 'saving…' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'saving…' }).first()).toBeDisabled();

  release!();

  // Refused, and the refusal NAMES the reason. Incidents.jsx special-cases 403
  // to say "operator required" rather than "failed (403)" — a distinction that
  // exists so an operator knows to ask for access instead of retrying.
  await expect(page.getByText('operator required')).toBeVisible();
  await expect(page.getByText(/failed \(403\)/)).toHaveCount(0);
  // And the row did NOT flip to resolved: the handler is deliberately not
  // optimistic, so a refused write must leave the queue exactly as it was.
  await expect(page.getByRole('button', { name: 'Resolve' }).first()).toBeVisible();
});
