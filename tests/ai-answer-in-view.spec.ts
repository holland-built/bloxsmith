import { test, expect } from './fixtures';

// A long answer (a table, a note, the counted line, Ask next) used to land with
// the chat scrolled to its very end, so the bold answer sat above the top of
// the box and you had to scroll up to read it. Now the question goes to the top
// of the box and the answer reads down from there.

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const answer = [
  '**You have 1,607 DNS zones.**',
  '| Type | Count |',
  '|---|---|',
  ...Array.from({ length: 14 }, (_, i) => `| Kind ${i + 1} | ${i * 10} |`),
  '- One lookup failed, so the total could be higher.',
].join('\n');

async function ask(page, q: string) {
  const box = page.getByPlaceholder('Ask about your network…');
  await box.fill(q);
  await box.press('Enter');
}

test('a long answer opens at its question, with the bold answer in view', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/query', (route) => route.fulfill(json({
    answer, suggestions: ['How many stub zones do I have?', 'How many reverse zones do I have?', 'Show me the DNS views'],
  })));
  await page.goto('/#ai');
  await ask(page, 'how many zones do I have');
  const log = page.getByRole('log');
  const bold = log.locator('strong', { hasText: 'You have 1,607 DNS zones.' });
  await expect(bold).toBeVisible();
  // Two questions, so the second answer has something above it to hide behind.
  await ask(page, 'how many zones do I have, again');
  await expect(bold.nth(1)).toBeVisible();
  await page.waitForTimeout(300);

  const lb = (await log.boundingBox())!;
  const q = (await log.getByText('how many zones do I have, again').boundingBox())!;
  const b = (await bold.nth(1).boundingBox())!;
  expect(Math.abs(q.y - lb.y), 'the latest question sits at the top of the box').toBeLessThan(40);
  expect(b.y + b.height, 'the bold answer is inside the box, not above or below it').toBeLessThan(lb.y + lb.height);
  expect(b.y).toBeGreaterThan(lb.y);
  // And the box is long enough to matter: the rest scrolls below.
  expect(await log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeGreaterThan(0);
});

test('the chat fills the window below the title, with the composer still on screen', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#ai');
  await page.route('**/api/query', (route) => route.fulfill(json({ answer, suggestions: [] })));
  await ask(page, 'how many zones do I have');
  await expect(page.getByRole('log').locator('strong').first()).toBeVisible();
  const log = (await page.getByRole('log').boundingBox())!;
  const composer = (await page.getByPlaceholder('Ask about your network…').boundingBox())!;
  const card = (await page.locator('[data-panel-id="ai-ask"]').boundingBox())!;
  // The card ends near the bottom of the window, not 60% of the way down it.
  expect(card.y + card.height).toBeLessThanOrEqual(900);
  expect(card.y + card.height).toBeGreaterThan(900 - 40);
  expect(composer.y + composer.height).toBeLessThan(900);
});
