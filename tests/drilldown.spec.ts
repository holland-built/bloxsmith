import { test, expect } from '@playwright/test';

// Overview → deeper-tab drill-downs: the click must land on the SAME data, filtered.

test('Subnets ≥90% KPI drills to Network with minUtil filter chip', async ({ page }) => {
  await page.goto('/#overview');
  await page.getByText('Subnets ≥90%').click();
  await expect(page).toHaveURL(/#network\?minUtil=90/);
  await expect(page.getByText(/util ≥ 90/)).toBeVisible();
  // dismiss chip clears the filter
  await page.getByText(/util ≥ 90/).getByText('✕').or(page.getByRole('button', { name: /✕/ }).first()).click();
  await expect(page).toHaveURL(/#network(?!\?minUtil)/);
});

test('host status legend drills to Infra with status chip', async ({ page }) => {
  await page.goto('/#overview');
  await page.getByText('Offline', { exact: true }).first().click();
  await expect(page).toHaveURL(/#infra\?status=offline/);
  await expect(page.getByText(/status: offline/)).toBeVisible();
});

test('Daily zones-with-issues KPI drills to DNS issues-only view', async ({ page }) => {
  await page.goto('/#daily');
  await page.getByText('DNS Zones w/ Issues').click();
  await expect(page).toHaveURL(/#dns\?issues=1/);
  await expect(page.getByText(/issues only/)).toBeVisible();
});
