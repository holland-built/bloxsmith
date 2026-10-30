import { test, expect } from './fixtures';

// Every page stays reachable now that the header carries one "All pages" menu
// (2026-10-29 flow redesign) instead of five group buttons. The everyday jobs
// also sit in a rail; tests/inbox-and-jobs.spec.ts covers that.
//
//   (a) every hash id still renders its own tab, unchanged
//   (b) the header carries one All pages menu at every width
//   (c) the header does not overflow horizontally at 1920 OR at 390

// id -> the h1 that tab and only that tab renders (read from ui/src/tabs/*.jsx).
// Matched at the START of the heading so a tab may append to its own title
// without this spec dictating copy.
const TAB_HEADINGS: [string, string][] = [
  ['overview', 'Overview'],
  ['daily', 'Daily Briefing'],
  ['network', 'Network'],
  ['dns', 'DNS'],
  ['security', 'Security'],
  ['infra', 'Infrastructure'],
  ['assets', 'Assets'],
  ['incidents', 'Incidents'],
  ['audit', 'Audit'],
  ['changes', 'What changed'],
  ['provision', 'Provision'],
  ['selfservice', 'Self-Service'],
  ['editor', 'Editor'],
  ['drift', 'Drift'],
  ['ai', 'AI Assistant'],
  ['chart', 'Build a chart'],
];

const GROUP_LABELS = ['Status', 'Inventory', 'Risk', 'Change', 'Ask'];

// Which group owns which tab. Duplicated from App.jsx on purpose: a test that
// imports the thing it checks would pass on any regrouping, including a wrong one.
const GROUP_TABS: Record<string, string[]> = {
  Status: ['Overview', 'Daily'],
  Inventory: ['Network', 'DNS', 'Assets', 'Infra'],
  Risk: ['Security', 'Incidents', 'Audit', 'Changes'],
  Change: ['Provision', 'Self-Service', 'Editor', 'Drift'],
  Ask: ['AI', 'Build a chart'],
};

const MENU = 'header button[data-menu]';

function esc(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// P6 (a) — every hash still reaches its own tab
// ---------------------------------------------------------------------------
for (const [id, heading] of TAB_HEADINGS) {
  test(`P6a: #${id} renders the ${heading} tab`, async ({ page }) => {
    await page.goto(`/#${id}`);
    await expect(page.locator('h1').first()).toHaveText(new RegExp(`^${esc(heading)}`));
  });
}

// ---------------------------------------------------------------------------
// P6 (b) — one All pages menu, and no group buttons, at 1920 and at 390
// ---------------------------------------------------------------------------
for (const w of [1920, 390]) {
  test(`P6b: the header has one All pages menu and no group buttons at ${w}px`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto('/#overview');
    const menu = page.locator(MENU);
    await expect(menu).toBeVisible();
    await expect(menu).toHaveText(/^All pages/);
    await expect(menu).toHaveAttribute('aria-haspopup', 'menu');
    await expect(page.locator('header button[data-group]')).toHaveCount(0);
  });
}

// ---------------------------------------------------------------------------
// P6 (c) — the header never scrolls sideways, at either width
// ---------------------------------------------------------------------------
for (const [w, h] of [
  [1920, 1080],
  [390, 844],
]) {
  test(`P6c: header does not overflow at ${w}x${h}`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/?cb=p6c-${w}#overview`);
    await expect(page.locator('header')).toHaveCount(1);
    // The right-hand cluster grows AFTER first paint (ConnStatus / UpdateButton
    // fetches resolving). Measuring before that settles would measure a header
    // narrower than the one a user sees.
    await page.waitForTimeout(2500);

    const m = await page.evaluate(() => {
      const el = document.querySelector('header')!;
      return {
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        // Named so a failure says WHICH child overflows instead of only that
        // something does.
        children: [...el.children].map((c) => ({
          w: Math.round(c.getBoundingClientRect().width),
          text: (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 32),
        })),
      };
    });

    expect(
      m.scrollWidth,
      `header overflows at ${w}px: scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth}. ` +
        `Children: ${JSON.stringify(m.children)}`,
    ).toBeLessThanOrEqual(m.clientWidth);
  });
}

// ---------------------------------------------------------------------------
// The menu itself: contents, groups, Escape, outside click, keyboard.
// P6a only proves the hashes work; these prove a user can REACH every page.
// ---------------------------------------------------------------------------
test('All pages lists every tab under its own group, and Escape returns focus', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/#overview');
  const btn = page.locator(MENU);
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await btn.click();
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  for (const label of GROUP_LABELS) {
    // Prefix-matched: the current page's item also carries a check mark.
    await expect(
      page.locator(`header [role="menu"] [role="group"][aria-label="${label}"] a[role="menuitem"]`),
    ).toHaveText(GROUP_TABS[label].map((t) => new RegExp(`^${esc(t)}`)));
  }
  await page.keyboard.press('Escape');
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
  await expect(btn).toBeFocused();
});

test('the current page is marked in the menu in words, not colour alone', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  for (const id of ['audit', 'ai', 'overview']) {
    await page.goto(`/#${id}`);
    await page.locator(MENU).click();
    const marked = await page.evaluate(() =>
      [...document.querySelectorAll('header a[role="menuitem"][aria-current="page"]')].map((a) => a.getAttribute('href')),
    );
    expect(marked, `#${id} should mark exactly its own item`).toEqual([`#${id}`]);
    await page.keyboard.press('Escape');
  }
});

test('a menu item navigates to its tab and the menu closes', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/#overview');
  await page.locator(MENU).click();
  await page.locator('header a[role="menuitem"]', { hasText: /^Incidents$/ }).click();
  await expect(page.locator('h1').first()).toHaveText(/^Incidents/);
  await expect(page.locator('header [role="menu"]')).toHaveCount(0);
});

test('clicking outside closes the menu', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/#overview');
  const btn = page.locator(MENU);
  await btn.click();
  await expect(page.locator('header [role="menu"]')).toHaveCount(1);
  await page.locator('h1').first().click();
  await expect(page.locator('header [role="menu"]')).toHaveCount(0);
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
});

test('at 390px All pages still reaches every tab', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?cb=p6-390#overview');
  await page.locator(MENU).click();
  const hrefs = await page.evaluate(() =>
    [...document.querySelectorAll('header [role="menu"] a[role="menuitem"]')].map((a) =>
      (a as HTMLAnchorElement).getAttribute('href'),
    ),
  );
  expect(hrefs.sort()).toEqual(TAB_HEADINGS.map(([id]) => `#${id}`).sort());
});

// The top bar no longer carries the theme switch at ANY width: it lives in
// Settings, which is reachable everywhere. A move that DELETED the control would
// satisfy "not on the bar" just as well, so this is the clause that tells the
// two apart: the switch has to still be there, and still work, from inside the
// sheet.
test('at 390px the theme switch is not on the bar and still works from Settings', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?cb=fold-390#overview');

  await expect(page.locator('header').getByRole('button', { name: 'Light theme' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Appearance', exact: true }).click();
  const lightInSheet = page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Light theme' });
  await expect(lightInSheet).toBeVisible();
  await lightInSheet.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

// A `role="menu"` that announces as a menu and does not move focus is worse
// than no role at all: a screen reader in menu mode gets nothing to steer.
test('the open menu owns focus, and arrow keys move within it instead of scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/#overview');

  const focusedHref = () =>
    page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return { role: a?.getAttribute('role') ?? null, href: a?.getAttribute('href') ?? null };
    });

  await page.locator(MENU).click();
  expect(await focusedHref()).toEqual({ role: 'menuitem', href: '#overview' });
  await page.keyboard.press('ArrowDown');
  expect(await focusedHref()).toEqual({ role: 'menuitem', href: '#daily' });
  await page.keyboard.press('End');
  expect(await focusedHref()).toEqual({ role: 'menuitem', href: '#chart' });
  // Wraps both ways.
  await page.keyboard.press('ArrowDown');
  expect(await focusedHref()).toEqual({ role: 'menuitem', href: '#overview' });
  await page.keyboard.press('ArrowUp');
  expect(await focusedHref()).toEqual({ role: 'menuitem', href: '#chart' });
  await page.keyboard.press('Home');
  expect(await focusedHref()).toEqual({ role: 'menuitem', href: '#overview' });

  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('header [role="menu"]')).toHaveCount(0);
  await expect(page.locator(MENU)).toBeFocused();
});

// Only the AI tab's send button answers to "Ask"; nothing in the header does.
test('no header control shares the name of the AI send button', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/#ai');
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toHaveCount(1);
});

// Activating a menu item left focus on BODY and announced nothing, so every
// tab change restarted a keyboard user at the top of the document.
test('activating a menu item moves focus into the new tab and announces it', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/#overview');
  await page.locator(MENU).click();
  await page.locator('header a[role="menuitem"][href="#incidents"]').click();

  await expect(page.locator('h1').first()).toHaveText(/^Incidents/);
  const focused = await page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return { tag: a?.tagName ?? null, label: a?.getAttribute('aria-label') ?? null };
  });
  expect(focused).toEqual({ tag: 'MAIN', label: 'Incidents tab' });
  await expect(page.locator('[data-tab-live]')).toHaveText('Incidents tab');
});

// role="menu" may own menuitems, groups and separators — not bare divs.
test('the menu keeps the five groups as real groups', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?cb=groups-390#overview');
  await page.locator(MENU).click();

  const groups = page.locator('header [role="menu"] > [role="group"]');
  await expect(groups).toHaveCount(5);
  expect(await groups.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).toEqual(GROUP_LABELS);
  for (const label of GROUP_LABELS) {
    await expect(
      page.locator(`header [role="menu"] [role="group"][aria-label="${label}"] a[role="menuitem"]`),
    ).toHaveCount(GROUP_TABS[label].length);
  }
});

// The "…" settings sheet was a bare div.fixed: no dialog role, no focus move,
// no trap, no Escape — 177 Tab presses from the trigger to its own ✕. Below lg
// it is the ONLY route to tenant switching, version, theme and density.
test('the settings sheet is a real modal dialog: focus, trap, Escape, return', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?cb=sheet-390#overview');

  const trigger = page.getByRole('button', { name: 'Settings' });
  await trigger.click();

  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toHaveCount(1);
  await expect(dialog).toHaveAttribute('aria-modal', 'true');

  // Focus is inside it on open, and its ✕ is one Tab away — not 177.
  expect(
    await page.evaluate(
      () => document.querySelector('[role="dialog"]')?.contains(document.activeElement) ?? false,
    ),
  ).toBe(true);
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();

  // Nothing behind the sheet can take focus while it is open.
  expect(
    await page.evaluate(() => {
      const bg = document.querySelector('header button[data-menu]') as HTMLElement;
      bg.focus();
      return document.activeElement === bg;
    }),
  ).toBe(false);

  // Tab is trapped: backwards from the first control wraps to the last one
  // inside the sheet, it does not walk out into the page behind.
  await page.keyboard.press('Shift+Tab');
  expect(
    await page.evaluate(
      () => document.querySelector('[role="dialog"]')?.contains(document.activeElement) ?? false,
    ),
  ).toBe(true);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
