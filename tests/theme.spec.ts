import { test, expect } from '@playwright/test';

// v2 theme system. LS wraps localStorage under a 'bx.' prefix and JSON-encodes
// values, so the persisted key is localStorage['bx.theme'] === '"light"' | '"dark"'.
// The boot <script> reads it before React mounts and sets html[data-theme]; the
// ThemeToggle button (label "Light"/"Dark") flips it and calls LS.set('theme').

test('toggle flips html[data-theme] and persists across reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.tabbar')).toBeVisible();

  const before = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(['light', 'dark']).toContain(before);

  // The toggle button shows the OTHER theme's name (dark -> "Light").
  const toggle = page.getByRole('button', { name: 'Toggle color theme' });
  await expect(toggle).toBeVisible();
  await toggle.click();

  const after = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(after).not.toBe(before);

  // Persisted (JSON string) under the bx.theme key.
  const stored = await page.evaluate(() => localStorage.getItem('bx.theme'));
  expect(stored).toBe(JSON.stringify(after));

  // Survives a reload (boot script re-applies from localStorage).
  await page.reload();
  await expect(page.locator('.tabbar')).toBeVisible();
  const afterReload = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(afterReload).toBe(after);
});

test('seeded bx.theme="light" applies a light theme + light body bg on overview', async ({ page }) => {
  // Seed BEFORE first paint so the boot script picks it up.
  await page.addInitScript(() => {
    try { localStorage.setItem('bx.theme', JSON.stringify('light')); } catch (e) {}
  });
  await page.goto('/#overview');
  await expect(page.locator('.tabbar')).toBeVisible();

  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(theme).toBe('light');

  // Light background: parse rgb() and require it to be bright (near-white --bg:#fafafa).
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const m = bg.match(/\d+/g)!.map(Number);
  const lum = 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
  expect(lum, `body bg ${bg} should be light`).toBeGreaterThan(200);
});

test('light-mode table text has >= 4.5:1 contrast against body bg', async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('bx.theme', JSON.stringify('light')); } catch (e) {}
  });
  // Network tab reliably renders a data table with live data.
  await page.goto('/#network', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();
  const cell = page.locator('.main table td').first();
  await expect(cell).toBeVisible({ timeout: 15000 });

  const ratio = await cell.evaluate((el) => {
    const rgb = (s: string) => (s.match(/\d+\.?\d*/g) || []).slice(0, 3).map(Number);
    const lin = (c: number) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const L = ([r, g, b]: number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const fg = L(rgb(getComputedStyle(el).color));
    const bg = L(rgb(getComputedStyle(document.body).backgroundColor));
    const [hi, lo] = fg > bg ? [fg, bg] : [bg, fg];
    return (hi + 0.05) / (lo + 0.05);
  });

  expect(ratio, 'light-mode table text/background contrast').toBeGreaterThanOrEqual(4.5);
});
