import { test, expect } from './fixtures';

// Layout B for AI answers (picked 2026-11-06). A breakdown answer showed its
// table flush left under a centred answer, numbers ragged, and the "Counted by"
// line read "...exist in total 1447 DNS zones exist in total; the 25 below are
// a sample, not the full list.." because the DNS lookup returns two facts in
// one string and only the first sample clause was removed.

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const answer = [
  '**You have at least 1,607 DNS zones.**',
  '| Zone type | Count |',
  '|---|---|',
  '| Authoritative | 1,447 |',
  '| Forward | 160 |',
  "| Stub | Couldn't check |",
  '| Total | 1,607+ |',
].join('\n');

const trace = [
  { tool: 'api_get', args: { path: '/api/ddi/v1/dns/auth_zone' }, fact: '1447 records exist in total' },
  { tool: 'api_get', args: { path: '/api/ddi/v1/dns/forward_zone' }, fact: '160 records exist in total' },
  {
    tool: 'get_dns', args: {},
    fact: '320 DNS views exist in total; the 25 below are a sample, not the full list. 1447 DNS zones exist in total; the 25 below are a sample, not the full list.',
  },
];

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/query', (r) => r.fulfill(json({ answer, trace, suggestions: [] })));
  await page.goto('/#ai');
  const box = page.getByPlaceholder('Ask about your network…');
  await box.fill('how many DNS zones do I have');
  await box.press('Enter');
  await expect(page.getByRole('log').getByRole('table')).toBeVisible();
});

test('the counted line lists each fact once, with commas, and no leftover sample wording', async ({ page }) => {
  const line = page.getByRole('log').getByText(/^Counted by Bloxsmith:/);
  await expect(line).toHaveText(
    'Counted by Bloxsmith: 1,447 records exist in total · 160 records exist in total · 320 DNS views exist in total · 1,447 DNS zones exist in total.',
  );
});

test('a breakdown table is centred, numbers line up on the right, the total is bold and a missing part is marked', async ({ page }) => {
  const log = page.getByRole('log');
  const table = log.getByRole('table');
  const answerBox = (await log.locator('p').filter({ hasText: 'You have at least 1,607 DNS zones.' }).boundingBox())!;
  const t = (await table.boundingBox())!;
  const mid = (b: { x: number; width: number }) => b.x + b.width / 2;
  expect(Math.abs(mid(t) - mid(answerBox)), 'table centred under the answer').toBeLessThan(4);

  const count = table.getByRole('cell', { name: '1,447' });
  await expect(count).toHaveCSS('text-align', 'right');
  await expect(table.getByRole('cell', { name: 'Authoritative' })).toHaveCSS('text-align', 'left');

  const total = table.getByRole('row').filter({ hasText: 'Total' });
  expect(Number(await total.evaluate((r) => getComputedStyle(r).fontWeight))).toBeGreaterThanOrEqual(600);

  const missing = table.getByRole('cell', { name: "Couldn't check" });
  const warn = await page.evaluate(() => {
    const d = document.createElement('div');
    d.style.color = 'var(--color-warn)';
    document.body.appendChild(d);
    const c = getComputedStyle(d).color;
    d.remove();
    return c;
  });
  await expect(missing).toHaveCSS('color', warn);
});

test('a table wider than the chat column scrolls instead of being cut off on the left', async ({ page }) => {
  const wide = ['**Here are the subnets.**', '| Subnet | Name | Comment |', '|---|---|---|',
    `| 10.0.0.0/8 | ${'subnetname'.repeat(12)} | ${'a long comment '.repeat(10)} |`].join('\n');
  await page.unroute('**/api/query');
  await page.route('**/api/query', (r) => r.fulfill(json({ answer: wide, suggestions: [] })));
  const box = page.getByPlaceholder('Ask about your network…');
  await box.fill('list subnets');
  await box.press('Enter');
  const tables = page.getByRole('log').getByRole('table');
  await expect(tables).toHaveCount(2);
  const wrap = tables.nth(1).locator('..');
  const [w, t] = [(await wrap.boundingBox())!, (await tables.nth(1).boundingBox())!];
  expect(t.x, 'the table starts inside its scroll box').toBeGreaterThanOrEqual(w.x - 1);
});
