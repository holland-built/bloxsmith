import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The Automate page: pick a job, Preview, Build, and the change appears in Your
// recent changes, where Remove lists what is still there before deleting it.
// The server side (recording exact IDs, removing only those) is pinned by
// go/internal/server/desk_test.go; this pins what a person sees and clicks.

function json(route: import('@playwright/test').Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

const RUN = {
  id: 'r-20261105-120000-ab12',
  job: 'ip',
  title: 'IP address for printer-02: 10.2.1.7',
  created: '2026-11-05T12:00:00Z',
  status: 'built',
  objects: [{ id: 'ipam/address/a1', kind: 'address', label: '10.2.1.7', state: 'created' }],
};

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/desk/spaces', (route) => json(route, { spaces: [
    { id: 'ipam/ip_space/a', name: 'Amsterdam Lab', yours: false, reason: '250 of 256 addresses free' },
  ] }));
  await page.route('**/api/ipam/subnets*', (route) => json(route, { subnets: [
    { id: 'ipam/subnet/s2', address: '10.2.1.0', cidr: 24, name: 'office-b' },
  ] }));
});

test('get an IP address: preview, build, then remove it', async ({ page }) => {
  let runs: unknown[] = [];
  const posted: Record<string, unknown>[] = [];
  await page.route('**/api/desk/runs', (route) => json(route, { runs }));
  await page.route('**/api/desk/run', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    posted.push(body);
    if (body.dry) return json(route, { ok: true, dry_run: true, addresses: [{ address: '10.2.1.7' }] });
    runs = [RUN];
    return json(route, { ok: true, run: RUN });
  });
  await page.route('**/api/desk/remove', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.dry) return json(route, { dry_run: true, run: RUN, would_remove: [{ id: 'ipam/address/a1', label: '10.2.1.7', exists: true }] });
    runs = [{ ...RUN, status: 'removed', objects: [{ ...RUN.objects[0], state: 'removed' }] }];
    return json(route, { ok: true, run: runs[0] });
  });

  await page.goto('/#automate');
  await expect(page.getByRole('heading', { name: 'What do you want to do?' })).toBeVisible();
  await expect(page.getByText('Nothing built here yet.')).toBeVisible();

  const job = page.locator('[data-panel-id="automate-job"]');
  await job.getByRole('combobox', { name: 'IP space' }).selectOption('ipam/ip_space/a');
  await job.getByRole('combobox', { name: 'Network' }).selectOption('ipam/subnet/s2');
  await job.getByRole('textbox', { name: /What is it for/ }).fill('printer-02');
  await job.getByRole('button', { name: 'Preview' }).click();

  const preview = job.locator('[data-desk-preview]');
  await expect(preview).toContainText('Nothing has been made yet.');
  await expect(preview).toContainText('This will reserve 10.2.1.7 in 10.2.1.0/24, office-b, for printer-02.');
  expect(posted[0]).toEqual({ job: 'ip', input: { space: 'ipam/ip_space/a', subnet_id: 'ipam/subnet/s2', name: 'printer-02' }, dry: true });

  await job.getByRole('button', { name: 'Build it' }).click();
  await expect(job.getByText('Done. 10.2.1.7 is reserved.')).toBeVisible();
  expect(posted[1]).toEqual({ job: 'ip', input: { space: 'ipam/ip_space/a', subnet_id: 'ipam/subnet/s2', name: 'printer-02' }, dry: false });

  const row = page.locator(`[data-run="${RUN.id}"]`);
  await expect(row).toContainText('IP address for printer-02: 10.2.1.7');
  await expect(row).toContainText('Built');

  await row.getByRole('button', { name: 'Remove' }).click();
  const plan = row.locator('[data-remove-plan]');
  await expect(plan).toContainText('This will delete:');
  await expect(plan).toContainText('10.2.1.7');
  await plan.getByRole('button', { name: 'Delete these' }).click();
  await expect(row).toContainText('Removed');
  await expect(row.getByRole('button', { name: 'Remove' })).toHaveCount(0);
});

test('changing an answer after Preview takes the Build button away', async ({ page }) => {
  await page.route('**/api/desk/runs', (route) => json(route, { runs: [] }));
  await page.route('**/api/desk/run', (route) => json(route, { ok: true, dry_run: true, addresses: [{ address: '10.2.1.7' }] }));
  await page.goto('/#automate');
  const job = page.locator('[data-panel-id="automate-job"]');
  await job.getByRole('combobox', { name: 'IP space' }).selectOption('ipam/ip_space/a');
  await job.getByRole('combobox', { name: 'Network' }).selectOption('ipam/subnet/s2');
  await job.getByRole('button', { name: 'Preview' }).click();
  await expect(job.getByRole('button', { name: 'Build it' })).toBeVisible();
  await job.getByRole('textbox', { name: /What is it for/ }).fill('changed');
  await expect(job.getByRole('button', { name: 'Build it' })).toHaveCount(0);
});

test('a slow Preview that answers after an answer changed is ignored', async ({ page }) => {
  await page.route('**/api/desk/runs', (route) => json(route, { runs: [] }));
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/desk/run', async (route) => {
    await held;
    return json(route, { ok: true, dry_run: true, addresses: [{ address: '10.2.1.7' }] });
  });
  await page.goto('/#automate');
  const job = page.locator('[data-panel-id="automate-job"]');
  await job.getByRole('combobox', { name: 'IP space' }).selectOption('ipam/ip_space/a');
  await job.getByRole('combobox', { name: 'Network' }).selectOption('ipam/subnet/s2');
  await job.getByRole('button', { name: 'Preview' }).click();
  await job.getByRole('textbox', { name: /What is it for/ }).fill('changed while waiting');
  release();
  await expect(job.getByRole('button', { name: 'Preview' })).toBeEnabled();
  await expect(job.locator('[data-desk-preview]')).toHaveCount(0);
  await expect(job.getByRole('button', { name: 'Build it' })).toHaveCount(0);
});

test('a run that could not be fully removed says so and offers Remove again', async ({ page }) => {
  const stuck = { ...RUN, status: 'remove-failed', error: '1 item(s) could not be removed. Remove again to retry them.',
    objects: [{ ...RUN.objects[0], state: 'failed', error: 'delete failed (500)' }] };
  await page.route('**/api/desk/runs', (route) => json(route, { runs: [stuck] }));
  await page.goto('/#automate');
  const row = page.locator(`[data-run="${RUN.id}"]`);
  await expect(row).toContainText('Some items could not be removed');
  await expect(row).toContainText('10.2.1.7: could not be removed (delete failed (500))');
  await expect(row.getByRole('button', { name: 'Remove' })).toBeVisible();
});

test('the rail and the Change menu both lead to Automate', async ({ page }) => {
  await page.route('**/api/desk/runs', (route) => json(route, { runs: [] }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#overview');
  await page.locator('[data-job-rail]').getByRole('link', { name: 'Automate' }).click();
  await expect(page).toHaveURL(/#automate$/);
  await expect(page.getByRole('heading', { name: 'Automate', level: 1 })).toBeVisible();
});

test('your IP space is suggested first and picked for you, with the reason shown', async ({ page }) => {
  await page.route('**/api/desk/runs', (route) => json(route, { runs: [] }));
  await page.route('**/api/desk/spaces', (route) => json(route, { spaces: [
    { id: 'ipam/ip_space/mine', name: 'team-lab', yours: true, reason: 'Named for you' },
    { id: 'ipam/ip_space/big', name: 'Big Lab', yours: false, reason: '5,000 of 6,000 addresses free' },
  ] }));
  await page.goto('/#automate');
  const job = page.locator('[data-panel-id="automate-job"]');
  const tips = job.locator('[data-space-suggestions]');
  await expect(tips.getByRole('button', { name: /team-lab/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(tips).toContainText('Named for you');
  await expect(tips).toContainText('5,000 of 6,000 addresses free');
  await expect(job.getByRole('combobox', { name: 'IP space' })).toHaveValue('ipam/ip_space/mine');
  await tips.getByRole('button', { name: /Big Lab/ }).click();
  await expect(job.getByRole('combobox', { name: 'IP space' })).toHaveValue('ipam/ip_space/big');
});

test('add a DNS name: preview says the full name, build sends the answers', async ({ page }) => {
  await page.route('**/api/desk/runs', (route) => json(route, { runs: [] }));
  await page.route('**/api/dns/zones*', (route) => json(route, {
    views: [{ id: 'dns/view/v1', name: 'default' }],
    zones: [{ id: 'dns/auth_zone/z1', fqdn: 'lab.example.', view: 'dns/view/v1' }] }));
  const posted: Record<string, unknown>[] = [];
  await page.route('**/api/desk/run', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    posted.push(body);
    if (body.dry) return json(route, { ok: true, dry_run: true, record: {} });
    return json(route, { ok: true, run: { ...RUN, job: 'dns', objects: [{ id: 'dns/record/r1', kind: 'dns_record', label: 'www.lab.example A 10.1.2.3', state: 'created' }] } });
  });
  await page.goto('/#automate');
  await page.getByRole('button', { name: /Add a DNS name/ }).click();
  const job = page.locator('[data-panel-id="automate-job"]');
  await job.getByRole('combobox', { name: 'Zone' }).selectOption('dns/auth_zone/z1');
  await job.getByRole('textbox', { name: /^Name/ }).fill('www');
  await job.getByRole('textbox', { name: 'Points to' }).fill('10.1.2.3');
  await job.getByRole('button', { name: 'Preview' }).click();
  await expect(job.locator('[data-desk-preview]')).toContainText('This will add www.lab.example, an A record pointing to 10.1.2.3.');
  await job.getByRole('button', { name: 'Build it' }).click();
  await expect(job.getByText('Done. www.lab.example now points to 10.1.2.3.')).toBeVisible();
  expect(posted[1]).toEqual({ job: 'dns', dry: false, input: { zone_id: 'dns/auth_zone/z1', zone_name: 'lab.example.', name_in_zone: 'www', type: 'A', value: '10.1.2.3' } });
});

test('make a new network: pick a block and a size in plain words', async ({ page }) => {
  await page.route('**/api/desk/runs', (route) => json(route, { runs: [] }));
  await page.route('**/api/ipam/blocks*', (route) => json(route, { blocks: [
    { id: 'ipam/address_block/b1', address: '10.9.0.0', cidr: 16, name: 'lab-block' } ] }));
  const posted: Record<string, unknown>[] = [];
  await page.route('**/api/desk/run', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    posted.push(body);
    return json(route, { ok: true, dry_run: true, would_create: { address: '10.9.4.0', cidr: 26 } });
  });
  await page.goto('/#automate');
  await page.getByRole('button', { name: /Make a new network/ }).click();
  const job = page.locator('[data-panel-id="automate-job"]');
  await job.getByRole('combobox', { name: 'IP space' }).selectOption('ipam/ip_space/a');
  await job.getByRole('combobox', { name: 'Address block' }).selectOption('ipam/address_block/b1');
  await job.getByRole('combobox', { name: 'Size' }).selectOption({ label: '/26, 64 addresses' });
  await job.getByRole('button', { name: 'Preview' }).click();
  await expect(job.locator('[data-desk-preview]')).toContainText('This will make 10.9.4.0/26 (64 addresses) in 10.9.0.0/16, lab-block.');
  expect(posted[0]).toEqual({ job: 'network', dry: true, input: { space: 'ipam/ip_space/a', block_id: 'ipam/address_block/b1', cidr: 26, name: '' } });
});

test('Remove says when a network will be kept because it holds other things', async ({ page }) => {
  const net = { ...RUN, job: 'network', title: 'Network demo', objects: [{ id: 'ipam/subnet/s9', kind: 'subnet', label: '10.9.4.0/26', state: 'created' }] };
  await page.route('**/api/desk/runs', (route) => json(route, { runs: [net] }));
  await page.route('**/api/desk/remove', (route) => json(route, { dry_run: true, run: net, would_remove: [
    { id: 'ipam/subnet/s9', label: '10.9.4.0/26', exists: true, blocked: 'This network now holds 2 address(es) this change did not make, so it was not deleted. Release them first.' } ] }));
  await page.goto('/#automate');
  const row = page.locator(`[data-run="${RUN.id}"]`);
  await row.getByRole('button', { name: 'Remove' }).click();
  await expect(row.locator('[data-remove-plan]')).toContainText('Will be kept: This network now holds 2 address(es)');
});

test('Find opens the search page with what was typed', async ({ page }) => {
  await page.route('**/api/desk/runs', (route) => json(route, { runs: [] }));
  await page.goto('/#automate');
  await page.getByRole('textbox', { name: 'Find an address, network or name' }).fill('printer-02');
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(page).toHaveURL(/#dossier\?q=printer-02$/);
});

const SITE_PLAN = {
  ok: true, dry_run: true,
  subnets: [{ address: '10.9.0.0/25', name: 'acme-bench', id: '(dry-run)' }, { address: '10.9.0.128/27', name: 'acme-mgmt', id: '(dry-run)' }],
  dhcp_ranges: [{ id: '(dry-run)', start: '10.9.0.20', end: '10.9.0.120' }],
  dns_zone_fqdn: 'acme.lab.example.com', dns_zone_created: true,
  hosts: [{ fqdn: 'acme-jump01.acme.lab.example.com', id: '(dry-run)' }],
};

test('set up a branch office: preview lists what the template will make', async ({ page }) => {
  await page.route('**/api/desk/runs', (route) => json(route, { runs: [] }));
  await page.route('**/api/templates', (route) => json(route, [
    { name: 'amer/lab/site-amer-lab.yaml', site: 'amer-lab', region: 'Americas', environment: 'lab', type: 'site', valid: true },
    { name: 'dns/corp.yaml', site: '', type: 'dns', valid: true },
  ]));
  const posted: Record<string, unknown>[] = [];
  await page.route('**/api/desk/run', async (route) => {
    posted.push(JSON.parse(route.request().postData() || '{}'));
    return json(route, SITE_PLAN);
  });
  await page.goto('/#automate');
  await page.getByRole('button', { name: /Set up a branch office/ }).click();
  const job = page.locator('[data-panel-id="automate-job"]');
  await expect(job.getByRole('combobox', { name: 'Site template' }).locator('option')).toHaveCount(2); // placeholder + the one site template
  await job.getByRole('combobox', { name: 'Site template' }).selectOption('amer/lab/site-amer-lab.yaml');
  await job.getByRole('textbox', { name: 'Site name' }).fill('Acme Boston');
  await expect(job.getByRole('textbox', { name: 'Site name' })).toHaveValue('acme-boston');
  await job.getByRole('combobox', { name: 'IP space' }).selectOption('ipam/ip_space/a');
  await job.getByRole('button', { name: 'Preview' }).click();
  const preview = job.locator('[data-desk-preview]');
  await expect(preview).toContainText('Network 10.9.0.0/25, acme-bench');
  await expect(preview).toContainText('1 DHCP range');
  await expect(preview).toContainText('DNS zone acme.lab.example.com');
  await expect(preview).toContainText('1 host: acme-jump01.acme.lab.example.com');
  expect(posted[0]).toEqual({ job: 'branch', dry: true, input: { template: 'amer/lab/site-amer-lab.yaml', site: 'acme-boston', space: 'ipam/ip_space/a', space_name: 'Amsterdam Lab' } });
});

test('get a demo ready: preview lists sample names and says when the server cannot start', async ({ page }) => {
  await page.route('**/api/desk/runs', (route) => json(route, { runs: [] }));
  const posted: Record<string, unknown>[] = [];
  await page.route('**/api/desk/run', async (route) => {
    posted.push(JSON.parse(route.request().postData() || '{}'));
    return json(route, { ...SITE_PLAN, sample_names: [{ label: 'www.acme.lab.example.com A 10.9.0.10' }],
      server: { ready: false, why: 'Set up the demo server first: a join token is required.' } });
  });
  await page.goto('/#automate');
  await page.getByRole('button', { name: /Get a demo ready/ }).click();
  const job = page.locator('[data-panel-id="automate-job"]');
  await job.getByRole('combobox', { name: 'IP space' }).selectOption('ipam/ip_space/a');
  await job.getByRole('textbox', { name: 'Customer or call name' }).fill('acme-bank');
  await job.getByRole('radio', { name: 'Europe' }).check();
  await job.getByRole('button', { name: 'Preview' }).click();
  const preview = job.locator('[data-desk-preview]');
  await expect(preview).toContainText('www.acme.lab.example.com A 10.9.0.10');
  await expect(preview).toContainText('The demo server cannot start yet: Set up the demo server first');
  expect(posted[0]).toEqual({ job: 'demo', dry: true, input: { space: 'ipam/ip_space/a', space_name: 'Amsterdam Lab', customer: 'acme-bank', region: 'emea', include_server: true } });
});

test('a demo kit shows its demo server building, and a failed join points at the token', async ({ page }) => {
  const kit = { ...RUN, id: 'r-kit', job: 'demo', title: 'Demo for acme-bank', objects: [
    { id: 'dns/record/r1', kind: 'dns_record', label: 'www.acme.lab.example.com A 10.9.0.10', state: 'created' },
    { id: 'c-20261105-120000', kind: 'demo_server', label: 'demo server', state: 'created' }] };
  let status = 'building';
  await page.route('**/api/desk/runs', (route) => json(route, { runs: [kit], demo: {
    'c-20261105-120000': { change: 'c-20261105-120000', status, ip: '10.99.0.7',
      error: status === 'failed' ? 'join: the VM did not join the Portal in time' : '' } } }));
  await page.goto('/#automate');
  const line = page.locator('[data-demo-server="c-20261105-120000"]');
  await expect(line).toContainText('demo server 10.99.0.7: building, about 15 minutes in all');
  status = 'failed';
  await page.reload();
  await expect(line).toContainText('did not finish');
  await expect(line).toContainText('If the join token has expired');
});

test('demo servers from the Demo server page are listed and removed only on request', async ({ page }) => {
  await page.route('**/api/desk/runs', (route) => json(route, { runs: [], older_demos: [
    { change: 'c-20261101-100000', status: 'ready', ip: '10.99.0.5', created: '2026-11-01T10:00:00Z' }] }));
  let body: Record<string, unknown> = {};
  await page.route('**/api/desk/remove', async (route) => {
    body = JSON.parse(route.request().postData() || '{}');
    return json(route, { dry_run: true, would_remove: [{ id: 'c-20261101-100000', label: 'demo server 10.99.0.5', exists: true,
      parts: ['VM 211 (nios-demo) with its disk and seed', 'Reserved address 10.99.0.5'] }] });
  });
  await page.goto('/#automate');
  const older = page.locator('[data-older-demos]');
  await expect(older).toContainText('Demo server 10.99.0.5');
  await older.getByRole('button', { name: 'Remove' }).click();
  await expect(older.locator('[data-remove-plan]')).toContainText('VM 211 (nios-demo) with its disk and seed');
  expect(body).toEqual({ demo_change: 'c-20261101-100000', dry: true });
});

test('after Preview, the IP job offers the same change as an Ansible playbook', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route('**/api/desk/runs', (route) => json(route, { runs: [] }));
  await page.route('**/api/desk/run', (route) => json(route, { ok: true, dry_run: true, addresses: [{ address: '10.2.1.7' }] }));
  await page.goto('/#automate');
  const job = page.locator('[data-panel-id="automate-job"]');
  await expect(job.locator('[data-ansible]')).toHaveCount(0);
  await job.getByRole('combobox', { name: 'IP space' }).selectOption('ipam/ip_space/a');
  await job.getByRole('combobox', { name: 'Network' }).selectOption('ipam/subnet/s2');
  await job.getByRole('button', { name: 'Preview' }).click();
  await job.getByText('Run this from Ansible instead').click();
  await job.getByRole('button', { name: 'Copy as Ansible playbook' }).click();
  await expect(job.locator('[data-ansible]').getByRole('status')).toContainText('Copied');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('infoblox.universal_ddi.ipam_address:');
  expect(clip).toContain('next_available_id: "ipam/subnet/s2"');
});

test('Plan it opens the job with the answers filled in, and builds nothing', async ({ page }) => {
  await page.route('**/api/desk/runs', (route) => json(route, { runs: [] }));
  let built = false;
  await page.route('**/api/desk/run', (route) => { built = true; return json(route, {}); });
  await page.route('**/api/desk/plan', (route) => json(route, { unclear: 'the Thursday date', jobs: [
    { job: 'demo', answers: { customer: 'acme-bank', region: 'emea', include_server: false }, says: 'A demo for acme-bank in Europe' },
  ] }));
  await page.goto('/#automate');
  await page.getByRole('textbox', { name: 'Or describe it in one sentence' }).fill('demo for acme bank in europe, no server, on Thursday');
  await page.getByRole('button', { name: 'Plan it' }).click();
  const plan = page.locator('[data-plan]');
  await expect(plan).toContainText('Get a demo ready');
  await expect(plan).toContainText('Not planned: the Thursday date');
  await plan.getByRole('button', { name: 'Open this job' }).click();
  const job = page.locator('[data-panel-id="automate-job"]');
  await expect(job.getByRole('textbox', { name: 'Customer or call name' })).toHaveValue('acme-bank');
  await expect(job.getByRole('radio', { name: 'Europe' })).toBeChecked();
  await expect(job.getByRole('checkbox', { name: /Include a demo DNS server/ })).not.toBeChecked();
  expect(built).toBe(false);
});
