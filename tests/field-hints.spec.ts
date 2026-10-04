import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Every /api/ response is faked from tests/page-fixtures.ts.
//
// A box that holds an address, a host name or a filter tells the browser so:
// no spell-check, no autofill history, no auto-capitalising. A box that holds
// prose says nothing and keeps its spell-check.
//
// ui/src/lib/machineText.test.js reads the source and holds the full list of
// which box is which. This is the other half: that the attributes written in
// the source reach the element a person types in.
test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

test('a filter box is marked as machine text', async ({ page }) => {
  await page.goto('/#overview');
  const filter = page.getByLabel('Filter subnets');
  await expect(filter).toBeVisible({ timeout: 20_000 });
  await expect(filter).toHaveAttribute('spellcheck', 'false');
  await expect(filter).toHaveAttribute('autocomplete', 'off');
  await expect(filter).toHaveAttribute('autocapitalize', 'none');
});

test('a form box for a name is machine text, and the comment box beside it is not', async ({ page }) => {
  await page.goto('/#provision');
  const name = page.getByPlaceholder('subnet name');
  await expect(name).toBeVisible({ timeout: 20_000 });
  await expect(name).toHaveAttribute('spellcheck', 'false');
  await expect(name).toHaveAttribute('autocomplete', 'off');

  // The comment is prose: a browser's spell-check is the point there.
  const comment = page.getByPlaceholder('optional');
  await expect(comment).toBeVisible();
  expect(await comment.getAttribute('spellcheck')).toBeNull();
  expect(await comment.getAttribute('autocomplete')).toBeNull();
});
