import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Automate: beside "Copy as Ansible playbook", a previewed job can be copied as
// Terraform for Infoblox's bloxone provider (ui/src/lib/terraform.js). That
// file is loaded only once a preview is shown, never with the page.

function json(route: import('@playwright/test').Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/desk/spaces', (route) => json(route, { spaces: [
    { id: 'ipam/ip_space/a', name: 'Amsterdam Lab', yours: false, reason: '250 of 256 addresses free' },
  ] }));
  await page.route('**/api/ipam/subnets*', (route) => json(route, { subnets: [
    { id: 'ipam/subnet/s2', address: '10.2.1.0', cidr: 24, name: 'office-b' },
  ] }));
  await page.route('**/api/desk/runs', (route) => json(route, { runs: [] }));
});

test('after Preview, the IP job can be copied as Terraform, loaded only then', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const scripts: string[] = [];
  page.on('request', (r) => { if (r.resourceType() === 'script') scripts.push(r.url()); });
  await page.route('**/api/desk/run', (route) => json(route, { ok: true, dry_run: true, addresses: [{ address: '10.2.1.7' }] }));
  await page.goto('/#automate');
  const job = page.locator('[data-panel-id="automate-job"]');
  await job.getByRole('combobox', { name: 'IP space' }).selectOption('ipam/ip_space/a');
  await job.getByRole('combobox', { name: 'Subnet' }).selectOption('ipam/subnet/s2');
  await job.getByRole('textbox', { name: /What is it for/ }).fill('printer-02');
  await expect(job.locator('[data-terraform]')).toHaveCount(0);
  expect(scripts.filter((u) => /terraform/i.test(u))).toEqual([]);

  await job.getByRole('button', { name: 'Preview' }).click();
  await job.getByText('Run this from Terraform instead').click();
  await job.getByRole('button', { name: 'Copy as Terraform' }).click();
  await expect(job.locator('[data-terraform]').getByRole('status')).toHaveText('Copied. Paste it into a main.tf file.');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('source  = "infobloxopen/bloxone"');
  expect(clip).toContain('resource "bloxone_ipam_address" "this" {');
  expect(clip).toContain('next_available_id = "ipam/subnet/s2"');
  expect(clip).toContain('comment           = "printer-02"');
  // The Ansible copy is still there beside it.
  await expect(job.locator('[data-ansible]')).toHaveCount(1);
});
