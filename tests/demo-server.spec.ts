import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The Demo server page builds real things on a Proxmox host and in Infoblox,
// so every write is behind a preview. These tests fake the server and check
// the page never starts a build or a teardown without that preview step.

const STATUS = {
  settings: {
    pve: 'root@10.0.0.2', pveName: 'pve1', pveIp: '10.0.0.2', pool: 'local-zfs', bridge: 'vmbr9',
    subnet: '10.99.0.0/24', gateway: '10.99.0.1', image: '/tmp/NIOS-X.qcow2', owner: 'jsmith',
    ram: 4096, cores: 3, disk: '64G', hasJoinToken: true,
  },
  problems: [],
  terraform: 'tofu',
  unlocked: true,
  steps: [
    { ID: 'ip', Says: 'Take the next free IP in the demo network' },
    { ID: 'vm', Says: 'Build a NIOS-X VM on Proxmox' },
  ],
  runs: [{ change: 'c-20261030-150000', status: 'ready', ip: '10.99.0.2', zone: 'demo-c-20261030-150000.example.', vmid: 211, vmName: 'jsmith-211' }],
};

const sse = (frames: object[]) => ({
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
  body: frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''),
});

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/demo/status', (r) => r.fulfill({ json: STATUS }));
});

test('Preview shows the checks and the code, and a failed check hides Build', async ({ page }) => {
  const live: string[] = [];
  await page.route('**/api/provision/demo/stream?*', (r) => {
    if (!r.request().url().includes('dry=1')) live.push(r.request().url());
    return r.fulfill(sse([{
      done: true, dry: true, ready: false,
      checks: [{ ok: true, says: 'Settings are complete' }, { ok: false, says: 'SSH to Proxmox works', fix: 'Add this computer\'s key to the host' }],
      code: { ip: { 'main.tf': 'resource "bloxone_ipam_address" "demo" {}' } },
    }]));
  });
  await page.goto('/#demo');
  await expect(page.locator('h1').first()).toHaveText(/^Demo server/);
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByText('SSH to Proxmox works')).toBeVisible();
  await expect(page.getByText("Add this computer's key to the host")).toBeVisible();
  await page.getByRole('tab', { name: 'Next free IP' }).click();
  await expect(page.getByText('resource "bloxone_ipam_address" "demo" {}')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Build it' })).toHaveCount(0);
  expect(live).toEqual([]);
});

test('Tear down lists what it removes and sends nothing live until confirmed', async ({ page }) => {
  const calls: string[] = [];
  await page.route('**/api/teardown/demo/stream?*', (r) => {
    const url = r.request().url();
    calls.push(url.includes('dry=1') ? 'dry' : 'live');
    return r.fulfill(sse(url.includes('dry=1')
      ? [{ done: true, dry: true, removes: ['VM 211 (jsmith-211) with its disk and seed', 'Reserved address 10.99.0.2'] }]
      : [{ event: { step: 'remove', state: 'ok', note: 'Everything this run made is gone.' } }, { done: true }]));
  });
  await page.goto('/#demo');
  await page.getByRole('button', { name: 'Tear down' }).click();
  await expect(page.getByText('VM 211 (jsmith-211) with its disk and seed')).toBeVisible();
  expect(calls).toEqual(['dry']);
  await page.getByRole('button', { name: 'Keep' }).click();
  await expect(page.getByText('VM 211 (jsmith-211) with its disk and seed')).toHaveCount(0);
  expect(calls).toEqual(['dry']);
  await page.getByRole('button', { name: 'Tear down' }).click();
  await page.getByRole('button', { name: 'Remove these' }).click();
  await expect.poll(() => calls).toEqual(['dry', 'dry', 'live']);
});

test('the join token box is empty and says a token is stored', async ({ page }) => {
  await page.goto('/#demo');
  const box = page.getByLabel('NIOS-X join token');
  await expect(box).toHaveValue('');
  await expect(box).toHaveAttribute('placeholder', /Stored/);
});
