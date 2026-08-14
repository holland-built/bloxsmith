import { defineConfig, devices } from '@playwright/test';

// The disposable e2e harness scripts/e2e.sh now EXISTS (it did not when this
// comment was first written, which is why nothing had ever run this suite
// unattended). It builds and runs the CURRENT working tree on its own port —
// 8091 by default, E2E_PORT to move it — with throwaway state, and exports
// NOC_BASE to match. So under the harness the constant below is never used.
//
// It is the fallback for a BARE `npx playwright test`, and it names :8090 —
// scripts/dev-serve.sh — because running the suite by hand against a dev server
// someone already had up is how it was used before the harness existed.
// Override NOC_BASE to point elsewhere deliberately (e.g.
// NOC_BASE=http://localhost:8080 to spot-check the deployed ghcr image).
//
// The sentence that used to close this comment — "the 18 specs that set their
// own `process.env.NOC_BASE || 'http://localhost:8091'` default line up with
// this one automatically" — described specs that do not exist. Checked
// 2026-08-11: `grep -rn 8091 tests/` matches NOTHING, and `grep -rn NOC_BASE
// tests/` matches only three diagnostic strings (tests/global-setup.ts:32,
// tests/fixtures.ts:39 and :208) that name the variable for a human reading a
// failure message. No spec sets its own base URL; every one of them inherits
// `use.baseURL` from this file.
const DEFAULT_BASE_URL = 'http://localhost:8090';

// EMPTY since 2026-08-13, and kept as a list rather than deleted so the next
// spec that genuinely needs a tenant has somewhere to go.
//
// It used to hold seven files — chart-tooltips, table-sizing, density,
// tabs-smoke, hub-security-availability, tab-switch-no-flash, dossier-page —
// because they assert on data only a live Infoblox tenant serves, so CI (which
// has no tenant key) could not run them. That was 96 tests, better than a fifth
// of the suite, proven only on whichever laptop last ran them by hand.
//
// tests/page-fixtures.ts removed the reason. It fakes every /api/ response with
// fixed synthetic data, so the tenant those specs needed now exists on every
// machine, identically. Each of the seven installs it in a beforeEach.
//
// THE EXCLUSION WAS PER FILE, WHICH IS WHY IT COST SO MUCH. Playwright's
// testIgnore works at file granularity, so three tests in dossier-page.spec.ts
// that deliberately hit the real endpoints — the block literally named "live
// tenant", which exists to prove those endpoints answer — kept the other 25 out
// of CI with them. Those three now skip themselves on E2E_SKIP_LIVE and undo the
// fixtures locally, so the cost is three tests instead of twenty-eight.
const LIVE_TENANT_SPECS: string[] = [];

// These fail on ubuntu runners while passing on macOS — measured on the first
// CI run ever to execute this suite (run 31499474048, 2026-08-11: 300 passed,
// the 9 failures all in these files). layout-persist REQUIRES the
// scripts/dev-serve.sh supervisor (it proves a restart survives; on CI it
// throws "P8 cannot be proven" by design — that is a refusal, not a skip).
// contrast.spec.ts measures AA contrast on RENDERED text, and Linux
// font rendering shifts it; the other four look like platform layout/timing
// differences. UNPROVEN ON LINUX, not known-good: until someone tunes them,
// these checks only gate a hand-run on macOS. Follow-up, not a resolution.
// Five of the six came off this list on 2026-08-13 once tests/page-fixtures.ts
// gave them a tenant. The original entry said the other four "look like platform
// layout/timing differences" — honest about being a guess, and wrong: the single
// run behind it (31499474048) had no tenant AND a different OS, so it could not
// separate the two. The same tests then failed on macOS under scripts/e2e.sh,
// which settled which variable mattered.
//
// layout-persist STAYS, and it is the one entry with a real diagnosis. It saves a
// layout, SIGTERMs the server and reads the layout back; the round trip has to
// reach real storage, so the fixture set — which answers GET /api/views with
// {views: []} — would make it save nothing and read back nothing. It would either
// fail for a reason unrelated to the platform or, worse, pass while proving
// nothing. Giving it fixtures requires passing /api/views through to the server,
// which is a separate piece of work.
// EMPTY since 2026-08-13. Kept as a list so a file that genuinely cannot run on
// the runner has somewhere to go.
//
// layout-persist.spec.ts was the last entry and it is gone for the same reason
// everything else left: the exclusion was per FILE while the problem was one
// TEST. Only "P8: the layout survives killing and restarting the Go binary"
// needs process control; the other four assert endpoint behaviour, rendering and
// clamping and run fine on CI. P8 now skips itself under E2E_SKIP_LIVE with its
// reason written next to it.
const LINUX_CI_UNPROVEN_SPECS: string[] = [];

export default defineConfig({
  testDir: './tests',
  testIgnore: process.env.E2E_SKIP_LIVE
    ? [...LIVE_TENANT_SPECS, ...LINUX_CI_UNPROVEN_SPECS]
    : [],
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
