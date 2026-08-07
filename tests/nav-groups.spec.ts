import { test, expect } from './fixtures';

// Predicate P6 for the tab-regrouping item (14 flat tabs -> 5 dropdown groups).
//
// The measured-overflow nav this replaces existed ONLY to fit 14 items in one
// row, and it shipped broken twice. Five static group buttons need no
// measurement — so the guard that replaces the measurer is not "does the
// arithmetic still work", it is the three clauses below:
//
//   (a) all 14 hash ids still render their own tab, unchanged
//   (b) the header carries exactly 5 group buttons at 1920
//   (c) the header does not overflow horizontally at 1920 OR at 390
//
// (c) is the clause that replaces "screenshot it and look". It is measured on
// the real <header>, not on the nav alone, because the failure mode being
// guarded is the tab row colliding with the right-hand controls cluster.

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
];

const GROUP_LABELS = ['Status', 'Estate', 'Risk', 'Change', 'Ask'];

// Which group owns which tab. Duplicated from App.jsx on purpose: a test that
// imports the thing it checks would pass on any regrouping, including a wrong one.
const GROUP_TABS: Record<string, string[]> = {
  Status: ['Overview', 'Daily'],
  Estate: ['Network', 'DNS', 'Assets', 'Infra'],
  Risk: ['Security', 'Incidents', 'Audit', 'Changes'],
  Change: ['Provision', 'Self-Service', 'Editor', 'Drift'],
  Ask: ['AI'],
};

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
// P6 (b) — exactly 5 group buttons in the header at 1920
// ---------------------------------------------------------------------------
test('P6b: header has exactly 5 group buttons at 1920x1080', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/#overview');
  await expect(page.locator('header')).toHaveCount(1);

  const groupBtns = page.locator('header button[data-group]');
  await expect(groupBtns).toHaveCount(5);
  await expect(groupBtns).toHaveText(GROUP_LABELS.map((l) => new RegExp(esc(l), 'i')));

  // Every one is a real menu trigger, not a styled div.
  for (const label of GROUP_LABELS) {
    await expect(
      page.locator(`header button[data-group="${label.toLowerCase()}"]`),
    ).toHaveAttribute('aria-haspopup', 'menu');
  }
});

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
// The group menus themselves: contents, one-at-a-time, Escape, active group.
// Not part of P6's three clauses, but P6a only proves the hashes still work —
// it does not prove a user can REACH a tab now that the flat strip is gone.
// ---------------------------------------------------------------------------
test('each group menu lists exactly its own tabs, and links to them', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/#overview');
  await expect(page.locator('header')).toHaveCount(1);

  for (const label of GROUP_LABELS) {
    const btn = page.locator(`header button[data-group="${label.toLowerCase()}"]`);
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    await btn.click();
    await expect(btn).toHaveAttribute('aria-expanded', 'true');

    // Prefix-matched: the item for the tab you are already on also carries a
    // "Here" marker, which is part of its text content.
    const items = page.locator('header [role="menu"] a[role="menuitem"]');
    await expect(items).toHaveText(GROUP_TABS[label].map((t) => new RegExp(`^${esc(t)}`)));
    // Only one menu is ever open.
    await expect(page.locator('header [role="menu"]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(btn).toHaveAttribute('aria-expanded', 'false');
    await expect(btn).toBeFocused();
  }
});

test('the group holding the current tab is marked active', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });

  // audit lives in Risk; ai lives in Ask. Exactly one group is current at a time.
  for (const [id, expected] of [
    ['audit', 'risk'],
    ['ai', 'ask'],
    ['overview', 'status'],
  ] as const) {
    await page.goto(`/#${id}`);
    await expect(page.locator('header button[data-group]').first()).toBeVisible();
    const current = await page.evaluate(() =>
      [...document.querySelectorAll('header button[data-group]')]
        .filter((b) => b.getAttribute('data-current') === 'true')
        .map((b) => b.getAttribute('data-group')),
    );
    expect(current, `#${id} should mark exactly one group current`).toEqual([expected]);
  }
});

test('a menu item navigates to its tab and the menu closes', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/#overview');
  await page.locator('header button[data-group="risk"]').click();
  await page.locator('header a[role="menuitem"]', { hasText: /^Incidents$/ }).click();

  await expect(page.locator('h1').first()).toHaveText(/^Incidents/);
  await expect(page.locator('header [role="menu"]')).toHaveCount(0);
  await expect(page.locator('header button[data-group="risk"]')).toHaveAttribute(
    'data-current',
    'true',
  );
});

test('clicking outside closes an open group menu', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/#overview');
  const btn = page.locator('header button[data-group="estate"]');
  await btn.click();
  await expect(page.locator('header [role="menu"]')).toHaveCount(1);
  await page.locator('h1').first().click();
  await expect(page.locator('header [role="menu"]')).toHaveCount(0);
  await expect(btn).toHaveAttribute('aria-expanded', 'false');
});

// Below the xl breakpoint the five cells collapse to one "Menu" cell. This is
// a static CSS breakpoint, so what has to be proved is not that it measured
// correctly but that nothing became unreachable: every tab stays one click away.
test('at 390px the bar collapses to one Menu button that still reaches every tab', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?cb=p6-390#overview');

  const menu = page.locator('header button[data-menu]');
  await expect(menu).toBeVisible();
  // The five wide-width cells are present but not displayed, so they cannot
  // paint over the right-hand controls.
  for (const label of GROUP_LABELS) {
    await expect(page.locator(`header button[data-group="${label.toLowerCase()}"]`)).toBeHidden();
  }

  await menu.click();
  const hrefs = await page.evaluate(() =>
    [...document.querySelectorAll('header [role="menu"] a[role="menuitem"]')].map((a) =>
      (a as HTMLAnchorElement).getAttribute('href'),
    ),
  );
  expect(hrefs.sort()).toEqual(TAB_HEADINGS.map(([id]) => `#${id}`).sort());
});

// P6c is satisfied at 390 by folding the tenant name, version and theme switch
// off the bar. A fold that DELETED a control would satisfy it just as well, so
// this is the clause that tells the two apart: the switch has to still be
// there, and still work, from inside the "…" sheet.
test('at 390px the theme switch folds off the bar but still works from Settings', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?cb=fold-390#overview');

  const lightOnBar = page.locator('header').getByRole('button', { name: 'Light theme' });
  await expect(lightOnBar).toBeHidden();

  await page.getByRole('button', { name: 'Settings' }).click();
  // Two now exist in the DOM — the folded header one and the sheet's — so the
  // ":visible" filter is what names the reachable one.
  const lightInSheet = page.locator('button[aria-label="Light theme"]:visible');
  await expect(lightInSheet).toHaveCount(1);
  await lightInSheet.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

// ---------------------------------------------------------------------------
// Keyboard and screen-reader behaviour of the new nav (2026-08-07 a11y audit).
//
// Each test below failed first for the reason named in its comment, so none of
// them is a restatement of markup that already existed.
// ---------------------------------------------------------------------------

// A `role="menu"` that announces as a menu and does not move focus is worse
// than no role at all: a screen reader in menu mode gets nothing to steer.
// Before the fix, ArrowDown scrolled the document (scrollY 40) and focus never
// left the group button.
test('an open group menu owns focus, and arrow keys move within it instead of scrolling', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/#overview');

  const focusedHref = () =>
    page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return { role: a?.getAttribute('role') ?? null, href: a?.getAttribute('href') ?? null };
    });

  await page.locator('header button[data-group="risk"]').click();

  // Risk owns security, incidents, audit, changes — in that order.
  expect(await focusedHref()).toEqual({ role: 'menuitem', href: '#security' });

  await page.keyboard.press('ArrowDown');
  expect(await focusedHref()).toEqual({ role: 'menuitem', href: '#incidents' });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  expect(await focusedHref()).toEqual({ role: 'menuitem', href: '#changes' });
  // Wraps.
  await page.keyboard.press('ArrowDown');
  expect(await focusedHref()).toEqual({ role: 'menuitem', href: '#security' });
  await page.keyboard.press('ArrowUp');
  expect(await focusedHref()).toEqual({ role: 'menuitem', href: '#changes' });

  await page.keyboard.press('Home');
  expect(await focusedHref()).toEqual({ role: 'menuitem', href: '#security' });
  await page.keyboard.press('End');
  expect(await focusedHref()).toEqual({ role: 'menuitem', href: '#changes' });

  // The page itself must not have moved under any of that.
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await page.keyboard.press('Escape');
  await expect(page.locator('header [role="menu"]')).toHaveCount(0);
  await expect(page.locator('header button[data-group="risk"]')).toBeFocused();
});

// Which group holds the current tab was conveyed by a background colour and an
// aria-hidden accent bar only — and the "Tab —" readout that spells it out in
// words renders at 2xl and no narrower. Before the fix aria-current was null on
// all five buttons at every width.
test('the current group carries aria-current, not colour alone', async ({ page }) => {
  for (const [id, expected] of [
    ['audit', 'risk'],
    ['ai', 'ask'],
    ['overview', 'status'],
  ] as const) {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(`/#${id}`);
    await expect(page.locator('header button[data-group]').first()).toBeVisible();
    const marked = await page.evaluate(() =>
      [...document.querySelectorAll('header button[data-group]')]
        .filter((b) => b.getAttribute('aria-current') === 'true')
        .map((b) => b.getAttribute('data-group')),
    );
    expect(marked, `#${id} should mark exactly one group with aria-current`).toEqual([expected]);
  }
});

// Two controls named exactly "Ask" existed on the AI tab — the nav group and
// the send button — which is ambiguous by accessible name for anyone
// navigating by it (and a Playwright strict-mode violation, see
// tests/ai-budget.spec.ts). The nav buttons now name themselves as sections.
test('each group button names itself as a section, so no two controls share a name', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/#ai');
  for (const label of GROUP_LABELS) {
    await expect(
      page.locator(`header button[data-group="${label.toLowerCase()}"]`),
    ).toHaveAttribute('aria-label', `${label} section`);
  }
  // The AI tab's send button keeps the bare name; nothing else answers to it.
  await expect(page.getByRole('button', { name: 'Ask', exact: true })).toHaveCount(1);
});

// Activating a menu item left focus on BODY and announced nothing, so every
// tab change restarted a keyboard user at the top of the document.
test('activating a menu item moves focus into the new tab and announces it', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/#overview');
  await page.locator('header button[data-group="risk"]').click();
  await page.locator('header a[role="menuitem"][href="#incidents"]').click();

  await expect(page.locator('h1').first()).toHaveText(/^Incidents/);
  const focused = await page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return { tag: a?.tagName ?? null, label: a?.getAttribute('aria-label') ?? null };
  });
  expect(focused).toEqual({ tag: 'MAIN', label: 'Incidents tab' });
  await expect(page.locator('[data-tab-live]')).toHaveText('Incidents tab');
});

// role="menu" may own menuitems, groups and separators — not bare divs. The
// collapsed form put 15 menuitems and 5 role-less heading divs in one menu, so
// the Status/Estate/Risk grouping was lost at xl and below.
test('at 390px the single Menu keeps the five groups as real groups', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?cb=groups-390#overview');
  await page.locator('header button[data-menu]').click();

  const groups = page.locator('header [role="menu"] > [role="group"]');
  await expect(groups).toHaveCount(5);
  expect(
    await groups.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))),
  ).toEqual(GROUP_LABELS);
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

// The five-cell form must be the one on screen at desk widths.
test('at 1920px the collapsed Menu button is not displayed', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/#overview');
  await expect(page.locator('header button[data-menu]')).toBeHidden();
  for (const label of GROUP_LABELS) {
    await expect(page.locator(`header button[data-group="${label.toLowerCase()}"]`)).toBeVisible();
  }
});
