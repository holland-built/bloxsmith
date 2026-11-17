import { test, expect } from './fixtures';
import { installBaselineWorld, openTask } from './page-fixtures';

// Every preview that suggests a network or address says what it checked and
// why it passed over anything (ui/src/components/CheckedAgainst.jsx, worded by
// ui/src/lib/checkedWords.js). The server sends `checked` and `skipped` (or
// `skipped_picks` on site, block and seed results) from go/internal/freecheck.

const json = (route: import('@playwright/test').Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const sse = (...frames: unknown[]) => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');

const CHECKED = { spaces: 3, networks: 40, ranges: 14, reservations: 200, hosts: 12, read_at: '2026-11-17T10:00:00Z', age_seconds: 40 };
const SKIP = { candidate: '10.16.8.0/24', reason: 'a DHCP range in corp-amer already uses 10.16.8.10 to 10.16.8.200' };
const LINE = 'Checked against: networks in 3 IP spaces, 14 DHCP ranges, 212 reservations and hosts. Checked 40 seconds ago.';
const WHY = 'Skipped 10.16.8.0/24 because a DHCP range in corp-amer already uses 10.16.8.10 to 10.16.8.200.';

async function expectChecked(scope: import('@playwright/test').Locator) {
  const box = scope.locator('[data-checked-against]');
  await expect(box).toContainText(LINE);
  await expect(box).toContainText(WHY);
}

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/vault/write-target*', (route) =>
    json(route, { known: true, tenant: 't/-', label: 'Test Tenant', writable: true }));
});

test('Provision subnet preview says what it checked and what it skipped', async ({ page }) => {
  await page.route('**/api/desk/spaces*', (route) => route.fulfill({ status: 404, body: '{}' }));
  await page.route('**/api/provision/stream*', (route) => route.fulfill({ status: 200, contentType: 'text/event-stream',
    body: sse({ step: 'Resolving block…' }, { done: true, subnet: { id: null, address: '10.16.9.0', cidr: 24 }, checked: CHECKED, skipped: [SKIP] }) }));
  await page.goto('/#provision');
  await page.getByRole('button', { name: 'Subnet', exact: true }).click();
  await page.getByRole('combobox').first().selectOption({ label: 'Baseline Space' });
  await page.getByRole('button', { name: 'Preview', exact: true }).first().click();
  await expectChecked(page.locator('[data-panel-id="provision-subnet-request"]'));
});

test('Provision seed preview lists the first 3 skips and says how many more', async ({ page }) => {
  const picks = Array.from({ length: 5 }, (_, i) => ({ candidate: `10.9.${i}.0/24`, reason: 'a subnet in lab already uses it' }));
  await page.route('**/api/provision/seed-demo/stream*', (route) => route.fulfill({ status: 200, contentType: 'text/event-stream',
    body: sse({ done: true, succeeded: 1, failed: 0, skipped: 0, total: 1, checked: CHECKED, skipped_picks: picks }) }));
  await page.goto('/#provision');
  await page.getByRole('button', { name: 'Seed demo', exact: true }).click();
  await page.getByRole('button', { name: 'Preview', exact: true }).first().click();
  const box = page.locator('[data-checked-against]');
  await expect(box).toContainText(LINE);
  await expect(box).toContainText('Skipped 10.9.2.0/24 because a subnet in lab already uses it.');
  await expect(box).not.toContainText('10.9.3.0/24');
  await expect(box).toContainText('And 2 more.');
});

test('Automate: Get an IP address preview says what it checked and what it skipped', async ({ page }) => {
  await page.route('**/api/desk/runs', (route) => json(route, { runs: [] }));
  await page.route('**/api/desk/spaces', (route) => json(route, { spaces: [
    { id: 'ipam/ip_space/a', name: 'Amsterdam Lab', yours: false, reason: '250 of 256 addresses free' } ] }));
  await page.route('**/api/ipam/subnets*', (route) => json(route, { subnets: [
    { id: 'ipam/subnet/s2', address: '10.16.8.0', cidr: 24, name: 'office-b' } ] }));
  await page.route('**/api/desk/run', (route) =>
    json(route, { ok: true, dry_run: true, addresses: [{ address: '10.16.8.201' }], checked: CHECKED, skipped: [SKIP] }));
  await page.goto('/#automate');
  const job = page.locator('[data-panel-id="automate-job"]');
  await job.getByRole('combobox', { name: 'IP space' }).selectOption('ipam/ip_space/a');
  await job.getByRole('combobox', { name: 'Network' }).selectOption('ipam/subnet/s2');
  await job.getByRole('button', { name: 'Preview' }).click();
  await expectChecked(job.locator('[data-desk-preview]'));
});

test('Editor: a subnet create preview says what it checked and what it skipped', async ({ page }) => {
  await page.route('**/api/edit/subnet', (route) =>
    json(route, { ok: true, dry_run: true, would_create: { address: '10.16.9.0', cidr: 24 }, checked: CHECKED, skipped: [SKIP] }));
  await page.goto('/#editor?type=subnet');
  await page.getByRole('textbox', { name: 'Address block ID *' }).fill('ipam/address_block/9');
  await page.getByRole('spinbutton', { name: 'How many devices need an address? *' }).fill('200');
  await page.getByRole('button', { name: 'Preview' }).first().click();
  await expectChecked(page.locator('[data-editor-result]'));
});

test('Get an address: the preview says what it checked, and a fresh read gives no age', async ({ page }) => {
  await page.route('**/api/desk/spaces*', (route) => route.fulfill({ status: 404, body: '{}' }));
  await page.route('**/api/ipam/spaces*', (r) => json(r, { spaces: [{ id: 'ipam/ip_space/1', name: 'acme-systems' }] }));
  await page.route('**/api/ipam/blocks*', (r) => json(r, { blocks: [] }));
  await page.route('**/api/ipam/subnets*', (r) =>
    json(r, { subnets: [{ id: 'ipam/subnet/1', address: '10.0.42.0', cidr: 24, name: 'site-42', utilization: { free: 200 } }] }));
  await page.route('**/api/selfservice/allocate', (r) => json(r, { ok: true, dry_run: true, addresses: [{ address: '10.0.42.7' }],
    checked: { ...CHECKED, networks: 0, age_seconds: 1 },
    skipped: [{ candidate: '10.0.42.5', reason: 'a reservation in acme-systems already uses 10.0.42.5' }] }));
  await page.goto('/#selfservice');
  const panel = await openTask(page, 'address');
  await panel.getByRole('combobox', { name: 'IP Space' }).selectOption('ipam/ip_space/1');
  await panel.getByRole('button', { name: 'Preview' }).click();
  const box = panel.locator('[data-checked-against]');
  await expect(box).toContainText('Checked against: 14 DHCP ranges, 212 reservations and hosts.');
  await expect(box).not.toContainText('ago');
  await expect(box).toContainText('Skipped 10.0.42.5 because a reservation in acme-systems already uses 10.0.42.5.');
});

// A network or address that something only in ANOTHER IP space uses is offered
// with an amber warning under it (go/internal/freecheck Warning), and the
// checked line counts it as shared.
const LAB_TAIL = "That's fine if the two spaces are kept apart, like a separate lab. If devices in one can reach the other,";

test('Provision subnet preview warns when another IP space also uses the network', async ({ page }) => {
  await page.route('**/api/desk/spaces*', (route) => route.fulfill({ status: 404, body: '{}' }));
  await page.route('**/api/provision/stream*', (route) => route.fulfill({ status: 200, contentType: 'text/event-stream',
    body: sse({ step: 'Resolving block…' }, { done: true, subnet: { id: null, address: '10.4.0.0', cidr: 24 },
      checked: { ...CHECKED, shared: 1 }, skipped: [],
      warnings: [{ candidate: '10.4.0.0/24', space: 'default-TK-lab', object: '10.0.0.0/8', kind: 'address block', contains: true }] }) }));
  await page.goto('/#provision');
  await page.getByRole('button', { name: 'Subnet', exact: true }).click();
  await page.getByRole('combobox').first().selectOption({ label: 'Baseline Space' });
  await page.getByRole('button', { name: 'Preview', exact: true }).first().click();
  const panel = page.locator('[data-panel-id="provision-subnet-request"]');
  const warn = panel.locator('[data-shared-warning]');
  await expect(warn).toHaveText('Also used in another IP space. 10.4.0.0/24 sits inside 10.0.0.0/8 in IP space default-TK-lab. ' +
    `${LAB_TAIL} pick a different network.`);
  await expect(warn).toHaveClass(/text-warn/);
  await expect(panel.locator('[data-checked-against]')).toContainText(
    'Checked against: networks in 3 IP spaces, 14 DHCP ranges, 212 reservations and hosts, 1 shared with other IP spaces.');
});

test('Get an address preview warns when another IP space also uses the address', async ({ page }) => {
  await page.route('**/api/desk/spaces*', (route) => route.fulfill({ status: 404, body: '{}' }));
  await page.route('**/api/ipam/spaces*', (r) => json(r, { spaces: [{ id: 'ipam/ip_space/1', name: 'acme-systems' }] }));
  await page.route('**/api/ipam/blocks*', (r) => json(r, { blocks: [] }));
  await page.route('**/api/ipam/subnets*', (r) =>
    json(r, { subnets: [{ id: 'ipam/subnet/1', address: '10.0.42.0', cidr: 24, name: 'site-42', utilization: { free: 200 } }] }));
  await page.route('**/api/selfservice/allocate', (r) => json(r, { ok: true, dry_run: true, addresses: [{ address: '10.0.42.7' }],
    checked: { ...CHECKED, networks: 0, age_seconds: 1, shared: 1 }, skipped: [],
    warnings: [
      { candidate: '10.0.42.7', space: 'lab', object: '10.0.42.1 to 10.0.42.99', kind: 'DHCP range', contains: true },
      { candidate: '10.0.42.7', space: 'dev', object: '10.0.42.7', kind: 'reservation', contains: true },
    ] }));
  await page.goto('/#selfservice');
  const panel = await openTask(page, 'address');
  await panel.getByRole('combobox', { name: 'IP Space' }).selectOption('ipam/ip_space/1');
  await panel.getByRole('button', { name: 'Preview' }).click();
  await expect(panel.locator('[data-shared-warning]')).toHaveText('Also used in another IP space. 10.0.42.7 sits inside ' +
    `10.0.42.1 to 10.0.42.99 and 10.0.42.7 in IP spaces lab and dev. ${LAB_TAIL} pick a different address.`);
  await expect(panel.locator('[data-checked-against]')).toContainText(
    'Checked against: 14 DHCP ranges, 212 reservations and hosts, 1 shared with other IP spaces.');
});
