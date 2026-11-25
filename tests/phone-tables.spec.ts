import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// GUI audit round 2, A1, B5, C3 (HIGH). On a phone a table drew its columns at
// full width and swiped sideways, so the columns people need (a subnet's
// fullness, a zone's issues, an audit entry's result, the Block button) sat off
// the screen. Below 768px each row is now a stacked block: the row's name on
// top, then one "Label: value" line per column, nothing past the right edge.

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

// The cell of the first row under the heading `label`, in the panel `panelId`,
// must be painted, inside the phone screen and inside the table's own box, and
// its text must not be cut off.
async function cellOnScreen(page: Page, panelId: string, label: RegExp) {
  const table = page.locator(`[data-panel-id="${panelId}"] table`).first();
  await expect(table).toBeAttached({ timeout: 20_000 });
  await page.waitForTimeout(300);
  return table.evaluate((t, src) => {
    const re = new RegExp(src, 'i');
    const ths = [...t.querySelectorAll('thead th')];
    const idx = ths.findIndex((th) => re.test((th.textContent || '').trim()));
    if (idx < 0) return `no column ${src}`;
    const td = t.querySelector('tbody tr')?.children[idx] as HTMLElement | undefined;
    if (!td) return 'no first-row cell';
    const r = td.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || getComputedStyle(td).display === 'none') return 'cell not painted';
    const box = (t.parentElement as HTMLElement).getBoundingClientRect();
    const right = Math.min(window.innerWidth, box.left + (t.parentElement as HTMLElement).clientWidth);
    if (r.left < box.left - 1 || r.right > right + 1) return `cell runs ${Math.round(r.right - right)}px past the right edge`;
    if (td.scrollWidth > td.clientWidth + 1) return `cell text cut: ${td.scrollWidth} > ${td.clientWidth}`;
    return 'ok';
  }, label.source);
}

test('Security triage: the Block button is on screen and big enough to tap', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#security');
  const block = page.locator('[data-panel-id="security-triage-inbox"] tbody button', { hasText: /^Block$/ }).first();
  await expect(block).toBeAttached({ timeout: 20_000 });
  await block.scrollIntoViewIfNeeded();
  const box = await block.boundingBox();
  expect(box, 'Block has no box').not.toBeNull();
  expect(box!.x + box!.width, 'Block runs off the right of the screen').toBeLessThanOrEqual(390);
  expect(box!.height, 'Block is shorter than 44px on a touch screen').toBeGreaterThanOrEqual(44);
  await expect(block).toBeVisible();
});

test('Network subnets: fullness and status are on screen', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#network');
  expect(await cellOnScreen(page, 'network-exhaustion', /^Utilization/)).toBe('ok');
  expect(await cellOnScreen(page, 'network-exhaustion', /^Status/)).toBe('ok');
});

test('Audit: an entry\'s Event and a Portal entry\'s Result are on screen', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#audit');
  expect(await cellOnScreen(page, 'audit-log', /^Event/)).toBe('ok');
  expect(await cellOnScreen(page, 'audit-csp-portal', /^Result/)).toBe('ok');
});

test('DNS zones: Issues are on screen', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#dns');
  expect(await cellOnScreen(page, 'dns-zones', /^Issues/)).toBe('ok');
});

test('a phone table shows each row as a block headed by its name, and swipes nowhere', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#network');
  const table = page.locator('[data-panel-id="network-exhaustion"] table').first();
  await expect(table).toBeAttached({ timeout: 20_000 });
  await page.waitForTimeout(300);
  const shape = await table.evaluate((t) => {
    const box = t.parentElement as HTMLElement;
    const row = t.querySelector('tbody tr') as HTMLElement;
    const cells = [...row.children] as HTMLElement[];
    const top = cells.reduce((a, c) => (c.getBoundingClientRect().top < a.getBoundingClientRect().top ? c : a));
    return {
      swipes: box.scrollWidth > box.clientWidth + 1,
      stacked: cells.length > 1 && cells[1].getBoundingClientRect().top > cells[0].getBoundingClientRect().top - 1
        && new Set(cells.map((c) => Math.round(c.getBoundingClientRect().left))).size < cells.length,
      heading: (top.textContent || '').trim(),
      labelled: cells.some((c) => /^Status:?/i.test((c.textContent || '').trim())),
    };
  });
  expect(shape.swipes, 'the table still swipes sideways').toBe(false);
  expect(shape.stacked, 'the cells still sit side by side').toBe(true);
  expect(shape.heading, 'the block should start with the subnet').toMatch(/^\d+\.\d+\.\d+\.\d+/);
  expect(shape.labelled, 'a value should carry its column name').toBe(true);
});

test('a phone table with sortable columns offers a Sort by picker that sorts', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#network');
  const panel = page.locator('[data-panel-id="network-exhaustion"]');
  const picker = panel.getByLabel('Sort by');
  await expect(picker).toBeVisible({ timeout: 20_000 });
  const first = () => panel.locator('tbody tr').first().locator('td').first().innerText();
  await picker.selectOption({ label: 'Network, lowest first' });
  const asc = await first();
  await picker.selectOption({ label: 'Network, highest first' });
  await expect.poll(first).not.toBe(asc);
});

// Codex review of r2a. A button that fills a cell (Incidents' action, holding
// the action's whole title) was kept at its full width, so a long title ran off
// the phone and was cut. It wraps to the row's width and stays 44px tall.
test('Incidents: a long action title wraps inside the phone screen', async ({ page }) => {
  await installBaselineWorld(page);
  const title = 'Investigate repeated lookups of a-very-long-suspicious-domain-name-that-never-ends.example.com from the branch office printers';
  await page.route('**/api/actions*', (r) => (new URL(r.request().url()).pathname === '/api/actions'
    ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, availability: 'ok', actions: [{ id: 'long-1', title, priority: 'high', status: 'active', type: 'investigation', last_activity: new Date().toISOString() }] }) })
    : r.fallback()));
  await page.goto('/#incidents');
  const btn = page.locator('[data-panel-id="incidents-soc-queue"] tbody button', { hasText: 'Investigate repeated' }).first();
  await expect(btn).toBeAttached({ timeout: 20_000 });
  await btn.scrollIntoViewIfNeeded();
  const box = await btn.boundingBox();
  const panel = await page.locator('[data-panel-id="incidents-soc-queue"]').boundingBox();
  expect(box!.x + box!.width, 'the action runs past its panel').toBeLessThanOrEqual(panel!.x + panel!.width);
  expect(box!.x + box!.width, 'the action runs off the screen').toBeLessThanOrEqual(390);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(await btn.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'the title is cut off').toBe(true);
});

// Codex review of r2a. Daily's DNS issues rows carry a rowLabel (the zone), and
// the row button already says it; the phone heading showed the issue count.
test('Daily DNS issues: each phone block is headed by its zone, as its button names it', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#daily');
  const row = page.locator('[data-panel-id="daily-dns-zone-issues"] tbody tr').first();
  await expect(row).toBeAttached({ timeout: 20_000 });
  const name = (await row.locator('[data-row-open]').getAttribute('aria-label'))!.replace('View details for ', '');
  await expect(row.locator('[data-dt-head]')).toHaveText(name);
});
