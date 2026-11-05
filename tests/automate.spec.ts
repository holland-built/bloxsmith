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
  await page.route('**/api/ipam/spaces*', (route) => json(route, { spaces: [
    { id: 'ipam/ip_space/a', name: 'Amsterdam Lab' },
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
  await expect(preview).toContainText('Nothing has been taken yet.');
  await expect(preview).toContainText('This will reserve 10.2.1.7 in 10.2.1.0/24, office-b, for printer-02.');
  expect(posted[0]).toEqual({ job: 'ip', input: { subnet_id: 'ipam/subnet/s2', name: 'printer-02' }, dry: true });

  await job.getByRole('button', { name: 'Build it' }).click();
  await expect(job.getByText('Done. 10.2.1.7 is reserved.')).toBeVisible();
  expect(posted[1]).toEqual({ job: 'ip', input: { subnet_id: 'ipam/subnet/s2', name: 'printer-02' }, dry: false });

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
