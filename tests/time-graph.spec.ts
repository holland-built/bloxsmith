import { test, expect } from '@playwright/test';

// P1 slice 5 — time & graph interaction system. Four parts, all against the
// SPARE local server.py (never :8080, which is a live Docker build):
//   1. global time-range control writes `t=` into the view-state hash
//   2. drag-select a time chart zooms + sets the global range; reset clears it
//   3. hovering a time chart shows a crosshair readout (value + timestamp)
//   4. audit/config-change annotation ticks overlay the time axis w/ hover detail
//
// The time control folds into the EXISTING hash serializer (parseHash/nav), so
// `t=` travels with the shareable URL exactly like `f=` / `<id>.q` do — no new
// store, no snapshot-key desync.
test.use({ baseURL: process.env.NOC_BASE || 'http://localhost:8091' });

// ── Part 1: global time control ─────────────────────────────────────────────
test('time-range preset writes t= into the URL hash and is optional by default', async ({ page }) => {
  await page.goto('/#overview');
  // Backward-compatible: unset by default — no t= in the hash.
  expect(page.url()).not.toContain('t=');

  const control = page.locator('.timerange');
  await expect(control).toBeVisible();

  const preset = control.locator('.tr-preset[data-preset="24h"]');
  await preset.click();
  await expect.poll(() => page.url()).toContain('t=24h');
  await expect(preset).toHaveAttribute('aria-pressed', 'true');

  // Reset ("All") clears it — back to default behavior, no t=.
  await control.locator('.tr-reset').click();
  await expect.poll(() => page.url()).not.toContain('t=');
});

// ── Security fixtures for parts 2–4 ─────────────────────────────────────────
// Events spread across a day so buckets differ; audit rows land inside the span.
const BASE = Date.parse('2026-07-09T00:00:00Z');
const H = 3600000;
function buildSecurity() {
  const events: any[] = [];
  for (let i = 0; i < 24; i++) {
    const n = i === 6 ? 12 : 2;              // a tall cluster at hour 6
    for (let k = 0; k < n; k++) {
      events.push({
        severity: 'high', qname: `e${i}_${k}.example`, policy_action: 'log',
        feed_name: 'f', device: `d${i}`, event_time: new Date(BASE + i * H).toISOString(),
      });
    }
  }
  return { counts: { high: events.length }, blocked: 0, logged: events.length, total: events.length, events };
}
// Audit rows (config changes) — /api/data feed shape (norm_audit → {ts,user,action,resource,result}).
const AUDIT = {
  subnets: [], leases: [], zones: [], hosts: [], events: [],
  auditLogs: [
    { id: 'a1', ts: new Date(BASE + 6 * H).toISOString(),  user: 'alice', action: 'UPDATE', resource: 'dns_record', result: 'success' },
    { id: 'a2', ts: new Date(BASE + 14 * H).toISOString(), user: 'bob',   action: 'DELETE', resource: 'subnet',     result: 'success' },
  ],
};

async function openSecurity(page: any) {
  await page.route('**/api/hub/security', (route: any) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildSecurity()) }));
  await page.route('**/api/data', (route: any) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(AUDIT) }));
  await page.goto('/#security');
  await expect(page.locator('.vh-svg')).toBeVisible();
}

// ── Part 2: capture-to-zoom + reset ─────────────────────────────────────────
test('drag-selecting the histogram zooms and sets the global t= range; reset clears it', async ({ page }) => {
  await openSecurity(page);
  const svg = page.locator('.vh-svg');
  const box = (await svg.boundingBox())!;
  expect(box).not.toBeNull();

  // Drag from ~20% to ~70% across the time axis.
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
  await page.mouse.up();

  // Global range is now an absolute from-to epoch window in the hash.
  await expect.poll(() => page.url()).toMatch(/t=\d+-\d+/);

  // A reset-zoom affordance is offered and clears the window.
  const reset = page.locator('.vh-reset');
  await expect(reset).toBeVisible();
  await reset.click();
  await expect.poll(() => page.url()).not.toContain('t=');
});

// ── Part 3: crosshair readout ───────────────────────────────────────────────
test('hovering the histogram shows a crosshair with a value + timestamp readout', async ({ page }) => {
  await openSecurity(page);
  const svg = page.locator('.vh-svg');
  const box = (await svg.boundingBox())!;

  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);

  // The crosshair is a zero-width SVG <line> (a vertical cursor) — present in the
  // DOM but bbox-invisible by definition; the readout tooltip is the visible part.
  await expect(page.locator('.vh-crosshair')).toHaveCount(1);
  const readout = page.locator('.vh-readout');
  await expect(readout).toBeVisible();
  // Value (event count) AND a timestamp are both present, as text (not color).
  await expect(readout).toContainText(/\d+\s+event/);
  await expect(readout).toContainText(/·/);
});

// ── Part 4: event annotations ───────────────────────────────────────────────
test('audit annotation ticks overlay the axis and reveal who/what/when on hover', async ({ page }) => {
  await openSecurity(page);
  const ticks = page.locator('.vh-annot');
  await expect.poll(() => ticks.count()).toBeGreaterThanOrEqual(1);

  await ticks.first().hover();
  const card = page.locator('.hoverdetail');
  await expect(card).toHaveClass(/show/);
  // Monochrome + text: the actor and action are spelled out, not color-coded.
  await expect(card).toContainText(/alice|bob/);
  await expect(card).toContainText(/UPDATE|DELETE/);
});
