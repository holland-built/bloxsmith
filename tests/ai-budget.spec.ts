import { test, expect } from './fixtures';

// BudgetLine (ui/src/tabs/Ai.jsx) is the one place the operator learns how
// much of the AI provider's budget this server has used today. Its rules are
// literal (see the comment above BudgetLine in Ai.jsx):
//   1. No "limit_tokens" -> no denominator, no percent, no bar. We do not
//      know the provider's real cap, so we must never imply one.
//   2. What renders is what THIS server counted, not the account's true
//      usage, said in plain text.
//   3. "near_limit" true -> a warning as readable TEXT, not colour alone.
//   4. No "budget" object at all -> render nothing. Silence, never a
//      fabricated zero.
//
// Every test here stubs /api/query so no real LLM call is made — the
// provider has a daily token cap and a real call would burn it and make the
// run flaky. The test drives the UI the way an operator does: open the AI
// tab, ask a question, read what comes back.

function fulfillJson(route: import('@playwright/test').Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function askSomething(page: import('@playwright/test').Page) {
  await page.goto('/#ai');
  await page.getByPlaceholder('Ask about your network…').fill('Which hosts are offline?');
  await page.getByRole('button', { name: 'Ask' }).click();
}

test.describe('AI token-budget line — honesty rules', () => {
  test('no limit known: count shows, no denominator, no percent, no bar', async ({ page }) => {
    await page.route('**/api/query', (route) =>
      fulfillJson(route, {
        answer: 'All hosts are online.',
        budget: { tokens_today: 4299, day: '2026-07-30', counted_by: 'this server only' },
      }),
    );
    await askSomething(page);

    const line = page.getByText(/tokens today/);
    await expect(line).toBeVisible();
    await expect(line).toContainText('4,299');

    const text = (await line.textContent()) || '';
    expect(text).not.toMatch(/\/\s*[\d,]+/); // no "/ <number>" denominator
    expect(text).not.toContain('%');
    // No progress-bar element rendered alongside the budget line.
    await expect(page.locator('[role="progressbar"]')).toHaveCount(0);
  });

  test('limit known: both the count and the limit render, formatted', async ({ page }) => {
    await page.route('**/api/query', (route) =>
      fulfillJson(route, {
        answer: 'All hosts are online.',
        budget: {
          tokens_today: 4299,
          day: '2026-07-30',
          counted_by: 'this server only',
          limit_tokens: 100000,
        },
      }),
    );
    await askSomething(page);

    const line = page.getByText(/tokens today/);
    await expect(line).toBeVisible();
    await expect(line).toContainText('4,299');
    await expect(line).toContainText('100,000');
  });

  test('near limit: the warning is readable text, not colour alone', async ({ page }) => {
    await page.route('**/api/query', (route) =>
      fulfillJson(route, {
        answer: 'All hosts are online.',
        budget: {
          tokens_today: 4299,
          day: '2026-07-30',
          counted_by: 'this server only',
          limit_tokens: 100000,
          near_limit: true,
        },
      }),
    );
    await askSomething(page);

    // The sentence itself must be present as text an operator (or a screen
    // reader) can read — not merely implied by a colour/style change.
    await expect(page.getByText(/near the daily limit, the AI may stop answering soon/)).toBeVisible();
  });

  test('budget absent: no budget line renders — silence, never a fabricated zero', async ({ page }) => {
    await page.route('**/api/query', (route) =>
      fulfillJson(route, { answer: 'All hosts are online.' }),
    );
    await askSomething(page);

    // Give the answer a moment to land, then assert no budget text exists at all.
    await expect(page.getByText('All hosts are online.')).toBeVisible();
    await expect(page.getByText(/tokens today/)).toHaveCount(0);
    await expect(page.getByText(/0 tokens today/)).toHaveCount(0);
  });
});
