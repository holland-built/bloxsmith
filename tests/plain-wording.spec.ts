import { test, expect } from './fixtures';
import { dataPayload, installBaselineWorld, openTask } from './page-fixtures';
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

test('a query-rate chart with no readings does not claim there were no queries', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/csp/dns-qps*', (r) => r.fulfill({ json: { status: 'ok', rows: [] } }));
  await page.goto('/#dns');
  const card = page.locator('[data-panel-id="dns-query-rate"]');
  await expect(card).toContainText('No DNS query rate readings for this period');
  await expect(card).not.toContainText('No DNS queries');
});

test('a failed Axur tile does not blame Infoblox', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/axur*', (r) => r.fulfill({ status: 500, json: {} }));
  await page.goto('/#security');
  const tile = page.getByRole('region', { name: 'Headline numbers' }).locator('[data-key="credentials"]');
  await expect(tile.locator('.sec-num')).toHaveText('Unknown');
  await expect(tile).toHaveAccessibleDescription('Not reported, so this is not known');
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

// ---------- a message never claims more than Bloxsmith knows ----------

const UNKNOWN = 'Bloxsmith did not get an answer, so this may or may not have happened. Refresh and check before trying again.';
const WRITABLE = { known: true, tenant: 't/-', label: 'Test Tenant', writable: true };
type Reply = (r: Route) => Promise<void>;
const noAnswer: [string, Reply][] = [
  ['no connection', (r) => r.abort()],
  ['502', (r) => r.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Bad gateway</h1>' })],
  ['504', (r) => r.fulfill({ status: 504, json: {} })],
  ['an unreadable 200', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: 'not json' })],
];

async function findOne(page: Page, reply: Reply) {
  await installBaselineWorld(page);
  await page.route('**/api/vault/write-target*', (r) => r.fulfill({ json: WRITABLE }));
  await page.route('**/api/made/find*', (r) => r.fulfill({ json: { results: [{ id: 'dns/record/r1', label: 'printer-02' }] } }));
  await page.route('**/api/made/delete', (r) => {
    const b = r.request().postDataJSON();
    if (b.dry) return r.fulfill({ json: { ok: true, dry_run: true, kind: b.kind, id: b.id, label: 'printer-02', made: true, gone: false, blocked: '', confirm: 'code-1' } });
    return reply(r);
  });
  await page.goto('/#made');
  await page.getByLabel('Name or address').fill('printer-02');
  await page.getByRole('button', { name: 'Find item' }).click();
  const row = page.locator('[data-delete-check="dns/record/r1"]');
  await row.getByRole('button', { name: /^Delete/ }).click();
  await row.getByRole('button', { name: 'Delete it' }).click();
  return row;
}

test('a refused delete keeps the row and its message', async ({ page }) => {
  const row = await findOne(page, (r) => r.fulfill({ status: 409, json: { ok: false, error: 'Still in use by a policy.' } }));
  await expect(row.getByRole('alert')).toHaveText('Still in use by a policy.');
  await expect(page.locator('[data-found]')).toContainText('printer-02');
});

for (const [name, reply] of noAnswer) {
  test(`a delete with ${name} says the outcome is unknown and keeps the row`, async ({ page }) => {
    const row = await findOne(page, reply);
    await expect(row.getByRole('alert')).toHaveText(UNKNOWN);
    await expect(page.locator('[data-found]')).toContainText('printer-02');
  });
}

async function allocate(page: Page, reply: Reply) {
  await installBaselineWorld(page);
  await page.route('**/api/vault/write-target*', (r) => r.fulfill({ json: WRITABLE }));
  await page.route('**/api/desk/spaces*', (r) => r.fulfill({ status: 404, body: '{}' }));
  await page.route('**/api/ipam/spaces*', (r) => r.fulfill({ json: { spaces: [{ id: 'ipam/ip_space/1', name: 'acme' }] } }));
  await page.route('**/api/ipam/blocks*', (r) => r.fulfill({ json: { blocks: [] } }));
  await page.route('**/api/ipam/subnets*', (r) => r.fulfill({ json: { subnets: [{ id: 'ipam/subnet/1', address: '10.0.42.0', cidr: 24, name: 's', utilization: { free: 200 } }] } }));
  await page.route('**/api/selfservice/allocate', (r) => (r.request().postDataJSON().dry
    ? r.fulfill({ json: { ok: true, dry_run: true, addresses: [{ address: '10.0.42.7' }] } }) : reply(r)));
  await page.goto('/#selfservice');
  const panel = await openTask(page, 'address');
  await panel.getByRole('combobox', { name: 'IP space' }).selectOption('ipam/ip_space/1');
  await panel.getByRole('button', { name: 'Preview' }).click();
  await expect(panel.getByText('10.0.42.7').first()).toBeVisible();
  await panel.getByRole('button', { name: /^(Allocate|Reserve|Get)/ }).last().click();
  return panel;
}

for (const [name, reply] of noAnswer) {
  test(`a create with ${name} does not invite a blind retry`, async ({ page }) => {
    const panel = await allocate(page, reply);
    await expect(panel).toContainText(UNKNOWN);
    await expect(panel).not.toContainText('Address allocated');
  });
}

test('a create the tenant could not be reached for does not claim no request completed', async ({ page }) => {
  const panel = await allocate(page, (r) => r.fulfill({ status: 502, json: { error: 'allocation failed (could not reach the tenant — no request completed)' } }));
  await expect(panel).toContainText(UNKNOWN);
  await expect(panel).not.toContainText('no request completed');
});

test('an empty 403 on a create says nothing was changed', async ({ page }) => {
  const panel = await allocate(page, (r) => r.fulfill({ status: 403, json: {} }));
  await expect(panel).toContainText("You don't have permission to do this. Nothing was changed.");
});

async function automateBuild(page: Page, reply: Reply) {
  await installBaselineWorld(page);
  await page.route('**/api/desk/spaces', (r) => r.fulfill({ json: { spaces: [{ id: 'ipam/ip_space/a', name: 'Lab', yours: false, reason: 'free' }] } }));
  await page.route('**/api/ipam/subnets*', (r) => r.fulfill({ json: { subnets: [{ id: 'ipam/subnet/s2', address: '10.2.1.0', cidr: 24, name: 'office-b' }] } }));
  await page.route('**/api/desk/runs', (r) => r.fulfill({ json: { runs: [] } }));
  await page.route('**/api/desk/run', (r) => (r.request().postDataJSON().dry
    ? r.fulfill({ json: { ok: true, dry_run: true, addresses: [{ address: '10.2.1.7' }] } }) : reply(r)));
  await page.goto('/#automate');
  const job = page.locator('[data-panel-id="automate-job"]');
  await job.getByRole('combobox', { name: 'IP space' }).selectOption('ipam/ip_space/a');
  await job.getByRole('combobox', { name: 'Subnet' }).selectOption('ipam/subnet/s2');
  await job.getByRole('textbox', { name: /What is it for/ }).fill('printer-02');
  await job.getByRole('button', { name: 'Preview' }).click();
  await job.getByRole('button', { name: 'Build it' }).click();
  return job;
}

test('an Automate build with no answer says the outcome is unknown', async ({ page }) => {
  const job = await automateBuild(page, (r) => r.fulfill({ status: 504, json: {} }));
  await expect(job).toContainText(UNKNOWN);
});

test('an Automate preview that fails keeps its normal message', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/desk/spaces', (r) => r.fulfill({ json: { spaces: [{ id: 'ipam/ip_space/a', name: 'Lab', yours: false, reason: 'free' }] } }));
  await page.route('**/api/ipam/subnets*', (r) => r.fulfill({ json: { subnets: [{ id: 'ipam/subnet/s2', address: '10.2.1.0', cidr: 24, name: 'office-b' }] } }));
  await page.route('**/api/desk/runs', (r) => r.fulfill({ json: { runs: [] } }));
  await page.route('**/api/desk/run', (r) => r.fulfill({ status: 502, json: {} }));
  await page.goto('/#automate');
  const job = page.locator('[data-panel-id="automate-job"]');
  await job.getByRole('combobox', { name: 'IP space' }).selectOption('ipam/ip_space/a');
  await job.getByRole('combobox', { name: 'Subnet' }).selectOption('ipam/subnet/s2');
  await job.getByRole('textbox', { name: /What is it for/ }).fill('printer-02');
  await job.getByRole('button', { name: 'Preview' }).click();
  await expect(job).toContainText('Could not run this job.');
  await expect(job).not.toContainText(UNKNOWN);
});

for (const [what, panelTask, url] of [['record', 'records', 'dns'], ['address', 'addresses', 'ipam']] as const) {
  test(`a 403 with a reason on a ${what} delete keeps the reason and says it was not changed`, async ({ page }) => {
    await installBaselineWorld(page);
    await page.route('**/api/vault/write-target*', (r) => r.fulfill({ json: WRITABLE }));
    await page.route('**/api/dns/zones*', (r) => r.fulfill({ json: { zones: [ZONE] } }));
    await page.route('**/api/dns/records*', (r) => r.fulfill({ json: { records: [RECORD] } }));
    await page.route('**/api/ipam/spaces*', (r) => r.fulfill({ json: { spaces: [{ id: 'space1', name: 'Default' }] } }));
    await page.route('**/api/ipam/subnets*', (r) => r.fulfill({ json: { subnets: [{ id: 'subnet1', address: '10.0.0.0', cidr: 24, name: 'sub' }] } }));
    await page.route('**/api/ipam/addresses*', (r) => r.fulfill({ json: { addresses: [{ id: 'ipam/address/a1', address: '10.0.0.9', state: 'used', usage: ['IPAM RESERVED'] }] } }));
    await page.route('**/api/made/delete', (r) => {
      const b = r.request().postDataJSON();
      if (b.dry) return r.fulfill({ json: { ok: true, dry_run: true, kind: b.kind, id: b.id, label: b.id, made: true, made_on: '2026-11-13T10:00:00Z', gone: false, blocked: '', confirm: 'c' } });
      return r.fulfill({ status: 403, json: { ok: false, error: 'Mark this tenant writable' } });
    });
    await page.goto('/#selfservice');
    const card = await openTask(page, panelTask);
    if (url === 'dns') await card.locator('select').selectOption(ZONE.id);
    else {
      await card.locator('select').first().selectOption('space1');
      await card.locator('select').nth(1).selectOption('subnet1');
    }
    await card.getByRole('button', { name: /^(Delete|Release)/ }).first().click();
    await card.getByRole('button', { name: /^Confirm/ }).click();
    await expect(card).toContainText(`Mark this tenant writable. ${what === 'record' ? 'The record was not deleted.' : 'The address was not released.'}`);
  });
}

test('an empty 403 on a record update says nothing was changed', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/vault/write-target*', (r) => r.fulfill({ json: WRITABLE }));
  await page.route('**/api/dns/zones*', (r) => r.fulfill({ json: { zones: [ZONE] } }));
  await page.route('**/api/dns/records*', (r) => {
    const req = r.request();
    if (req.method() === 'GET') return r.fulfill({ json: { records: [RECORD] } });
    const body = req.postDataJSON();
    return body.dry ? r.fulfill({ json: { would_update: body } }) : r.fulfill({ status: 403, json: {} });
  });
  await page.goto('/#selfservice');
  const card = await openTask(page, 'records');
  await card.locator('select').selectOption(ZONE.id);
  const row = card.locator('.rounded-control.border.border-border.p-2').filter({ hasText: RECORD.dns_rdata });
  await row.getByRole('button', { name: 'Edit' }).click();
  await row.locator('input').first().fill('10.0.0.2');
  await row.getByRole('button', { name: 'Preview' }).click();
  await row.getByRole('button', { name: 'Update' }).click();
  await expect(card).toContainText("You don't have permission to do this. Nothing was changed.");
});

test('an audit log that could not be read is not called empty', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/audit/log*', (r) => r.fulfill({ json: { entries: [], chain_valid: true, read_error: 'is a directory' } }));
  await page.goto('/#audit');
  await expect(page.getByText('Audit log unavailable').first()).toBeVisible();
  await expect(page.locator('body')).not.toContainText('No audit entries yet');
});

const tinyOnly = () => ({ ...dataPayload(), subnets: [{ id: 'ipam/subnet/t1', addr: '10.9.0.0', cidr: 30, util: 50, used: 1, total: 2, site: 'x' }] });

test('Network names what is missing from the list', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/data', (r) => r.fulfill({ json: tinyOnly() }));
  await page.route('**/api/ipam/subnets/unused*', (r) => r.fulfill({ json: { subnets: [], more: false } }));
  await page.goto('/#network');
  const card = page.locator('[data-panel-id="network-exhaustion"]');
  await expect(card).toContainText('No networks of /28 or larger');
  await page.goto('/#network?unused=1');
  await expect(card).toContainText('No unused networks found');
});

test('Daily says only that no network of /28 or larger was loaded', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/data', (r) => r.fulfill({ json: tinyOnly() }));
  await page.goto('/#daily');
  await expect(page.locator('[data-panel-id="daily-top-capacity-risks"]')).toContainText('No networks of /28 or larger in the loaded data');
});

test('IPAM spaces with no capacity figure are not called missing', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/csp/ipam-util*', (r) => r.fulfill({ json: { status: 'ok', rows: [{ id: 'a', label: 'A', used: 0, total: 0 }] } }));
  await page.goto('/#network');
  const card = page.locator('[data-panel-id="network-ipam-spaces"]');
  await expect(card).toContainText('No IP spaces report how full they are');
  await expect(card).not.toContainText('No IP spaces found');
});

test('first load shows neither an empty network list nor an empty connection', async ({ page }) => {
  await installBaselineWorld(page);
  let release = () => {};
  const held = new Promise<void>((done) => { release = done; });
  await page.route('**/api/data', async (r) => { await held; await r.fulfill({ json: dataPayload() }).catch(() => {}); });
  await page.goto('/#network');
  const bands = page.locator('[data-panel-id="network-utilization-distribution"]');
  await expect(bands).toBeVisible();
  await expect(bands).not.toContainText('No subnets found');
  await expect(page.locator('[data-panel-id="network-exhaustion"]')).not.toContainText('No subnets found');
  await expect(page.locator('.frame-conn-body [data-state]')).toHaveText('checking');
  release();
});

test('a generic 403 on a record delete reads as no permission', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/vault/write-target*', (r) => r.fulfill({ json: WRITABLE }));
  await page.route('**/api/dns/zones*', (r) => r.fulfill({ json: { zones: [ZONE] } }));
  await page.route('**/api/dns/records*', (r) => r.fulfill({ json: { records: [RECORD] } }));
  await page.route('**/api/made/delete', (r) => {
    const b = r.request().postDataJSON();
    if (b.dry) return r.fulfill({ json: { ok: true, dry_run: true, kind: b.kind, id: b.id, label: b.id, made: true, made_on: '2026-11-13T10:00:00Z', gone: false, blocked: '', confirm: 'c' } });
    return r.fulfill({ status: 403, json: { ok: false, error: 'delete failed (status 403)' } });
  });
  await page.goto('/#selfservice');
  const card = await openTask(page, 'records');
  await card.locator('select').selectOption(ZONE.id);
  await card.getByRole('button', { name: /^Delete/ }).first().click();
  await card.getByRole('button', { name: /^Confirm/ }).click();
  await expect(card).toContainText("You don't have permission to see this. Check the key in Settings. The record was not deleted.");
  await expect(card).not.toContainText('delete failed');
});

test('a block with no clear answer says the outcome is unknown', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/vault/write-target*', (r) => r.fulfill({ json: WRITABLE }));
  await page.route('**/api/block-domain', (r) => r.fulfill({ status: 502, json: { ok: false, outcome: 'rejected', error: 'block request rejected: EOF' } }));
  await page.goto('/#security');
  await page.locator('button.sec-block').first().click({ force: true });
  await expect(page.getByText(UNKNOWN).first()).toBeVisible();
});

test('a block that was never sent says so instead of unknown', async ({ page }) => {
  const notSent = 'Infoblox did not answer within 30s. Nothing was sent.';
  await installBaselineWorld(page);
  await page.route('**/api/vault/write-target*', (r) => r.fulfill({ json: WRITABLE }));
  await page.route('**/api/block-domain', (r) => r.fulfill({ status: 502, json: { ok: false, outcome: 'not-sent', error: notSent } }));
  await page.goto('/#security');
  await page.locator('button.sec-block').first().click({ force: true });
  await expect(page.getByText(notSent).first()).toBeVisible();
  await expect(page.getByText(UNKNOWN)).toHaveCount(0);
});

test('an Automate remove with no answer says the outcome is unknown', async ({ page }) => {
  await installBaselineWorld(page);
  const run = { id: 'r-1', job: 'ip', title: 'IP address', created: '2026-11-05T12:00:00Z', status: 'built',
    objects: [{ id: 'ipam/address/a1', kind: 'address', label: '10.2.1.7', state: 'created' }] };
  await page.route('**/api/desk/spaces', (r) => r.fulfill({ json: { spaces: [] } }));
  await page.route('**/api/desk/runs', (r) => r.fulfill({ json: { runs: [run] } }));
  await page.route('**/api/desk/remove', (r) => (r.request().postDataJSON().dry
    ? r.fulfill({ json: { dry_run: true, run, would_remove: [{ id: 'ipam/address/a1', label: '10.2.1.7', exists: true }] } })
    : r.fulfill({ status: 504, json: {} })));
  await page.goto('/#automate');
  const row = page.locator('[data-run="r-1"]');
  await row.getByRole('button', { name: 'Remove' }).click();
  await row.locator('[data-remove-plan]').getByRole('button').first().click();
  await expect(row).toContainText(UNKNOWN);
});

test('a made item with an unknown delete is not called undeletable', async ({ page }) => {
  await installBaselineWorld(page);
  await page.route('**/api/desk/runs', (r) => r.fulfill({ json: { tenant: 't/-', runs: [{ id: 'r-1', title: 'IP address', created: '2026-11-05T12:00:00Z', tenant: 't/-', status: 'remove-failed',
    objects: [{ id: 'ipam/address/a1', kind: 'address', label: '10.2.1.7', state: 'failed', error: UNKNOWN }] }] } }));
  await page.goto('/#made');
  const row = page.locator('[data-made-run="r-1"]');
  await expect(row).toContainText('result unknown');
  await expect(row).not.toContainText('could not be deleted');
});
