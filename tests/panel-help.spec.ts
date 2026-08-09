import { test, expect } from './fixtures';

// The per-panel help affordance: an ⓘ button in every panel header that opens
// one or two lines of plain English underneath it.
//
// THE GLYPH IS THE VISIBLE LABEL AND THE WORDS ARE THE ACCESSIBLE ONE. It drew
// the word "About" for one release; the user reversed that ("the i cirle is
// better than about"). Nothing else moved — the accessible name is still
// "About: <panel>", which is why every locator below still reads that way, and
// the three doors (hover, focus, click-to-pin) are unchanged.
//
// WHY A DISCLOSURE AND NOT A TOOLTIP, AND WHY HOVER IS AN ADDITION. The
// reasoning above TabIntro in ui/src/components/ui.jsx still holds — hover does
// not exist on touch and never reaches a keyboard, so an affordance that ONLY
// hovers is unreadable on exactly the devices this dashboard gets glanced at
// from. Click and keyboard are therefore still the load-bearing doors, and the
// tests for them below are unchanged. Hover was added on top, with focus
// alongside it so the keyboard is not the poor relation, and the rule is:
//
//   hover or focus  -> shown while that lasts
//   click / Enter / Space -> PINNED, stays after the pointer and the focus go
//   click again     -> closed, and the hover/focus you are still inside is
//                      cancelled too, so it does not spring back open
//
// THE THIRD RULE IS NOT FUSSINESS. A click leaves the focus on the button and
// usually leaves the pointer on it, so an implementation that unpins without
// cancelling those two shuts the panel and reopens it in the same frame —
// "click again to close" silently stops working, and the test at the top of
// this file that has always asserted it is what catches that.
//
// SCOPE OF THIS SPEC. The behaviour tests below all drive #overview, because
// its panel names are stable and short. The width test at the bottom drives the
// four busiest tabs instead, because a header is only at risk where the header
// is already crowded.

const HEATMAP_HELP = 'One square per subnet';
// Verbatim out of LAYOUT_HELP_REST in ui/src/components/ui.jsx. Written out
// here rather than imported so that rewording the string has to come past this
// file — which is the point, since where these words appear is the whole
// subject of the last two tests.
const LAYOUT_SENTENCE = 'Drag a panel’s right edge to make it wider or narrower';

test('a panel header carries an ⓘ button named after its own panel', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  // Named by reference to the panel's own <h2>, so a screen reader hears which
  // panel it is about — never seven identical "more info" buttons down a tab.
  const btn = page.getByRole('button', { name: 'About: Subnet Heatmap', exact: true });
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  // The visible label is the glyph, and the name is still the words. Both
  // halves asserted, because shipping one without the other is the failure:
  // a glyph with a glyph for a name reads as "circled latin small letter i",
  // and the word "About" back on screen is the thing that was reverted.
  //
  // Read as the button's OWN text nodes, skipping the sr-only <span>. The
  // element's textContent holds "About:" too — that span is what supplies the
  // accessible name above — so a plain toHaveText would assert the opposite of
  // what is painted.
  const painted = await btn.evaluate((el) =>
    Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => (n.textContent || '').trim())
      .join(''),
  );
  expect(painted).toBe('ⓘ');
});

test('clicking ⓘ reveals the help text and flips aria-expanded', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  const btn = page.getByRole('button', { name: 'About: Subnet Heatmap', exact: true });
  const controls = await btn.getAttribute('aria-controls');
  expect(controls, 'the About button must point at the region it opens').toBeTruthy();

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

test('hovering About reveals the help, and moving the pointer away closes it', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  const btn = page.getByRole('button', { name: 'About: Subnet Heatmap', exact: true });
  const region = page.locator(`#${await btn.getAttribute('aria-controls')}`);
  await expect(region).toBeHidden();

  // hover() moves a real mouse; it dispatches no click, so this fails if the
  // affordance still needs one.
  await btn.hover();
  await expect(region).toBeVisible();
  await expect(region).toContainText(HEATMAP_HELP);
  await expect(btn).toHaveAttribute('aria-expanded', 'true');

  // Nothing pinned it, so leaving closes it. The corner of the viewport, not
  // another control — this must not depend on what happens to be next to it.
  await page.mouse.move(2, 2);
  await expect(region).toBeHidden();
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
});

test('keyboard focus alone reveals the help — no click, no pointer', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  const btn = page.getByRole('button', { name: 'About: Subnet Heatmap', exact: true });
  const region = page.locator(`#${await btn.getAttribute('aria-controls')}`);
  await expect(region).toBeHidden();

  // focus() is the DOM focus a Tab press lands, with no mouse anywhere near it.
  // A keyboard user must not have to press a key to read what a mouse user gets
  // for free.
  await btn.focus();
  await expect(region).toBeVisible();
  await expect(region).toContainText(HEATMAP_HELP);
  await expect(btn).toHaveAttribute('aria-expanded', 'true');

  // Tab moves the focus on, and an unpinned preview goes with it.
  await page.keyboard.press('Tab');
  await expect(btn).not.toBeFocused();
  await expect(region).toBeHidden();
});

test('a clicked-open panel stays open after the pointer and the focus both leave', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  const btn = page.getByRole('button', { name: 'About: Subnet Heatmap', exact: true });
  const region = page.locator(`#${await btn.getAttribute('aria-controls')}`);

  await btn.click();
  await expect(region).toBeVisible();

  // Both previews are withdrawn: the pointer goes to the far corner and the
  // focus is dropped outright. If the panel were only held open by one of them
  // it would close here — which is the whole point of pinning, since a long
  // entry cannot be read while holding a mouse still.
  await page.mouse.move(2, 2);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(btn).not.toBeFocused();
  await expect(region).toBeVisible();
  await expect(region).toContainText(HEATMAP_HELP);
  await expect(btn).toHaveAttribute('aria-expanded', 'true');

  // And a second click still closes it, with the pointer sitting on the button
  // (click hovers first) and the focus back on it — the two states that would
  // re-open it if unpinning did not cancel them.
  await btn.click();
  await expect(region).toBeHidden();
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
});

test('a closed panel keeps its help copy out of the document altogether', async ({ page }) => {
  // THE REGRESSION GUARD. 83 always-rendered hidden help blocks once broke eight
  // specs at once: `text=DNS Zones` matched an invisible "How many DNS zones you
  // hold…" before it reached the real heading, and find-in-page, copy-all and
  // translation tools read a page exactly the way that locator does. Adding
  // hover is the obvious way to bring that back — render the text always and
  // toggle a class — so this reads document.body.textContent, which sees hidden
  // text, and fails if the copy is merely invisible rather than absent.
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  const read = () =>
    page.evaluate(
      (phrase) => ({
        inDocument: (document.body.textContent || '').includes(phrase),
        // Every disclosure container that exists, and how much text it holds.
        // The count guards the guard: if the containers ever stopped rendering
        // the assertion below would pass on an empty page and prove nothing.
        containers: Array.from(document.querySelectorAll('[data-panel-help]')).map(
          (el) => (el.textContent || '').length,
        ),
      }),
      HEATMAP_HELP,
    );

  const closed = await read();
  expect(closed.containers.length, 'expected the disclosure containers to exist while collapsed').toBeGreaterThan(0);
  expect(closed.containers.filter((n) => n > 0), 'a collapsed disclosure must hold no text at all').toEqual([]);
  expect(closed.inDocument, 'a closed panel must not put its help sentence in the document').toBe(false);

  // The same read finds it once it is open, so the assertion above is a real
  // measurement and not a phrase that never appears anywhere.
  const btn = page.getByRole('button', { name: 'About: Subnet Heatmap', exact: true });
  await btn.click();
  await expect(page.locator(`#${await btn.getAttribute('aria-controls')}`)).toBeVisible();
  expect((await read()).inDocument).toBe(true);

  // And hover leaves nothing behind either: close it, move away, and the text
  // is gone from the document again rather than parked out of sight.
  await btn.click();
  await page.mouse.move(2, 2);
  await expect.poll(async () => (await read()).inDocument).toBe(false);
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

test("an open panel's help is about that panel and nothing else", async ({ page }) => {
  // WHAT THIS USED TO ASSERT, AND WHY IT FLIPPED. Until 2026-08-09 this test
  // required the layout sentences INSIDE every managed panel's help ("a
  // rearrangeable panel says so"). Reported as "dont need that every time":
  // the same ~60 words printed 83 times a page, under copy that was otherwise
  // about the one panel the reader had just opened. The sentences did not get
  // weaker, they moved — the test below proves they are still said, once, in
  // the window where somebody is standing when they want them.
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  const btn = page.getByRole('button', { name: 'About: Top Consumers', exact: true });
  await btn.click();
  const region = page.locator(`#${await btn.getAttribute('aria-controls')}`);
  await expect(region).toBeVisible();
  // Its own copy is still there — otherwise this passes on an empty box.
  await expect(region).toContainText('The twelve subnets handing out the most addresses');
  await expect(region).not.toContainText(LAYOUT_SENTENCE);
});

test('the layout sentences are said once on a page, in the Arrange window', async ({ page }) => {
  // The other half of the move: they must not have been deleted. Overview
  // carries a layoutKey, so its panels really are movable, and reorder/resize
  // are otherwise invisible (the resize hotspot is opacity-0 until hover) —
  // this is the only place the operator is ever told.
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();

  // Open EVERY panel's help first, so "once on the page" is counted against the
  // worst case rather than against a page where nothing is expanded.
  const buttons = page.getByRole('button', { name: /^About[: ]/ });
  const count = await buttons.count();
  expect(count, 'expected the Overview panels to carry help buttons').toBeGreaterThan(0);
  for (let i = 0; i < count; i++) await buttons.nth(i).click();

  const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
  const bodyText = () => page.evaluate(() => document.body.textContent || '');

  // Zero while the window is shut — 83 open disclosures and not one of them
  // says it. document.body.textContent, so hidden copy counts too.
  expect(occurrences(await bodyText(), LAYOUT_SENTENCE)).toBe(0);

  await page.locator('[data-layout-arrange]').first().click();
  const dialog = page.locator('[data-arrange-dialog]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(LAYOUT_SENTENCE);
  // Exactly one, page-wide: the window says it, and nothing else does.
  expect(occurrences(await bodyText(), LAYOUT_SENTENCE)).toBe(1);
  // Overview shows several panels, so the reorder half is on too, and it is
  // one paragraph rather than two stacked ones.
  await expect(dialog).toContainText('Drag a row up or down to change the order');
  await expect(dialog.locator('p').last()).toContainText(LAYOUT_SENTENCE);
});

test('a titleless panel still gets its ⓘ button', async ({ page }) => {
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
  // The named risk this affordance carries: the ⓘ button adds width to the `right`
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

// Every panel header this control sits in, on the four busiest tabs, at five
// widths — each ⓘ button, heading and open disclosure measured against its own
// card. This is where the control's width cost is held honest, so it is re-run
// whenever that width changes.
//
// THE EXCLUSION LIST IS GONE, AND THAT IS A MEASUREMENT, NOT AN OPINION. While
// this button drew the word "About" it was 45px wide, and two panels were
// excluded at 390 for spilling 52px and 28px. Reverting the label to the glyph
// (the user: "the i cirle is better than about") took the button back to
// 24.83px in Chromium, measured at every width in this list, and re-running the
// same sweep found ZERO spills anywhere — including those two. So the list was
// deleted rather than carried forward: an exclusion nobody re-measures is a bug
// with a permit. All four tabs at all five widths are now held to zero.
const BUSY_TABS = ['#security', '#assets', '#network', '#dns'];
const WIDTHS = [1920, 1280, 1024, 768, 390];

test('the ⓘ fits every busy header from 1920 down to 390', async ({ page }) => {
  const findings: string[] = [];
  let checkedButtons = 0;

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    for (const tab of BUSY_TABS) {
      await page.goto(`/${tab}`);
      await expect(page.locator('h1').first()).toBeVisible();
      // The fit system publishes widths from a layout effect and the grid
      // re-applies them; give it a beat to settle before reading geometry.
      await page.waitForTimeout(600);

      const buttons = page.getByRole('button', { name: /^About[: ]/ });
      const count = await buttons.count();
      expect(count, `${tab} at ${width} should carry ⓘ buttons`).toBeGreaterThan(0);
      // Open every one, so the disclosure body is measured too.
      for (let i = 0; i < count; i++) await buttons.nth(i).click();
      checkedButtons += count;
      await page.waitForTimeout(400);

      const bad = await page.evaluate(() => {
        const out: string[] = [];
        for (const card of Array.from(document.querySelectorAll('[data-panel-id]'))) {
          const id = card.getAttribute('data-panel-id') || '(no id)';
          const cardRect = card.getBoundingClientRect();
          const parts = Array.from(
            card.querySelectorAll('h2, [data-panel-help], [data-panel-help-toggle]'),
          );
          for (const el of parts) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            const spill = Math.max(r.right - cardRect.right, cardRect.left - r.left);
            const what = el.hasAttribute('data-panel-help-toggle')
              ? 'the ⓘ button'
              : el.hasAttribute('data-panel-help')
                ? 'the open disclosure'
                : 'the heading';
            if (spill > 1) {
              out.push(`${id}: ${what} spills ${Math.round(spill)}px past its card`);
            }
            // A control squeezed to nothing is as broken as one that spills.
            // The floor is 20px because the glyph button measures 24.83px in
            // Chromium at every width in this sweep — a threshold above that
            // would fire on a healthy control, which is how a guard gets
            // deleted instead of fixed.
            if (el.hasAttribute('data-panel-help-toggle') && r.width < 20) {
              out.push(`${id}: the ⓘ button is squeezed to ${Math.round(r.width)}px`);
            }
          }
        }
        return out;
      });

      for (const line of bad) findings.push(`${width}px ${tab} — ${line}`);
    }
  }

  expect(checkedButtons, 'expected to have measured a lot of headers').toBeGreaterThan(50);
  expect(findings, findings.join('\n') || undefined).toEqual([]);
});
