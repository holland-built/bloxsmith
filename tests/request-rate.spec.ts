import { test, expect, type Page } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// HOW MANY REQUESTS A PAGE SENDS, counted at the network layer.
//
// Four things this guards, each of which used to cost a request that brought
// back nothing new:
//   - the header's status dot polled the full /api/data (1.5 MB raw on the live
//     tenant) every 60s on top of the page's own 30s poll of the same url, so
//     Network, Infra and Daily fetched it three times a minute. The dot now takes
//     the page's answer (lib/api.js adoption, 45s window). Overview was already
//     at two, because Overview itself adopts the dot's answer when their ticks
//     meet; its test guards that it stays there. Measured with the old code:
//     Network 6 in two minutes, Overview 4.
//   - Self-service read the zone list twice and the IP space list three times
//     on every visit; Provision the space and template lists twice each.
//   - the boot read /api/vault/status twice: VaultGate's gate check, then the
//     header's poll a moment later.
//   - Overview fetched the chart library ahead of the board for one chart
//     below the fold; it now waits for the page to be idle (last test).
//
// The clock is faked so two minutes of polling take a second. Time is advanced
// in 5s steps with a pause between, so each poll's answer has landed before the
// next timer fires, as it would in real time.

function counter(page: Page) {
  const counts = new Map<string, number>();
  page.on('request', (req) => {
    const url = new URL(req.url());
    const key = url.pathname.startsWith('/api/') ? url.pathname + url.search : url.pathname;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });
  return {
    get: (key: string) => counts.get(key) ?? 0,
    api: () => [...counts].filter(([k]) => k.startsWith('/api/')).reduce((n, [, v]) => n + v, 0),
    reset: () => counts.clear(),
    dump: () => Object.fromEntries([...counts].filter(([k]) => k.startsWith('/api/')).sort()),
  };
}

async function twoMinutes(page: Page) {
  for (let t = 0; t < 120_000; t += 5_000) {
    await page.clock.runFor(5_000);
    await page.waitForTimeout(60);
  }
}

async function open(page: Page, hash: string, ready: () => Promise<void>) {
  await installBaselineWorld(page);
  await page.clock.install();
  const c = counter(page);
  await page.goto(`/#${hash}`);
  await ready();
  // Let anything the mount started finish before the steady state is counted.
  await page.waitForTimeout(500);
  return c;
}

const overviewReady = (page: Page) => () =>
  expect(page.locator('[data-board-row="Hosts"]')).toContainText(/\d+ of \d+ not online/, { timeout: 20_000 });

test('Overview: /api/data is fetched twice a minute, not three times', async ({ page }) => {
  const c = await open(page, 'overview', overviewReady(page));
  const mount = c.api();
  c.reset();
  await twoMinutes(page);
  console.log(`overview: ${mount} API requests at mount; over two minutes ${c.api()} (${c.api() / 2}/min)`, c.dump());
  // The page polls every 30s: 4 in two minutes, and the dot's two 60s ticks
  // share one of those rather than adding to them.
  expect(c.get('/api/data'), 'full /api/data fetches in two minutes').toBe(4);
});

test('Network: the header dot shares the page\'s /api/data poll', async ({ page }) => {
  // The old code made 6: the dot's two 60s ticks fetched on top of the page's 4.
  const c = await open(page, 'network', () =>
    expect(page.locator('[data-panel-id="network-utilization-distribution"]')).toBeVisible({ timeout: 20_000 }));
  const mount = c.api();
  c.reset();
  await twoMinutes(page);
  console.log(`network: ${mount} API requests at mount; over two minutes ${c.api()} (${c.api() / 2}/min)`, c.dump());
  expect(c.get('/api/data'), 'full /api/data fetches in two minutes').toBe(4);
});

test('Self-service: each picker list is read once per visit', async ({ page }) => {
  const c = await open(page, 'selfservice', () =>
    expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 }));
  const mount = c.dump();
  const mountTotal = c.api();
  c.reset();
  await twoMinutes(page);
  console.log(`selfservice: ${mountTotal} API requests at mount`, mount, `; over two minutes ${c.api()} (${c.api() / 2}/min)`, c.dump());
  expect(mount['/api/dns/zones'], 'zone list reads at mount').toBe(1);
  expect(mount['/api/ipam/spaces'], 'IP space list reads at mount').toBe(1);
});

test('boot reads the vault status once, not once for the gate and again for the header', async ({ page }) => {
  const c = await open(page, 'overview', overviewReady(page));
  expect(c.get('/api/vault/status')).toBe(1);
});

test('Overview draws its DNS chart without a scroll, in the placeholder\'s space', async ({ page }) => {
  // The chart below the board waits until the page is idle (or near the
  // screen) before it fetches the chart library. It must still arrive on its
  // own, and the placeholder must have held exactly its height.
  await open(page, 'overview', overviewReady(page));
  const hero = page.locator('[data-panel-id="dns-hero"]');
  const before = await hero.boundingBox();
  await expect(hero.locator('.recharts-surface')).toBeAttached({ timeout: 10_000 });
  const after = await hero.boundingBox();
  expect(Math.round(after!.height)).toBe(Math.round(before!.height));
});
