import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The Settings sheet after the 2026-10-02 overhaul: a drawer on the right with a
// list of six sections, one on screen at a time. It used to be one 420px column
// holding every block at once — "way too much info", in the owner's words.
//
// WHAT HAS TO STAY TRUE WHEN SIX BLOCKS BECOME SIX SCREENS:
//   - nothing is lost: every control is still reachable, at 1920 and at 390;
//   - nothing typed is lost by looking elsewhere: the panes stay mounted;
//   - it is still a modal dialog (focus, Tab trap, Escape, focus back);
//   - the buttons say what they do, in plain words, not `chg` and ✕.

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const SECTIONS = ['Connections', 'Write access', 'Integrations', 'Appearance', 'Updates', 'Security'];
const SETTINGS = { name: 'Settings', exact: true };

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
  // Two tenants, so the list has something to Change and Remove, and a stored
  // Axur key, so its box has something to say.
  await page.route('**/api/vault/status*', (route) =>
    json(route, {
      active: 'sales',
      exists: true,
      ready: true,
      unlocked: true,
      vaultMode: true,
      hasGroq: false,
      hasAxur: true,
      llm: { base_url: '', hasKey: false, model: '' },
      tenants: [
        { id: 'ams', label: 'Infoblox SE AMS' },
        { id: 'sales', label: 'Infoblox Sales' },
      ],
      version: 'v3.81.1',
      writeAllowed: [],
    }),
  );
  // The CSP account picker only draws when the account list answers, and the
  // write block only offers "Allow changes" when the tenant is read-only.
  await page.route('**/api/accounts*', (route) =>
    json(route, { accounts: [{ id: 'a1', name: 'Infoblox Sales' }, { id: 'a2', name: 'Infoblox SE AMS' }], active: 'a1' }),
  );
  await page.route('**/api/vault/write-target*', (route) =>
    json(route, { known: true, tenant: 'sales/-', label: 'Infoblox Sales', writable: false }),
  );
});

async function openSheet(page: Page, width = 1280, height = 800) {
  await page.setViewportSize({ width, height });
  await page.goto('/#overview');
  await page.getByRole('button', SETTINGS).click();
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await expect(sheet).toBeVisible();
  return sheet;
}

const pane = (page: Page, name: string) => page.locator(`[role="dialog"] section[aria-label="${name}"]`);

test('it is a drawer on the right edge with the six sections listed', async ({ page }) => {
  const sheet = await openSheet(page, 1920, 1000);

  const box = await sheet.boundingBox();
  expect(box, 'the drawer has a box').not.toBeNull();
  expect(Math.round(box!.x + box!.width), 'its right edge is the screen edge').toBe(1920);
  expect(Math.round(box!.height), 'it is the full height of the screen').toBe(1000);
  expect(box!.width, 'it is a drawer, not a full-width page').toBeLessThanOrEqual(800);

  const nav = sheet.getByRole('navigation', { name: 'Settings sections' });
  await expect(nav.getByRole('button')).toHaveText(SECTIONS);
});

test('Connections is showing when it opens, and only one section shows at a time', async ({ page }) => {
  const sheet = await openSheet(page);
  const nav = sheet.getByRole('navigation', { name: 'Settings sections' });
  await expect(nav.getByRole('button', { name: 'Connections', exact: true })).toHaveAttribute('aria-current', 'true');

  for (const name of SECTIONS) {
    await nav.getByRole('button', { name, exact: true }).click();
    await expect(pane(page, name)).toBeVisible();
    await expect(pane(page, name).getByRole('heading', { name, exact: true })).toBeVisible();
    for (const other of SECTIONS.filter((n) => n !== name)) {
      await expect(pane(page, other), `${other} is hidden while ${name} shows`).toBeHidden();
    }
    await expect(nav.getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'true');
  }
});

test('each section holds what it should, and nothing from the others', async ({ page }) => {
  const sheet = await openSheet(page);
  const go = (name: string) => sheet.getByRole('button', { name, exact: true }).click();

  await expect(sheet.getByRole('button', { name: 'Test active connection' })).toBeVisible();
  await expect(sheet.getByLabel('Active CSP account')).toBeVisible();
  await expect(sheet.getByLabel('Axur API key')).toBeHidden();

  await go('Write access');
  await expect(sheet.getByText('Changing this tenant')).toBeVisible();
  await go('Integrations');
  await expect(sheet.getByLabel('Axur API key')).toBeVisible();
  await go('Appearance');
  await expect(sheet.getByRole('button', { name: 'Dark theme' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Compact density' })).toBeVisible();
  await go('Updates');
  await expect(sheet.getByRole('button', { name: 'Check for updates' })).toBeVisible();
  await go('Security');
  await expect(sheet.getByLabel('Dashboard token')).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Lock vault now' })).toBeVisible();
});

test('the buttons say what they do: Change key and Remove, not chg and a cross', async ({ page }) => {
  const sheet = await openSheet(page);

  await expect(sheet.getByRole('button', { name: 'chg', exact: true })).toHaveCount(0);
  for (const tenant of ['Infoblox SE AMS', 'Infoblox Sales']) {
    await expect(sheet.getByRole('button', { name: `Change key for ${tenant}` })).toHaveText('Change key');
    await expect(sheet.getByRole('button', { name: `Remove ${tenant}` })).toHaveText('Remove');
  }
  // The only cross left in the drawer is the one that closes it.
  const crosses = await sheet.getByRole('button').evaluateAll((els) =>
    els.filter((e) => (e.textContent || '').trim() === '✕').map((e) => e.getAttribute('aria-label')),
  );
  expect(crosses).toEqual(['Close']);
});

test('removing a connection asks first, in words, and Keep puts it back', async ({ page }) => {
  const sheet = await openSheet(page);
  await sheet.getByRole('button', { name: 'Remove Infoblox SE AMS' }).click();

  await expect(sheet.getByText('Remove Infoblox SE AMS?')).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Confirm remove Infoblox SE AMS' })).toHaveText('Remove');
  await sheet.getByRole('button', { name: 'Keep Infoblox SE AMS' }).click();
  await expect(sheet.getByText('Remove Infoblox SE AMS?')).toHaveCount(0);
  await expect(sheet.getByRole('button', { name: 'Change key for Infoblox SE AMS' })).toBeVisible();
});

test('no heading or label in the drawer is capitals or monospace', async ({ page }) => {
  const sheet = await openSheet(page);
  for (const name of SECTIONS) {
    await sheet.getByRole('button', { name, exact: true }).click();
    const bad = await page.evaluate(() => {
      const root = document.querySelector('[role="dialog"]')!;
      const out: string[] = [];
      for (const el of root.querySelectorAll('*')) {
        if (!(el as HTMLElement).offsetParent && getComputedStyle(el).position !== 'fixed') continue;
        const cs = getComputedStyle(el);
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent || '').trim());
        if (!own) continue;
        if (cs.textTransform === 'uppercase') out.push(`uppercase: ${(el.textContent || '').trim().slice(0, 30)}`);
        if (/mono/i.test(cs.fontFamily)) out.push(`mono: ${(el.textContent || '').trim().slice(0, 30)}`);
      }
      return out;
    });
    expect(bad, `${name} section has capitals or monospace text`).toEqual([]);
  }
});

test('adding a connection happens inside Connections, with the section list still there', async ({ page }) => {
  const sheet = await openSheet(page);
  const nav = sheet.getByRole('navigation', { name: 'Settings sections' });

  await sheet.getByRole('button', { name: '+ Add connection' }).click();
  await expect(sheet.getByLabel('Infoblox API key')).toBeVisible();
  await expect(nav.getByRole('button')).toHaveCount(6);
  await expect(nav.getByRole('button', { name: 'Security', exact: true })).toBeVisible();
});

test('what you typed is still there after you look at another section', async ({ page }) => {
  const sheet = await openSheet(page);
  const go = (name: string) => sheet.getByRole('button', { name, exact: true }).click();

  // A half-typed new connection.
  await sheet.getByRole('button', { name: '+ Add connection' }).click();
  await sheet.getByLabel('Infoblox API key').fill('half-typed');
  // A half-typed Axur key.
  await go('Integrations');
  await sheet.getByLabel('Axur API key').fill('axur-half');
  // An unconfirmed grant.
  await go('Write access');
  await sheet.getByRole('button', { name: /Allow changes to this tenant/ }).click();

  await go('Updates');
  await go('Connections');
  await expect(sheet.getByLabel('Infoblox API key')).toHaveValue('half-typed');
  await go('Integrations');
  await expect(sheet.getByLabel('Axur API key')).toHaveValue('axur-half');
  await go('Write access');
  await expect(sheet.getByRole('button', { name: 'Yes, allow changes' })).toBeVisible();
});

test('an update check in progress is still in progress, and still lands, after you look away and back', async ({ page }) => {
  // The ordinary read says "up to date"; the forced one, which the button sends,
  // answers slowly and says something DIFFERENT. So a pane that was unmounted
  // by the switch (and lost its local "Checking…") would show the first answer,
  // and only a pane that stayed mounted can show the second.
  await page.route('**/api/update/check*', async (route) => {
    const forced = /[?&]force=1\b/.test(route.request().url());
    if (forced) {
      await new Promise((r) => setTimeout(r, 1500));
      return json(route, { current: 'v3.81.1', latest: 'v3.99.0', available: true, url: '', selfUpdate: true, cached: false, checkedAt: new Date().toISOString() });
    }
    return json(route, { current: 'v3.81.1', latest: 'v3.81.1', available: false, url: '', selfUpdate: true, cached: false, checkedAt: new Date().toISOString() });
  });
  const sheet = await openSheet(page);
  const go = (name: string) => sheet.getByRole('button', { name, exact: true }).click();

  await go('Updates');
  await expect(pane(page, 'Updates').getByRole('status')).toContainText("You're on the latest version.");
  await sheet.getByRole('button', { name: 'Check for updates' }).click();
  await expect(pane(page, 'Updates').getByRole('status')).toContainText('Checking…');

  await go('Connections');
  await go('Updates');
  // Back, and the check is still the one in flight, not a fresh pane's answer.
  await expect(pane(page, 'Updates').getByRole('status')).toContainText('Checking…');
  await expect(pane(page, 'Updates').getByRole('status')).toContainText('Version 3.99.0 is ready to install.');
});

test('Tab stays inside the drawer whichever section is showing, and Escape closes it', async ({ page }) => {
  const sheet = await openSheet(page);
  const trigger = page.getByRole('button', SETTINGS);
  await sheet.getByRole('button', { name: 'Appearance', exact: true }).click();

  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement) ?? false);
    expect(inside, `focus left the drawer on Tab press ${i + 1}`).toBe(true);
  }
  // Never lands in a section that is hidden.
  const hiddenFocus = await page.evaluate(() => {
    const a = document.activeElement;
    return !!a && !!a.closest('section.hidden');
  });
  expect(hiddenFocus).toBe(false);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('on a 390px phone the drawer fills the screen, every section is reachable, and the page does not scroll sideways', async ({ page }) => {
  const sheet = await openSheet(page, 390, 844);

  const box = await sheet.boundingBox();
  expect(Math.round(box!.width), 'it fills the width').toBe(390);
  expect(Math.round(box!.height), 'and the height').toBe(844);

  const nav = sheet.getByRole('navigation', { name: 'Settings sections' });
  for (const name of SECTIONS) {
    const btn = nav.getByRole('button', { name, exact: true });
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    await expect(pane(page, name)).toBeVisible();
    await expect(btn).toHaveAttribute('aria-current', 'true');
  }

  // The last section's controls can be scrolled to, not stranded below the fold.
  await expect(sheet.getByRole('button', { name: 'Lock vault now' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Lock vault now' }).scrollIntoViewIfNeeded();
  const inView = await sheet.getByRole('button', { name: 'Lock vault now' }).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.bottom <= window.innerHeight && r.right <= window.innerWidth;
  });
  expect(inView).toBe(true);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow, 'the page scrolls sideways').toBe(false);
});
