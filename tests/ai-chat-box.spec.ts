import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The AI page works like the chat boxes people know: Enter sends, Shift+Enter
// starts a new line, and New chat clears the conversation.

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

test('Enter sends, Shift+Enter adds a line, New chat starts over', async ({ page }) => {
  const asked: string[] = [];
  await page.route('**/api/query', (r) => { asked.push(r.request().postDataJSON().question); return r.fulfill({ json: { answer: 'ok' } }); });
  await page.goto('/#ai');
  await expect(page.getByText('What do you want to know about your network?')).toBeVisible();
  const box = page.getByRole('textbox', { name: 'Ask about your network' });
  await box.fill('first line');
  await box.press('Shift+Enter');
  await box.pressSequentially('second line');
  expect(asked).toHaveLength(0);
  await box.press('Enter');
  await expect.poll(() => asked).toEqual(['first line\nsecond line']);
  await expect(page.getByRole('log')).toContainText('ok');
  await expect(box).toHaveValue('');

  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.getByText('What do you want to know about your network?')).toBeVisible();
  await page.reload();
  await expect(page.getByText('What do you want to know about your network?')).toBeVisible();
});

test('a suggestion is asked with one click', async ({ page }) => {
  const asked: string[] = [];
  await page.route('**/api/query', (r) => { asked.push(r.request().postDataJSON().question); return r.fulfill({ json: { answer: 'ok' } }); });
  await page.goto('/#ai');
  await page.getByRole('button', { name: 'Which subnets are nearly full?' }).click();
  await expect.poll(() => asked).toEqual(['Which subnets are nearly full?']);
});
