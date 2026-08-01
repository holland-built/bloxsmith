import { test as base, expect, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs';

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

// ---------------------------------------------------------------------------
// Failure diagnostics (Phase 1A of the drilldown-flake investigation).
//
// Purely observational: it adds listeners and, ONLY when an attempt has already
// failed, attaches what it saw. It asserts nothing and changes no timing, so it
// cannot turn a passing test red or a failing test green.
//
// It answers the question three successive diagnoses of tests/drilldown.spec.ts
// guessed at without evidence: when that assertion timed out, had the page's
// /api/data request (a) never been sent, (b) been sent and still been in
// flight, (c) failed outright, or (d) succeeded and simply not rendered?
//
// Every attachment is stamped with the retry index, because the original
// attempt and the retry run against materially different server states and
// conflating them is exactly how the earlier diagnoses went wrong.
// ---------------------------------------------------------------------------

type ReqRecord = {
  url: string;
  method: string;
  startMs: number;
  endMs: number | null;
  status: number | null;
  outcome: 'in-flight-at-test-end' | 'finished' | 'failed';
  failure: string | null;
};

const MAX_CONSOLE = 300;
const MAX_SERVER_RECORDS = 3000;

function installDiagnostics(page: Page, t0: number) {
  const consoleEvents: unknown[] = [];
  const pageErrors: unknown[] = [];
  const failedRequests: unknown[] = [];
  const navigations: unknown[] = [];
  // Keyed by the Request object so a retried/redirected URL can't collide.
  const requests = new Map<unknown, ReqRecord>();
  const at = () => Date.now() - t0;

  page.on('console', (m) => {
    if (consoleEvents.length < MAX_CONSOLE) {
      consoleEvents.push({ atMs: at(), type: m.type(), text: m.text() });
    }
  });
  page.on('pageerror', (e) => pageErrors.push({ atMs: at(), message: String(e) }));
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) navigations.push({ atMs: at(), url: f.url() });
  });
  page.on('request', (r) => {
    // Only the JSON API matters here; static assets would drown the record.
    if (!r.url().includes('/api/')) return;
    requests.set(r, {
      url: r.url(),
      method: r.method(),
      startMs: at(),
      endMs: null,
      status: null,
      outcome: 'in-flight-at-test-end',
      failure: null,
    });
  });
  page.on('response', (res) => {
    const rec = requests.get(res.request());
    if (rec) rec.status = res.status();
  });
  page.on('requestfinished', (r) => {
    const rec = requests.get(r);
    if (rec) {
      rec.endMs = at();
      rec.outcome = 'finished';
    }
  });
  page.on('requestfailed', (r) => {
    const rec = requests.get(r);
    const failure = r.failure()?.errorText ?? 'unknown failure (Request.failure() returned null)';
    if (rec) {
      rec.endMs = at();
      rec.outcome = 'failed';
      rec.failure = failure;
    }
    failedRequests.push({ atMs: at(), url: r.url(), method: r.method(), failure });
  });

  return { consoleEvents, pageErrors, failedRequests, navigations, requests };
}

// Reads the server-side diagnostic request log (go/internal/server/reqlog.go).
// The three outcomes below are deliberately distinguishable in the attachment:
// "nobody turned it on", "it was on but I could not read it", and "I read it
// and these are the records" — including the empty case, which is itself a
// finding (a request that never reached the server leaves no record).
function readServerLog(windowStartIso: string) {
  const path = process.env.BLOXSMITH_REQLOG;
  if (!path) {
    return {
      status: 'not-configured',
      detail: 'BLOXSMITH_REQLOG was not set for this run, so the server wrote no request log. ' +
        'This is NOT "the server received no requests".',
    };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (err) {
    return { status: 'read-failed', path, error: String(err) };
  }
  const lines = raw.split('\n').filter(Boolean);
  const parsed: any[] = [];
  let unparseable = 0;
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      unparseable++;
    }
  }
  const inWindow = parsed.filter((r) => typeof r?.t === 'string' && r.t >= windowStartIso);
  const pids = [...new Set(inWindow.map((r) => r.pid))];
  const procStarts = [...new Set(inWindow.map((r) => r.proc_start))];
  return {
    status: 'read-ok',
    path,
    totalLines: lines.length,
    unparseableLines: unparseable,
    windowStartIso,
    recordsInWindow: inWindow.length,
    serverPids: pids,
    serverProcessStarts: procStarts,
    // More than one distinct proc_start inside one test = the server restarted
    // mid-test. That is the single fact the restart theory needs and has never had.
    restartedDuringTest: procStarts.length > 1,
    truncated: inWindow.length > MAX_SERVER_RECORDS,
    records: inWindow.slice(-MAX_SERVER_RECORDS),
  };
}

async function attachDiagnostics(
  testInfo: TestInfo,
  diag: ReturnType<typeof installDiagnostics>,
  t0: number,
  windowStartIso: string,
) {
  if (testInfo.status === testInfo.expectedStatus) return; // attempt passed: nothing to explain
  const label = `attempt${testInfo.retry}`;
  const server = readServerLog(windowStartIso);
  const body = {
    test: testInfo.title,
    file: testInfo.file,
    retryIndex: testInfo.retry,
    status: testInfo.status,
    expectedStatus: testInfo.expectedStatus,
    durationMs: testInfo.duration,
    testStartIso: windowStartIso,
    wallClockMsAtAttach: Date.now() - t0,
    baseURL: process.env.NOC_BASE ?? '(config default)',
    apiRequests: [...diag.requests.values()],
    failedRequests: diag.failedRequests,
    navigations: diag.navigations,
    pageErrors: diag.pageErrors,
    console: diag.consoleEvents,
    consoleTruncatedAt: diag.consoleEvents.length >= MAX_CONSOLE ? MAX_CONSOLE : null,
    server,
  };
  const pidSuffix =
    server.status === 'read-ok' && (server as any).serverPids?.length === 1
      ? `-pid${(server as any).serverPids[0]}`
      : '';
  await testInfo.attach(`diagnostics-${label}${pidSuffix}.json`, {
    body: JSON.stringify(body, null, 2),
    contentType: 'application/json',
  });
}

export const test = base.extend({
  page: async ({ page, baseURL }, use, testInfo) => {
    const t0 = Date.now();
    const windowStartIso = new Date(t0 - 1000).toISOString();
    const diag = installDiagnostics(page, t0);
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
    // Runs after the test body, so testInfo.status is already known.
    await attachDiagnostics(testInfo, diag, t0, windowStartIso);
  },
});

export { expect };
