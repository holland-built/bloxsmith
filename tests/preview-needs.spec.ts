import { test, expect } from './fixtures';
import { openTask } from './page-fixtures';

// A greyed-out Preview says what it is waiting for (owner, 2026-11-13: "we need
// to highlight why the preview button cant be pressed").

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

test('Get an address says why Preview is off, and the reason goes as each one is fixed', async ({ page }) => {
  await page.route('**/api/ipam/spaces*', (r) => r.fulfill(json({ spaces: [{ id: 'ipam/ip_space/1', name: 'acme-systems' }] })));
  await page.route('**/api/ipam/blocks*', (r) => r.fulfill(json({ blocks: [{ id: 'ipam/address_block/b1', address: '192.168.6.0', cidr: 23 }] })));
  await page.route('**/api/ipam/subnets*', (r) =>
    r.fulfill(json({ subnets: r.request().url().includes('block=') ? [] : [{ id: 'ipam/subnet/1', address: '10.0.42.0', cidr: 24, utilization: { free: 200 } }] })),
  );
  await page.route('**/api/dns/zones*', (r) => r.fulfill(json({ zones: [{ id: 'dns/auth_zone/z1', fqdn: 'example.com.' }] })));
  await page.goto('/#selfservice');
  const panel = await openTask(page, 'address');
  const preview = panel.getByRole('button', { name: 'Preview' });

  await expect(preview).toBeDisabled();
  await expect(preview).toHaveAccessibleDescription('To preview, pick an IP space.');

  await panel.getByRole('combobox', { name: 'IP Space' }).selectOption('ipam/ip_space/1');
  await panel.getByRole('combobox', { name: 'Block' }).selectOption('ipam/address_block/b1');
  await panel.getByRole('checkbox', { name: 'Also give it a DNS name' }).check();
  await panel.getByRole('checkbox', { name: 'Lock it to one device (DHCP reservation)' }).check();
  await expect(panel.getByText(
    "To preview, pick another block (this one has no subnets), type a Name (it becomes the DNS name), pick a DNS zone and type the device's MAC address.",
  )).toBeVisible();

  await panel.getByRole('combobox', { name: 'Block' }).selectOption('');
  await panel.getByPlaceholder('host-01').fill('printer-3');
  await panel.getByRole('combobox', { name: 'Zone' }).selectOption('dns/auth_zone/z1');
  await panel.getByRole('textbox', { name: 'Device MAC address' }).fill('aa:bb:cc:dd:ee:01');
  await expect(preview).toBeEnabled();
  await expect(panel.getByText(/^To preview,/)).toHaveCount(0);
});
