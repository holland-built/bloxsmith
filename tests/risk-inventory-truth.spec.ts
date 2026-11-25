import { test, expect } from './fixtures';
import { dataPayload, installBaselineWorld } from './page-fixtures';

// GUI audit round 1, job w3b (2026-11-25): Risk and Inventory pages must not
// show a failed read as zero, as "none found", or under another panel's name,
// and their panel headers must fit on a phone.

type Page = import('@playwright/test').Page;
type Box = { x: number; y: number; width: number; height: number };

// A request that failed outright, the way the audit's fail state did it.
const fail = (page: Page, glob: string) =>
  page.route(glob, (r) => r.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"upstream timeout"}' }));

const panel = (page: Page, id: string) => page.locator(`[data-panel-id="${id}"]`);

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;

test.describe('Security', () => {
  test('review 3: a failed exposed-surface request gives its reason, not just "unavailable"', async ({ page }) => {
    await installBaselineWorld(page);
    await fail(page, '**/api/csp/exposed-hostnames*');
    await fail(page, '**/api/csp/exposed-ips*');
    await page.goto('/#security');
    const card = panel(page, 'security-exposed-surface');
    await expect(card.getByText('Exposed surface information is unavailable')).toBeVisible();
    await expect(card.getByText('upstream timeout')).toBeVisible();
  });

  test('C1: exposed surface says unavailable, never "none found", when both requests fail', async ({ page }) => {
    await installBaselineWorld(page);
    await fail(page, '**/api/csp/exposed-hostnames*');
    await fail(page, '**/api/csp/exposed-ips*');
    await page.goto('/#security');
    const card = panel(page, 'security-exposed-surface');
    await expect(card.getByText(/unavailable/i).first()).toBeVisible();
    await expect(card.getByText('No hostnames found')).toHaveCount(0);
    await expect(card.getByText('No IP addresses found')).toHaveCount(0);
    await expect(card.getByText(/\b0 hostnames\b|\b0 IPs\b|of 0\b/)).toHaveCount(0);
  });

  test('C6: the severity filter is a named group of toggle buttons that fits on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installBaselineWorld(page);
    await page.goto('/#security');
    const card = panel(page, 'security-triage-inbox');
    const group = card.getByRole('group', { name: 'Show by severity' });
    await expect(group).toBeVisible();
    const buttons = group.getByRole('button');
    await expect(buttons).toHaveCount(5);
    await expect(group.getByRole('button', { name: 'all', pressed: true })).toBeVisible();
    const cardBox = (await card.boundingBox())!;
    for (const b of await buttons.all()) {
      await expect(b).toHaveAttribute('type', 'button');
      await expect(b).toHaveAttribute('aria-pressed', /^(true|false)$/);
      const box = (await b.boundingBox())!;
      expect(box.height, 'filter buttons are at least 24px tall').toBeGreaterThanOrEqual(24);
      expect(box.x + box.width, 'filter buttons stay inside the panel').toBeLessThanOrEqual(cardBox.x + cardBox.width);
    }
    await group.getByRole('button', { name: 'high' }).click();
    await expect(group.getByRole('button', { name: 'high', pressed: true })).toBeVisible();
    await expect(group.getByRole('button', { name: 'all', pressed: false })).toBeVisible();
  });

  test('C11: threat events by hour gives one total in the header, legend and note', async ({ page }) => {
    await installBaselineWorld(page);
    await page.goto('/#security');
    const card = panel(page, 'security-threat-events');
    await expect(card.locator('.recharts-surface, svg').first()).toBeVisible();
    const legend = await card.locator('div.gap-x-4 b').allTextContents();
    const legendTotal = legend.reduce((n, t) => n + Number(t.replace(/,/g, '')), 0);
    const head = (await card.getByText(/^[\d,]+ (of [\d,]+ )?events?$/).first().textContent())!.trim();
    const headTotal = Number(head.replace(/^([\d,]+ of )?([\d,]+).*$/, '$2').replace(/,/g, ''));
    expect(headTotal, `header "${head}" vs legend ${legendTotal}`).toBe(legendTotal);
    const note = await card.getByText(/^Showing the newest/).textContent();
    expect(note).toContain(` of ${legendTotal.toLocaleString()} `);
  });
});

test.describe('Incidents', () => {
  test('review 1: a failed incidents read shows no count beside the triage error', async ({ page }) => {
    await installBaselineWorld(page);
    await fail(page, '**/api/incidents*');
    await page.goto('/#incidents');
    const card = panel(page, 'incidents-triage');
    await expect(card.getByText('Incidents information is unavailable')).toBeVisible();
    await expect(card.locator('[data-triage-count]')).toHaveCount(0);
  });

  test('C2: a failed incidents read draws no dash tiles under the error', async ({ page }) => {
    await installBaselineWorld(page);
    await fail(page, '**/api/incidents*');
    await page.goto('/#incidents');
    const card = panel(page, 'incidents-severity');
    await expect(card.getByText('Severity counts unavailable')).toBeVisible();
    await expect(card.locator('.ov-kpi')).toHaveCount(0);
  });

  test('C10: a failed action read is named "Action volume", not another panel', async ({ page }) => {
    await installBaselineWorld(page);
    await fail(page, '**/api/actions*');
    await page.goto('/#incidents');
    const card = panel(page, 'incidents-action-volume');
    await expect(card.getByText('Action volume is unavailable')).toBeVisible();
    await expect(card.getByText(/suggested actions are unavailable/i)).toHaveCount(0);
  });

  test('C5: the triage header fits on a phone without squashing its buttons', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installBaselineWorld(page);
    await page.goto('/#incidents');
    const card = panel(page, 'incidents-triage');
    const clear = card.getByRole('button', { name: 'Clear seen marks' });
    await expect(clear).toBeVisible();
    const c = (await clear.boundingBox())!;
    expect(c.height, '"Clear seen marks" stays on one line').toBeLessThan(40);
    const cardBox = (await card.boundingBox())!;
    for (const other of [card.getByRole('button', { name: /^About/ }), card.getByRole('button', { name: /^Options/ }), card.getByLabel('Filter incidents')]) {
      const o = (await other.boundingBox())!;
      expect(overlaps(c, o), 'the button does not run into its neighbours').toBe(false);
    }
    const count = card.locator('[data-triage-count]');
    const n = (await count.boundingBox())!;
    expect(n.width, 'the count is not squashed').toBeGreaterThan(4);
    expect(n.x + n.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
    expect(c.x + c.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
  });
});

test.describe('Panel header', () => {
  test('C5: on a phone a short-title panel puts its controls below the title, clear of the ⓘ and ⋯ buttons', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installBaselineWorld(page);
    await page.goto('/#incidents');
    const card = panel(page, 'incidents-triage');
    const title = card.getByRole('heading', { name: 'Triage' });
    await expect(title).toBeVisible();
    const t = (await title.boundingBox())!;
    const about = (await card.getByRole('button', { name: /^About/ }).boundingBox())!;
    const menu = (await card.getByRole('button', { name: /^Options/ }).boundingBox())!;
    for (const control of [card.getByLabel('Filter incidents'), card.getByRole('button', { name: 'Clear seen marks' })]) {
      const c = (await control.boundingBox())!;
      expect(c.y, 'the control is on a line below the title').toBeGreaterThanOrEqual(t.y + t.height - 1);
      expect(overlaps(c, about) || overlaps(c, menu), 'the control is clear of the ⓘ and ⋯ buttons').toBe(false);
    }
  });
});

test.describe('Audit', () => {
  test('C9: no "0 recorded events" beside a failed audit log read', async ({ page }) => {
    await installBaselineWorld(page);
    await fail(page, '**/api/audit/log*');
    await page.goto('/#audit');
    const card = panel(page, 'audit-activity-summary');
    await expect(card.getByText('Audit log unavailable')).toBeVisible();
    await expect(card.getByText(/recorded events?/)).toHaveCount(0);
  });
});

test.describe('Changes', () => {
  test('C13: the row limit and the tile lines use plain words', async ({ page }) => {
    await installBaselineWorld(page);
    await page.goto('/#changes');
    const cap = page.locator('[data-changes-cap]');
    await expect(cap).toContainText("Based on the newest 500 changes; older ones weren't checked");
    await expect(page.getByText('older rows not read')).toHaveCount(0);
    await expect(page.getByText(/Only the 500 most recent/)).toHaveCount(0);
  });

  test('C13: a failed read names no time window the header does not show', async ({ page }) => {
    await installBaselineWorld(page);
    await fail(page, '**/api/csp-audit*');
    await page.goto('/#changes');
    await expect(page.locator('[data-feed-unavailable]').first()).toBeVisible();
    await expect(page.locator('main').getByText(/24 hours/)).toHaveCount(0);
  });

  // The phone list now stacks each change into lines (round 2 phone job), so
  // nothing is off to the right: no sideways swipe, so no edge fade.
  test('C3: on a phone the changes list fits the screen, so it neither swipes nor fades', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installBaselineWorld(page);
    await page.goto('/#changes');
    const scroller = page.getByRole('table', { name: 'Changed objects, grouped by resource' });
    await expect(scroller).toBeVisible();
    const fade = () => scroller.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--scroll-cue-end')) || 0);
    expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await expect.poll(fade, { message: 'no fade when nothing is off to the right' }).toBe(0);
  });
});

test.describe('DNS', () => {
  test('review 2: when only some failed-lookup reads fail, the panel still says why, with Try again', async ({ page }) => {
    await installBaselineWorld(page);
    await page.route('**/api/csp/dns-failures*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      status: 'partial', window: 'today', source: 'failure_records', total: 1290,
      codes: { nxdomain: 1200, servfail: 40, refused: 45, other: 5 }, codes_status: 'ok',
      names: null, names_status: 'error',
    }) }));
    await page.goto('/#dns');
    const card = panel(page, 'dns-failed-lookups');
    await expect(card.locator('[data-failed-total] dd')).toHaveText('1,290');
    await expect(card.locator('[data-failed-names]')).toHaveText('not checked');
    const line = card.locator('[data-panel-failed]');
    await expect(line).toContainText("Couldn't read some of these numbers from Infoblox.");
    await expect(line.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('B2: a failed failed-lookups request says why once, with Try again, and shows no numbers under it', async ({ page }) => {
    await installBaselineWorld(page);
    let down = true;
    await page.route('**/api/csp/dns-failures*', (r) => (down ? r.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"upstream timeout"}' }) : r.fallback()));
    await page.goto('/#dns');
    const card = panel(page, 'dns-failed-lookups');
    // The whole read failed, so no numbers are drawn under the line (GUI audit round 2, B2).
    await expect(card.locator('[data-panel-failed]')).toBeVisible();
    await expect(card.locator('[data-failed-total]')).toHaveCount(0);
    const line = card.locator('[data-panel-failed]');
    await expect(line).toHaveCount(1);
    await expect(line).toContainText("Couldn't read these numbers from Infoblox.");
    down = false;
    await line.getByRole('button', { name: 'Try again' }).click();
    await expect(card.locator('[data-failed-total] dd')).not.toHaveText('not checked');
    await expect(card.locator('[data-panel-failed]')).toHaveCount(0);
  });

  test('B2: a failed zone list shows a dash, not "0 zones"', async ({ page }) => {
    await installBaselineWorld(page);
    await fail(page, '**/api/data*');
    await page.goto('/#dns');
    const card = panel(page, 'dns-zones');
    await expect(card.locator('[data-feed-unavailable]')).toBeVisible();
    await expect(card.getByText(/^0 zones$/)).toHaveCount(0);
    await expect(card.getByText(/^— zones$/)).toBeVisible();
  });

  test('B11: the zone problems panel has a title, also when its read fails', async ({ page }) => {
    await installBaselineWorld(page);
    await page.goto('/#dns');
    await expect(panel(page, 'dns-zone-kpis').getByRole('heading', { name: 'Zone problems' })).toBeVisible();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await installBaselineWorld(page);
    await fail(page, '**/api/data*');
    await page.reload();
    const card = panel(page, 'dns-zone-kpis');
    await expect(card.locator('[data-feed-unavailable]')).toBeVisible();
    await expect(card.getByRole('heading', { name: 'Zone problems' })).toBeVisible();
  });
});

test.describe('Network', () => {
  test('review 2: when only some DHCP request reads fail, the panel still says why, with Try again', async ({ page }) => {
    // The baseline world has one of the four totals failed.
    await installBaselineWorld(page);
    await page.goto('/#network');
    const card = panel(page, 'network-dhcp-requests');
    await expect(card.locator('[data-dhcp-request][data-state="error"] dd')).toHaveText('not checked');
    const line = card.locator('[data-panel-failed]');
    await expect(line).toContainText("Couldn't read some of these numbers from Infoblox.");
    await expect(line.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('B2: a failed DHCP requests read says why once, with Try again, and shows no numbers under it', async ({ page }) => {
    await installBaselineWorld(page);
    let down = true;
    await page.route('**/api/csp/dhcp-requests*', (r) => (down ? r.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"upstream timeout"}' }) : r.fallback()));
    await page.goto('/#network');
    const card = panel(page, 'network-dhcp-requests');
    // The whole read failed, so no numbers are drawn under the line (GUI audit round 2, B2).
    await expect(card.locator('[data-panel-failed]')).toBeVisible();
    await expect(card.locator('[data-dhcp-request]')).toHaveCount(0);
    const line = card.locator('[data-panel-failed]');
    await expect(line).toHaveCount(1);
    await expect(line).toContainText("Couldn't read these numbers from Infoblox.");
    down = false;
    await line.getByRole('button', { name: 'Try again' }).click();
    // The answer now arrives; the baseline world still has one of the four
    // totals failed, so the line stays, naming only some of the numbers.
    await expect(card.locator('[data-dhcp-request] dd').first()).toHaveText('4,200');
    await expect(line).toContainText("Couldn't read some of these numbers from Infoblox.");
  });

  test('B2: a failed lease list shows a dash, not "0 of 0"', async ({ page }) => {
    await installBaselineWorld(page);
    await fail(page, '**/api/csp/dhcp-leases*');
    await page.goto('/#network');
    const card = panel(page, 'network-dhcp-leases');
    await expect(card.locator('[data-feed-unavailable]')).toBeVisible();
    await expect(card.getByText(/^0 of 0$/)).toHaveCount(0);
    await expect(card.getByText(/^—$/)).toBeVisible();
  });

  test('B6: a failed overlaps request shows the request error, not "couldn\'t read every subnet"', async ({ page }) => {
    await installBaselineWorld(page);
    await fail(page, '**/api/ipam/overlaps*');
    await page.goto('/#network');
    const card = panel(page, 'network-overlaps');
    await expect(card.locator('[data-feed-unavailable]')).toBeVisible();
    await expect(card.getByText(/Couldn't read every subnet/)).toHaveCount(0);
    // The request's own reason, as the shared unavailable message shows it.
    await expect(card.getByText(/upstream timeout/)).toBeVisible();
  });

  test('B6 guard: a partial read still says the list could be wrong', async ({ page }) => {
    await installBaselineWorld(page);
    await page.route('**/api/ipam/overlaps*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'partial', groups: [] }) }));
    await page.goto('/#network');
    await expect(panel(page, 'network-overlaps').getByText(/Couldn't read every subnet/)).toBeVisible();
  });

  test('B15: on a phone the lease count sits with the controls, not alone left of the search', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installBaselineWorld(page);
    await page.goto('/#network');
    const card = panel(page, 'network-dhcp-leases');
    const count = card.getByText(/^\d+ of \d+$/);
    await expect(count).toBeVisible();
    const n = (await count.boundingBox())!;
    const s = (await card.getByLabel('Search address, hostname, MAC').boundingBox())!;
    expect(n.y, 'the count is not on the search box line').toBeGreaterThanOrEqual(s.y + s.height - 1);
  });
});

test.describe('Infra', () => {
  test('B8: host status chips use the same words as the legend and headline', async ({ page }) => {
    await installBaselineWorld(page);
    await page.goto('/#infra');
    const table = panel(page, 'infra-host-inventory');
    await expect(table.getByText('baseline-host-c')).toBeVisible();
    const chips = (await table.locator('tbody td span.rounded-full').allTextContents()).map((t) => t.trim());
    expect(chips.sort()).toEqual(['Active', 'Not online', 'Review']);
    const legend = panel(page, 'infra-host-status');
    for (const w of ['Active', 'Review', 'Not online']) await expect(legend.getByText(w, { exact: true })).toBeVisible();
  });

  test('B8 follow-up: a status that only contains a healthy word is never counted Active', async ({ page }) => {
    const payload = structuredClone(dataPayload()) as { hosts: Array<Record<string, string>> };
    payload.hosts = [
      { id: 'h1', ip: '10.0.0.1', name: 'host-setup', status: 'Setup failed', type: 'onprem' },
      { id: 'h2', ip: '10.0.0.2', name: 'host-inactive', status: 'Inactive', type: 'onprem' },
      { id: 'h3', ip: '10.0.0.3', name: 'host-online', status: 'online', type: 'onprem' },
    ];
    await installBaselineWorld(page);
    await page.route('**/api/data', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) }));
    await page.goto('/#infra');
    const donut = panel(page, 'infra-host-status');
    await expect(donut.getByText('Not online', { exact: true })).toBeVisible();
    // One healthy host of three: Active is a third, the other two are not online.
    await expect(donut).toContainText(/Active\s*33%/);
    await expect(donut).toContainText(/Not online\s*67%/);
    await expect(page.getByRole('list', { name: 'Headline numbers' }).getByRole('button', { name: /^Not online\b/ })).toHaveAccessibleName(/ 2$/);
  });
});
