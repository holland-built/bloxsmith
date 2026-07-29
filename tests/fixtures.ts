import { test as base, expect, type Page } from '@playwright/test';

// scripts/dev-serve.sh restarts the server binary whenever go/**/*.go changes:
// it SIGTERMs the old process (up to ~5s graceful-wait), starts the new one,
// then polls its own health check (up to ~5s) before calling it up. During
// that window `page.goto()` sees a bare ERR_CONNECTION_REFUSED — not a product
// bug, just the dev server being momentarily absent. Left alone, that surfaces
// as a confusing connection error and (with the suite's blanket retry) a
// re-run that may land in the same restart window and fail for real.
//
// This fixture intercepts ONLY that one error signature and polls the base
// URL until it answers again (or gives up with a clear diagnostic) before
// retrying the navigation once. Every other navigation failure — 404, a
// genuine timeout, a JS exception during load — passes through untouched, so
// this can never mask a real product race the way a blind whole-test retry
// could.
const HEALTH_POLL_INTERVAL_MS = 300;
// Worst case per dev-serve.sh: ~5s graceful SIGTERM wait + ~5s health_check
// polling = ~10s. Give real margin over that.
const HEALTH_POLL_TIMEOUT_MS = 20_000;

async function waitForServer(page: Page, baseURL: string): Promise<void> {
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await page.request.get(baseURL, { timeout: 2000 });
      if (res.ok()) return;
      lastError = new Error(`health check got HTTP ${res.status()}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  throw new Error(
    `dev server unreachable: ${baseURL} did not answer within ${HEALTH_POLL_TIMEOUT_MS}ms ` +
      `(last error: ${String(lastError)}). Is the dev server ` +
      `(scripts/dev-serve.sh, or whatever NOC_BASE points at) actually running?`,
  );
}

// Matches ERR_CONNECTION_REFUSED itself, plus the secondary race Chromium can
// produce right after it: the browser asynchronously auto-navigates to its
// internal chrome-error page following a refused connection, and if a retry's
// goto() lands while that transition is still in flight, Playwright reports
// it as "interrupted by another navigation" rather than as the connection
// error. Both are the same underlying "server was briefly down" event, not a
// product bug — anything else (404, a real timeout, a JS exception) is
// rethrown immediately on first occurrence.
const TRANSIENT_NAV_ERROR = /ERR_CONNECTION_REFUSED|interrupted by another navigation/;
const MAX_ATTEMPTS = 4;

export const test = base.extend({
  page: async ({ page, baseURL }, use) => {
    const originalGoto = page.goto.bind(page);
    page.goto = (async (url: Parameters<Page['goto']>[0], options?: Parameters<Page['goto']>[1]) => {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          return await originalGoto(url, options);
        } catch (err) {
          const transient = err instanceof Error && TRANSIENT_NAV_ERROR.test(err.message);
          if (!transient || !baseURL || attempt === MAX_ATTEMPTS) throw err;
          await waitForServer(page, baseURL);
          // Let Chromium's own internal error-page transition finish settling
          // before retrying, so the retry doesn't collide with it.
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      // Unreachable: the loop above always returns or throws.
      throw new Error('gotoReady: exhausted attempts without returning or throwing');
    }) as typeof originalGoto;
    await use(page);
  },
});

export { expect };
