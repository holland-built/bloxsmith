import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// A question that is still being sent must not pull the cursor back into the
// chat box once the person has moved on. Found from a trace of
// ask-lookup-pinned.spec.ts: the domain typed into Threat lookup landed in the
// chat box, because the chat put the cursor back one frame after sending
// whatever had focus by then.

test('typing in Threat lookup while a question is sent stays in Threat lookup', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/query', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ answer: 'Two hosts are offline.', trace: [] }) }),
  );
  await page.goto('/#ai');
  const chat = page.getByPlaceholder('Ask a question…');
  await expect(chat).toBeEnabled();

  // Hold the check that runs before every question, so the person can move
  // to the lookup box before the question is actually sent.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await page.route('**/api/vault/status', async (route) => { await gate; await route.fallback(); });

  await chat.fill('Which hosts are offline?');
  await chat.press('Enter');
  const lookup = page.getByPlaceholder('domain, IP, or host…');
  await lookup.click();
  release();
  await expect(page.getByRole('log').getByText('Two hosts are offline.')).toBeVisible();
  // Let any queued focus move run before looking.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await expect(lookup).toBeFocused();
  await page.keyboard.type('bad.example.com');
  await expect(lookup).toHaveValue('bad.example.com');
  await expect(chat).toHaveValue('');
});
