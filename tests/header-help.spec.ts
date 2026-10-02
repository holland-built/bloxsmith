import { test, expect } from './fixtures';

// The help layer for the top bar. Reported symptom: "I didn't know what the
// compact was at the top" — a row of small controls, each explaining itself
// through a `title=` tooltip that does not exist on touch and is never read on a
// desk either.
//
// ONE DIALOG, ONE DOOR, AT EVERY WIDTH. The top bar used to carry an ⓘ button
// for it, and below `lg` that button folded away and the settings sheet's link
// took over — two doors that were each other's inverse. The bar no longer
// carries the ⓘ at all: theme and spacing moved into Settings, which left
// nothing in the bar that needed a manual beside it. The settings sheet's
// "What these controls do →" row is the only way in, shown at 1920 and at 390,
// and the tests below say so in both directions: present in the sheet, absent
// from the bar.
//
// WHAT THIS FILE STOPPED ASSERTING, AND WHY. The sheet used to print the same
// sentences as always-visible captions, once under each switch and once under
// Updates. Reported as "in a setting kabob why have feature description": a
// settings panel is controls, not a manual. The sentences now exist once, in
// ui/src/lib/controlHelp.js, rendered by one component. The tests below assert
// the absence as hard as they assert the link, because a caption creeping back
// in is exactly the regression that is easy to ship.

const OPEN = { name: 'What these controls do', exact: true };
const SHEET_LINK = { name: 'What these controls do →', exact: true };
const SETTINGS = { name: 'Settings', exact: true };

// The terms the dialog lists, in the order a reader meets the controls: the bar
// left to right, then the two switches that live in Settings. Written out here
// rather than imported so the test fails if the dictionary is edited to dodge it.
const TERMS = [
  'Status, Estate, Risk, Change, Ask',
  'Update v…',
  'The tenant name',
  'The sliders button',
  'Sun · Monitor · Moon',
  'The two row icons',
  '+ Provision',
];

// Verbatim out of CONTROL_HELP — the three paragraphs that used to sit in the
// settings sheet.
const EXPLANATIONS = [
  'System follows your computer',
  'Compact fits more rows on screen',
  'Appears at the top of the screen only when a newer version exists',
];

const WIDTHS = [
  [1920, 1000],
  [390, 844],
] as const;

async function openSheet(page: import('@playwright/test').Page, width = 1280, height = 800) {
  await page.setViewportSize({ width, height });
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();
  await page.getByRole('button', SETTINGS).click();
  return page.getByRole('dialog', { name: 'Settings' });
}

async function openDialog(page: import('@playwright/test').Page, width = 1280, height = 800) {
  const sheet = await openSheet(page, width, height);
  await sheet.getByRole('button', SHEET_LINK).click();
  const dialog = page.getByRole('dialog', { name: 'What these controls do' });
  await expect(dialog).toBeVisible();
  return dialog;
}

for (const [w, h] of WIDTHS) {
  test(`at ${w}px the top bar has no help button and Settings has the one link`, async ({ page }) => {
    const sheet = await openSheet(page, w, h);

    await expect(page.locator('header').getByRole('button', OPEN)).toHaveCount(0);
    // ONE row, near the top of Appearance — not a link repeated under every
    // switch, which is the same clutter in a new hat.
    await expect(sheet.getByRole('button', SHEET_LINK)).toHaveCount(1);
    await expect(sheet.getByRole('button', SHEET_LINK)).toHaveAttribute('aria-haspopup', 'dialog');
  });
}

test('the link opens a real modal dialog naming every control, in order', async ({ page }) => {
  const dialog = await openDialog(page);

  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  // Asserted by the term list rather than by free text so a paragraph that
  // happens to contain the word "theme" cannot stand in for an entry.
  await expect(dialog.locator('dt')).toHaveText(TERMS);
});

test('the density entry answers the question that was actually asked', async ({ page }) => {
  const dialog = await openDialog(page);
  await expect(dialog).toContainText('Compact fits more rows on screen');
  await expect(dialog).toContainText('Comfortable gives everything more space');
});

test('the dialog says the number keys open the sections', async ({ page }) => {
  // The bar stopped drawing a digit on each section button, so this is where a
  // reader finds out the keys exist.
  const dialog = await openDialog(page);
  await expect(dialog).toContainText('Press the keys 1 to 5');
});

test('the link closes Settings and opens the dialog, rather than stacking two', async ({ page }) => {
  const sheet = await openSheet(page);
  await sheet.getByRole('button', SHEET_LINK).click();

  const dialog = page.getByRole('dialog', { name: 'What these controls do' });
  await expect(dialog).toBeVisible();
  // Two modal dialogs at once means two focus traps and two Escape handlers
  // arguing over the same keypress.
  await expect(sheet).toBeHidden();
});

test('Escape closes the dialog and focus goes back to the Settings button', async ({ page }) => {
  const dialog = await openDialog(page);
  const settings = page.getByRole('button', SETTINGS);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  // Focus landing on BODY is the failure this guards: a keyboard user would
  // restart at the top of the document every time they read one line of help.
  await expect(settings).toBeFocused();
});

test('the ✕ takes the same route home', async ({ page }) => {
  const dialog = await openDialog(page);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', SETTINGS)).toBeFocused();
});

test('it is reachable with the keyboard alone', async ({ page }) => {
  const sheet = await openSheet(page);

  // press() sends a real key event to a focused element — no synthesised
  // click — so this fails if the link is pointer-only.
  await sheet.getByRole('button', SHEET_LINK).press('Enter');
  await expect(page.getByRole('dialog', { name: 'What these controls do' })).toBeVisible();
});

test('on a 390px phone the dialog is reachable, through Settings, and says the same things', async ({ page }) => {
  const dialog = await openDialog(page, 390, 844);

  await expect(dialog).toContainText('Compact fits more rows on screen');
  await expect(dialog).toContainText('System follows your computer');
  await expect(dialog).toContainText('Appears at the top of the screen only when a newer version exists');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', SETTINGS)).toBeFocused();
});

test('the settings sheet holds controls, not explanations', async ({ page }) => {
  const sheet = await openSheet(page);

  // The switches and their short labels stay — those are the controls.
  await expect(sheet).toContainText('Light · System · Dark');
  await expect(sheet).toContainText('Comfortable · Compact');
  // The three paragraphs do not. This is the complaint, asserted.
  for (const sentence of EXPLANATIONS) {
    await expect(sheet).not.toContainText(sentence);
  }
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
