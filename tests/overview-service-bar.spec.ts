import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The owner's pick 2 (2026-11-24): on Overview's service bar, a bar that is
// good when full (services up) shows running services in plain grey and only
// the stopped ones in colour, and the stopped marks are also taller, so they
// read without colour. A bar that is bad when full (subnets full) is unchanged.
//
// Before: running marks took the verdict colour (amber when any were stopped)
// and stopped marks were the palest grey, so the problem had the least colour.
const HEALTH_25_28 = [
  { name: 'DNS', status: 'warn', statusLabel: 'degraded', meta: '3 stopped · 25/28 up', availability: 'ok' },
  { name: 'DHCP', status: 'ok', statusLabel: 'healthy', meta: '2/2 up', availability: 'ok' },
  { name: 'Security', status: 'ok', statusLabel: 'healthy', meta: '1/1 up', availability: 'ok' },
];

type Tick = { rgba: number[]; h: number };

// Each tick's painted colour, as bytes from a canvas so color-mix() and
// named spaces all compare the same way, and its height.
async function ticks(page, detail: string): Promise<{ ticks: Tick[]; warn: number[] }> {
  return page.locator(`section[aria-label="${detail}"]`).evaluate((sec) => {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    const px = (css: string) => {
      g.clearRect(0, 0, 1, 1);
      g.fillStyle = '#000';
      g.fillStyle = css;
      g.fillRect(0, 0, 1, 1);
      return [...g.getImageData(0, 0, 1, 1).data];
    };
    const probe = document.createElement('i');
    probe.style.background = 'var(--ov-warn)';
    sec.append(probe);
    const warn = px(getComputedStyle(probe).backgroundColor);
    probe.remove();
    const list = [...sec.querySelectorAll('.ov-ticks i')].map((el) => ({
      rgba: px(getComputedStyle(el).backgroundColor),
      h: el.getBoundingClientRect().height,
    }));
    return { ticks: list, warn };
  });
}

const grey = (c: number[]) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) < 16;
const same = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 2);

for (const theme of ['dark', 'light'] as const) {
  test(`${theme}: stopped services are the only coloured marks, and taller`, async ({ page }) => {
    await page.addInitScript((t) => { try { localStorage.setItem('theme', t) } catch {} }, theme);
    await installBaselineWorld(page);
    await page.route('**/api/hub/health', (r) => r.fulfill({ json: HEALTH_25_28 }));
    await page.goto('/#overview');
    const bar = page.locator('section[aria-label="DNS detail"] .ov-ticks[role="img"]');
    await expect(bar).toBeVisible({ timeout: 20000 });

    // 25 of 28 running: round(25/28 * 48) = 43 running marks, 5 stopped.
    const { ticks: t, warn } = await ticks(page, 'DNS detail');
    expect(t).toHaveLength(48);
    const running = t.slice(0, 43);
    const stopped = t.slice(43);
    for (const r of running) expect(grey(r.rgba), `running ${r.rgba}`).toBe(true);
    for (const s of stopped) expect(same(s.rgba, warn), `stopped ${s.rgba} vs warn ${warn}`).toBe(true);
    // Not by colour alone: every stopped mark is taller than every running one.
    expect(Math.min(...stopped.map((s) => s.h))).toBeGreaterThan(Math.max(...running.map((r) => r.h)));

    // All running: nothing on the bar is coloured.
    await page.getByRole('button', { name: /^DHCP/ }).click();
    const dhcp = await ticks(page, 'DHCP detail');
    expect(dhcp.ticks).toHaveLength(48);
    for (const r of dhcp.ticks) expect(grey(r.rgba), `dhcp ${r.rgba}`).toBe(true);

    // A bad-when-full bar keeps one height for every mark: it is not restyled.
    await page.getByRole('button', { name: /^IPAM/ }).click();
    const ipam = await ticks(page, 'IPAM detail');
    if (ipam.ticks.length) expect(new Set(ipam.ticks.map((x) => x.h)).size).toBe(1);
  });
}
