import { test, expect } from './fixtures';

// The header's half of the help layer. Reported symptom: "I didn't know what
// the compact was at the top" — six controls in one row, every one of them
// explaining itself through a `title=` hover tooltip that does not exist on
// touch and is never read on a desk either.
//
// TWO SURFACES, ONE FACT, AND THE SPLIT IS DELIBERATE. Above `lg` the theme and
// density switches are in the header, so the header carries a dialog naming
// every control in it. Below `lg` those two switches are not in the header at
// all (App.jsx's A3 fold moves them into the "…" sheet), so the dialog folds
// with them and the sheet's always-visible captions are what a narrow screen
// reads. Neither width is left without an answer, and neither gets an answer
// about a control it cannot see.
//
// Playwright's Desktop Chrome default viewport is 1280px, i.e. above `lg`, so
// the unfolded form is what the first tests below see.

const OPEN = { name: 'What these controls do', exact: true };

test('the header carries a button that opens control help', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  const btn = page.getByRole('button', OPEN);
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
});

test('it opens a real modal dialog naming all six header controls', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  await page.getByRole('button', OPEN).click();

  const dialog = page.getByRole('dialog', { name: 'What these controls do' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(page.getByRole('button', OPEN)).toHaveAttribute('aria-expanded', 'true');

  // One row per control in the header, in the header's own order. Asserted by
  // the term list rather than by free text so a paragraph that happens to
  // contain the word "theme" cannot stand in for an entry.
  const terms = dialog.locator('dt');
  await expect(terms).toHaveCount(6);
});

test('the density entry answers the question that was actually asked', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();
  await page.getByRole('button', OPEN).click();

  const dialog = page.getByRole('dialog', { name: 'What these controls do' });
  await expect(dialog).toContainText('Compact fits more rows on screen');
  await expect(dialog).toContainText('Comfortable gives everything more space');
});

test('Escape closes it and focus goes back to the button that opened it', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  const btn = page.getByRole('button', OPEN);
  await btn.click();
  const dialog = page.getByRole('dialog', { name: 'What these controls do' });
  await expect(dialog).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // Focus landing on BODY is the failure this guards: a keyboard user would
  // restart at the top of the document every time they read one line of help.
  await expect(btn).toBeFocused();
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
});

test('the ✕ closes it and also returns focus', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  const btn = page.getByRole('button', OPEN);
  await btn.click();
  const dialog = page.getByRole('dialog', { name: 'What these controls do' });
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await expect(btn).toBeFocused();
});

test('it is reachable with the keyboard alone', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  // press() sends a real key event to a focused element — no synthesised
  // click — so this fails if the trigger is pointer-only.
  await page.getByRole('button', OPEN).press('Enter');
  await expect(page.getByRole('dialog', { name: 'What these controls do' })).toBeVisible();
});

test('below lg the trigger folds away with the controls it describes', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  // Same fold as the theme and density switches beside it (App.jsx's A3 fold
  // comment). Explaining a switch that is not on this screen would send a
  // phone user hunting the header for a control that lives in the sheet.
  await expect(page.getByRole('button', OPEN)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
});

test('the settings sheet spells out both switches, at every width', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();

  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await expect(sheet).toBeVisible();
  // Always-visible text, not a tooltip and not behind another disclosure: this
  // is the only place a phone can read what the two switches do.
  await expect(sheet).toContainText('Compact fits more rows on screen');
  await expect(sheet).toContainText('System follows your computer');
});

test('the settings sheet captions survive the fold', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();

  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await expect(sheet).toContainText('Compact fits more rows on screen');
});

test('Overview says how to rearrange it, and that nothing needs saving', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  // "How do I save my layout?" has no button as its answer — there is no save
  // button and there never was; every drop and resize writes itself. Overview
  // is also the ONLY rearrangeable tab, so the sentence belongs on it and
  // nowhere else.
  const intro = page.locator('main p').first();
  await expect(intro).toContainText('drag');
  await expect(intro).toContainText('resize');
  await expect(intro).toContainText('saves automatically');
});
