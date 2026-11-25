import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { installBaselineWorld, openTask } from './page-fixtures';

// The shared error pieces in components/ui.jsx (FeedUnavailable, FetchError,
// FIELD_CLS) and FilterSelect, from the 2026-11-25 screen audit
// (A2 B1 B3 C2 C4 C7 C14 D2 D4 D8 D17 E1 E2 E5 E6).

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const SHELL = new Set(['/api/brand', '/api/update/check', '/api/vault/status', '/api/views', '/api/vault/write-target']);
const NO_SERVER = 'Bloxsmith itself did not answer. Check that it is still running.';
const TOO_SLOW = 'Infoblox did not answer in time.';

// Every request a page makes fails the way the audit's fail state did.
async function everyFeedFails(page: Page) {
  await installBaselineWorld(page);
  await page.route('**/api/**', (r) => (SHELL.has(new URL(r.request().url()).pathname)
    ? r.fallback()
    : r.fulfill(json({ error: 'upstream timeout' }, 502))));
}

// The colour a .text-muted line has on this page, for comparing against.
async function mutedColour(page: Page) {
  return page.evaluate(() => {
    const p = document.createElement('span');
    p.className = 'text-muted';
    document.body.append(p);
    const c = getComputedStyle(p).color;
    p.remove();
    return c;
  });
}

test('a browser that cannot reach Bloxsmith says so in plain words, in the muted colour', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/csp/assets?*', (r) => r.abort('failed'));
  await page.goto('/#assets');
  const box = page.locator('[data-feed-unavailable="Asset inventory unavailable"]');
  const reason = box.locator(':scope > div').nth(1);
  await expect(reason).toHaveText(NO_SERVER, { timeout: 20_000 });
  await expect(box).not.toContainText('Failed to fetch');
  // One problem, one severity colour: the label is red, the reason is muted.
  expect(await reason.evaluate((el) => getComputedStyle(el).color)).toBe(await mutedColour(page));
});

test('a list that cannot reach Bloxsmith names the list and the plain reason', async ({ page }) => {
  await page.route('**/api/ipam/spaces*', (r) => r.abort('failed'));
  await page.goto('/#selfservice');
  const card = await openTask(page, 'address');
  await expect(card.getByRole('alert').filter({ hasText: 'Could not load IP spaces.' }))
    .toContainText(`Could not load IP spaces. ${NO_SERVER}`);
  await expect(card).not.toContainText('Failed to fetch');
});

test('a list Infoblox is too slow to send says Infoblox did not answer in time', async ({ page }) => {
  test.setTimeout(60_000);
  // Never answered, so the page's own 12-second budget gives up on it.
  await page.route('**/api/ipam/spaces*', () => {});
  await page.goto('/#selfservice');
  const card = await openTask(page, 'address');
  await expect(card.getByRole('alert').filter({ hasText: 'Could not load IP spaces.' }))
    .toContainText(`Could not load IP spaces. ${TOO_SLOW}`, { timeout: 30_000 });
  await expect(card).not.toContainText(/abort/i);
});

test('a failed list says it is trying again, then offers Try again once the retries are spent', async ({ page }) => {
  test.setTimeout(60_000);
  await page.route('**/api/ipam/spaces*', (r) => r.fulfill(json({ error: 'upstream timeout' }, 502)));
  await page.goto('/#selfservice');
  const card = await openTask(page, 'address');
  const alert = card.getByRole('alert').filter({ hasText: 'Could not load IP spaces.' });
  await expect(alert).toContainText("Didn't load — trying again…");
  const again = alert.getByRole('button', { name: 'Try again' });
  await expect(again).toBeVisible({ timeout: 30_000 });
  await expect(alert).not.toContainText('trying again');
  // The same size as a panel header button, and the line wraps without an indent.
  const s = await again.evaluate((el) => {
    const b = getComputedStyle(el);
    const a = getComputedStyle(el.parentElement!);
    return { font: b.fontSize, padTop: b.paddingTop, ml: b.marginLeft, display: a.display, wrap: a.flexWrap };
  });
  expect(s).toEqual({ font: '14px', padTop: '6px', ml: '0px', display: 'flex', wrap: 'wrap' });
  // The reason is muted; only the sentence naming the failure is red.
  const reason = alert.getByText('upstream timeout.');
  expect(await reason.evaluate((el) => getComputedStyle(el).color)).toBe(await mutedColour(page));
});

test('the Try again button in a failed panel is the size of a header button', async ({ page }) => {
  test.setTimeout(60_000);
  await everyFeedFails(page);
  await page.goto('/#network');
  const again = page.locator('[data-feed-unavailable]').getByRole('button', { name: 'Try again' }).first();
  await expect(again).toBeVisible({ timeout: 30_000 });
  const s = await again.evaluate((el) => ({ font: getComputedStyle(el).fontSize, padTop: getComputedStyle(el).paddingTop }));
  expect(s).toEqual({ font: '14px', padTop: '6px' });
});

for (const width of [390, 1440]) {
  test(`at ${width}px every failed panel's message stays inside its panel`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    await everyFeedFails(page);
    for (const hash of ['#network', '#assets', '#incidents']) {
      await page.goto(`/${hash}`);
      await expect(page.locator('[data-feed-unavailable]').getByRole('button', { name: 'Try again' }).first())
        .toBeVisible({ timeout: 30_000 });
      const spill = await page.evaluate(() => [...document.querySelectorAll('[data-panel-id]')].flatMap((panel) => {
        const p = panel.getBoundingClientRect();
        return [...panel.querySelectorAll('[data-feed-unavailable], [data-feed-unavailable] *')]
          .map((el) => ({ el, b: el.getBoundingClientRect() }))
          .filter(({ b }) => b.height > 0 && b.bottom > p.bottom + 0.5)
          .map(({ el, b }) => `${panel.getAttribute('data-panel-id')}: ${el.tagName} ${Math.round(b.bottom - p.bottom)}px below`);
      }));
      expect(spill, hash).toEqual([]);
    }
  });
}

// Its words are dimmer and the pointer says no, but the outline keeps its full
// 3:1, which tests/contrast.spec.ts measures on every field, disabled or not.
test('a box that cannot be used looks it', async ({ page }) => {
  await page.goto('/#selfservice');
  const card = await openTask(page, 'address');
  const block = card.getByRole('combobox', { name: 'Address block', exact: true });
  const space = card.getByRole('combobox', { name: 'IP space', exact: true });
  await expect(block).toBeDisabled();
  await expect(space).toBeEnabled();
  const look = (el: Element) => ({ color: getComputedStyle(el).color, cursor: getComputedStyle(el).cursor, border: getComputedStyle(el).borderTopColor });
  const off = await block.evaluate(look);
  const on = await space.evaluate(look);
  expect(off.cursor).toBe('not-allowed');
  expect(off.color).not.toBe(on.color);
  expect(off.border).toBe(on.border);
});

test('a short list has no search box, and an empty one says there is nothing to pick yet', async ({ page }) => {
  await page.route('**/api/ipam/spaces*', (r) => r.fulfill(json({ spaces: [{ id: 'ipam/ip_space/1', name: 'one' }] })));
  await page.goto('/#selfservice');
  const card = await openTask(page, 'address');
  await expect(card.getByRole('combobox', { name: 'IP space', exact: true })).toBeVisible();
  await expect(card.getByRole('searchbox', { name: 'Search IP space' })).toHaveCount(0);

  await page.route('**/api/ipam/spaces*', (r) => r.fulfill(json({ spaces: [] })));
  await page.reload();
  const again = await openTask(page, 'address');
  const space = again.getByRole('combobox', { name: 'IP space', exact: true });
  await expect(space.locator('option').first()).toHaveText('Nothing to pick yet');
  await expect(again).not.toContainText('0 options');
});

test('a long list keeps its search box', async ({ page }) => {
  const spaces = Array.from({ length: 9 }, (_, i) => ({ id: `ipam/ip_space/${i}`, name: `space ${i}` }));
  await page.route('**/api/ipam/spaces*', (r) => r.fulfill(json({ spaces })));
  await page.goto('/#selfservice');
  const card = await openTask(page, 'address');
  await expect(card.getByRole('searchbox', { name: 'Search IP space' })).toBeVisible();
});
