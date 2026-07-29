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
  // 'html' always writes playwright-report/ (not just on failure) so CI has
  // something to upload as an artifact; 'never' skips auto-opening it locally.
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.NOC_BASE || DEFAULT_BASE_URL,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
