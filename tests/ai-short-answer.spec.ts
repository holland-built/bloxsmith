import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// "Entirely too much info on the answer": an answer shows its sentence, three
// suggestions and one line of facts Bloxsmith counted. How it looked things up
// folds away until asked for.

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

test('an answer is short: three suggestions, one fact line, lookups folded', async ({ page }) => {
  await page.route('**/api/query', (r) => r.fulfill({ json: {
    answer: '**You have 620 /32 subnets.**',
    suggestions: ['How many /30s?', 'How many /24s?', 'Which are full?', 'Show /31s', 'Show /32s'],
    trace: [
      { tool: 'get_subnets', args: { prefix: 32 }, fact: '72535 subnets exist in total; the 25 below are a sample, not the full list.' },
      { tool: 'api_get', args: { path: 'ipam/subnet' }, fact: '620 records exist in total; the 10 below are a sample, not the full list.' },
    ],
  } }));
  await page.goto('/#ai');
  const box = page.getByRole('textbox', { name: 'Ask about your network' });
  await box.fill("how many /32's do I have");
  await box.press('Enter');
  const log = page.getByRole('log');
  await expect(log).toContainText('You have 620 /32 subnets.');
  await expect(log.getByText('Counted by Bloxsmith: 72535 subnets exist in total · 620 records exist in total')).toBeVisible();
  for (const sg of ['How many /30s?', 'How many /24s?', 'Which are full?']) await expect(log.getByText(sg, { exact: true })).toBeVisible();
  await expect(log.getByText('Show /31s', { exact: true })).toHaveCount(0);
  await expect(log.getByText('get_subnets')).toBeHidden();
  await log.getByText('How I got this (2 lookups)').click();
  await expect(log.getByText('get_subnets')).toBeVisible();
});

test('a fact with two counts keeps both on the visible line', async ({ page }) => {
  await page.route('**/api/query', (r) => r.fulfill({ json: {
    answer: '**You have 12 zones.**',
    trace: [{ tool: 'get_dns', args: {}, fact: '3 DNS views; 12 zones exist in total; the 10 below are a sample, not the full list.' }],
  } }));
  await page.goto('/#ai');
  const box = page.getByRole('textbox', { name: 'Ask about your network' });
  await box.fill('how many zones');
  await box.press('Enter');
  await expect(page.getByRole('log').getByText('Counted by Bloxsmith: 3 DNS views; 12 zones exist in total', { exact: true })).toBeVisible();
});
