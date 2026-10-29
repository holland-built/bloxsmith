import { test, expect } from '@playwright/test';

// The UX audit of 2026-10-26 found three dead ends: search only on Cmd+K, a
// search page that never named the subnet a free address sits in, and an AI
// answer that failed with no way to ask again.

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

test('on a phone the Search button on the page bar opens the same search as Cmd+K', async ({ page }) => {
  // From md up the header's search box does this job and the button is hidden.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#overview');
  await page.getByRole('button', { name: /^Search/ }).click();
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
});

test('a free IPv4 address is placed in the subnet that holds it', async ({ page }) => {
  const none = { availability: 'ok', rows: [], truncated: false, limit: 50 };
  await page.route('**/api/csp/assets?*', (r) => r.fulfill(json(none)));
  await page.route('**/api/search/dns?*', (r) => r.fulfill(json(none)));
  await page.route('**/api/search/ipam?*', (r) => r.fulfill(json(none)));
  await page.route('**/api/dossier?*', (r) => r.fulfill(json({ query: '10.80.0.5', type: 'ip', summary: {}, sources: [] })));
  await page.route('**/api/csp-audit?*', (r) => r.fulfill(json(none)));
  await page.route('**/api/search/subnet?*', (r) =>
    r.fulfill(json({ availability: 'ok', rows: [{ id: 's', address: '10.80.0.0', cidr: 22, name: 'dub-wired' }], truncated: false, limit: 50 })),
  );
  await page.goto('/#dossier?q=10.80.0.5');
  await expect(page.locator('[data-dossier-summary]')).toHaveText(
    "10.80.0.5 looks free. It's inside subnet 10.80.0.0/22 (dub-wired). No IPAM record, DNS record or asset uses it.",
  );
});

test('a failed AI question offers Try again, which asks the same question', async ({ page }) => {
  const asked: string[] = [];
  await page.route('**/api/query', async (route) => {
    asked.push(JSON.parse(route.request().postData() || '{}').question);
    return route.fulfill(json(asked.length === 1 ? { error: 'provider refused' } : { answer: 'Two subnets are over 80%.' }));
  });
  await page.goto('/#ai');
  const box = page.getByPlaceholder('Ask about your network…');
  await box.fill('Which subnets are nearly full?');
  await box.press('Enter');
  const log = page.getByRole('log');
  await expect(log.getByText('provider refused')).toBeVisible();
  await log.getByRole('button', { name: 'Try again' }).click();
  await expect(log.getByText('Two subnets are over 80%.')).toBeVisible();
  expect(asked).toEqual(['Which subnets are nearly full?', 'Which subnets are nearly full?']);
});

test('while a question runs, the chat says it is working and counts the seconds', async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/query', async (route) => {
    await held;
    return route.fulfill(json({ answer: 'Done.' }));
  });
  await page.goto('/#ai');
  const box = page.getByPlaceholder('Ask about your network…');
  await box.fill('Which hosts are offline?');
  await box.press('Enter');
  await expect(page.getByText(/Looking this up in your Infoblox account… \d+ s/)).toBeVisible();
  release();
  await expect(page.getByRole('log').getByText('Done.')).toBeVisible();
  await expect(page.getByText(/Looking this up/)).toHaveCount(0);
});
