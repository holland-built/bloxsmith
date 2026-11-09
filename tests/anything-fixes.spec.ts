import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { installBaselineWorld } from './page-fixtures';

// Fixes from the "change anything" pass. Each test failed on the code before it.

const ZONE = { id: 'zone1', fqdn: 'example.com' };

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

async function zones(page: Page) {
  await page.route('**/api/dns/zones*', (r) => r.fulfill({ json: { zones: [ZONE] } }));
  await page.route('**/api/desk/spaces*', (r) => r.fulfill({ status: 404, body: '{}' }));
  await page.route('**/api/ipam/spaces*', (r) => r.fulfill({ json: { spaces: [] } }));
}

test('an edit made while Preview is loading leaves no Create button for the old preview', async ({ page }) => {
  await zones(page);
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/dns/records', async (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    await held;
    return r.fulfill({ json: { ok: true, dry_run: true, record: { name_in_zone: 'www', dns_rdata: '192.0.2.10' } } });
  });
  await page.goto('/#selfservice');
  const card = page.locator('[data-panel-id="selfservice-create-record"]');
  await card.getByRole('combobox', { name: 'Zone' }).selectOption(ZONE.id);
  await card.getByLabel('Value').fill('192.0.2.10');
  await card.getByRole('button', { name: 'Preview' }).click();
  await card.getByLabel('Value').fill('192.0.2.99');
  release();
  await expect(card.getByText(/changed since|out of date|Preview again/i).first()).toBeVisible();
  await expect(card.getByRole('button', { name: 'Create', exact: true })).toHaveCount(0);
});

test('Delete does not arm when the record cannot be re-checked', async ({ page }) => {
  await zones(page);
  const rec = { id: 'rec-a', type: 'A', name_in_zone: 'www', ttl: 300, dns_rdata: '192.0.2.10', comment: '' };
  let reads = 0;
  await page.route('**/api/dns/records?*', (r) => {
    reads++;
    return reads === 1 ? r.fulfill({ json: { records: [rec] } }) : r.fulfill({ status: 502, json: { error: 'upstream' } });
  });
  await page.goto('/#selfservice');
  const card = page.locator('[data-panel-id="selfservice-manage-records"]');
  await card.locator('select').selectOption(ZONE.id);
  await card.getByRole('button', { name: 'Delete' }).click();
  await expect(card.getByText("Couldn't re-check that record, so it wasn't deleted. Try again.")).toBeVisible();
  await expect(card.getByRole('button', { name: 'Confirm delete' })).toHaveCount(0);
});

test('Allocate says which address it reserved', async ({ page }) => {
  await page.route('**/api/desk/spaces*', (r) => r.fulfill({ status: 404, body: '{}' }));
  await page.route('**/api/ipam/spaces*', (r) => r.fulfill({ json: { spaces: [{ id: 'sp1', name: 'Lab' }] } }));
  await page.route('**/api/ipam/blocks*', (r) => r.fulfill({ json: { blocks: [] } }));
  await page.route('**/api/ipam/subnets*', (r) => r.fulfill({ json: { subnets: [{ id: 'sub1', address: '10.1.2.0', cidr: 24, utilization: { free: 200 } }] } }));
  await page.route('**/api/selfservice/allocate', (r) => {
    const dry = r.request().postDataJSON().dry;
    return r.fulfill({ json: dry ? { ok: true, dry_run: true, addresses: [{ address: '10.1.2.30' }] } : { ok: true, addresses: [{ id: 'a1', address: '10.1.2.37' }] } });
  });
  await page.goto('/#selfservice');
  const card = page.locator('[data-panel-id="selfservice-allocate"]');
  await card.getByRole('combobox', { name: 'IP Space' }).selectOption({ label: 'Lab' });
  await card.getByRole('combobox', { name: 'Subnet' }).selectOption('sub1');
  await card.getByRole('button', { name: 'Preview' }).click();
  await card.getByRole('button', { name: 'Allocate', exact: true }).click();
  await expect(card.getByText('Done. 10.1.2.37 is yours.')).toBeVisible();
});

test('an incident ack is still ticked after a reload', async ({ page }) => {
  const s = { category: 'subnet-utilization', severity: 'crit', entity_id: 'ipam/subnet/x', entity_type: 'subnet', message: 'full', detected_at: 1789908095, source: 'network' };
  await page.route('**/api/incidents', (r) => r.fulfill({ json: {
    _meta: { leases: 'ok', subnets: 'ok', zones: 'ok' },
    incidents: [{ category: 'subnet-utilization', key: 'subnet-utilization', count: 1, severity: 'crit', entity_type: 'subnet', message: '1', sample_entities: [], first_detected_at: 1789908095 }],
    signals: [s], signals_total: 1, signals_truncated: false, signals_degraded: false, snoozes: {},
  } }));
  await page.goto('/#incidents');
  const box = page.getByRole('checkbox', { name: 'Acknowledge signal' }).first();
  await box.check();
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Acknowledge signal' }).first()).toBeChecked();
});

test('a follow-up question carries the earlier answer, and the chat survives a page change', async ({ page }) => {
  const bodies: { question: string; context?: string }[] = [];
  await page.route('**/api/query', (r) => { bodies.push(r.request().postDataJSON()); return r.fulfill({ json: { answer: `answer ${bodies.length}` } }); });
  await page.goto('/#ai');
  const input = page.getByRole('textbox', { name: 'Ask about your network' });
  await input.fill('which subnets are full?');
  await input.press('Enter');
  await expect(page.getByRole('log')).toContainText('answer 1');
  await page.goto('/#overview');
  await page.goto('/#ai');
  await expect(page.getByRole('log')).toContainText('answer 1');
  await input.fill('which of those is fullest?');
  await input.press('Enter');
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1].context).toContain('Q: which subnets are full?');
  expect(bodies[1].context).toContain('A: answer 1');
});

test('a page that fails to load after an update offers a reload button', async ({ page }) => {
  // Stop the one automatic reload so the message can be seen.
  await page.addInitScript(() => sessionStorage.setItem('bx:chunk-reload', String(Date.now())));
  await page.goto('/#overview');
  await page.route(/\/assets\/Incidents-[^/]*\.js$/, (r) => r.fulfill({ status: 404, body: '' }));
  await page.goto('/#incidents');
  await expect(page.getByRole('button', { name: 'Reload the page' })).toBeVisible();
});
