import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';
import type { Page, Locator } from '@playwright/test';

// Right-clicking a network, address block, IP space, address or DNS zone name
// opens a small menu of what you can do with it (ItemMenu.jsx). Each entry
// opens a job that already exists with the details filled in, and never runs
// its Preview or Apply: these tests fail on any write-shaped request.
//
// Every /api/ answer is faked: tests/page-fixtures.ts, plus the lists below.

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

// Requests that would mean a job ran rather than just opened.
const WRITES = /\/api\/(desk\/run$|selfservice\/|edit\/(?!find)|provision|teardown|retag)/;

let writes: string[] = [];

test.beforeEach(async ({ page }) => {
  writes = [];
  await installBaselineWorld(page);
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (WRITES.test(u.pathname)) writes.push(`${r.method()} ${u.pathname}`);
  });
  await page.route('**/api/desk/spaces', (r) => r.fulfill(json({ spaces: [
    { id: 'ipam/ip_space/baseline-1', name: 'Baseline Space', yours: false, reason: '250 of 256 addresses free' },
    { id: 'ipam/ip_space/a', name: 'Corp', yours: true, reason: 'You built here before' },
  ] })));
  await page.route('**/api/ipam/subnets*', (r) => r.fulfill(json({ subnets: [
    { id: 'ipam/subnet/other', address: '10.40.0.0', cidr: 24, name: 'other', utilization: { free: 200 } },
    { id: 'ipam/subnet/baseline-3', address: '10.30.0.0', cidr: 24, name: 'baseline-net-c', utilization: { free: 5 } },
  ] })));
  await page.route('**/api/ipam/blocks*', (r) => r.fulfill(json({ blocks: [
    { id: 'ipam/address_block/other', address: '172.16.0.0', cidr: 12, name: 'other' },
    { id: 'ipam/address_block/a1', address: '10.0.0.0', cidr: 8, name: 'corp-ten' },
  ] })));
  await page.route('**/api/desk/runs', (r) => r.fulfill(json({ runs: [] })));
});

test.afterEach(() => {
  expect(writes, 'opening a job from the menu must not preview or apply anything').toEqual([]);
});

const menu = (page: Page) => page.getByRole('menu');
const names = (page: Page) => menu(page).getByRole('menuitem');

const spaceLink = (page: Page) => page.locator('a[data-item-link="space"]', { hasText: 'Baseline Space' }).first();
const networkLink = (page: Page) => page.locator('a[data-item-link="network"]', { hasText: '10.30.0.0' }).first();
const addressLink = (page: Page) => page.locator('a[data-item-link="address"]', { hasText: '10.10.0.5' }).first();
const zoneLink = (page: Page) => page.locator('a[data-item-link="zone"]', { hasText: 'baseline.example.' }).first();

async function blockLink(page: Page) {
  const panel = page.locator('[data-panel-id="network-overlaps"]');
  await panel.getByRole('button', { name: /10\.0\.0\.0\/8/ }).click();
  return panel.locator('a[data-item-link="block"]', { hasText: '10.0.0.0/8' });
}

async function rightClick(link: Locator) {
  await expect(link).toBeVisible();
  await link.click({ button: 'right' });
}

async function pick(page: Page, link: Locator, label: string) {
  await rightClick(link);
  await menu(page).getByRole('menuitem', { name: label, exact: true }).click();
}

test('right-click shows each kind its own menu', async ({ page }) => {
  await page.goto('/#network');
  await rightClick(spaceLink(page));
  await expect(names(page)).toHaveText(['Open', 'Add a network here', 'Build a site here', 'Show overlaps']);
  await page.keyboard.press('Escape');

  await rightClick(networkLink(page));
  await expect(names(page)).toHaveText(['Open', 'Get a free address', 'Reserve an address', 'Add a DHCP range', 'Edit', 'Copy']);
  await page.keyboard.press('Escape');

  await rightClick(addressLink(page));
  await expect(names(page)).toHaveText(['Open', 'Reserve it', 'Copy']);
  await page.keyboard.press('Escape');

  await rightClick(await blockLink(page));
  await expect(names(page)).toHaveText(['Open', 'Add a network inside', 'Copy']);
  await page.keyboard.press('Escape');

  await page.goto('/#dns');
  await rightClick(zoneLink(page));
  await expect(names(page)).toHaveText(['Open', 'Add a record', 'Edit', 'Copy']);
});

test('Shift+F10 opens it from the keyboard; arrows, Enter and Escape work, and Escape gives focus back', async ({ page }) => {
  await page.goto('/#network');
  const link = networkLink(page);
  await expect(link).toBeVisible();
  await link.focus();
  await page.keyboard.press('Shift+F10');
  await expect(menu(page)).toBeVisible();
  await expect(names(page).nth(0)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(names(page).nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(names(page).last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(names(page).first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(link).toBeFocused();

  // The Menu key opens it too, and Enter picks.
  await page.keyboard.press('ContextMenu');
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#automate\?job=ip&subnet=ipam%2Fsubnet%2Fbaseline-3&network=10\.30\.0\.0%2F24$/);
  await expect(menu(page)).toHaveCount(0);
});

test('a click outside closes it, Shift+right-click keeps the browser menu, and it stays inside the window', async ({ page }) => {
  await page.goto('/#network');
  const link = spaceLink(page);
  await rightClick(link);
  await expect(menu(page)).toBeVisible();
  await page.locator('h1', { hasText: 'Network' }).click();
  await expect(menu(page)).toHaveCount(0);

  const prevented = await link.evaluate((a) => {
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, shiftKey: true, clientX: 10, clientY: 10 });
    a.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(prevented).toBe(false);
  await expect(menu(page)).toHaveCount(0);

  const vp = page.viewportSize()!;
  await link.evaluate((a, { x, y }) => {
    a.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  }, { x: vp.width - 4, y: vp.height - 4 });
  const box = (await menu(page).boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
});

test('a long press opens it on a touch screen', async ({ page }) => {
  await page.goto('/#network');
  const link = spaceLink(page);
  await expect(link).toBeVisible();
  await link.evaluate((a) => {
    const r = a.getBoundingClientRect();
    a.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: r.left + 2, clientY: r.top + 2 }));
  });
  await expect(menu(page)).toBeVisible();
  await expect(names(page).first()).toHaveText('Open');
});

test('IP space: Add a network here and Build a site here open those jobs on that space', async ({ page }) => {
  await page.goto('/#network');
  await pick(page, spaceLink(page), 'Add a network here');
  await expect(page).toHaveURL(/#automate\?job=network&space=ipam%2Fip_space%2Fbaseline-1$/);
  const job = page.locator('[data-panel-id="automate-job"]');
  await expect(job).toContainText('Make a new network');
  await expect(job.getByRole('combobox', { name: 'IP space' })).toHaveValue('ipam/ip_space/baseline-1');

  await page.goto('/#network');
  await pick(page, spaceLink(page), 'Build a site here');
  await expect(job).toContainText('Set up a branch office');
  await expect(job.getByRole('combobox', { name: 'IP space' })).toHaveValue('ipam/ip_space/baseline-1');
  await expect(job.getByRole('button', { name: 'Preview' })).toBeVisible();
  await expect(job.locator('[data-desk-preview]')).toHaveCount(0);
});

test('IP space: Show overlaps lists only the ranges that space shares', async ({ page }) => {
  await page.route('**/api/ipam/overlaps', (r) => r.fulfill(json({ status: 'ok', portal: 'https://csp.infoblox.com', groups: [
    { range: '10.0.0.0/8', spaces: 2, members: [
      { id: 'ipam/ip_space/baseline-1', name: 'Baseline Space', prefixes: ['10.0.0.0/8'], ranges: [{ prefix: '10.0.0.0/8', id: 'ipam/address_block/x', kind: 'address_block' }] },
      { id: 'ipam/ip_space/b', name: 'Lab', prefixes: ['10.1.0.0/16'], ranges: [{ prefix: '10.1.0.0/16', id: 'ipam/subnet/y', kind: 'subnet' }] },
    ] },
    { range: '192.168.0.0/16', spaces: 2, members: [
      { id: 'ipam/ip_space/a', name: 'Corp', prefixes: ['192.168.0.0/16'], ranges: [{ prefix: '192.168.0.0/16', id: 'ipam/address_block/z', kind: 'address_block' }] },
      { id: 'ipam/ip_space/b', name: 'Lab', prefixes: ['192.168.1.0/24'], ranges: [{ prefix: '192.168.1.0/24', id: 'ipam/subnet/w', kind: 'subnet' }] },
    ] },
  ] })));
  await page.goto('/#network');
  const panel = page.locator('[data-panel-id="network-overlaps"]');
  await expect(panel.getByRole('button', { name: /spaces$/ })).toHaveCount(2);
  await pick(page, spaceLink(page), 'Show overlaps');
  await expect(page).toHaveURL(/#network\?overlaps=ipam%2Fip_space%2Fbaseline-1&focus=overlaps$/);
  await expect(panel.getByRole('button', { name: /spaces$/ })).toHaveCount(1);
  await expect(panel.getByRole('button', { name: /spaces$/ })).toContainText('10.0.0.0/8');
  await expect(panel).toContainText('Only ranges Baseline Space shares with another IP space.');
  await panel.getByRole('button', { name: 'Show all' }).click();
  await expect(panel.getByRole('button', { name: /spaces$/ })).toHaveCount(2);
});

test('address block: Add a network inside opens Make a new network on its space and block', async ({ page }) => {
  await page.goto('/#network');
  await pick(page, await blockLink(page), 'Add a network inside');
  await expect(page).toHaveURL(/#automate\?job=network&space=ipam%2Fip_space%2Fa&block=ipam%2Faddress_block%2Fa1$/);
  const job = page.locator('[data-panel-id="automate-job"]');
  await expect(job.getByRole('combobox', { name: 'IP space' })).toHaveValue('ipam/ip_space/a');
  await expect(job.getByRole('combobox', { name: 'Address block' })).toHaveValue('ipam/address_block/a1');

  await page.goto('/#network');
  await pick(page, await blockLink(page), 'Open');
  await expect(page).toHaveURL(/#editor\?type=address_block&id=ipam%2Faddress_block%2Fa1&q=10\.0\.0\.0$/);
});

test('network: Get a free address finds the space from the network and picks that network', async ({ page }) => {
  await page.goto('/#network');
  await pick(page, networkLink(page), 'Get a free address');
  const job = page.locator('[data-panel-id="automate-job"]');
  await expect(job).toContainText('Get an IP address');
  // The table row knew the network's id, not its space: the item lookup says Baseline Space.
  await expect(job.getByRole('combobox', { name: 'IP space' })).toHaveValue('ipam/ip_space/baseline-1');
  await expect(job.getByRole('combobox', { name: 'Network' })).toHaveValue('ipam/subnet/baseline-3');
});

test('network: Reserve an address opens Get an address on that network, locked to a device', async ({ page }) => {
  await page.goto('/#network');
  await pick(page, networkLink(page), 'Reserve an address');
  await expect(page).toHaveURL(/#selfservice\?subnet=ipam%2Fsubnet%2Fbaseline-3&network=10\.30\.0\.0%2F24&reserve=1$/);
  const panel = page.locator('[data-task="address"]');
  await expect(panel.getByRole('combobox', { name: 'IP Space' })).toHaveValue('ipam/ip_space/baseline-1');
  await expect(panel.getByRole('combobox', { name: 'Subnet' })).toHaveValue('ipam/subnet/baseline-3');
  await expect(panel.getByRole('checkbox', { name: 'Lock it to one device (DHCP reservation)' })).toBeChecked();
});

test('network: Edit and Add a DHCP range open the Editor, filled in from the item page', async ({ page }) => {
  await page.goto('/#network');
  await pick(page, networkLink(page), 'Edit');
  await expect(page).toHaveURL(/#editor\?type=subnet&id=ipam%2Fsubnet%2Fbaseline-3&q=10\.30\.0\.0$/);

  // The network's own page knows its space's id, which a DHCP range needs.
  await page.goto('/#dossier?kind=network&q=10.30.0.0%2F24&id=ipam%2Fsubnet%2Fbaseline-3');
  const item = page.locator('[data-item-page="network"]');
  await expect(item.locator('[data-item-details]')).toContainText('baseline-net-c');
  await item.getByRole('link', { name: 'Add a DHCP range' }).click();
  await expect(page).toHaveURL(/#editor\?type=dhcp_range&space=ipam%2Fip_space%2Fbaseline-1&subnet=ipam%2Fsubnet%2Fbaseline-3&network=10\.30\.0\.0%2F24$/);
  await expect(page.getByRole('textbox', { name: 'IP Space' })).toHaveValue('ipam/ip_space/baseline-1');
});

test('address: Reserve it opens a new host in the Editor with the address filled in', async ({ page }) => {
  await page.goto('/#network');
  await pick(page, addressLink(page), 'Reserve it');
  await expect(page).toHaveURL(/#editor\?type=host&addresses=10\.10\.0\.5$/);
  await expect(page.getByRole('textbox', { name: /Addresses/ })).toHaveValue('10.10.0.5');
});

test('DNS zone: Add a record opens Add a DNS name with the zone picked; Edit opens the Editor', async ({ page }) => {
  await page.goto('/#dns');
  await pick(page, zoneLink(page), 'Add a record');
  await expect(page).toHaveURL(/#automate\?job=dns&zone=baseline\.example&zone_id=dns%2Fauth_zone%2Fbaseline-1$/);
  const job = page.locator('[data-panel-id="automate-job"]');
  await expect(job).toContainText('Add a DNS name');
  await expect(job.getByRole('combobox', { name: 'Zone' })).toHaveValue('dns/auth_zone/baseline-1');

  await page.goto('/#dns');
  await pick(page, zoneLink(page), 'Edit');
  await expect(page).toHaveURL(/#editor\?type=dns_zone&id=dns%2Fauth_zone%2Fbaseline-1&q=baseline\.example$/);
});

test('Copy puts the name on the clipboard and says Copied', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/#network');
  await rightClick(networkLink(page));
  await menu(page).getByRole('menuitem', { name: 'Copy' }).click();
  await expect(menu(page).getByRole('menuitem', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('10.30.0.0/24');
  await expect(menu(page)).toHaveCount(0);
  await expect(networkLink(page)).toBeFocused();
});

// A link's prefill belongs to that link. Going on to the plain page takes back
// what it filled in, but not what the person picked or typed since, and going
// back to the link fills it in again.
const setHash = (page: Page, h: string) => page.evaluate((x) => { location.hash = x; }, h);

test('Automate: a plain visit after a prefilled link clears the prefill, keeps what was typed, and the link works again', async ({ page }) => {
  await page.goto('/#automate?job=network&space=ipam%2Fip_space%2Fa&block=ipam%2Faddress_block%2Fa1');
  const job = page.locator('[data-panel-id="automate-job"]');
  const space = job.getByRole('combobox', { name: 'IP space' });
  await expect(space).toHaveValue('ipam/ip_space/a');
  await expect(job.getByRole('combobox', { name: 'Address block' })).toHaveValue('ipam/address_block/a1');
  await job.getByRole('textbox', { name: /Name/ }).fill('lab-1');

  await setHash(page, '#automate');
  await expect(space).toHaveValue('');
  await expect(job.getByRole('combobox', { name: 'Address block' })).toHaveValue('');
  await expect(job.getByRole('textbox', { name: /Name/ })).toHaveValue('lab-1');

  await setHash(page, '#automate?job=network&space=ipam%2Fip_space%2Fa&block=ipam%2Faddress_block%2Fa1');
  await expect(space).toHaveValue('ipam/ip_space/a');
  await expect(job.getByRole('combobox', { name: 'Address block' })).toHaveValue('ipam/address_block/a1');
});

test('Automate: a space picked by hand after the prefill stays when the prefill goes', async ({ page }) => {
  await page.goto('/#automate?job=network&space=ipam%2Fip_space%2Fa');
  const space = page.locator('[data-panel-id="automate-job"]').getByRole('combobox', { name: 'IP space' });
  await expect(space).toHaveValue('ipam/ip_space/a');
  await space.selectOption('ipam/ip_space/baseline-1');
  await setHash(page, '#automate');
  await expect(space).toHaveValue('ipam/ip_space/baseline-1');
});

test('Get an address: a plain visit after a prefilled link clears the prefill, keeps what was typed, and the link works again', async ({ page }) => {
  const link = '#selfservice?space=ipam%2Fip_space%2Fbaseline-1&subnet=ipam%2Fsubnet%2Fbaseline-3&reserve=1';
  await page.goto('/' + link);
  const panel = page.locator('[data-task="address"]');
  const space = panel.getByRole('combobox', { name: 'IP Space' });
  const subnet = panel.getByRole('combobox', { name: 'Subnet' });
  const lock = panel.getByRole('checkbox', { name: 'Lock it to one device (DHCP reservation)' });
  await expect(space).toHaveValue('ipam/ip_space/baseline-1');
  await expect(subnet).toHaveValue('ipam/subnet/baseline-3');
  await expect(lock).toBeChecked();
  await panel.getByPlaceholder('host-01').fill('printer-3');

  await setHash(page, '#selfservice');
  await expect(space).toHaveValue('');
  await expect(subnet).toHaveValue('');
  await expect(lock).not.toBeChecked();
  await expect(panel.getByPlaceholder('host-01')).toHaveValue('printer-3');

  await setHash(page, link);
  await expect(space).toHaveValue('ipam/ip_space/baseline-1');
  await expect(subnet).toHaveValue('ipam/subnet/baseline-3');
  await expect(lock).toBeChecked();
});

test('network: Add a DHCP range from a table finds the IP space from the network', async ({ page }) => {
  await page.goto('/#network');
  await pick(page, networkLink(page), 'Add a DHCP range');
  await expect(page).toHaveURL(/#editor\?type=dhcp_range&subnet=ipam%2Fsubnet%2Fbaseline-3&network=10\.30\.0\.0%2F24$/);
  await expect(page.getByRole('textbox', { name: 'IP Space' })).toHaveValue('ipam/ip_space/baseline-1');
  await expect(page.locator('[data-editor-form]')).toContainText('For network 10.30.0.0/24');
});

test('network: Add a DHCP range says so when the IP space cannot be found', async ({ page }) => {
  await page.route('**/api/item/network?**', (r) => r.fulfill(json({ availability: 'error', reason: 'Infoblox did not answer.' })));
  await page.goto('/#editor?type=dhcp_range&subnet=ipam%2Fsubnet%2Fbaseline-3&network=10.30.0.0%2F24');
  await expect(page.getByRole('textbox', { name: 'IP Space' })).toHaveValue('');
  await expect(page.locator('[data-editor-form]')).toContainText('For network 10.30.0.0/24');
  await expect(page.locator('[data-editor-form]')).toContainText("The IP space of 10.30.0.0/24 could not be filled in. Type its ID, which starts ipam/ip_space/.");
});

test('Get an address: following a second link with another space picks that link\'s subnet', async ({ page }) => {
  await page.route('**/api/ipam/spaces*', (r) => r.fulfill(json({ spaces: [
    { id: 'ipam/ip_space/baseline-1', name: 'Baseline Space' },
    { id: 'ipam/ip_space/a', name: 'Corp' },
  ] })));
  await page.route('**/api/ipam/subnets*', async (r) => {
    const two = new URL(r.request().url()).searchParams.get('space') === 'ipam/ip_space/a';
    // The second space's list answers late, as a real read can.
    if (two) await new Promise((res) => setTimeout(res, 400));
    return r.fulfill(json({ subnets: two
      ? [{ id: 'ipam/subnet/two-0', address: '10.50.0.0', cidr: 24, utilization: { free: 9 } }, { id: 'ipam/subnet/two-1', address: '10.50.1.0', cidr: 24, utilization: { free: 9 } }]
      : [{ id: 'ipam/subnet/baseline-3', address: '10.30.0.0', cidr: 24, utilization: { free: 5 } }] }));
  });
  await page.goto('/#selfservice?space=ipam%2Fip_space%2Fbaseline-1&subnet=ipam%2Fsubnet%2Fbaseline-3');
  const panel = page.locator('[data-task="address"]');
  await expect(panel.getByRole('combobox', { name: 'Subnet' })).toHaveValue('ipam/subnet/baseline-3');

  await setHash(page, '#selfservice?space=ipam%2Fip_space%2Fa&subnet=ipam%2Fsubnet%2Ftwo-1');
  await expect(panel.getByRole('combobox', { name: 'IP Space' })).toHaveValue('ipam/ip_space/a');
  await expect(panel.getByRole('combobox', { name: 'Subnet' })).toHaveValue('ipam/subnet/two-1');
});

test('Get an address: a Block picked by hand stays when a plain visit takes the link back', async ({ page }) => {
  await page.route('**/api/ipam/spaces*', (r) => r.fulfill(json({ spaces: [{ id: 'ipam/ip_space/a', name: 'Corp' }] })));
  await page.goto('/#selfservice?space=ipam%2Fip_space%2Fa');
  const panel = page.locator('[data-task="address"]');
  const space = panel.getByRole('combobox', { name: 'IP Space' });
  const block = panel.getByRole('combobox', { name: 'Block' });
  await expect(space).toHaveValue('ipam/ip_space/a');
  await block.selectOption('ipam/address_block/a1');
  await setHash(page, '#selfservice');
  // The link filled the space only; the Block was picked by hand, on that space.
  await expect(block).toHaveValue('ipam/address_block/a1');
  await expect(space).toHaveValue('ipam/ip_space/a');
});

async function rangeLookups(page: Page) {
  await page.route('**/api/item/network?**', (r) => {
    const id = new URL(r.request().url()).searchParams.get('id');
    const sp = id === 'ipam/subnet/b' ? 'ipam/ip_space/b' : 'ipam/ip_space/a';
    return r.fulfill(json({ availability: 'ok', rows: [{ id, address: '10.9.0.0', cidr: 24, space: sp }] }));
  });
}

test('Editor: a new subnet in the hash replaces the IP space the last lookup filled in', async ({ page }) => {
  await rangeLookups(page);
  await page.goto('/#editor?type=dhcp_range&subnet=ipam%2Fsubnet%2Fa');
  const box = page.getByRole('textbox', { name: 'IP Space' });
  await expect(box).toHaveValue('ipam/ip_space/a');
  await setHash(page, '#editor?type=dhcp_range&subnet=ipam%2Fsubnet%2Fb');
  await expect(box).toHaveValue('ipam/ip_space/b');
});

test('Editor: an IP space typed by hand stays when the subnet in the hash changes', async ({ page }) => {
  await rangeLookups(page);
  await page.goto('/#editor?type=dhcp_range&subnet=ipam%2Fsubnet%2Fa');
  const box = page.getByRole('textbox', { name: 'IP Space' });
  await expect(box).toHaveValue('ipam/ip_space/a');
  await box.fill('ipam/ip_space/typed');
  await setHash(page, '#editor?type=dhcp_range&subnet=ipam%2Fsubnet%2Fb');
  await page.waitForTimeout(500);
  await expect(box).toHaveValue('ipam/ip_space/typed');
});
