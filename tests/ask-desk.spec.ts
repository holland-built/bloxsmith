import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The Ask tab's "B · Desk" layout: asking leads, wide and filled; Threat
// lookup sits beside it, open, so both are usable at once and the lookup never
// reads as the model's evidence. Every answer says it is AI-generated, next to
// the server-counted facts; an error does not.

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('at desktop width Threat lookup sits beside Ask AI, open, not below it', async ({ page }) => {
  await page.goto('/#ai');
  const ask = await page.locator('[data-panel-id="ai-ask"]').boundingBox();
  const lookup = page.locator('[data-panel-id="ai-threat-lookup"]');
  const lb = await lookup.boundingBox();
  expect(ask && lb).toBeTruthy();
  expect(lb!.x).toBeGreaterThan(ask!.x + ask!.width - 1);
  expect(Math.abs(lb!.y - ask!.y)).toBeLessThan(2);
  expect(ask!.width).toBeGreaterThan(lb!.width);
  expect(await lookup.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
});

test('every answer is marked AI-generated and keeps its tool facts; an error is not marked', async ({ page }) => {
  let n = 0;
  await page.route('**/api/query', (route) => {
    n += 1;
    const body = n === 1
      ? { answer: 'Two hosts are offline.', trace: [{ tool: 'list_hosts', args: { status: 'offline' }, fact: '2 rows' }] }
      : { error: 'provider refused' };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/#ai');
  const box = page.getByPlaceholder('Ask about your network…');
  await box.fill('Which hosts are offline?');
  await box.press('Enter');
  const log = page.getByRole('log');
  await expect(log.getByText('Two hosts are offline.')).toBeVisible();
  await expect(log.getByText('AI-generated', { exact: true })).toHaveCount(1);
  await expect(log.getByText('↳ 2 rows')).toBeVisible();

  await box.fill('And now?');
  await box.press('Enter');
  await expect(log.getByText('provider refused')).toBeVisible();
  await expect(log.getByText('AI-generated', { exact: true })).toHaveCount(1);
});

test('suggestions are square-cornered buttons, not pills', async ({ page }) => {
  await page.goto('/#ai');
  const sg = page.getByRole('button', { name: 'Which hosts are offline?' });
  const radius = await sg.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius));
  expect(radius).toBeLessThan(12);
});

test('on a phone the two panels stack, lookup under the chat', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#ai');
  const ask = await page.locator('[data-panel-id="ai-ask"]').boundingBox();
  const lb = await page.locator('[data-panel-id="ai-threat-lookup"]').boundingBox();
  expect(lb!.y).toBeGreaterThan(ask!.y + ask!.height - 1);
});

test('a wide lookup result can be scrolled to its last column, not clipped', async ({ page }) => {
  // Long values, as real feeds return: each cell caps at 180px, so eight of
  // them are far wider than the lookup panel beside the chat.
  const long = 'Infoblox_High_Risk,Infoblox_Base,Suspicious_Lookalike';
  const row = { name: 'tbcloud-alibaba.com.example-lookalike.net', type: long, threat_level: long, class: long, property: long, feed: long, first_seen: long, last_seen: long, last_column: 'reach me' };
  await page.route('**/api/threat-lookup*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entities: [row], availability: 'ok' }) }),
  );
  await page.goto('/#ai');
  await page.getByPlaceholder('domain, IP, or host…').fill('tbcloud-alibaba.com');
  await page.getByRole('button', { name: 'Lookup', exact: true }).click();
  // The table's own wrapper, found without relying on anything this change added.
  const region = page.locator('[data-panel-id="ai-threat-lookup"] table').first().locator('..');
  await expect(region).toBeVisible();
  expect(await region.evaluate((el) => el.scrollWidth > el.clientWidth), 'the table was not wider than the panel, so this proves nothing').toBe(true);
  // What a user does: a sideways wheel over the table. A clipped box ignores
  // it (a script could still scroll it, which is why this is not scrollIntoView).
  const r = await region.boundingBox();
  await page.mouse.move(r!.x + r!.width / 2, r!.y + 20);
  await page.mouse.wheel(2000, 0);
  await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  const c = await region.getByRole('columnheader', { name: 'last_column' }).boundingBox();
  expect(c!.x + c!.width).toBeLessThanOrEqual(r!.x + r!.width + 1);
});
