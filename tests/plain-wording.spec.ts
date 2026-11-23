import { test, expect } from './fixtures';
import { installBaselineWorld, openTask } from './page-fixtures';
import type { Page, Route } from '@playwright/test';

// The words customers should never read, checked in the text each main page
// really shows. "Threat feed" stays: it is the Infoblox product term.
const BANNED: [string, RegExp][] = [
  ['feed', /(?<!threat )(?<![-\w])feeds?\b(?!-)/i],
  ['upstream', /\bupstream\b/i],
  ['tofu', /\btofu\b/i],
  ['cube', /\bcubes?\b/i],
  ['not entitled', /\bnot entitled\b/i],
  ['no data', /\bno data\b/i],
  ['Act or Look as a state', /^(Act|Look)$/m],
  ['a bare HTTP code', /\bHTTP \d{3}\b/],
];

const PAGES = ['overview', 'daily', 'best-practices', 'value', 'network', 'dns', 'security', 'infra', 'assets',
  'incidents', 'audit', 'changes', 'automate', 'provision', 'selfservice', 'editor', 'drift', 'lists', 'made',
  'demo', 'ai', 'chart'];

// The calls the app frame needs to draw at all stay real in every state.
const FRAME = /\/api\/(brand|update|views|tenants|vault|auth|settings|health|version)/;

async function visibleProblems(page: Page, id: string) {
  await page.goto(`/#${id}`);
  await expect(page.locator('h1').first()).toBeVisible();
  await page.waitForTimeout(900);
  const text = await page.locator('body').innerText();
  return BANNED.filter(([, re]) => re.test(text)).map(([name, re]) => `${name}: "${text.slice(Math.max(0, text.search(re) - 40), text.search(re) + 30).replace(/\s+/g, ' ')}"`);
}

const answer = (body: unknown, status = 200) => (route: Route) => {
  if (route.request().method() !== 'GET' || FRAME.test(route.request().url())) return route.fallback();
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
};

for (const id of PAGES) {
  test(`${id}: no internal words when loaded`, async ({ page }) => {
    await installBaselineWorld(page);
    expect(await visibleProblems(page, id)).toEqual([]);
  });

  test(`${id}: no internal words when empty`, async ({ page }) => {
    await installBaselineWorld(page);
    await page.route('**/api/**', answer({}));
    expect(await visibleProblems(page, id)).toEqual([]);
  });

  test(`${id}: no internal words when loading failed`, async ({ page }) => {
    await installBaselineWorld(page);
    await page.route('**/api/**', answer({}, 500));
    expect(await visibleProblems(page, id)).toEqual([]);
  });
}

test('a failed find says what failed and what to do', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/made/find*', (r) => r.fulfill({ status: 500, json: {} }));
  await page.goto('/#made');
  await page.getByLabel('Name or address').fill('printer-02');
  await page.getByRole('button', { name: 'Find item' }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'Could not find' });
  await expect(alert).toContainText('Try again');
  await expect(page.locator('body')).not.toContainText('HTTP 500');
});

test('an empty message names what is empty, and a failed load never shows it', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/lookalikes*', (r) => r.fulfill({ json: { domains: [], targets: [] } }));
  await page.goto('/#security');
  const card = page.locator('[data-panel-id="security-lookalike-domains"]');
  await expect(card).toContainText('No lookalike domains found');

  await page.unroute('**/api/lookalikes*');
  await page.route('**/api/lookalikes*', (r) => r.fulfill({ status: 500, json: {} }));
  await page.reload();
  await expect(card).toContainText('Lookalike domain information is unavailable');
  await expect(card).not.toContainText('No lookalike domains found');
});

test('Security marks an event as seen in the same words as Incidents', async ({ page }) => {
  await installBaselineWorld(page);
  await page.goto('/#security');
  await expect(page.getByRole('checkbox', { name: /^Mark .+ as seen$/ }).first()).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /^Acknowledge / })).toHaveCount(0);
});

const ZONE = { id: 'dns/auth_zone/z1', fqdn: 'example.com.', view: 'dns/view/v1' };
const RECORD = { id: 'dns/record/r1', name_in_zone: 'www', type: 'A', dns_rdata: '10.0.0.1', ttl: 300, zone: ZONE.id, comment: '' };

async function openRecords(page: Page) {
  await installBaselineWorld(page);
  await page.route('**/api/dns/zones*', (r) => r.fulfill({ json: { zones: [ZONE], total: 1 } }));
  await page.route('**/api/dns/records*', (r) => r.fulfill({ json: { records: [RECORD], total: 2 } }));
  await page.goto('/#selfservice');
  const card = await openTask(page, 'records');
  await card.locator('select').selectOption(ZONE.id);
  await expect(card.getByText('www').first()).toBeVisible();
  return card;
}

for (const status of [401, 403]) {
  test(`Show more reads a ${status} as no permission`, async ({ page }) => {
    const card = await openRecords(page);
    await page.route('**/api/dns/records*_offset=*', (r) => r.fulfill({ status, json: {} }));
    await card.getByRole('button', { name: /^Show \d+ more$/ }).click();
    await expect(card).toContainText("You don't have permission to see this.");
    await expect(card).toContainText('No more rows were loaded.');
    await expect(card).not.toContainText(`HTTP ${status}`);
  });

  test(`the delete re-check reads a ${status} as no permission and says nothing was deleted`, async ({ page }) => {
    const card = await openRecords(page);
    await page.route('**/api/dns/records*', (r) => r.fulfill({ status, json: {} }));
    await card.getByRole('button', { name: /^Delete/ }).first().click();
    await expect(card).toContainText("You don't have permission to see this.");
    await expect(card).toContainText('The record was not deleted.');
  });
}
