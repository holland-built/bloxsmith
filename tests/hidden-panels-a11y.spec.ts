import { test, expect } from './fixtures';

// The accessibility half of P7's hidden-panel row. tests/hidden-panels.spec.ts
// proves WHICH panels disappear and come back; this file proves that the one
// control on that row can be used by someone who cannot see it.
//
// Three defects the 2026-08-07 audit found by reading the source, none of
// which it could exercise live because this tenant owns every mapped service —
// so, exactly as that spec does, the inventory response is faked.
//
//   1. the button was named just "show anyway": the same name on every group
//      on the page, saying nothing about what would appear
//   2. no state — nothing said this was a collapsed disclosure
//   3. it unmounts itself on click, dropping focus to <body>: the operator
//      lands back at the top of the document with no signal that the panels
//      they asked for now exist

function fulfillJson(route: import('@playwright/test').Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

function inventory(page: import('@playwright/test').Page, body: unknown) {
  return page.route('**/api/service-inventory', (route) => fulfillJson(route, body));
}

// This tenant's real answer with the DNS types taken out — the same literal
// tests/hidden-panels.spec.ts uses.
const OWNS_NO_DNS = { availability: 'ok', service_types: ['dfp', 'dhcp', 'discovery', 'ntp', 'orpheus'] };

const activeElement = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    return {
      tag: el.tagName,
      tabindex: el.getAttribute('tabindex'),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50),
    };
  });

test('the reveal button names its own group, says it is collapsed, and hands focus to what it revealed', async ({ page }) => {
  await inventory(page, OWNS_NO_DNS);
  await page.goto('/#dns');

  // Two runs hide on this tab (DNS Query Rate and DNS Services sit either side
  // of a panel that is NOT hidden), so the name has to carry the group.
  await expect(page.getByTestId('hidden-panels')).toHaveCount(2);
  const reveal = page.getByRole('button', { name: 'Show anyway: 1 hidden DNS panel', exact: true });
  await expect(reveal).toHaveCount(2);

  // A collapsed disclosure. (No aria-controls: what it reveals does not exist
  // while it is on screen, so any id would be a dangling reference.)
  await expect(reveal.first()).toHaveAttribute('aria-expanded', 'false');

  // The visible words still start the accessible name, so voice control and
  // the existing spec's `name: 'show anyway'` both still find it.
  await expect(page.getByRole('button', { name: 'show anyway' }).first()).toBeVisible();

  await reveal.first().click();
  await expect(page.getByText('DNS Query Rate — 24h')).toBeVisible();

  // Focus landed on the panel that appeared, not on <body>.
  const focused = await activeElement(page);
  expect(focused?.tag, 'focus fell to the document body').not.toBe('BODY');
  expect(focused?.tabindex).toBe('-1');
  expect(focused?.text).toContain('DNS Query Rate');
});
