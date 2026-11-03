import { test, expect } from '@playwright/test';

// The AI answer box printed the model's text as-is, so bold showed as ** and a
// table as rows of | characters. The model is now told to answer with a bold
// first line and one short table (rule 12, go/internal/ai/schema.go), and the
// box renders that as bold text and a real table.

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

test('an AI answer shows its bold line and its table, not markdown characters', async ({ page }) => {
  const answer = [
    '**Found 1 network list and 5 hosts.**',
    '| Item | Answer |',
    '|---|---|',
    '| Network list | **sholland-home** |',
    '| Note | see [this page](https://evil.example) |',
    '- Subnets not checked',
  ].join('\n');
  await page.route('**/api/query', (route) => route.fulfill(json({ answer, suggestions: [] })));
  await page.goto('/#ai');
  const box = page.getByPlaceholder('Ask about your network…');
  await box.fill('show me sholland networks');
  await box.press('Enter');
  const log = page.getByRole('log');
  await expect(log.locator('strong', { hasText: 'Found 1 network list and 5 hosts.' })).toBeVisible();
  const table = log.getByRole('table');
  await expect(table.getByRole('columnheader', { name: 'Item' })).toBeVisible();
  await expect(table.getByRole('cell', { name: 'sholland-home' })).toBeVisible();
  await expect(log.getByRole('listitem')).toHaveText('Subnets not checked');
  await expect(log).not.toContainText('**');
  await expect(log).not.toContainText('|');
  // Text in the answer can come from the tenant's own data, so a link in it
  // shows as words only.
  await expect(log.getByText('this page')).toBeVisible();
  await expect(log.getByRole('link')).toHaveCount(0);
});
