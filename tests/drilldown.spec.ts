import { test, expect } from './fixtures';

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

  // Unlike the other two drill-downs in this file, this legend row does not
  // exist in the DOM until /api/data has resolved AND at least one host
  // buckets as Offline — 'Subnets ≥90%' and 'DNS Zones w/ Issues' are static
  // KPI labels present from first paint (they fall back to a "(loaded rows)"
  // variant while data is in flight, so the label text is there regardless).
  // A bare `getByText('Offline', { exact: true }).first()` only ever resolved
  // correctly because, today, it happens to be the sole exact-case "Offline"
  // text on the page — an accident of the current UI, not a guarantee, and it
  // gave no explicit signal that the legend had actually finished loading
  // before the click fired. Scoping to the one control whose accessible name
  // starts with "Offline" (the legend row is a role="button" element, unlike
  // any plain text on the page) removes the .first() guesswork, and waiting
  // on it explicitly before clicking mirrors write-lock's fix: wait for the
  // specific condition that makes the click meaningful, don't race the fetch.
  const offlineRow = page.getByRole('button', { name: /^Offline/ });
  await expect(offlineRow).toBeVisible();
  await offlineRow.click();
  await expect(page).toHaveURL(/#infra\?status=offline/);
  await expect(page.getByText(/status: offline/)).toBeVisible();
});

test('Daily zones-with-issues KPI drills to DNS issues-only view', async ({ page }) => {
  await page.goto('/#daily');
  await page.getByText('DNS Zones w/ Issues').click();
  await expect(page).toHaveURL(/#dns\?issues=1/);
  await expect(page.getByText(/issues only/)).toBeVisible();
});
