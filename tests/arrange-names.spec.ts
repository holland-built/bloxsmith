import { test, expect } from './fixtures';

// "Arrange this page" never lists a panel by its internal code name.
//
// THE COMPLAINT THIS EXISTS FOR, verbatim from the screenshot that raised it:
// five rows of the popup on #overview read "Top Consumers", "Subnet Heatmap",
// "Host Status", "Top Subnets by Utilization" and "License Inventory" — and two
// read `dns-hero` and `kpi-stack`. Those are panelIds. The reader of this
// dashboard has never seen this codebase and cannot be expected to know which
// panel either one is.
//
// The names come from CardGrid's title registry, which Card fills in from
// `panelName ?? title` and which keeps only a plain string; `nameOf` falls back
// to the raw panel id when it has neither. That fallback is deliberate and
// stays — a panel must never drop out of the popup — so the guarantee is that
// nothing ever REACHES it.
//
// TWO HALVES, AND NEITHER IS SUFFICIENT ALONE:
//   - ui/src/lib/arrangeNames.test.js reads the JSX and covers every panel that
//     CAN exist, including the ones that only render when a feed errors or when
//     a tenant owns a particular service. It cannot prove the popup rendered
//     what the call site handed up.
//   - this file proves exactly that, for whatever the browser actually painted.
//
// THIS SPEC WRITES NOTHING. It opens the popup and reads it; it presses no Move,
// no Take off the page and no Put back, so no `__layout_<key>` view is created
// and there is none to clean up. That is what keeps it out of the view-ownership
// rules in playwright.config.ts's `workers: 1` comment — it is not a writer.
//
// The 15 ids are the app's tab ids (ui/src/App.jsx), the same list
// tests/tabs-smoke.spec.ts carries and for the same reason: a tab missing from
// this array is a tab nothing here ever looks at.
const TABS = [
  'overview', 'daily', 'network', 'dns', 'security', 'infra', 'assets', 'incidents',
  'audit', 'changes', 'provision', 'selfservice', 'editor', 'drift', 'ai',
];

// A panelId's shape: kebab-case, which is what panelHelp.test.js already
// enforces on every id in the app. A row matching this is either the fallback
// firing or a "name" that is an id typed out by hand.
const LOOKS_LIKE_AN_ID = /^[a-z0-9]+(-[a-z0-9]+)+$/;

type Row = { id: string | null; name: string; section: string };

// Every row of the open popup, paired with the panel id its own buttons name.
// The id is read from `data-arrange="up:<id>"` / `"back:<id>"` rather than
// passed in, so the comparison below is against the row's OWN panel and cannot
// drift from whatever the tab happens to be rendering.
const arrangeRows = (page: import('@playwright/test').Page) =>
  page.$$eval('[data-arrange-dialog] li', (lis) =>
    lis.map((li) => {
      const btn = li.querySelector('[data-arrange]');
      const attr = btn?.getAttribute('data-arrange') ?? '';
      const colon = attr.indexOf(':');
      return {
        id: colon === -1 ? null : attr.slice(colon + 1),
        // [data-arrange-name], not "the row's first span". The rows carry a
        // drag grip ahead of the name now, so a positional read would grade the
        // grip glyph on every tab and call every panel unnamed. The attribute
        // names the thing being read, so nothing added to a row later can move
        // it again.
        name: (li.querySelector('[data-arrange-name]')?.textContent ?? '').trim(),
        section: attr.startsWith('back:') ? 'Off this page' : 'On this page',
      };
    }),
  );

// Counted across the whole file so a change that stopped the popup opening —
// a renamed testid, a tab that no longer mounts — cannot leave every test below
// passing on zero rows.
const seen: Record<string, number> = {};

for (const id of TABS) {
  test(`every "Arrange this page" row on #${id} reads as words, not a panelId`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(`/#${id}`);
    await expect(page.locator('h1').first()).toBeVisible();

    // The button is absent by design on a one-panel tab with nothing hidden
    // (#editor renders exactly one panel and always will) — CardGrid gates the
    // strip on `reorderable || hiddenTiles.length`. That is not a failure, and
    // the aggregate check at the bottom is what stops it from becoming an
    // excuse for the whole file to pass on nothing.
    const button = page.locator('[data-layout-arrange]').first();
    if ((await button.count()) === 0) {
      seen[id] = 0;
      test.skip(true, `#${id} shows no "Arrange panels" button — too few panels to rearrange`);
      return;
    }

    await button.click();
    await expect(page.locator('[data-arrange-dialog]')).toBeVisible();

    const rows: Row[] = await arrangeRows(page);
    expect(rows.length, `the popup on #${id} listed no panels at all`).toBeGreaterThan(0);
    seen[id] = rows.length;

    const bad = rows
      .filter((r) => r.name === '' || r.name === r.id || LOOKS_LIKE_AN_ID.test(r.name))
      .map((r) => `${r.section}: panel "${r.id}" is listed as "${r.name}"`);

    expect(
      bad,
      `#${id} names ${bad.length} panel(s) by their internal code name. Add panelName="Some Words" ` +
        'to that Card — it renders nothing and changes no layout.',
    ).toEqual([]);

    // Two panels listed under one name is the other way this popup misleads:
    // the rows are indistinguishable, and "Move up" on either is a coin flip.
    const onPage = rows.filter((r) => r.section === 'On this page').map((r) => r.name);
    expect(new Set(onPage).size, `#${id} lists two panels under the same name: ${onPage.join(', ')}`).toBe(
      onPage.length,
    );

    await page.keyboard.press('Escape');
  });
}

test('the popup was actually opened and read on most tabs', () => {
  // The guard against a green run that proved nothing. Every skip above is
  // recorded as 0, so this fails if the button silently stopped rendering
  // app-wide rather than on the one-panel tabs it is expected to be absent on.
  const opened = Object.entries(seen).filter(([, n]) => n > 0);
  const total = opened.reduce((n, [, count]) => n + count, 0);
  expect(
    opened.length,
    `the Arrange popup only opened on ${opened.length} of ${TABS.length} tabs (${JSON.stringify(seen)})`,
  ).toBeGreaterThanOrEqual(10);
  expect(total, 'no panel rows were read on any tab').toBeGreaterThan(30);
});
