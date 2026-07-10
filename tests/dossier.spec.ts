import { test, expect } from '@playwright/test';

// SECURITY External-intel (Dossier). SecThreatLookup fires /api/dossier AND
// /api/threat-lookup on Lookup; we mock both plus hub/security (empty) so the page
// is deterministic and interactive.

const EMPTY_SEC = { counts: {}, blocked: 0, logged: 0, total: 0, events: [] };

async function mockBase(page: any, dossier: any) {
  await page.route('**/api/hub/security', (r: any) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(EMPTY_SEC) }));
  await page.route('**/api/threat-lookup**', (r: any) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entities: [], query: 'eicar.co' }) }));
  await page.route('**/api/dossier**', (r: any) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dossier) }));
}

test('dossier lookup shows the External intel block with a malicious pill', async ({ page }) => {
  await mockBase(page, {
    summary: { malicious: true, max_threat_level: 100, threat_classes: ['Malware'] },
    sources: [{ source: 'X', detail: 'y' }],
    unavailable: null,
  });

  await page.goto('/#security');

  const input = page.getByLabel('Threat lookup query');
  await expect(input).toBeVisible();
  await input.fill('eicar.co');
  await page.getByRole('button', { name: /Lookup/ }).click();

  const dossier = page.locator('div', { hasText: 'External intel (Dossier)' }).last();
  await expect(page.getByText('External intel (Dossier)')).toBeVisible();
  await expect(page.getByText('malicious', { exact: true })).toBeVisible();
});

test('an unavailable dossier renders the dim "unavailable" message', async ({ page }) => {
  await mockBase(page, { unavailable: 'Threat IQ not entitled' });

  await page.goto('/#security');
  await page.getByLabel('Threat lookup query').fill('eicar.co');
  await page.getByRole('button', { name: /Lookup/ }).click();

  await expect(page.getByText(/External intel unavailable: Threat IQ not entitled/)).toBeVisible();
});
