import { test, expect } from './fixtures';
import { openTask } from './page-fixtures';

// Infoblox makes the reverse (PTR) record only when a reverse zone covers the
// address. A preview that asks for one gets the server's amber reverse_note
// when none does (go/internal/edit/reverse.go), shown by CheckedAgainst.jsx.

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const ZONES = { zones: [{ id: 'dns/auth_zone/z1', fqdn: 'example.com.' }] };
const NOTE = 'No reverse zone covers 10.0.42.1, so no reverse (PTR) record will be made.';

test('Get an address: the preview warns when no reverse zone covers the address', async ({ page }) => {
  await page.route('**/api/ipam/spaces*', (r) => r.fulfill(json({ spaces: [{ id: 'ipam/ip_space/1', name: 'acme-systems' }] })));
  await page.route('**/api/ipam/blocks*', (r) => r.fulfill(json({ blocks: [] })));
  await page.route('**/api/ipam/subnets*', (r) =>
    r.fulfill(json({ subnets: [{ id: 'ipam/subnet/1', address: '10.0.42.0', cidr: 24, name: 'site-42', utilization: { free: 200 } }] })),
  );
  await page.route('**/api/dns/zones*', (r) => r.fulfill(json(ZONES)));
  await page.route('**/api/selfservice/allocate', (r) =>
    r.fulfill(json({ ok: true, dry_run: true, addresses: [{ address: '10.0.42.1' }], record: { dry_run: true }, reverse_note: NOTE })),
  );
  await page.goto('/#selfservice');
  const panel = await openTask(page, 'address');
  await panel.getByRole('combobox', { name: 'IP Space' }).selectOption('ipam/ip_space/1');
  await panel.getByRole('checkbox', { name: 'Also give it a DNS name' }).check();
  await panel.getByPlaceholder('host-01').fill('printer-3');
  await panel.getByRole('combobox', { name: 'Zone' }).selectOption('dns/auth_zone/z1');
  await panel.getByRole('checkbox', { name: 'Also create the reverse (PTR) record' }).check();
  await panel.getByRole('button', { name: 'Preview' }).click();
  const note = panel.locator('[data-reverse-note]');
  await expect(note).toHaveText(NOTE);
  await expect(note).toHaveClass(/text-warn/);
});

test('Create a DNS record: the preview warns when no reverse zone covers the address, and drops it after an edit', async ({ page }) => {
  await page.route('**/api/dns/zones*', (r) => r.fulfill(json(ZONES)));
  await page.route('**/api/dns/records', (r) =>
    r.fulfill(json({ ok: true, dry_run: true, record: { name_in_zone: 'host1', type: 'A' },
      reverse_note: 'No reverse zone covers 10.0.0.5, so no reverse (PTR) record will be made.' })),
  );
  await page.goto('/#selfservice');
  const panel = await openTask(page, 'record');
  await panel.getByRole('combobox', { name: 'Zone' }).selectOption('dns/auth_zone/z1');
  await panel.getByPlaceholder('host or @').fill('host1');
  await panel.getByPlaceholder('192.0.2.10').fill('10.0.0.5');
  await panel.getByRole('checkbox', { name: 'Also create the reverse (PTR) record' }).check();
  await panel.getByRole('button', { name: 'Preview' }).click();
  const note = panel.locator('[data-reverse-note]');
  await expect(note).toHaveText('No reverse zone covers 10.0.0.5, so no reverse (PTR) record will be made.');
  await panel.getByPlaceholder('192.0.2.10').fill('10.0.0.6');
  await expect(note).toHaveCount(0);
});
