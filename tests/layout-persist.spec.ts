import { test, expect } from './fixtures';
import { execSync } from 'node:child_process';

// P8 (item 6) and the live half of P9a (item 7).
//
// The point of this file is that "the layout persisted" is proven against a
// RESTARTED SERVER PROCESS, not against a browser that still had it in memory.
// localStorage, sessionStorage and an in-memory React state would all pass a
// naive "save it, reload, it's still there" test; only killing the process
// that owns the file separates server-side persistence from browser cache.
//
// Every expected value below is a hand-written literal, read off the JSX in
// ui/src/tabs/Overview.jsx, never recomputed from the app's own code.

const VIEW = '__layout_overview';

// The declared JSX order in Overview.jsx's <CardGrid layoutKey="overview">.
const DECLARED_ORDER = [
  'dns-hero',
  'kpi-stack',
  'top-consumers',
  'subnet-heatmap',
  'host-status',
  'subnet-table',
  'license-inventory',
];

// A saved order that is nothing like the declared one, and which deliberately
// OMITS 'top-consumers' — an omitted panel must keep its declared position, at
// the end, rather than vanish or jump to the front.
const SAVED_ORDER = [
  'license-inventory',
  'subnet-table',
  'host-status',
  'subnet-heatmap',
  'kpi-stack',
  'dns-hero',
];

// license-inventory is the interesting one: it is a measuring DataTable panel,
// so the fit system wants it wide. A saved span of 2 proves user > measured.
const SAVED_SPANS = { 'dns-hero': 6, 'host-status': 4, 'license-inventory': 2 };

const EXPECTED_ORDER = [
  'license-inventory',
  'subnet-table',
  'host-status',
  'subnet-heatmap',
  'kpi-stack',
  'dns-hero',
  'top-consumers', // omitted from the saved order -> keeps its place, at the end
];

const SAVE_BODY = {
  name: VIEW,
  order: SAVED_ORDER,
  layout: { version: 1, spans: SAVED_SPANS },
};

type Page = import('@playwright/test').Page;

async function gotoOverview(page: Page, width = 1920) {
  await page.setViewportSize({ width, height: 1080 });
  await page.goto('/#overview');
  // All seven panels mounted. The layout GET resolves on mount and the grid
  // re-applies on a rAF, so wait for the count and then let that settle.
  await page.waitForFunction(
    () => document.querySelectorAll('[data-panel-id]').length === 7,
    { timeout: 20_000 },
  );
  await page.waitForTimeout(1200);
}

const domOrder = (page: Page) =>
  page.$$eval('[data-panel-id]', (els) => els.map((e) => e.getAttribute('data-panel-id')));

// The inline span each managed card ended up with, plus the tracks the grid
// actually has at this width. Reads gridColumn off the element, which is the
// property applyLayout writes and the one that would overflow the page.
function readSpans() {
  const grid = document.querySelector('[data-card-grid]') as HTMLElement;
  const tracks = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
  const spans: Record<string, number | null> = {};
  for (const el of Array.from(document.querySelectorAll('[data-panel-id]'))) {
    const id = el.getAttribute('data-panel-id')!;
    const m = /span (\d+)/.exec((el as HTMLElement).style.gridColumn || '');
    spans[id] = m ? Number(m[1]) : null;
  }
  return { tracks, spans, scrollWidth: grid.scrollWidth, clientWidth: grid.clientWidth };
}

// ---------------------------------------------------------------------------
// The restart. This is the whole predicate, so it is deliberate and checked:
// find the server process by its exact command line, SIGTERM it, and wait for
// scripts/dev-serve.sh's self-heal loop (a 2s tick that restarts the binary
// when the port is dead and the child is gone) to bring back a DIFFERENT pid.
// A same-pid "restart" would prove nothing, so the pid change is asserted.
// ---------------------------------------------------------------------------
function serverPid(): string | null {
  try {
    return execSync('pgrep -f "^/tmp/bloxsmith-dev$"', { encoding: 'utf8' }).trim().split('\n')[0] || null;
  } catch {
    return null; // pgrep exits 1 when nothing matches
  }
}

async function restartServer(): Promise<{ before: string; after: string }> {
  const before = serverPid();
  if (!before) {
    throw new Error(
      'P8 cannot be proven: no process matching "/tmp/bloxsmith-dev" is running, so this run is ' +
        'not pointed at scripts/dev-serve.sh and the binary cannot be restarted from here.',
    );
  }
  execSync(`kill -TERM ${before}`);
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const now = serverPid();
    if (now && now !== before) return { before, after: now };
  }
  throw new Error(`server did not come back with a new pid within 40s (was ${before})`);
}

test.describe.configure({ mode: 'serial' });

test('with no saved layout the tab renders in its declared order, with no span written', async ({ page, request }) => {
  // The path that must stay pixel-identical to before this feature existed.
  await request.delete(`/api/views/${VIEW}`);
  expect((await request.get(`/api/views/${VIEW}`)).status()).toBe(404);

  await gotoOverview(page);
  expect(await domOrder(page)).toEqual(DECLARED_ORDER);

  // Nothing carries a user override, so the only inline spans present are the
  // fit system's own — and the two non-measuring chart panels have none at all.
  const { spans } = await page.evaluate(readSpans);
  expect(spans['dns-hero']).toBeNull();
  expect(spans['host-status']).toBeNull();
});

test('a real round-trip through the live endpoint drops nothing and rejects nothing', async ({ request }) => {
  // The bug this catches: ViewWrite builds its record from a whitelist
  // (name, widgets, order, layout, folder, saved_at) and silently discards any
  // other top-level key. A {name, version, spans} blob would POST with
  // {"ok":true} and read back with version and spans simply gone.
  const post = await request.post('/api/views', { data: SAVE_BODY });
  expect(post.ok()).toBeTruthy();

  const got = await (await request.get(`/api/views/${VIEW}`)).json();
  expect(got.order).toEqual(SAVED_ORDER);
  expect(got.layout).toEqual({ version: 1, spans: SAVED_SPANS });
  expect(got.name).toBe(VIEW);
  // The envelope ViewWrite stamps on regardless — parseLoad must tolerate
  // exactly these and no more.
  expect(Object.keys(got).sort()).toEqual(['folder', 'layout', 'name', 'order', 'saved_at', 'widgets']);
});

test('P8: the layout survives killing and restarting the Go binary', async ({ page, request }) => {
  test.setTimeout(180_000);

  // Saved by hand — the drag UI does not exist until item 8.
  expect((await request.post('/api/views', { data: SAVE_BODY })).ok()).toBeTruthy();

  const { before, after } = await restartServer();
  expect(after).not.toBe(before);

  // Read back from the process that did NOT write it.
  const reread = await request.get(`/api/views/${VIEW}`);
  expect(reread.status()).toBe(200);
  const blob = await reread.json();
  expect(blob.order).toEqual(SAVED_ORDER);
  expect(blob.layout).toEqual({ version: 1, spans: SAVED_SPANS });

  await gotoOverview(page);

  // DOM order, not CSS order: this is read straight off the document, so it is
  // the same order a screen reader and Tab focus traverse.
  expect(await domOrder(page)).toEqual(EXPECTED_ORDER);

  const { tracks, spans } = await page.evaluate(readSpans);
  expect(tracks).toBe(6); // xl:grid-cols-6 at 1920
  expect(spans['dns-hero']).toBe(6);
  expect(spans['host-status']).toBe(4);
  // user > measured: the fit system would have sized this table panel itself.
  expect(spans['license-inventory']).toBe(2);
});

test('P8 clamp: at 390px no managed card exceeds 2 tracks and the grid does not overflow', async ({ page, request }) => {
  test.setTimeout(120_000);
  expect((await request.post('/api/views', { data: SAVE_BODY })).ok()).toBeTruthy();

  await gotoOverview(page, 390);

  const { tracks, spans, scrollWidth, clientWidth } = await page.evaluate(readSpans);
  expect(tracks).toBe(2); // base grid-cols-2

  for (const [id, span] of Object.entries(spans)) {
    if (span === null) continue;
    expect(span, `${id} asked for ${span} of ${tracks} tracks at 390px`).toBeLessThanOrEqual(2);
  }
  // The saved spans are 6 / 4 / 2 and all three clamp to 2 — stored unclamped,
  // rendered clamped.
  expect(spans['dns-hero']).toBe(2);
  expect(spans['host-status']).toBe(2);
  expect(spans['license-inventory']).toBe(2);

  expect(scrollWidth, `grid scrollWidth ${scrollWidth} > clientWidth ${clientWidth}`).toBeLessThanOrEqual(clientWidth);
});

test('widening the window restores the unclamped intent, because the clamp is render-only', async ({ page, request }) => {
  test.setTimeout(120_000);
  expect((await request.post('/api/views', { data: SAVE_BODY })).ok()).toBeTruthy();

  await gotoOverview(page, 390);
  expect((await page.evaluate(readSpans)).spans['dns-hero']).toBe(2);

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(1200); // ResizeObserver -> rAF -> re-clamp
  const wide = await page.evaluate(readSpans);
  expect(wide.tracks).toBe(6);
  expect(wide.spans['dns-hero']).toBe(6);

  // Leave the tenant as this file found it.
  await request.delete(`/api/views/${VIEW}`);
});
