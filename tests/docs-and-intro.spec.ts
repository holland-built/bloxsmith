import { test, expect } from './fixtures';

// The tab intro line, and the page's help. Help is now the "Help" button in
// the page bar (2026-11-06); it was a "Docs →" button beside the intro.
//
// TWO CHANGES ARE PINNED HERE, both from 2026-08-10.
//
// 1. "Docs →" USED TO LEAVE THE APP. It was an <a href> to docs/TABS.md on
//    github.com, so the answer to "what is this tab" was a new browser tab, a
//    page load and a scroll — and nothing at all on a machine that cannot reach
//    github.com, which is an ordinary condition for the networks this tool gets
//    pointed at. It now opens a panel beside the page, rendering the SAME file,
//    imported at build time (see components/DocsPanel.jsx). The document still
//    lives on GitHub and is still the only copy.
//
// 2. (Gone 2026-11-09.) Overview's intro carried a self-retiring lesson on
//    arranging panels; the intro went with the panel wall. The same words live
//    in the "Arrange this page" window (panel-help and header-help check them).

test('Help opens the tab section in the app, and never navigates to GitHub', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('main h1')).toHaveText('Overview');

  // If this ever becomes an <a href> again, the click below leaves the app and
  // the dialog assertion fails — but say so directly too, because "the dialog
  // did not appear" is a confusing way to report "it opened GitHub".
  const docs = page.getByRole('button', { name: 'Help for this page' });
  await expect(
    docs,
    'the Help control is not a button — it has gone back to being a link out to GitHub',
  ).toBeVisible();

  await docs.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // The panel shows THIS tab's section, titled from the document's own heading.
  await expect(page.locator('#docs-title')).toHaveText('Help: Overview');
  // Content from the Overview section of docs/TABS.md, not from another tab.
  await expect(dialog).toContainText('Your network at a glance');
  await expect(dialog).toContainText('License Inventory');
  // ...and not the next tab along, which would mean the section did not end.
  await expect(dialog).not.toContainText('Provision runs the two write flows');

  // Still on Overview: a panel, not a navigation.
  await expect(page.locator('main h1')).toHaveText('Overview');
  expect(page.url()).toContain('#overview');
});

test('the docs panel closes on Escape and hands focus back to the button', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('main h1')).toHaveText('Overview');

  await page.getByRole('button', { name: 'Help for this page' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Focus must not be left on <body>: a keyboard reader who opens the panel and
  // closes it would otherwise be tabbing from the top of the document again.
  await expect(page.getByRole('button', { name: 'Help for this page' }), 'focus was not returned to the Help button').toBeFocused();
});
