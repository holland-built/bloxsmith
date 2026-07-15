import { test, expect } from '@playwright/test';

// Shared panel-sizing system (P0 slice 1):
//   1. panel-size token scale + Panel `size` prop (Triage no longer cramped)
//   2. maximize/fullscreen affordance on the shared Panel header (Esc + focus return)
//   3. compact incident banner (dense strip, not the tall .band)
// All three land on the SHARED Panel/IncidentsTab, so this exercises them on the
// Incidents tab where the Triage panel, the banner, and a maximizable panel co-exist.

test.use({ colorScheme: 'dark' });

const INCIDENTS = {
  incidents: [
    { key: 'k1', severity: 'crit', count: 3, message: 'Subnet exhaustion critical', sample_entities: ['10.1.0.0/24'], category: 'subnet' },
    { key: 'k2', severity: 'warn', count: 1, message: 'Zone drift detected', sample_entities: ['corp.local'], category: 'zone' },
  ],
  // Triage lists individual signals now (server inlines them next to the rollup);
  // the panel/maximize assertions need rows, and rows come from signals[].
  signals: [
    { source:'subnet', entity_type:'subnet', entity_id:'10.1.0.0/24', category:'subnet',
      severity:'crit', message:'Subnet exhaustion critical', detected_at:1784000000 },
    { source:'dns', entity_type:'zone', entity_id:'zone/example.com', category:'dns',
      severity:'warn', message:'TTL anomaly', detected_at:1784000000 },
  ],
  signals_total: 2,
  signals_truncated: false,
};

async function gotoIncidents(page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route('**/api/**', route => {
    const u = route.request().url();
    let body = '{}';
    if (u.includes('/api/incidents')) body = JSON.stringify(INCIDENTS);
    else if (u.includes('/api/actions')) body = '[]';
    else if (u.includes('/api/mcp/events')) body = '[]';
    else if (u.includes('/api/vault/status')) body = JSON.stringify({ vaultMode: false, unlocked: true });
    route.fulfill({ status: 200, contentType: 'application/json', body });
  });
  await page.goto('/#incidents', { waitUntil: 'networkidle' });
  await expect(page.locator('.tabbar')).toBeVisible();
}

// The Triage panel is the first .pcard on the Incidents page.
const triagePanel = page => page.locator('.page .pcard').first();

test('shared Panel renders a labeled maximize button in its header', async ({ page }) => {
  await gotoIncidents(page);
  const btn = triagePanel(page).locator('.pcard-max');
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('aria-label', /Maximize/i);
});

test('clicking maximize opens a fullscreen overlay containing the panel content', async ({ page }) => {
  await gotoIncidents(page);
  await expect(page.locator('.pcard-overlay')).toHaveCount(0);
  await triagePanel(page).locator('.pcard-max').click();
  const overlay = page.locator('.pcard-overlay');
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveAttribute('role', 'dialog');
  // overlay carries the panel's own content (the Triage table rows)
  await expect(overlay).toContainText('Subnet exhaustion critical');
  // overlay uses (nearly) the whole viewport
  const box = await overlay.boundingBox();
  expect(box!.height).toBeGreaterThan(700);
});

test('Esc closes the overlay and returns focus to the maximize button', async ({ page }) => {
  await gotoIncidents(page);
  const btn = triagePanel(page).locator('.pcard-max');
  await btn.click();
  await expect(page.locator('.pcard-overlay')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.pcard-overlay')).toHaveCount(0);
  await expect(btn).toBeFocused();
});

test('Triage panel body uses the size token (taller than a cramped fixed height)', async ({ page }) => {
  await gotoIncidents(page);
  // Only two short incident rows — without the size floor the panel would be
  // well under 300px. The `size` token gives it a real, consistent body height.
  const h = await triagePanel(page).evaluate(el => el.getBoundingClientRect().height);
  expect(h).toBeGreaterThanOrEqual(330);
});

test('incident banner is the compact strip, not the tall SynthBand', async ({ page }) => {
  await gotoIncidents(page);
  const strip = page.locator('.inc-strip');
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('critical'); // keeps the crit text
  // the tall full-width answer band is gone from this page
  await expect(page.locator('.page .band')).toHaveCount(0);
  // dense: the strip is much shorter than the old ~64px+ band
  const h = await strip.evaluate(el => el.getBoundingClientRect().height);
  expect(h).toBeLessThan(52);
});
