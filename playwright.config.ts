import { defineConfig, devices } from '@playwright/test';

// Default target is the disposable e2e harness (scripts/e2e.sh), which builds
// and runs the CURRENT working tree on its own container/port — never the live
// :8080 stack (the published ghcr image). Override with NOC_BASE to point
// elsewhere deliberately (e.g. NOC_BASE=http://localhost:8080 to spot-check the
// deployed image by hand). The 18 specs that set their own
// `process.env.NOC_BASE || 'http://localhost:8091'` default line up with this
// one automatically whenever NOC_BASE is exported by the harness.
const DEFAULT_BASE_URL = 'http://localhost:8090';

export default defineConfig({
  testDir: './tests',
  // Explicit, because the default did NOT land in this repo. Playwright's
  // computed default here resolved to /Users/sholland/test-results — outside
  // the project, outside .gitignore, and nowhere anyone would look — so every
  // trace, video and screenshot this config now captures would have been
  // written somewhere invisible. Measured with
  // `npx playwright test --list --reporter=json`, which reports
  // projects[0].outputDir.
  outputDir: './test-results',
  // Fails fast with a clear message if the target server never comes up at
  // all, instead of every spec discovering ERR_CONNECTION_REFUSED on its own.
  globalSetup: './tests/global-setup.ts',
  // One retry absorbs rare races against a live server (e.g. a global keydown
  // listener not yet attached when Ctrl/Cmd-K is pressed under parallel load).
  // Deterministic failures still fail both attempts — retries never hide real bugs.
  // (A dev-server restart mid-run — scripts/dev-serve.sh rebuilding on a Go
  // change — is handled separately, and earlier, by tests/fixtures.ts: it
  // waits for the server to come back and retries just the navigation, so
  // this whole-test retry is never the thing absorbing that failure mode.)
  retries: 1,
  // One worker, because several specs in this suite are exclusive owners of
  // shared state and the default (2) let them run against each other:
  //   - tests/layout-persist.spec.ts SIGTERMs the Go binary to prove a saved
  //     layout survives a restart. That is hostile to EVERY spec running
  //     concurrently, not just to one — anything mid-request when the process
  //     dies sees a connection error it has no reason to expect.
  //   - tests/layout-drag.spec.ts writes the same single saved view,
  //     `__layout_overview`, that the persistence spec reads back.
  //   - since 2026-08-08 every one of the 15 tabs carries a layoutKey, so the
  //     shared resource is a whole `__layout_<key>` namespace rather than one
  //     record. layout-drag.spec.ts also owns `__layout_network`,
  //     `__layout_dns` and `__layout_security`; tests/hidden-tiles.spec.ts
  //     owns `__layout_daily`. Each of those specs deletes its own keys before
  //     and after every test, but there is still exactly one record per key
  //     per tenant, so two writers in parallel would corrupt each other the
  //     same way the two Overview owners did.
  // Observed under 2 workers: a drag assertion read back `host-status: 4` —
  // the persistence spec's fixture, not the order it had just dragged — and a
  // persistence assertion read an order the drag spec had written moments
  // earlier. Neither spec is wrong; they are two exclusive owners of one
  // resource, plus a process kill.
  //
  // Two narrower fixes were considered and do NOT work. Giving the drag spec
  // its own view name fixes only the shared-key half, and leaves the restart
  // free to break whatever else is in flight. `test.describe.serial` serialises
  // within ONE file, so it cannot order two files against each other.
  // The targeted fix, if the wall-clock cost of this ever becomes a problem,
  // is a second Playwright project holding only the restart spec, run after
  // the parallel one — more config than the current runtime justifies.
  workers: 1,
  // 'html' always writes playwright-report/ (not just on failure) so CI has
  // something to upload as an artifact; 'never' skips auto-opening it locally.
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.NOC_BASE || DEFAULT_BASE_URL,
    // Capture for EVERY failed attempt, not 'on-first-retry'. The drilldown
    // flake (tests/drilldown.spec.ts) only ever appears on the first full-suite
    // run after the dev server rebuilds, and the ORIGINAL attempt is the only
    // genuinely process-cold observation of it — the retry runs against a
    // materially warmer server, so 'on-first-retry' would systematically
    // discard the one attempt worth looking at. 'retain-on-failure' records
    // every attempt and throws the recording away when the attempt passes,
    // so a green suite costs nothing on disk.
    //
    // Attempts are already separated on disk by Playwright's own per-attempt
    // output directory (…-chromium/ for attempt 0, …-chromium-retry1/ for
    // attempt 1), and tests/fixtures.ts stamps the retry index into the name
    // of every diagnostic attachment it adds.
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
