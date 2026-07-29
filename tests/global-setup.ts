import type { FullConfig } from '@playwright/test';

// Fails the whole run fast, with a clear diagnostic, instead of letting every
// spec discover ERR_CONNECTION_REFUSED on its own goto(). This only covers
// "never came up" / "already down before we started" — the mid-run restart
// case (dev-serve.sh rebuilding on a Go change) is handled per-navigation by
// tests/fixtures.ts, since a global check here can't see a restart that
// happens after the run has already started.
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 15_000;

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use?.baseURL;
  if (!baseURL) return;

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseURL);
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(
    `dev server unreachable: ${baseURL} did not answer within ${POLL_TIMEOUT_MS}ms ` +
      `(last error: ${String(lastError)}). Start it first — e.g. ` +
      `scripts/dev-serve.sh — or point NOC_BASE at a server that's already up.`,
  );
}
