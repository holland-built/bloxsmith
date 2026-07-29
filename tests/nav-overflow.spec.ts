import { test, expect } from './fixtures';

// The top-bar tabs are measured-then-fitted: whatever does not fit moves into a
// "More" menu. That is measurement-dependent code, so it can regress silently —
// it already shipped broken twice, once rendering all 13 tabs on top of the
// header controls, once hiding the More button inside the very overflow it was
// meant to replace. These assertions are the guard.
//
// Three invariants, at every width:
//   1. the tab row never overlaps the right-hand controls
//   2. the ACTIVE tab is always inline, never menu-only
//   3. nothing is unreachable — visible + hidden always totals every tab

const TOTAL_TABS = 13;

async function navState(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const nav = document.querySelector('nav');
    const inline = [...(nav?.querySelectorAll('a[href^="#"]') ?? [])].map((a) =>
      (a.textContent || '').trim(),
    );
    const moreBtn = [...document.querySelectorAll('button')].find((b) =>
      /More/i.test(b.textContent || ''),
    );
    const hiddenCount = moreBtn
      ? Number((moreBtn.textContent || '').replace(/[^0-9]/g, '')) || 0
      : 0;
    const active =
      [...(nav?.querySelectorAll('a[href^="#"]') ?? [])]
        .find((a) => a.className.includes('font-medium'))
        ?.textContent?.trim() ?? null;
    return { inline, hiddenCount, hasMore: !!moreBtn, active };
  });
}

for (const width of [1600, 1150, 900, 820]) {
  test(`nav at ${width}px: no overlap, active inline, nothing unreachable`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/?cb=nav-${width}#audit`);
    await page.waitForSelector('nav a[href^="#"]', { timeout: 30_000 });
    // let the post-mount shrink (ConnStatus / UpdateButton resolving) settle
    await page.waitForTimeout(2500);

    const state = await navState(page);

    // 3. every tab is accounted for, either inline or behind the menu
    expect(
      state.inline.length + state.hiddenCount,
      `inline ${state.inline.length} + hidden ${state.hiddenCount} should equal ${TOTAL_TABS}`,
    ).toBe(TOTAL_TABS);

    // 2. the active tab is inline, never only in the menu
    expect(state.active, 'active tab must render inline').toBe('Audit');

    // 1. the tab row must not run under the right-hand controls
    const overlap = await page.evaluate(() => {
      const nav = document.querySelector('nav');
      const tabs = [...(nav?.querySelectorAll('a[href^="#"]') ?? [])];
      if (!tabs.length) return 'no tabs rendered';
      const right = document.querySelector('nav')?.parentElement?.parentElement;
      const controls = [...(right?.querySelectorAll('button') ?? [])].filter(
        (b) => !/More/i.test(b.textContent || ''),
      );
      const lastTab = tabs[tabs.length - 1].getBoundingClientRect();
      for (const c of controls) {
        const r = c.getBoundingClientRect();
        if (r.width === 0) continue;
        // a control starting left of where the tabs end means they collide
        if (r.left < lastTab.right - 1 && r.right > lastTab.left + 1) {
          return `tab row overlaps a control (tab ends ${Math.round(
            lastTab.right,
          )}, control starts ${Math.round(r.left)})`;
        }
      }
      return null;
    });
    expect(overlap, String(overlap)).toBeNull();
  });
}

test('More menu reveals the hidden tabs by name', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto('/?cb=nav-menu#audit');
  await page.waitForSelector('nav a[href^="#"]', { timeout: 30_000 });
  await page.waitForTimeout(2500);

  const before = await navState(page);
  test.skip(!before.hasMore, 'nothing overflowed at this width');

  const moreBtn = page.getByRole('button', { name: /more tab/i });
  await expect(moreBtn).toHaveAttribute('aria-expanded', 'false');
  await moreBtn.click();
  await expect(moreBtn).toHaveAttribute('aria-expanded', 'true');

  // the popover must NAME the hidden tabs — that is the whole point of the
  // menu over a bare scroll affordance
  const named = await page.evaluate(() =>
    [...document.querySelectorAll('a[role="menuitem"]')].map((a) =>
      (a.textContent || '').trim(),
    ),
  );
  expect(named.length, 'menu should list every hidden tab').toBe(before.hiddenCount);
  expect(named).toContain('AI');

  // Escape closes and returns focus to the trigger
  await page.keyboard.press('Escape');
  await expect(moreBtn).toHaveAttribute('aria-expanded', 'false');
  await expect(moreBtn).toBeFocused();
});
