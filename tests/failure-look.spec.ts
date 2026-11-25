import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { installBaselineWorld, openTask } from './page-fixtures';

// GUI audit round 2, R2-A4, R2-C3, R2-E2. A failed panel looked three different
// ways (a centred red line, an 11px line beside a 14px button, 13px grey text),
// took three lines to say one thing, said "Try again in a moment" while the app
// was already retrying, and blamed "the server" without saying which one.

const SHELL = new Set(['/api/brand', '/api/update/check', '/api/vault/status', '/api/views', '/api/vault/write-target']);

// Every read fails the way the audit's fail state did: 503, no body.
async function everyReadFails(page: Page) {
  await installBaselineWorld(page);
  await page.route('**/api/**', (r) => (SHELL.has(new URL(r.request().url()).pathname)
    ? r.fallback()
    : r.fulfill({ status: 503, body: '' })));
}

// Size and colour of a failure's red words, its reason and its retry part.
const look = (box: Locator) => box.evaluate((el) => {
  const kids = [...el.querySelectorAll('*')].filter((k) => k.children.length === 0 && (k.textContent || '').trim()) as HTMLElement[];
  // One line that wraps only when its panel is too narrow, not three stacked
  // lines: the parts flow in a wrapping row.
  const box = getComputedStyle(el);
  return {
    sizes: [...new Set(kids.map((k) => getComputedStyle(k).fontSize))],
    oneLine: box.display === 'flex' && box.flexDirection === 'row' && box.flexWrap === 'wrap',
    text: (el.textContent || '').trim(),
  };
});

test('a failed panel and a failed list look the same: one 14px line, who failed, no "in a moment"', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await everyReadFails(page);
  await page.goto('/#network');
  const panel = page.locator('[data-feed-unavailable]:has([data-failure-reason])').first();
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const p = await look(panel);
  expect(p.sizes, 'every part of a failed panel is body size').toEqual(['14px']);
  expect(p.oneLine, `a failed panel says it on one line: ${p.text}`).toBe(true);
  expect(p.text).toMatch(/Bloxsmith/);
  await expect(page.locator('main')).not.toContainText(/try again in a moment/i);

  await page.goto('/#selfservice');
  const card = await openTask(page, 'address');
  const list = card.getByRole('alert').filter({ hasText: 'Could not load IP spaces.' });
  await expect(list).toBeVisible({ timeout: 30_000 });
  const l = await look(list);
  expect(l.sizes, 'every part of a failed list is body size').toEqual(['14px']);
  expect(l.oneLine, `a failed list says it on one line: ${l.text}`).toBe(true);
  await expect(list).not.toContainText(/in a moment/i);
});
