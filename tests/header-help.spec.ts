import { test, expect } from './fixtures';

// The header's half of the help layer. Reported symptom: "I didn't know what
// the compact was at the top" — six controls in one row, every one of them
// explaining itself through a `title=` hover tooltip that does not exist on
// touch and is never read on a desk either.
//
// ONE DIALOG, TWO DOORS. Above `lg` the header's ⓘ opens it. Below `lg` that
// button is display:none (App.jsx's A3 fold takes it with the two switches it
// describes), so the settings sheet's "What these controls do →" row is the
// door — and it is the door at every width, because the switches themselves
// live in that sheet too.
//
// WHAT THIS FILE STOPPED ASSERTING, AND WHY. The sheet used to print the same
// sentences as always-visible captions, once under each switch and once under
// Updates. Reported as "in a setting kabob why have feature description": a
// settings panel is controls, not a manual. The sentences now exist once, in
// ui/src/lib/controlHelp.js, rendered by one component. The tests below assert
// the absence as hard as they assert the link, because a caption creeping back
// in is exactly the regression that is easy to ship.
//
// Playwright's Desktop Chrome default viewport is 1280px, i.e. above `lg`, so
// the unfolded form is what the first tests below see.

const OPEN = { name: 'What these controls do', exact: true };
const SHEET_LINK = { name: 'What these controls do →', exact: true };
const SETTINGS = { name: 'Settings', exact: true };

// Verbatim out of CONTROL_HELP — the three paragraphs that used to sit in the
// settings sheet. Written out here rather than imported so the test fails if
// the dictionary is edited to dodge it.
const EXPLANATIONS = [
  'System follows your computer',
  'Compact fits more rows on screen',
  'Appears at the top of the screen only when a newer version exists',
];

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
  // comment). A trigger here would point at controls that are not on screen.
  await expect(page.getByRole('button', OPEN)).toBeHidden();
  await expect(page.getByRole('button', SETTINGS)).toBeVisible();
});

test('the settings sheet holds controls, not explanations', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();
  await page.getByRole('button', SETTINGS).click();

  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await expect(sheet).toBeVisible();
  // The switches and their short labels stay — those are the controls.
  await expect(sheet).toContainText('Light · System · Dark');
  await expect(sheet).toContainText('Comfortable · Compact');
  // The three paragraphs do not. This is the complaint, asserted.
  for (const sentence of EXPLANATIONS) {
    await expect(sheet).not.toContainText(sentence);
  }
});

test('one link, not one per setting', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();
  await page.getByRole('button', SETTINGS).click();

  const sheet = page.getByRole('dialog', { name: 'Settings' });
  // Three captions replaced by ONE row, near the top of Appearance — not a
  // link repeated under every switch, which is the same clutter in a new hat.
  await expect(sheet.getByRole('button', SHEET_LINK)).toHaveCount(1);
  await expect(sheet.getByRole('button', SHEET_LINK)).toHaveAttribute('aria-haspopup', 'dialog');
});

test('the link closes Settings and opens the dialog, rather than stacking two', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();
  await page.getByRole('button', SETTINGS).click();

  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await sheet.getByRole('button', SHEET_LINK).click();

  const dialog = page.getByRole('dialog', { name: 'What these controls do' });
  await expect(dialog).toBeVisible();
  // Two modal dialogs at once means two focus traps and two Escape handlers
  // arguing over the same keypress.
  await expect(sheet).toBeHidden();
  await expect(dialog.locator('dt')).toHaveCount(6);
});

test('closing that dialog puts focus back on the Settings button, not the ⓘ', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  const settings = page.getByRole('button', SETTINGS);
  await settings.click();
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', SHEET_LINK).click();

  const dialog = page.getByRole('dialog', { name: 'What these controls do' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // "…" is where the reader's attention was — they pressed it, and the sheet
  // it opened vanished on the way here. Landing on the header's ⓘ instead
  // would drop them somewhere they never went.
  await expect(settings).toBeFocused();
  await expect(page.getByRole('button', OPEN)).not.toBeFocused();
});

test('the ✕ takes the same route home', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  const settings = page.getByRole('button', SETTINGS);
  await settings.click();
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', SHEET_LINK).click();

  const dialog = page.getByRole('dialog', { name: 'What these controls do' });
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await expect(settings).toBeFocused();
});

test('on a 390px phone the dialog is still reachable, through Settings', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  // The regression this exists to stop: the header ⓘ is display:none here, so
  // deleting the sheet's captions without adding this link would leave a phone
  // with no route to the sentences at all.
  await expect(page.getByRole('button', OPEN)).toBeHidden();

  const settings = page.getByRole('button', SETTINGS);
  await settings.click();
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  const link = sheet.getByRole('button', SHEET_LINK);
  await expect(link).toBeVisible();
  await link.click();

  const dialog = page.getByRole('dialog', { name: 'What these controls do' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Compact fits more rows on screen');
  await expect(dialog).toContainText('System follows your computer');
  await expect(dialog).toContainText('Appears at the top of the screen only when a newer version exists');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(settings).toBeFocused();
});

test('the header ⓘ still returns focus to itself', async ({ page }) => {
  // The second door must not have changed the first one. Opening from the
  // header and closing returns to the header button, as it always did.
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  const btn = page.getByRole('button', OPEN);
  await btn.click();
  await page.keyboard.press('Escape');
  await expect(btn).toBeFocused();
  await expect(page.getByRole('button', SETTINGS)).not.toBeFocused();
});

test('Overview says how to rearrange it, and that nothing needs saving', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  // "How do I save my layout?" has no button as its answer — there is no save
  // button and there never was; every drop and resize writes itself. Overview
  // is checked here because it is the tab this intro copy lives on, NOT
  // because it is the only rearrangeable one: since 2026-08-08 all 15 tabs
  // carry a layoutKey, and each panel states the same thing for itself in its
  // ⓘ help (the LAYOUT_HELP sentence in components/ui.jsx, rendered only when
  // the grid is managed). This assertion is about the tab intro, so it stays
  // on the tab that has one.
  const intro = page.locator('main p').first();
  await expect(intro).toContainText('drag');
  await expect(intro).toContainText('resize');
  await expect(intro).toContainText('saves automatically');
});
