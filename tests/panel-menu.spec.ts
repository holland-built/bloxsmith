import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';
import {
  activeHandlePanel, activeMenuTogglePanel, domOrder, dragOntoRightHalfOf, gotoTab, liveText,
  openPanelMenu, panelMenuList, panelMenuToggle, tabToHandle,
} from './layout-helpers';

// Every /api/ response is faked from tests/page-fixtures.ts. Saved layouts are
// real state on the test server, so the Overview view is removed around each
// test.
//
// ONE "…" MENU IN PLACE OF TWO OF A PANEL'S THREE HEADER BUTTONS.
//
// Every managed panel carried ⓘ ✕ ⠿ in its header: 21 small boxes on Overview.
// The owner was shown three live variants on 2026-10-04 and chose this one: the
// ⓘ stays where it was, and "Take off the page" and "Move" sit behind one "…".
//
// What this file holds is the menu itself: that the two buttons are out of
// sight until asked for, that the menu opens and shuts the ways a person
// expects, and that both gestures still work from inside it, by pointer and by
// keyboard. The gestures' own behaviour (what a drag saves, what a hidden tile
// leaves behind) stays in tests/layout-drag.spec.ts and
// tests/hidden-tiles.spec.ts, which now reach their buttons through the same
// helpers this file uses.
//
// Every test here fails on v3.88.0, where there is no "…" button to find.

const VIEW = '/api/views/__layout_overview';
const PANELS = 7;

test.beforeEach(async ({ page, request }) => {
  await installBaselineWorld(page);
  await request.delete(VIEW);
});
test.afterEach(async ({ request }) => {
  await request.delete(VIEW);
});

type Page = import('@playwright/test').Page;
const panel = (page: Page, id: string) => page.locator(`[data-panel-id="${id}"]`);
const moveBtn = (page: Page, id: string) => panel(page, id).locator('[data-layout-handle]');
const hideBtn = (page: Page, id: string) => panel(page, id).locator('[data-layout-hide]');

test('a panel header shows the ⓘ and one "…"; Move and Take off the page wait inside it', async ({ page }) => {
  await gotoTab(page, 'overview', PANELS);

  // Host Status has no controls of its own in its header, so what is left is
  // exactly the chrome every managed panel gets.
  const header = panel(page, 'host-status').locator('h2').locator('..');
  const buttons = header.getByRole('button');
  await expect(buttons).toHaveCount(2);
  await expect(buttons.nth(0)).toHaveAccessibleName('About: Host Status');
  await expect(buttons.nth(1)).toHaveAccessibleName('Options: Host Status');

  // One "…" per panel, on all seven, and neither of the two buttons it holds
  // is on screen anywhere.
  await expect(page.locator('[data-panel-menu-toggle]')).toHaveCount(PANELS);
  for (const sel of ['[data-layout-handle]', '[data-layout-hide]']) {
    const all = page.locator(sel);
    await expect(all).toHaveCount(PANELS);
    for (let i = 0; i < PANELS; i++) await expect(all.nth(i)).toBeHidden();
  }
});

test('the menu opens on a click and shuts on Escape, on a press elsewhere, and when focus moves on', async ({ page }) => {
  await gotoTab(page, 'overview', PANELS);
  const id = 'host-status';
  const toggle = panelMenuToggle(page, id);
  const list = panelMenuList(page, id);

  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(list).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  // Named by the words they show, then the panel.
  await expect(hideBtn(page, id)).toHaveAccessibleName('Take off the page Host Status');
  await expect(moveBtn(page, id)).toHaveAccessibleName('Move Host Status');
  await expect(hideBtn(page, id)).toContainText('Take off the page');
  await expect(moveBtn(page, id)).toContainText('Move');

  // Escape shuts it and hands the focus back to the button that opened it.
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  expect(await activeMenuTogglePanel(page)).toBe(id);

  // A press anywhere else.
  await toggle.click();
  await expect(list).toBeVisible();
  await page.locator('h1').first().click();
  await expect(list).toBeHidden();

  // Tab through it and out the far side: "…", Take off the page, Move, gone.
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(list).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(hideBtn(page, id)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(moveBtn(page, id)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(list).toBeHidden();
});

test('both rows are 24px targets, and the open menu stays inside the window at desktop and phone width', async ({ page }) => {
  for (const [width, height] of [[1920, 2400], [390, 2400]] as const) {
    await gotoTab(page, 'overview', PANELS, width, height);
    // The last column is where a box hung from the right edge could leave the
    // window; on a phone every panel is full width.
    const id = 'host-status';
    await openPanelMenu(page, id);
    for (const row of [hideBtn(page, id), moveBtn(page, id)]) {
      const b = (await row.boundingBox())!;
      expect(b.height, `${width}px: a menu row is ${b.height}px tall`).toBeGreaterThanOrEqual(24);
      expect(b.width, `${width}px: a menu row is ${b.width}px wide`).toBeGreaterThanOrEqual(24);
    }
    const box = (await panelMenuList(page, id).boundingBox())!;
    expect(box.x, `${width}px: the open menu starts left of the window`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${width}px: the open menu runs past the window's right edge`).toBeLessThanOrEqual(width);
    // And it has not pushed the page sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  }
});

test('Take off the page hides the panel, and its menu is shut when the panel is put back', async ({ page }) => {
  await gotoTab(page, 'overview', PANELS);
  const id = 'host-status';
  await openPanelMenu(page, id);
  await hideBtn(page, id).click();
  await expect(panel(page, id)).toHaveCount(0);
  await expect(page.locator('[data-panel-id]')).toHaveCount(PANELS - 1);

  // The panel renders nothing while it is off the page but its component stays
  // mounted, so a menu left open at the click would still be open on return.
  await page.getByRole('button', { name: 'Arrange panels', exact: true }).click();
  await page.getByRole('button', { name: 'Put back on the page: Host Status', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(panel(page, id)).toHaveCount(1);
  await expect(panelMenuToggle(page, id)).toHaveAttribute('aria-expanded', 'false');
  await expect(panelMenuList(page, id)).toBeHidden();
});

test('dragging Move out of the menu reorders the page and shuts the menu', async ({ page }) => {
  await gotoTab(page, 'overview', PANELS);
  const before = await domOrder(page);
  expect(before[0]).toBe('dns-hero');

  // The helper opens dns-hero's menu, presses on Move and drags: the same
  // gesture tests/layout-drag.spec.ts performs.
  await dragOntoRightHalfOf(page, 'dns-hero', 1);
  expect(await domOrder(page)).toEqual([before[1], before[0], ...before.slice(2)]);
  await expect(panelMenuList(page, 'dns-hero')).toBeHidden();
  await expect(panelMenuToggle(page, 'dns-hero')).toHaveAttribute('aria-expanded', 'false');
  // The press landed on Move, which is now out of sight. Its focus goes to the
  // panel's "…" button, not to nothing.
  expect(await activeMenuTogglePanel(page)).toBe('dns-hero');
});

test('by keyboard: Enter on Move starts a move, the menu stays open through it, and Escape then shuts it', async ({ page }) => {
  await gotoTab(page, 'overview', PANELS);
  const id = 'dns-hero';
  const before = await domOrder(page);

  // Tab to "…", Enter, Tab to Move: no pointer anywhere in this test.
  await tabToHandle(page, id);
  await page.keyboard.press('Enter');
  await expect(moveBtn(page, id)).toHaveAttribute('aria-pressed', 'true');
  expect(await liveText(page)).toContain(`Position 1 of ${PANELS}`);
  // The keys are said on screen now, not only to a screen reader.
  await expect(moveBtn(page, id)).toContainText('arrow keys, then Enter');

  // An arrow press re-sorts the real DOM, which blurs the Move button. The
  // menu must not shut on that blur: it would take the button away mid-move.
  await page.keyboard.press('ArrowRight');
  expect(await liveText(page)).toBe(`Moved to position 2 of ${PANELS}`);
  expect(await domOrder(page)).toEqual([before[1], before[0], ...before.slice(2)]);
  await expect(panelMenuList(page, id)).toBeVisible();
  expect(await activeHandlePanel(page)).toBe(id);

  // First Escape belongs to the move: it cancels it and the menu stays.
  await page.keyboard.press('Escape');
  await expect(moveBtn(page, id)).toHaveAttribute('aria-pressed', 'false');
  expect(await domOrder(page)).toEqual(before);
  await expect(panelMenuList(page, id)).toBeVisible();

  // Second Escape shuts the menu and puts focus back on "…".
  await page.keyboard.press('Escape');
  await expect(panelMenuList(page, id)).toBeHidden();
  expect(await activeMenuTogglePanel(page)).toBe(id);
});
