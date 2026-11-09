import { test, expect } from './fixtures';

// Three helpers taken from a colleague's Infoblox CSP tool (2026-11-09):
// the DNS form refuses a record that already exists, both forms can make the
// reverse (PTR) record, and Get an address can give the address its DNS name
// in the same step.

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const ZONES = { zones: [{ id: 'dns/auth_zone/z1', fqdn: 'example.com.' }] };

test('the DNS form says a record already exists, and offers no Create', async ({ page }) => {
  await page.route('**/api/dns/zones*', (r) => r.fulfill(json(ZONES)));
  await page.route('**/api/dns/records', (r) =>
    r.fulfill(json({ ok: false, duplicate: true, error: 'That A record already exists: host1 10.0.0.5. Nothing was created.' }, 409)),
  );
  await page.goto('/#selfservice');
  const panel = page.locator('[data-panel-id]').filter({ hasText: 'Create DNS Record' }).first();
  await panel.getByRole('combobox', { name: 'Zone' }).selectOption('dns/auth_zone/z1');
  await panel.getByPlaceholder('host or @').fill('host1');
  await panel.getByPlaceholder('192.0.2.10').fill('10.0.0.5');
  await panel.getByRole('button', { name: 'Preview' }).click();
  await expect(panel.getByText('That A record already exists: host1 10.0.0.5. Nothing was created.')).toBeVisible();
  // Create appears only after a clean preview.
  await expect(panel.getByRole('button', { name: 'Create', exact: true })).toHaveCount(0);
});

test('the DNS form offers the reverse record for A and AAAA only, and sends it', async ({ page }) => {
  await page.route('**/api/dns/zones*', (r) => r.fulfill(json(ZONES)));
  const sent: Record<string, unknown>[] = [];
  await page.route('**/api/dns/records', (r) => {
    const b = r.request().postDataJSON();
    sent.push(b);
    return r.fulfill(json({ ok: true, dry_run: true, record: { name_in_zone: 'host1', type: 'A' } }));
  });
  await page.goto('/#selfservice');
  const panel = page.locator('[data-panel-id]').filter({ hasText: 'Create DNS Record' }).first();
  const ptr = panel.getByRole('checkbox', { name: 'Also create the reverse (PTR) record' });
  await expect(ptr).toBeVisible();
  await panel.getByRole('combobox', { name: 'Type' }).selectOption('CNAME');
  await expect(ptr).toHaveCount(0);
  await panel.getByRole('combobox', { name: 'Type' }).selectOption('A');

  await panel.getByRole('combobox', { name: 'Zone' }).selectOption('dns/auth_zone/z1');
  await panel.getByPlaceholder('host or @').fill('host1');
  await panel.getByPlaceholder('192.0.2.10').fill('10.0.0.5');
  await ptr.check();
  await panel.getByRole('button', { name: 'Preview' }).click();
  await expect(panel.getByText('This will create A host1.example.com → 10.0.0.5, with a reverse record. No identical record exists.')).toBeVisible();
  expect(sent.at(-1)).toMatchObject({ create_ptr: true, dry: true, type: 'A' });
});

test('Get an address can give the address its DNS name in the same step', async ({ page }) => {
  await page.route('**/api/ipam/spaces*', (r) => r.fulfill(json({ spaces: [{ id: 'ipam/ip_space/1', name: 'acme-systems' }] })));
  await page.route('**/api/ipam/blocks*', (r) => r.fulfill(json({ blocks: [] })));
  await page.route('**/api/ipam/subnets*', (r) =>
    r.fulfill(json({ subnets: [{ id: 'ipam/subnet/1', address: '10.0.42.0', cidr: 24, name: 'site-42', utilization: { free: 200 } }] })),
  );
  await page.route('**/api/dns/zones*', (r) => r.fulfill(json(ZONES)));
  const sent: Record<string, unknown>[] = [];
  await page.route('**/api/selfservice/allocate', (r) => {
    sent.push(r.request().postDataJSON());
    return r.fulfill(json({ ok: true, dry_run: true, addresses: [{ address: '10.0.42.1' }], record: { dry_run: true } }));
  });
  await page.goto('/#selfservice');
  const panel = page.locator('[data-panel-id]').filter({ hasText: 'Allocate Address' }).first();
  await panel.getByRole('combobox', { name: 'IP Space' }).selectOption('ipam/ip_space/1');
  const dnsBox = panel.getByRole('checkbox', { name: 'Also give it a DNS name' });

  // One address gets one name: with a count of 2 the option is off.
  await panel.getByRole('spinbutton', { name: 'Count' }).fill('2');
  await expect(dnsBox).toBeDisabled();
  await panel.getByRole('spinbutton', { name: 'Count' }).fill('1');

  await dnsBox.check();
  await panel.getByPlaceholder('host-01').fill('printer-3');
  // Preview waits for a zone, so a half-filled DNS name is never sent.
  await expect(panel.getByRole('button', { name: 'Preview' })).toBeDisabled();
  await panel.getByRole('combobox', { name: 'Zone' }).selectOption('dns/auth_zone/z1');
  await expect(panel.getByText('It will be printer-3.example.com.')).toBeVisible();
  await panel.getByRole('checkbox', { name: 'Also create the reverse (PTR) record' }).check();
  await panel.getByRole('button', { name: 'Preview' }).click();
  await expect(panel.getByText(/This will take 10\.0\.42\.1 in subnet 10\.0\.42\.0\/24 — site-42, named printer-3\. It will also point printer-3\.example\.com to it, with a reverse record\./)).toBeVisible();
  expect(sent.at(-1)).toMatchObject({ dns: { zone_id: 'dns/auth_zone/z1', name: 'printer-3', type: 'A', create_ptr: true } });
});
