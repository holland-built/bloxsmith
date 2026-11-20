import { test, expect } from './fixtures';

// The demo seed's cloud tick boxes: AWS, Azure and Google Cloud are offered
// beside the three regions, start unticked so a default run seeds what it
// always did, and a ticked cloud is sent in the seed request's regions.

test.describe('Provision → Seed demo cloud choices', () => {
  test('AWS, Azure and Google Cloud are off by default; ticking AWS sends aws', async ({ page }) => {
    await page.route('**/api/vault/write-target*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ known: true, tenant: 't/-', label: 'Test Tenant', writable: true }) }));
    const asked: string[] = [];
    await page.route('**/api/provision/seed-demo/stream*', (route) => {
      asked.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ done: true, summary: { succeeded: [], failed: [], skipped: [] }, succeeded: 0, failed: 0, skipped: 0, total: 0 })}\n\n`,
      });
    });

    await page.goto('/#provision');
    await page.getByRole('button', { name: 'Seed demo', exact: true }).click();

    const aws = page.getByRole('checkbox', { name: /^AWS\b/ });
    const azure = page.getByRole('checkbox', { name: /^Azure\b/ });
    const gcp = page.getByRole('checkbox', { name: /^Google Cloud\b/ });
    for (const box of [aws, azure, gcp]) {
      await expect(box).toHaveCount(1);
      await expect(box).not.toBeChecked();
    }

    // The untouched default asks for the three regions only.
    await page.getByRole('button', { name: 'Preview', exact: true }).first().click();
    await expect.poll(() => asked.length).toBe(1);
    expect(new URL(asked[0]).searchParams.get('regions')).toBe('amer,emea,apac');

    await aws.check();
    await page.getByRole('button', { name: 'Preview', exact: true }).first().click();
    await expect.poll(() => asked.length).toBe(2);
    expect(new URL(asked[1]).searchParams.get('regions')).toBe('amer,emea,apac,aws');
  });
});
