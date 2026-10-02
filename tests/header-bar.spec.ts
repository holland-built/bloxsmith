import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The top bar after the 2026-10-02 overhaul: plain-text sections, a tenant chip
// that says what a change would do, one Settings button, and Provision. Theme,
// spacing and the "What these controls do" dialog live in Settings now.
//
// THE TENANT CHIP'S WRITE WORDS ARE THE ONE PART WORTH BREAKING ON PURPOSE. They
// sit beside the tenant name because that is the fact an operator needs before
// pressing Provision, which makes a stale or invented answer worse than none:
// "Changes allowed" left on screen after a revoke, or "Read-only" painted when
// the read failed, would each be a false statement about a tenant. So the tests
// below drive every outcome — read-only, allowed, unknown, a failed read, a
// verdict that turns bad — rather than the one that happens to be default.

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const TENANT = 'Baseline Tenant';
const writeTarget = (over: Record<string, unknown> = {}) => ({
  known: true,
  tenant: 'baseline-tenant/-',
  label: TENANT,
  writable: false,
  ...over,
});

const chip = (page: Page) => page.locator('header [data-write]');

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

test('the bar holds sections, a tenant chip, Settings and Provision, and nothing else', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/#overview');
  const header = page.locator('header');

  await expect(header.locator('button[data-group]')).toHaveCount(5);
  await expect(header.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await expect(header.getByRole('link', { name: 'Provision' })).toBeVisible();
  await expect(header.getByRole('link', { name: 'Provision' })).toContainText('+ Provision');
  await expect(header.getByText(TENANT)).toBeVisible();

  // Moved to Settings, not duplicated.
  await expect(header.getByRole('button', { name: /density$/ })).toHaveCount(0);
  await expect(header.getByRole('button', { name: /theme$/ })).toHaveCount(0);
  await expect(header.getByRole('button', { name: 'What these controls do' })).toHaveCount(0);
});

test('section buttons are plain sentence-case text, not numbered mono capitals', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/#overview');
  const first = page.locator('header button[data-group="status"]');
  await expect(first).toHaveText(/^Status/);

  const style = await first.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { transform: cs.textTransform, family: cs.fontFamily };
  });
  expect(style.transform).toBe('none');
  expect(style.family.toLowerCase()).not.toContain('mono');
  // The digit keys still open them; the bar just stops drawing the digit.
  await expect(first).toHaveAttribute('aria-keyshortcuts', '1');
});

for (const [name, target, words] of [
  ['read-only', writeTarget(), 'Read-only'],
  ['changes allowed', writeTarget({ writable: true }), 'Changes allowed'],
  ["can't tell when the answer says it does not know", writeTarget({ known: false }), "Can't tell"],
] as const) {
  test(`the chip says "${words}" for ${name}`, async ({ page }) => {
    await page.route('**/api/vault/write-target*', (route) => json(route, target));
    await page.goto('/#overview');
    await expect(chip(page)).toHaveText(words);
  });
}

test("a failed permission read says Can't tell, never read-only", async ({ page }) => {
  await page.route('**/api/vault/write-target*', (route) => json(route, { error: 'boom' }, 500));
  await page.goto('/#overview');
  await expect(chip(page)).toHaveText("Can't tell");
});

test('a write target in a switched account is flagged, even when the labels match', async ({ page }) => {
  // The server's label is the BASE tenant's, so after a CSP account switch it is
  // the same text as the name beside it; only the `/<account>` end of the id
  // says the change would land somewhere else.
  await page.route('**/api/vault/write-target*', (route) =>
    json(route, writeTarget({ writable: true, tenant: 'baseline-tenant/acct-2' })),
  );
  await page.goto('/#overview');
  await expect(chip(page)).toHaveText('Changes allowed in another account');
});

for (const [w, h] of [
  [390, 844],
  [360, 740],
  [320, 640],
] as const) {
  test(`at ${w}px the switched-account warning is read in full, not cut off`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.route('**/api/vault/write-target*', (route) =>
      json(route, writeTarget({ writable: true, tenant: 'baseline-tenant/acct-2' })),
    );
    await page.goto('/#overview');
    const words = chip(page);
    await expect(words).toHaveText('Changes allowed in another account');

    const clipped = await words.evaluate((el) => ({
      across: el.scrollWidth > el.clientWidth + 1,
      down: el.scrollHeight > el.clientHeight + 1,
    }));
    expect(clipped, 'the write words are cut off on a phone').toEqual({ across: false, down: false });
    await headerFits(page);
  });
}

test('no account switch means no "in another account"', async ({ page }) => {
  await page.route('**/api/vault/write-target*', (route) => json(route, writeTarget({ writable: true })));
  await page.goto('/#overview');
  await expect(chip(page)).toHaveText('Changes allowed');
});

test('a verdict that turns bad replaces the good one at once, not after the next poll', async ({ page }) => {
  let failing = false;
  await page.route('**/api/vault/write-target*', (route) =>
    failing ? json(route, { error: 'boom' }, 500) : json(route, writeTarget({ writable: true })),
  );
  await page.goto('/#overview');
  await expect(chip(page)).toHaveText('Changes allowed');

  // Settings fires this after a grant or a revoke; the poll is 30s away.
  failing = true;
  await page.evaluate(() => window.dispatchEvent(new Event('bx:write-target')));
  await expect(chip(page)).toHaveText("Can't tell");
});

test('granting or revoking in Settings changes the chip without waiting for a poll', async ({ page }) => {
  let writable = false;
  await page.route('**/api/vault/write-target*', (route) => json(route, writeTarget({ writable })));
  await page.route('**/api/vault/tenant-writable', (route) => {
    writable = (route.request().postDataJSON() as { writable: boolean }).writable;
    return json(route, { ok: true });
  });
  await page.goto('/#overview');
  await expect(chip(page)).toHaveText('Read-only');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Write access', exact: true }).click();
  await page.getByRole('button', { name: /Allow changes to this tenant/ }).click();
  await page.getByRole('button', { name: 'Yes, allow changes' }).click();
  await expect(chip(page)).toHaveText('Changes allowed');

  await page.getByRole('button', { name: 'Make read-only' }).click();
  await expect(chip(page)).toHaveText('Read-only');
});

// THE NAME STAYS WHEN THE ESTATE DOES NOT. The chip used to put "feed error" or
// "no data" where the tenant's name goes, so beside "Changes allowed" it named no
// tenant at all. Each state below is driven with a real tenant list.
const emptyData = (degraded: boolean, meta: Record<string, string> = {}) => ({
  subnets: [], leases: [], hosts: [], zones: [], dnsViews: [], secPolicies: [], feeds: [], auditLogs: [],
  _totals: { degraded },
  _meta: { subnets: 'ok', leases: 'ok', dnsViews: 'ok', zones: 'ok', hosts: 'ok', secPolicies: 'ok', feeds: 'ok', auditLogs: 'ok', ...meta },
});
const pill = (page: Page) => page.locator('header span[title*="last data fetch"]');

test('a failing feed keeps the tenant name, and says feed error and the write state beside it', async ({ page }) => {
  await page.route('**/api/data*', (route) => json(route, emptyData(true, { hosts: 'error', subnets: 'error', leases: 'error' })));
  await page.route('**/api/vault/write-target*', (route) => json(route, writeTarget({ writable: true })));
  await page.goto('/#overview');
  await expect(pill(page)).toContainText(TENANT);
  await expect(pill(page)).toContainText('feed error');
  await expect(pill(page)).toContainText('Changes allowed');
  await expect(pill(page)).not.toContainText('no data');
});

test('an empty estate keeps the tenant name, and says no data beside it', async ({ page }) => {
  await page.route('**/api/data*', (route) => json(route, emptyData(false)));
  await page.route('**/api/vault/write-target*', (route) => json(route, writeTarget()));
  await page.goto('/#overview');
  await expect(pill(page)).toContainText(TENANT);
  await expect(pill(page)).toContainText('no data');
  await expect(pill(page)).toContainText('Read-only');
  await expect(pill(page)).not.toContainText('feed error');
});

test('a healthy tenant shows its name and no state word', async ({ page }) => {
  await page.goto('/#overview');
  await expect(pill(page)).toContainText(TENANT);
  await expect(page.locator('header [data-state]')).toHaveCount(0);
});

test('the moment the vault locks the chip says locked, keeps the name, and drops the write words', async ({ page }) => {
  // A vault that is really locked replaces the whole dashboard with the unlock
  // screen, so the chip's "locked" is the moment BETWEEN the lock event and that
  // screen arriving. The status read is left saying unlocked, which is exactly
  // that moment held still.
  await page.goto('/#overview');
  await expect(chip(page)).toHaveText('Changes allowed');

  await page.evaluate(() => window.dispatchEvent(new Event('bx:vault-locked')));
  await expect(page.locator('header [data-state]')).toHaveText('locked');
  await expect(pill(page)).toContainText(TENANT);
  await expect(chip(page)).toHaveCount(0);
});

test('the old verdict is not shown while a grant or revoke is being re-read', async ({ page }) => {
  let writable = true;
  let hold = false;
  await page.route('**/api/vault/write-target*', async (route) => {
    const answer = writeTarget({ writable });
    if (hold) await new Promise((r) => setTimeout(r, 1200));
    return json(route, answer);
  });
  await page.goto('/#overview');
  await expect(chip(page)).toHaveText('Changes allowed');

  // A revoke lands: the next read answers read-only, slowly.
  writable = false;
  hold = true;
  await page.evaluate(() => window.dispatchEvent(new Event('bx:write-target')));
  // One reading, not a retrying expect: the point is what is on screen DURING
  // the wait, and a retry would pass in the instant after it ends.
  await page.waitForTimeout(300);
  await expect(page.locator('header').getByText('Changes allowed')).toHaveCount(0);
  await expect(chip(page)).toHaveText('Read-only');
});

test('an older answer cannot land after a newer one', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/vault/write-target*', async (route) => {
    calls += 1;
    if (calls === 1) {
      // The page-load read: slow, and it says writable.
      await new Promise((r) => setTimeout(r, 1500));
      return json(route, writeTarget({ writable: true }));
    }
    // The re-read after a revoke: fast, and it says read-only.
    return json(route, writeTarget({ writable: false }));
  });
  await page.goto('/#overview');
  // The page-load read has been sent, so the chip is mounted and listening. An
  // event fired before that would find nobody there and prove nothing.
  await expect.poll(() => calls).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('bx:write-target')));
  await expect(chip(page)).toHaveText('Read-only');

  // Let the slow, older answer arrive. It must not put the old verdict back.
  await page.waitForTimeout(1800);
  await expect(chip(page)).toHaveText('Read-only');
});

test('switching to read-write from the Provision page updates the chip', async ({ page }) => {
  let writable = false;
  await page.route('**/api/vault/write-target*', (route) => json(route, writeTarget({ writable })));
  await page.route('**/api/vault/tenant-writable', (route) => {
    writable = true;
    return json(route, { ok: true });
  });
  await page.goto('/#provision');
  await expect(chip(page)).toHaveText('Read-only');

  await page.getByRole('button', { name: 'Switch to read-write' }).click();
  await page.getByRole('button', { name: 'Yes, allow changes' }).click();
  await expect(chip(page)).toHaveText('Changes allowed');
});

// The widest honest header: a long tenant name that is writable. Every width
// test below starts from it, because a bar that fits a short name proves nothing.
async function widestWorld(page: Page, update: Record<string, unknown> = { available: false, current: 'v3.80.8', latest: 'v3.80.8' }) {
  const label = 'Infoblox Professional Services EMEA Sandbox';
  await page.route('**/api/vault/write-target*', (route) => json(route, writeTarget({ writable: true, label })));
  await page.route('**/api/vault/status*', (route) =>
    json(route, {
      active: 'baseline-tenant',
      exists: true,
      ready: true,
      unlocked: true,
      vaultMode: false,
      hasGroq: false,
      llm: { base_url: '', hasKey: false, model: '' },
      tenants: [{ id: 'baseline-tenant', label }],
      version: 'v3.80.8',
      writeAllowed: [],
    }),
  );
  await page.route('**/api/update/check*', (route) =>
    json(route, { url: '', selfUpdate: true, checkDisabled: false, ...update }),
  );
}

async function headerFits(page: Page) {
  const m = await page.evaluate(() => {
    const h = document.querySelector('header')!;
    const right = (el: Element | null) => (el ? Math.round(el.getBoundingClientRect().right) : -1);
    return {
      scrollWidth: h.scrollWidth,
      clientWidth: h.clientWidth,
      settings: right(h.querySelector('button[aria-label="Settings"]')),
      provision: right([...h.querySelectorAll('a')].find((a) => /Provision/.test(a.textContent || '')) ?? null),
      viewport: window.innerWidth,
    };
  });
  expect(m.scrollWidth, `header overflows: ${JSON.stringify(m)}`).toBeLessThanOrEqual(m.clientWidth);
  expect(m.settings, `Settings pushed off screen: ${JSON.stringify(m)}`).toBeLessThanOrEqual(m.viewport);
  expect(m.provision, `Provision pushed off screen: ${JSON.stringify(m)}`).toBeLessThanOrEqual(m.viewport);
}

for (const [w, h] of [
  [1920, 1080],
  [1024, 768],
  [768, 1024],
  [700, 900],
  [390, 844],
  [360, 740],
  [320, 640],
] as const) {
  test(`a long tenant name, an update and a writable tenant still fit at ${w}px`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await widestWorld(page, { available: true, current: 'v3.80.8', latest: 'v3.81.0' });
    await page.goto('/#overview');
    await expect(chip(page)).toHaveText('Changes allowed');
    // The pill is for 768px and up. Below it the update is a dot on Settings,
    // which is where the Install button is — saying so is part of the contract.
    if (w >= 768) {
      await expect(page.getByRole('button', { name: 'Update v3.81.0' })).toBeVisible();
    } else {
      await expect(page.getByRole('button', { name: 'Update v3.81.0' })).toBeHidden();
      await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveAttribute(
        'aria-description',
        'An update is ready to install',
      );
    }
    await headerFits(page);
  });
}

// The tallest, widest chip there is: a long name, a failing feed, and a switched
// account that can be changed. It has to fit a phone without losing any of the
// three facts.
for (const [w, h] of [
  [390, 844],
  [360, 740],
  [320, 640],
] as const) {
  test(`a long name, a feed error and a switched writable account fit at ${w}px`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await widestWorld(page);
    await page.route('**/api/data*', (route) => json(route, emptyData(true, { hosts: 'error', subnets: 'error', leases: 'error' })));
    await page.route('**/api/vault/write-target*', (route) =>
      json(route, writeTarget({ writable: true, tenant: 'baseline-tenant/acct-2' })),
    );
    await page.goto('/#overview');
    await expect(chip(page)).toHaveText('Changes allowed in another account');
    await expect(page.locator('header [data-state]')).toHaveText('feed error');
    // All three facts are there AND readable: the name is in the chip, and neither
    // the state word nor the write words are clipped by their own box.
    await expect(pill(page)).toContainText('Infoblox Professional Services EMEA Sandbox');
    for (const hook of ['[data-state]', '[data-write]']) {
      const clipped = await page.locator(`header ${hook}`).evaluate((el) => ({
        across: el.scrollWidth > el.clientWidth + 1,
        down: el.scrollHeight > el.clientHeight + 1,
      }));
      expect(clipped, `${hook} is cut off at ${w}px`).toEqual({ across: false, down: false });
    }
    await headerFits(page);
  });
}

test('a single-key server with no tenant list still names what a write would hit', async ({ page }) => {
  await page.route('**/api/vault/status*', (route) => json(route, { vaultMode: false, ready: true }));
  await page.route('**/api/data*', (route) => json(route, emptyData(true, { hosts: 'error', subnets: 'error', leases: 'error' })));
  await page.route('**/api/vault/write-target*', (route) => json(route, writeTarget({ writable: true, label: 'Lab Estate' })));
  await page.goto('/#overview');
  await expect(pill(page)).toContainText('Lab Estate');
  await expect(pill(page)).toContainText('feed error');
  await expect(pill(page)).toContainText('Changes allowed');
});

test('and with no label anywhere it says "This connection", never nothing', async ({ page }) => {
  await page.route('**/api/vault/status*', (route) => json(route, { vaultMode: false, ready: true }));
  await page.route('**/api/data*', (route) => json(route, emptyData(false)));
  await page.route('**/api/vault/write-target*', (route) => json(route, writeTarget({ writable: true, label: '' })));
  await page.goto('/#overview');
  await expect(pill(page)).toContainText('This connection');
  await expect(pill(page)).toContainText('no data');
  await expect(pill(page)).toContainText('Changes allowed');
});

// THE OTHER UPDATE STATES. The "ready" pill was the only one that got a phone
// layout at first; the install error (a whole sentence), "Updating…" and "update
// check failed" are drawn by the same component and were still sitting in the
// bar at 390px. Each is driven here with the widest tenant beside it.
const LONG_ERROR = 'update applied but could not confirm — refresh to verify the version';
const READY = { available: true, current: 'v3.80.8', latest: 'v3.81.0' };

async function installFromSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Updates', exact: true }).click();
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Install v3.81.0 and restart' }).click();
}

test('a failed install fits a phone bar, and Settings carries the dot', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await widestWorld(page, READY);
  await page.route('**/api/update/apply', (route) => json(route, { error: LONG_ERROR }, 500));
  await page.goto('/#overview');
  await installFromSettings(page);
  await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('status')).toContainText(LONG_ERROR);
  await page.keyboard.press('Escape');

  await expect(page.locator('header').getByText(LONG_ERROR)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveAttribute(
    'aria-description',
    'The last update failed',
  );
  await headerFits(page);
});

for (const [w, h] of [
  [700, 900],
  [768, 1024],
  [1024, 768],
] as const) {
  test(`a long install error does not push the bar wide at ${w}px`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await widestWorld(page, READY);
    await page.route('**/api/update/apply', (route) => json(route, { error: LONG_ERROR }, 500));
    await page.goto('/#overview');
    await installFromSettings(page);
    await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('status')).toContainText(LONG_ERROR);
    await page.keyboard.press('Escape');
    await headerFits(page);
  });
}

test('a failed install is spelled out in the bar where there is room for it', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await widestWorld(page, READY);
  await page.route('**/api/update/apply', (route) => json(route, { error: LONG_ERROR }, 500));
  await page.goto('/#overview');
  await installFromSettings(page);
  await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('status')).toContainText(LONG_ERROR);
  await page.keyboard.press('Escape');

  await expect(page.locator('header').getByText(LONG_ERROR)).toBeVisible();
});

test('an install in progress fits a phone bar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await widestWorld(page, READY);
  await page.route('**/api/update/apply', (route) => json(route, { ok: true }));
  await page.route('**/api/update/status', (route) => json(route, { phase: 'downloading', pct: 10, running: true }));
  await page.goto('/#overview');
  await installFromSettings(page);
  await expect(page.getByRole('dialog', { name: 'Settings' }).getByRole('status')).toContainText('Installing the update');
  await page.keyboard.press('Escape');

  await expect(page.locator('header').getByText('Updating…')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveAttribute(
    'aria-description',
    'An update is installing',
  );
  await headerFits(page);
});

test('a failed update check fits a phone bar, and is still said at desktop width', async ({ page }) => {
  await widestWorld(page, {
    available: false,
    current: 'v3.80.8',
    latest: '',
    error: 'dial tcp: lookup api.github.com: no such host',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#overview');
  await expect(chip(page)).toHaveText('Changes allowed');
  await expect(page.locator('header').getByText('update check failed')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveAttribute(
    'aria-description',
    'The last update check failed',
  );
  await headerFits(page);

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator('header').getByText(/update check failed/)).toBeVisible();
});

for (const [w, h] of [
  [1920, 1080],
  [390, 844],
] as const) {
  test(`Settings holds theme, spacing and the help link at ${w}px`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/#overview');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Settings' });
    await sheet.getByRole('button', { name: 'Appearance', exact: true }).click();

    await expect(sheet.getByRole('button', { name: 'Dark theme' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Compact density' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'What these controls do →' })).toBeVisible();
  });
}

// Light and dark is the one setting people flip while looking at the page, so
// it is on the bar, not behind Settings. One button: it shows where you are and
// flips to the other side. "System" stays in Settings.
for (const [w, h] of [
  [1920, 1080],
  [390, 844],
] as const) {
  test(`the header has a light/dark button that flips and remembers at ${w}px`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
    await page.goto('/#overview');
    const html = page.locator('html');
    const toggle = page.locator('header [data-theme-toggle]');
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(toggle).toHaveAccessibleName('Switch to light mode');

    await toggle.click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    await expect(toggle).toHaveAccessibleName('Switch to dark mode');
    expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('light');

    await toggle.click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await headerFits(page);
  });
}

// Under 380px there is no room for it beside a long tenant name, so the bar
// drops it and Settings, Appearance keeps the switch.
test('under 380px the light/dark button gives way and Settings still has the switch', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/#overview');
  await expect(page.locator('header [data-theme-toggle]')).toBeHidden();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await sheet.getByRole('button', { name: 'Appearance', exact: true }).click();
  await expect(sheet.getByRole('button', { name: 'Dark theme' })).toBeVisible();
});
