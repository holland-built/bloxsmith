import { test, expect } from '@playwright/test';

// Mocks /api/data with 2 subnets + 3 leases. leasesInSubnet (index.html) matches
// by octet prefix (/24 -> first 3 octets). Subnet Alpha (util 90) sorts first.

const DATA = {
  subnets: [
    { id: 's-a', name: 'Subnet Alpha', addr: '10.10.10.0', cidr: 24, util: 90, site: 'HQ' },
    { id: 's-b', name: 'Subnet Beta', addr: '10.20.20.0', cidr: 24, util: 20, site: 'DR' },
  ],
  leases: [
    { addr: '10.10.10.5', mac: 'aa:bb:cc:00:00:05', state: 'active', host: 'alpha-1' },
    { addr: '10.10.10.6', mac: 'aa:bb:cc:00:00:06', state: 'active', host: 'alpha-2' },
    { addr: '10.20.20.9', mac: 'aa:bb:cc:00:00:09', state: 'free', host: 'beta-1' },
  ],
  zones: [],
  hosts: [],
  auditLogs: [],
};

test('clicking a subnet row drills into leases, back restores the table', async ({ page }) => {
  await page.route('**/api/data', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DATA) })
  );

  await page.goto('/#network');
  const rows = page.locator('table.dt tbody tr.clickable');
  await expect(rows.first()).toBeVisible();

  // First (highest-util) subnet row = Subnet Alpha.
  await expect(rows.first()).toContainText('Subnet Alpha');
  await rows.first().click();

  // Hash gains the subnet param.
  await expect(page).toHaveURL(/subnet=/);

  // Drill panel: back button + Alpha's two matching leases.
  await expect(page.getByRole('button', { name: /Back/ })).toBeVisible();
  // v2 re-layout: the drill area is a <section> ("Subnet detail") holding a .grid
  // of two `Panel`s, and Panel now renders .pcard (not .panel) — .panel today only
  // matches the topbar ⋯ overflow + an unrelated Alerts panel. Scope to the section.
  const drill = page.locator('section:has-text("Subnet detail")');
  await expect(drill.locator('.pcard').first()).toContainText('Subnet Alpha');
  // Exactly Alpha's two matching leases, and not Beta's.
  await expect(drill.locator('table.dt tbody tr')).toHaveCount(2);

  // Back -> subnet table restored.
  await page.getByRole('button', { name: /Back/ }).click();
  await expect(page).not.toHaveURL(/subnet=/);
  await expect(page.locator('table.dt tbody tr.clickable').first()).toContainText('Subnet Alpha');
});
