import { test, expect } from './fixtures';

// The per-panel help affordance: an ⓘ button in every panel header that opens
// one or two lines of plain English underneath it.
//
// WHY A DISCLOSURE AND NOT A TOOLTIP. The same reasoning already written above
// TabIntro in ui/src/components/ui.jsx: hover does not exist on touch, so a
// `title=` tooltip is unreadable on exactly the devices this dashboard gets
// glanced at from. Every assertion below is therefore about click and keyboard,
// and there is deliberately no hover test to write.
//
// SCOPE OF THIS SPEC, stated rather than implied. Only the seven Overview
// panels carry a `panelId` today, and the ⓘ button is keyed off the help
// dictionary, which is keyed off panelId — so Overview is the only tab where
// this can be observed yet. The unmanaged-grid half of the affordance (a Card
// with help but no drag handle) is not reachable until panelIds land on the
// other tabs; the assertion here that stands in for it is that the disclosure
// text is independent of the layout machinery, checked by the auto-appended
// move/resize line appearing ONLY where the panel really is rearrangeable.

const HEATMAP_HELP = 'One square per subnet';

test('a panel header carries an ⓘ button named after its own panel', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  // Named by reference to the panel's own <h2>, so a screen reader hears which
  // panel it is about — never seven identical "more info" buttons down a tab.
  const btn = page.getByRole('button', { name: 'About: Subnet Heatmap', exact: true });
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
});

test('clicking ⓘ reveals the help text and flips aria-expanded', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  const btn = page.getByRole('button', { name: 'About: Subnet Heatmap', exact: true });
  const controls = await btn.getAttribute('aria-controls');
  expect(controls, 'the ⓘ button must point at the region it opens').toBeTruthy();

  const region = page.locator(`#${controls}`);
  await expect(region).toBeHidden();

  await btn.click();
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  await expect(region).toBeVisible();
  await expect(region).toContainText(HEATMAP_HELP);

  await btn.click();
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await expect(region).toBeHidden();
});

test('the disclosure is operable with the keyboard alone', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  const btn = page.getByRole('button', { name: 'About: Host Status', exact: true });
  // press() focuses the element and sends a real key event — no click is
  // synthesised by Playwright, so this fails if the affordance is
  // pointer-only.
  await btn.press('Enter');
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  await expect(btn).toBeFocused();

  await btn.press(' ');
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
});

test('a rearrangeable panel says so; the sentence is generated, not written per panel', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  const btn = page.getByRole('button', { name: 'About: Top Consumers', exact: true });
  await btn.click();
  const region = page.locator(`#${await btn.getAttribute('aria-controls')}`);
  // Overview is the one grid with layoutKey set, so its panels ARE movable and
  // the disclosure has to say how — reordering and resizing are otherwise
  // invisible (the resize hotspot is opacity-0 until hover).
  await expect(region).toContainText('drag');
  await expect(region).toContainText('save');
});

test('a titleless panel still gets its ⓘ', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  // The KPI stack has no header row at all, so its button lives in the same
  // absolute top-right slot the drag handle uses.
  const btn = page.getByRole('button', { name: 'About kpi-stack', exact: true });
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
});

test('at 375px an open disclosure does not push the header outside its card', async ({ page }) => {
  // The named risk this affordance carries: the ⓘ adds width to the `right`
  // span, and the 13-headers-overflowing fix at 360-480px depends on that span
  // being able to wrap. Measured against the card, not the viewport — a header
  // painting over the panel beside it is the failure mode.
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  const buttons = page.getByRole('button', { name: /^About[: ]/ });
  const count = await buttons.count();
  expect(count, 'expected the Overview panels to carry help buttons').toBeGreaterThan(0);

  for (let i = 0; i < count; i++) await buttons.nth(i).click();
  await page.waitForTimeout(300);

  const overflows = await page.evaluate(() => {
    const bad: string[] = [];
    for (const card of Array.from(document.querySelectorAll('[data-panel-id]'))) {
      const cardRect = card.getBoundingClientRect();
      for (const el of Array.from(card.querySelectorAll('h2, [data-panel-help]'))) {
        const r = el.getBoundingClientRect();
        // A collapsed disclosure is display:none and reports an all-zero rect,
        // which would score as "spills by the card's own left offset" — a
        // measurement of nothing dressed up as a violation.
        if (r.width === 0 && r.height === 0) continue;
        const spill = Math.max(r.right - cardRect.right, cardRect.left - r.left);
        if (spill > 1) {
          bad.push(`${card.getAttribute('data-panel-id')}: <${el.tagName.toLowerCase()}> spills ${Math.round(spill)}px past the card`);
        }
      }
    }
    return bad;
  });

  expect(overflows, overflows.join('\n') || undefined).toEqual([]);
});
