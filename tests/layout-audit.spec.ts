import { expect, test } from '@playwright/test';

const sideways = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const dnsRow = (id: string, name: string) => ({
  absolute_name_spec: `${name}.acme.corp.`, absolute_zone_name: 'acme.corp.', dns_rdata: '10.4.0.53',
  id, name_in_zone: name, ttl: 28800, type: 'A', zone: 'dns/auth_zone/1', comment: '', disabled: false,
});

for (const width of [700, 768, 1024, 1280, 1600]) {
  test(`the search result page does not scroll sideways at ${width}px`, async ({ page }) => {
    await page.route('**/api/search/dns?*', (r) => r.fulfill({ json: {
      availability: 'ok', truncated: false,
      rows: [dnsRow('dns/record/1', 'app-dc1-prod'), dnsRow('dns/record/2', 'app-dc2-prod')],
    } }));
    await page.route('**/api/search/ipam?*', (r) => r.fulfill({ json: { availability: 'ok', rows: [], total: 0 } }));
    await page.route('**/api/csp/assets?*', (r) => r.fulfill({ json: { availability: 'ok', rows: [], total: 0 } }));
    await page.route('**/api/csp-audit?*', (r) => r.fulfill({ json: { count: 0, rows: [], status: 'ok', truncated: false } }));
    await page.route('**/api/kentik/traffic?*', (r) => r.fulfill({ json: { availability: 'ok', rows: [] } }));
    await page.route('**/api/dossier?*', (r) => r.fulfill({ json: {
      query: 'app-dc1-prod.acme.corp', type: 'host',
      summary: { actor: '', assessed: true, country: 'US', malicious: false, max_threat_level: 0, properties: [], registrar: '', threat_classes: [] },
      sources: [{ source: 'whois', whois: '{}' }, { source: 'geo', geo: {} }],
    } }));
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/#dossier?q=app-dc1-prod.acme.corp');
    await expect(page.locator('[data-dossier-extra="dns"]').first()).toBeVisible();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });
}

test('a pressed button dips to 0.96, and a disabled one does not', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(() => {
    const rules = [];
    const walk = (list) => {
      for (const r of list) {
        if (r.cssRules) walk(r.cssRules);
        if (r.selectorText?.includes(':active') && r.style?.scale === '0.96') rules.push(r.selectorText);
      }
    };
    for (const s of document.styleSheets) walk(s.cssRules);
    const on = document.createElement('button');
    const off = document.createElement('button');
    off.disabled = true;
    const matches = (el) => rules.some((sel) => el.matches(sel.replaceAll(':active', '')));
    return { enabled: matches(on), disabled: matches(off) };
  });
  expect(result).toEqual({ enabled: true, disabled: false });
});

test('scrolling inside the Settings panel stays in the panel', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /settings/i }).first().click();
  const dialog = page.getByRole('dialog').first();
  await expect(dialog).toBeVisible();
  const contained = await dialog.evaluate((root) =>
    [root, ...root.querySelectorAll('*')].some((el) => {
      const cs = getComputedStyle(el);
      return /auto|scroll/.test(cs.overflowY) && cs.overscrollBehaviorY === 'contain';
    }),
  );
  expect(contained).toBe(true);
});

test('Host Inventory search and type filter stay inside the card at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/#infra');
  const search = page.getByLabel('Search name or IP');
  const type = page.getByLabel('Filter by type');
  await expect(search).toBeVisible({ timeout: 10_000 });
  await page.waitForLoadState('networkidle');
  const card = search.locator('xpath=ancestor::div[contains(@class,"bg-card")][1]');
  const edges = await card.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { left: box.left + parseFloat(cs.paddingLeft), right: box.right - parseFloat(cs.paddingRight) };
  });
  for (const control of [search, type]) {
    const box = await control.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(edges.left - 0.5);
    expect(box!.x + box!.width).toBeLessThanOrEqual(edges.right + 0.5);
  }
});

test('tapping the connection chip shows its full name on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/');
  const chip = page.locator('header').getByRole('button', { name: /This connection|connected/ }).first();
  await expect(chip).toBeVisible({ timeout: 10_000 });
  await chip.click();
  const details = page.locator('#conn-details');
  await expect(details).toBeVisible();
  await expect(details).toContainText(/This connection|connected/);
  const box = await details.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
});
