import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Ask tab, lookup layout "A · Pinned panel". Threat lookup is as tall as what
// it shows, not stretched to the Ask AI panel's row, and it stays in view
// beside the chat while the page scrolls. Before this, a failed lookup's
// "unavailable" block filled the stretched height and pushed the dossier and
// the search box off a short screen.

const LOOKUP = '[data-panel-id="ai-threat-lookup"]';

async function failedLookup(page) {
  await page.route('**/api/threat-lookup*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entities: [], availability: 'error', reason: 'upstream timed out' }) }),
  );
  await page.route('**/api/dossier*', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'vault locked' }) }),
  );
}

// Enough answers to make the chat log reach its cap, so the page is taller
// than a 760px screen, as it is after a few real questions.
async function fillChat(page) {
  const long = 'Two hosts are offline. '.repeat(12);
  await page.route('**/api/query', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ answer: long, trace: [] }) }),
  );
  const box = page.getByPlaceholder('Ask about your network…');
  for (let i = 0; i < 4; i++) {
    await box.fill(`Question ${i}`);
    await box.press('Enter');
    await expect(page.getByRole('log').getByText('AI-generated', { exact: true })).toHaveCount(i + 1);
  }
}

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

test('a failed lookup is only as tall as its content, not the height of the chat beside it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 760 });
  await failedLookup(page);
  await page.goto('/#ai');
  await fillChat(page);
  await page.getByPlaceholder('domain, IP, or host…').fill('bad.example.com');
  await page.getByRole('button', { name: 'Lookup', exact: true }).click();
  await expect(page.locator(`${LOOKUP} [data-feed-unavailable="Threat lookup unavailable"]`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lookup', exact: true })).toBeEnabled();

  // One reading, after the lookup has settled: no retrying assertion here.
  const ask = (await page.locator('[data-panel-id="ai-ask"]').boundingBox())!;
  const lookup = (await page.locator(LOOKUP).boundingBox())!;
  const block = (await page.locator(`${LOOKUP} [data-feed-unavailable="Threat lookup unavailable"]`).boundingBox())!;
  expect(ask.height, 'the chat must be tall, or this proves nothing').toBeGreaterThan(500);
  // The "unavailable" block holds two lines of text; stretched, it was hundreds of px.
  expect(block.height).toBeLessThan(160);
  expect(lookup.height).toBeLessThan(ask.height - 100);
});

test('the lookup stays in view beside the chat when the page scrolls', async ({ page }) => {
  // 700 tall, not the 760 the other tests here use. The page got shorter when
  // the panel spacing tightened on 2026-10-03, and at 760 it scrolled 196px:
  // under the 200 this test asks for before it will believe its own result.
  // The guard is kept as it was and the window is made shorter instead.
  const TALL = 700;
  await page.setViewportSize({ width: 1440, height: TALL });
  await page.goto('/#ai');
  await fillChat(page);
  const maxScroll = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
  expect(maxScroll, `the page must scroll at ${TALL}px tall, or this proves nothing`).toBeGreaterThan(200);

  const before = (await page.locator(LOOKUP).boundingBox())!;
  await page.evaluate((y) => window.scrollTo(0, y), maxScroll);
  await page.waitForFunction((y) => Math.abs(window.scrollY - y) < 2, maxScroll);
  const after = (await page.locator(LOOKUP).boundingBox())!;
  const search = (await page.getByPlaceholder('domain, IP, or host…').boundingBox())!;
  // Still beside the chat, pinned under the sticky header, and usable.
  expect(after.x).toBe(before.x);
  expect(after.y).toBeGreaterThanOrEqual(59);
  expect(after.y).toBeLessThan(90);
  expect(search.y).toBeGreaterThan(59);
  expect(search.y + search.height).toBeLessThan(TALL);
});

test('on a phone the lookup does not pin: it scrolls away under the chat as before', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#ai');
  const lb = (await page.locator(LOOKUP).boundingBox())!;
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const after = (await page.locator(LOOKUP).boundingBox())!;
  const scrolled = await page.evaluate(() => window.scrollY);
  expect(Math.abs(after.y - (lb.y - scrolled))).toBeLessThan(2);
});

test('moved above the chat, the lookup does not pin, so it can never float over it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 760 });
  await page.goto('/#ai');
  const lookup = page.locator(LOOKUP);
  expect(await lookup.evaluate((el) => getComputedStyle(el).position)).toBe('sticky');
  // Stands in for a saved layout that puts the lookup first: widened to the
  // full row, the chat would scroll up underneath a pinned lookup.
  await lookup.evaluate((el) => el.parentElement!.insertBefore(el, el.parentElement!.firstElementChild));
  expect(await lookup.evaluate((el) => getComputedStyle(el).position)).not.toBe('sticky');
});
