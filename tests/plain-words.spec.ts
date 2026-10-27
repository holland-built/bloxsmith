import { test, expect } from '@playwright/test';

// The plain-words pass from the UX audit of 2026-10-26: incidents worst first
// and named by what they are about, engineering labels in everyday words, and
// the Assets search box kept inside its card on a phone.

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const now = Math.floor(Date.now() / 1000);

test('Incidents lists the critical one first, by name, in plain words', async ({ page }) => {
  const zone = (i: number) => ({
    source: 'network', entity_type: 'zone', entity_id: `dns/auth_zone/uuid-${i}`, category: 'dns-ttl-anomaly',
    severity: 'warn', message: `zone${i}.example.com.: High Neg-TTL`, detected_at: now - 60 * i,
  });
  await page.route('**/api/incidents*', (r) => r.fulfill(json({
    _meta: { leases: 'ok', subnets: 'ok', zones: 'ok' },
    incidents: [
      { category: 'dns-ttl-anomaly', count: 3, severity: 'warn', message: '3 dns ttl anomaly', key: 'a' },
      { category: 'dnssec-unsigned', count: 1, severity: 'crit', message: '1 dnssec unsigned', key: 'b' },
    ],
    signals: [
      zone(1), zone(2), zone(3),
      { source: 'dns', entity_type: 'posture', entity_id: 'dnssec-posture', category: 'dnssec-unsigned', severity: 'crit', message: '602 of 602 DNS zones unsigned (DNSSEC)', detected_at: now - 90 * 86400 },
    ],
    signals_degraded: false, signals_total: 4, signals_truncated: false, snoozes: {},
  })));
  await page.goto('/#incidents');
  const triage = page.locator('[data-panel-id]').filter({ has: page.getByRole('heading', { name: 'Triage' }) });
  const firstRow = triage.getByRole('row').nth(1);
  await expect(firstRow).toContainText('602 of 602 DNS zones not signed (DNSSEC)');
  await expect(firstRow).toContainText('All DNS zones');
  await expect(triage).toContainText('zone1.example.com.: remembers "not found" too long');
  await expect(triage).not.toContainText('High Neg-TTL');
  await expect(triage).not.toContainText('dns/auth_zone/uuid-1');
  await expect(page.getByRole('button', { name: /DNS zone timing/ })).toBeVisible();
});

test('Audit names each kind of event in words', async ({ page }) => {
  const entry = (seq: number, event: string) => ({ actor: 'op', detail: {}, event, hash: `h${seq}`, prev_hash: seq ? `h${seq - 1}` : '', seq, ts: now - 3600 * (5 - seq) });
  const entries = [entry(0, 'update-apply'), entry(1, 'write-authorized'), entry(2, 'write-refused-read-only'), entry(3, 'provision-subnet-error')];
  await page.route('**/api/audit/log*', (r) => r.fulfill(json({
    chain_valid: true, chain_state: 'ok', chain_detail: '', chain_verify_error: null, broken_index: null, broken_reason: null,
    append_failures: 0, entries, returned: entries.length, total: entries.length, truncated: false,
  })));
  await page.goto('/#audit');
  // In the log's own rows (the filter's <option>s carry the same words, hidden).
  const log = page.getByRole('table').first();
  await expect(log.getByText('Change blocked (read-only)')).toBeVisible();
  await expect(log.getByText("Couldn't create a subnet")).toBeVisible();
  const options = page.getByRole('combobox').filter({ has: page.locator('option', { hasText: 'All events' }) }).locator('option');
  const texts = await options.allTextContents();
  expect(texts.some((t) => /^[a-z]+(-[a-z]+)+$/.test(t)), `a raw event id is still shown: ${texts.join(', ')}`).toBe(false);
});

test('on a phone the Assets search box stays inside its card', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#assets');
  const box = page.getByRole('textbox', { name: 'Search assets by name' });
  const card = page.locator('[data-panel-id]').filter({ has: box });
  const b = await box.boundingBox();
  const c = await card.boundingBox();
  expect(b!.x).toBeGreaterThanOrEqual(c!.x);
  expect(b!.x + b!.width).toBeLessThanOrEqual(c!.x + c!.width);
});
