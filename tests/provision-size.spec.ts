import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Provision asks how many devices need an address, not for a prefix number.
// The request it sends still carries the prefix (cidr=24), and the block list
// says how big each block is.

function json(route: import('@playwright/test').Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

test('180 devices asks for a /24 and the block list shows sizes', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/vault/write-target*', (route) =>
    json(route, { known: true, tenant: 't/-', label: 'Test Tenant', writable: true }));
  await page.route('**/api/desk/spaces*', (route) => route.fulfill({ status: 404, body: '{}' }));
  await page.route('**/api/ipam/spaces*', (route) => json(route, { spaces: [{ id: 'ipam/ip_space/a', name: 'Amsterdam Lab' }] }));
  await page.route('**/api/ipam/blocks*', (route) => json(route, { blocks: [{ id: 'ipam/address_block/b1', address: '10.9.0.0', cidr: 16 }] }));
  const asked: string[] = [];
  await page.route('**/api/provision/stream*', (route) => {
    asked.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify({ done: true })}\n\n` });
  });

  await page.goto('/#provision');
  await page.getByRole('combobox', { name: 'Space', exact: true }).selectOption('ipam/ip_space/a');
  await expect(page.getByRole('combobox', { name: 'Block', exact: true }).locator('option', { hasText: '10.9.0.0/16 (65,536 addresses)' })).toBeAttached();

  const devices = page.getByRole('spinbutton', { name: 'How many devices need an address?' });
  await expect(devices).toHaveValue('254'); // the starting /24, as devices
  await devices.fill('0');
  await expect(page.getByText('Enter a whole number of devices, 1 or more.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview', exact: true })).toBeDisabled();
  await devices.fill('180');
  await expect(page.getByText('/24: 256 addresses, 254 usable by devices')).toBeVisible();
  await devices.fill('300');
  await expect(page.getByText('/23: 512 addresses, 510 usable by devices')).toBeVisible();
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect.poll(() => asked.length).toBeGreaterThan(0);
  expect(new URL(asked[0]).searchParams.get('cidr')).toBe('23');
});

test('the Editor asks for devices and still sends the prefix', async ({ page }) => {
  await installBaselineWorld(page);
  const posted: Record<string, unknown>[] = [];
  await page.route('**/api/edit/subnet', (route) => {
    posted.push(JSON.parse(route.request().postData() || '{}'));
    return json(route, { ok: true, dry_run: true });
  });
  await page.goto('/#editor?type=subnet');
  await page.getByRole('textbox', { name: 'Address block ID *' }).fill('ipam/address_block/9');
  const devices = page.getByRole('spinbutton', { name: 'How many devices need an address? *' });
  await devices.fill('50');
  await expect(page.getByText('/26: 64 addresses, 62 usable by devices')).toBeVisible();
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect.poll(() => posted.length).toBeGreaterThan(0);
  expect(posted[0]).toMatchObject({ block_id: 'ipam/address_block/9', cidr: 26, dry: true });
});

test('Editor: after picking an existing subnet and going back to a new one, the devices box is empty', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/edit/subnet/find*', (r) => r.fulfill({ json: { items: [
    { id: 'ipam/subnet/c2', label: '10.3.0.0/16 — branch-lan', fields: { block_id: 'ipam/address_block/9', cidr: 16, name: 'branch-lan', comment: '', tags: '' } } ] } }));
  const posted: Record<string, unknown>[] = [];
  await page.route('**/api/edit/subnet', (route) => {
    posted.push(JSON.parse(route.request().postData() || '{}'));
    return json(route, { ok: true, dry_run: true });
  });
  await page.goto('/#editor?type=subnet');
  await page.getByRole('spinbutton', { name: 'How many devices need an address? *' }).fill('50');
  await page.getByPlaceholder('Find by name, comment or full network address').fill('branch');
  await page.getByRole('button', { name: '10.3.0.0/16 — branch-lan' }).click();
  await expect(page.getByRole('button', { name: 'Delete Subnet' })).toBeVisible();
  await page.getByRole('button', { name: 'Make a new one instead' }).click();
  const devices = page.getByRole('spinbutton', { name: 'How many devices need an address? *' });
  await expect(devices).toHaveValue('');
  await expect(page.locator('[data-size-words]')).toHaveCount(0);
});

test('Editor: an IPv6 address block takes a prefix, not a device count', async ({ page }) => {
  await installBaselineWorld(page);
  const posted: Record<string, unknown>[] = [];
  await page.route('**/api/edit/address_block', (route) => {
    posted.push(JSON.parse(route.request().postData() || '{}'));
    return json(route, { ok: true, dry_run: true });
  });
  await page.goto('/#editor?type=address_block');
  await page.getByRole('textbox', { name: 'Address *' }).fill('2001:db8::');
  await expect(page.getByRole('spinbutton', { name: /How many devices/ })).toHaveCount(0);
  await page.getByRole('spinbutton', { name: 'Size: the number after the slash *' }).fill('56');
  await expect(page.getByText('/56 is 4,722,366,482,869,645,213,696 addresses')).toBeVisible();
  await page.getByRole('textbox', { name: 'IP Space *' }).fill('my-ip-space');
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect.poll(() => posted.length).toBeGreaterThan(0);
  expect(posted[0]).toMatchObject({ address: '2001:db8::', cidr: 56, space: 'my-ip-space' });
});

test('Editor: Tags finds an existing block by its exact size, not a device count', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#editor?type=tags');
  await expect(page.getByRole('spinbutton', { name: /How many devices/ })).toHaveCount(0);
  await page.getByRole('spinbutton', { name: 'Block size: the number after the slash' }).fill('31');
  await expect(page.getByText('/31 is 2 addresses')).toBeVisible();
});
