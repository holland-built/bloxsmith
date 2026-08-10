import { test, expect } from './fixtures';

// The tab intro line and the "Docs →" button beside it.
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
// 2. THE ARRANGING SENTENCE IS ONBOARDING AND NOW RETIRES ITSELF. Overview's
//    intro carried 30 words teaching drag-to-rearrange, permanently, above the
//    thing the reader came to look at. Once a rearrangement has actually saved
//    it is gone for good on that browser (lib/arrangedOnce.js). The one-line
//    summary of what the tab IS always stays — that does not go out of date the
//    way a lesson does.
//
// This spec owns `__layout_overview` while it runs, the same key layout-drag
// and layout-persist own, and deletes it either side. The suite runs one worker
// (playwright.config.ts explains why), so that is safe.

const VIEW = '__layout_overview';
const LESSON = /drag a panel/i;
const SUMMARY = /Your estate at a glance/i;

test.beforeEach(async ({ request }) => {
  await request.delete(`/api/views/${VIEW}`);
});

test.afterEach(async ({ request }) => {
  await request.delete(`/api/views/${VIEW}`);
});

test('Docs opens the tab section in the app, and never navigates to GitHub', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('main h1')).toHaveText('Overview');

  // If this ever becomes an <a href> again, the click below leaves the app and
  // the dialog assertion fails — but say so directly too, because "the dialog
  // did not appear" is a confusing way to report "it opened GitHub".
  const docs = page.getByRole('button', { name: 'Docs →' });
  await expect(
    docs,
    'the Docs control is not a button — it has gone back to being a link out to GitHub',
  ).toBeVisible();

  await docs.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // The panel shows THIS tab's section, titled from the document's own heading.
  await expect(page.locator('#docs-title')).toHaveText('Docs — Overview');
  // Content from the Overview section of docs/TABS.md, not from another tab.
  await expect(dialog).toContainText('Estate at a glance');
  await expect(dialog).toContainText('Top Consumers');
  // ...and not the next tab along, which would mean the section did not end.
  await expect(dialog).not.toContainText('Provision runs the two write flows');

  // Still on Overview: a panel, not a navigation.
  await expect(page.locator('main h1')).toHaveText('Overview');
  expect(page.url()).toContain('#overview');
});

test('the docs panel closes on Escape and hands focus back to the button', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('main h1')).toHaveText('Overview');

  await page.getByRole('button', { name: 'Docs →' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Focus must not be left on <body>: a keyboard reader who opens the panel and
  // closes it would otherwise be tabbing from the top of the document again.
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim());
  expect(focused, 'focus was not returned to the Docs button').toBe('Docs →');
});

test('the arranging lesson shows to a new reader and retires once a layout saves', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('main h1')).toHaveText('Overview');

  // A reader who has never arranged anything is taught how.
  await expect(page.getByText(LESSON)).toBeVisible();
  await expect(page.getByText(SUMMARY)).toBeVisible();

  // Perform the thing it teaches, through the same commit path every gesture
  // uses. The Arrange window's buttons end at ctx.apply(next, true) exactly as
  // a pointer drag does, and driving it that way keeps this test about the
  // lesson rather than about pointer arithmetic that layout-drag already owns.
  await page.getByRole('button', { name: 'Arrange panels' }).click();
  const arrange = page.getByRole('dialog');
  await expect(arrange).toBeVisible();
  // "Move down: <panel name>" — ui.jsx:1365.
  await arrange.getByRole('button', { name: /^Move down:/ }).first().click();

  // The save must actually have succeeded — the sentence claims arrangements
  // save by themselves, so a failed save is not proof of the claim and must not
  // retire it. Read from the pill element rather than by text: "Saved" also
  // appears in the live region ("Layout saved"), and matching both is how this
  // assertion first failed.
  await expect
    .poll(
      () => page.evaluate(() => (document.querySelector('[data-layout-toast]')?.textContent ?? '').trim()),
      { timeout: 15000, message: 'the layout never reported a successful save' },
    )
    .toBe('Saved');
  await page.keyboard.press('Escape');

  // Gone now, and the summary is not.
  await expect(page.getByText(LESSON)).toHaveCount(0);
  await expect(page.getByText(SUMMARY)).toBeVisible();

  // Still gone after a full reload — this is the whole point, not a one-render
  // state that comes back the next time the tab is opened.
  await page.reload();
  await expect(page.locator('main h1')).toHaveText('Overview');
  await expect(page.getByText(SUMMARY)).toBeVisible();
  await expect(
    page.getByText(LESSON),
    'the lesson came back after a reload, so it was never really retired',
  ).toHaveCount(0);
});
