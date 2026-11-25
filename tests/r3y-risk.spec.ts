import { test, expect, type Page } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// GUI audit round 3, job r3y: the Risk pages (Security, Incidents, Audit,
// Changes) and the phone Sort by picker. Each test names the finding it pins.
// Every page is served from the fixed baseline world, so nothing here reaches
// a tenant.

test.use({ timezoneId: 'UTC', locale: 'en-US' });

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

const panel = (page: Page, id: string) => page.locator(`[data-panel-id="${id}"]`);

test('R3-C1: on a phone the Changes list flows with the page, so the deleted record is reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#changes');
  const feed = page.getByRole('table', { name: /Changed objects/ });
  const deleted = feed.locator('[data-flag="deleted"]');
  await expect(deleted).toHaveCount(1);
  // No box of its own that scrolls up and down and hides rows below its edge.
  expect(await feed.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  // Scrolled to, the deleted row is on screen and not clipped by the list.
  await deleted.scrollIntoViewIfNeeded();
  await expect(deleted).toBeInViewport();
  const f = (await feed.boundingBox())!;
  const d = (await deleted.boundingBox())!;
  expect(d.y + d.height).toBeLessThanOrEqual(f.y + f.height + 1);
});

test('R2-C1: Block shows on the logged row without hovering, on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#security');
  const logged = panel(page, 'security-triage-inbox').getByRole('row').filter({ hasText: 'watch.baseline.example' });
  await page.mouse.move(0, 0);
  await expect(logged.getByRole('button', { name: 'Block' })).toHaveCSS('opacity', '1');
});

test('R3-C2: Security numbers agree, and the unreviewed figure says it counts the listed rows', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#security');
  const summary = panel(page, 'security-response-summary');
  const hero = panel(page, 'security-threat-events');
  await expect(summary).toContainText('Total events');
  const total = await summary.getByText('Total events', { exact: true }).locator('xpath=following-sibling::div[1]').innerText();
  // The hour chart's count is the same number as Total events.
  await expect(hero).toContainText(`${total} events`);
  // Unreviewed critical is worked out from the listed rows only, and says so.
  await expect(summary).toContainText(/Critical, not yet reviewed, of the 2 listed/);
});

test('R3-C3: on a phone each suggested action starts with its name, then its state and Resolve', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#incidents');
  const queue = panel(page, 'incidents-soc-queue');
  const row = queue.getByRole('row').filter({ hasText: 'Baseline suspicious domain' });
  const name = row.getByRole('button', { name: 'Baseline suspicious domain' });
  const resolve = row.getByRole('button', { name: 'Resolve' });
  await expect(resolve).toBeVisible();
  const n = (await name.boundingBox())!;
  const r = (await resolve.boundingBox())!;
  expect(n.y + n.height).toBeLessThanOrEqual(r.y + 1);
});

test('R3-C5: Changes and Audit call a failed change by one word', async ({ page }) => {
  await page.goto('/#changes');
  const feed = page.getByRole('table', { name: /Changed objects/ });
  await expect(feed.locator('[data-flag="failed"]')).toHaveCount(1);
  expect(await page.locator('main').innerText()).not.toMatch(/refused/i);
  await page.goto('/#audit');
  const portal = panel(page, 'audit-csp-portal');
  await expect(portal.getByRole('cell', { name: 'Failed', exact: true })).toBeVisible();
  expect(await portal.innerText()).not.toMatch(/Refused/);
});

test('R3-C7: Portal audit failure has a Try again button and no "Try again in a moment"', async ({ page }) => {
  await page.route('**/api/csp-audit**', (r) => r.fulfill({ status: 503, body: '' }));
  await page.goto('/#audit');
  const portal = panel(page, 'audit-csp-portal');
  await expect(portal.getByRole('button', { name: /Try again/ })).toBeVisible();
  expect(await portal.innerText()).not.toContain('in a moment');
});

test('C8: Audit Detail says what happened without internal ids or version tags', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#audit');
  const log = panel(page, 'audit-log');
  await expect(log.getByRole('row')).toHaveCount(6);
  const text = await log.locator('tbody').innerText();
  for (const raw of ['dns/record/', 'ipam/address_block', 'Prefix length', 'v0.0.0', 'From version']) expect(text, raw).not.toContain(raw);
  await expect(log).toContainText('Subnet: 10.10.0.0/24');
  await expect(log).toContainText('Item: DNS record');
});

test('R3-B1 R3-C4: the phone Sort by picker names the direction in words', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#audit');
  const picker = panel(page, 'audit-log').getByRole('combobox', { name: 'Sort by' });
  await expect(picker).toBeVisible();
  const labels = await picker.locator('option').allInnerTexts();
  expect(labels.join(' | ')).not.toContain('reversed');
  expect(labels).toContain('Time, newest first');
  expect(labels).toContain('Time, oldest first');
  expect(labels).toContain('Actor, A to Z');
  await expect(picker.locator('option:checked')).toHaveText('Time, newest first');
});
