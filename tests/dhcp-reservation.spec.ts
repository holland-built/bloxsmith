import { test, expect } from './fixtures';
import { openTask } from './page-fixtures';

// Get an address can lock the address to one device: a DHCP reservation
// (owner, 2026-11-12). Preview names the address and the MAC; Reserve sends
// back the exact previewed address, so what is reserved is what was shown.

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function openAddress(page: import('@playwright/test').Page) {
  await page.route('**/api/ipam/spaces*', (r) => r.fulfill(json({ spaces: [{ id: 'ipam/ip_space/1', name: 'acme-systems' }] })));
  await page.route('**/api/ipam/blocks*', (r) => r.fulfill(json({ blocks: [] })));
  await page.route('**/api/ipam/subnets*', (r) =>
    r.fulfill(json({ subnets: [{ id: 'ipam/subnet/1', address: '10.0.42.0', cidr: 24, name: 'site-42', utilization: { free: 200 } }] })),
  );
  await page.goto('/#selfservice');
  const panel = await openTask(page, 'address');
  await panel.getByRole('combobox', { name: 'IP Space' }).selectOption('ipam/ip_space/1');
  return panel;
}

test('Get an address can reserve the address for one device', async ({ page }) => {
  const sent: Record<string, any>[] = [];
  await page.route('**/api/selfservice/allocate', (r) => {
    const b = r.request().postDataJSON();
    sent.push(b);
    return b.dry
      ? r.fulfill(json({ ok: true, dry_run: true, addresses: [{ address: '10.0.42.7' }], fixed_address: { dry_run: true, address: '10.0.42.7', mac: 'aa:bb:cc:dd:ee:01', name: 'printer-3' } }))
      : r.fulfill(json({ ok: true, addresses: [{ id: 'dhcp/fixed_address/f1', address: '10.0.42.7' }], fixed_address: { ok: true, id: 'dhcp/fixed_address/f1', address: '10.0.42.7', mac: 'aa:bb:cc:dd:ee:01' } }));
  });
  const panel = await openAddress(page);
  const lock = panel.getByRole('checkbox', { name: 'Lock it to one device (DHCP reservation)' });

  // One device gets one address.
  await panel.getByRole('spinbutton', { name: 'Count' }).fill('2');
  await expect(lock).toBeDisabled();
  await panel.getByRole('spinbutton', { name: 'Count' }).fill('1');

  await lock.check();
  await panel.getByPlaceholder('host-01').fill('printer-3');
  const mac = panel.getByRole('textbox', { name: 'Device MAC address' });
  await mac.fill('aa:bb:cc');
  await expect(panel.getByText('Six pairs of letters or digits, like aa:bb:cc:dd:ee:ff.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Preview' })).toBeDisabled();
  await mac.fill('AA:BB:CC:DD:EE:01');

  await panel.getByRole('button', { name: 'Preview' }).click();
  await expect(panel.getByText(/This will take 10\.0\.42\.7 in subnet 10\.0\.42\.0\/24 — site-42, named printer-3\. Only the device aa:bb:cc:dd:ee:01 will get it from DHCP\./)).toBeVisible();
  expect(sent.at(-1)).toMatchObject({ dry: true, count: 1, dhcp: { mac: 'AA:BB:CC:DD:EE:01', name: 'printer-3' } });
  expect(sent.at(-1)!.dhcp.address).toBeUndefined();

  await panel.getByRole('button', { name: 'Reserve', exact: true }).click();
  await expect(panel.getByText('Done. 10.0.42.7 is reserved for the device aa:bb:cc:dd:ee:01.')).toBeVisible();
  expect(sent.at(-1)).toMatchObject({ dry: false, dhcp: { mac: 'AA:BB:CC:DD:EE:01', address: '10.0.42.7' } });
});

test('a device that already has a reservation is refused in the preview', async ({ page }) => {
  await page.route('**/api/selfservice/allocate', (r) =>
    r.fulfill(json({ ok: false, error: 'aa:bb:cc:dd:ee:01 already has a reservation: 10.0.42.40 (old-printer). Use that one, or remove it first' }, 409)),
  );
  const panel = await openAddress(page);
  await panel.getByRole('checkbox', { name: 'Lock it to one device (DHCP reservation)' }).check();
  await panel.getByRole('textbox', { name: 'Device MAC address' }).fill('aa:bb:cc:dd:ee:01');
  await panel.getByRole('button', { name: 'Preview' }).click();
  await expect(panel.getByText(/already has a reservation: 10\.0\.42\.40/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Reserve', exact: true })).toHaveCount(0);
});
