import { test, expect } from './fixtures';
import type { Page, Route } from '@playwright/test';

// Sibling of tests/selfservice-picker-failure.spec.ts, which proved the same
// distinction for SelfService's pickers.
//
// Part 1 — Provision.jsx and Drift.jsx read their pickers with useApi() and then
// `data?.spaces ?? []` / `Array.isArray(data) ? data : []`. /api/ipam/spaces and
// /api/ipam/blocks answer 502 on an upstream failure and /api/templates answers
// 500, and every one of those collapses into the SAME empty array a tenant that
// genuinely owns nothing produces. Unread, the select showed its placeholder and
// Apply sat disabled with no reason given — a dead backend rendered as a tenant
// that owns nothing. Each picker is asserted BOTH ways: failed read shows the
// fetch-error and NOT the "no X" wording, genuine empty shows "no X" and NOT the
// fetch-error. Without the second half these specs would pass on code that
// screams "could not load" at an empty tenant.
//
// Part 2 — go/internal/edit/resources.go:Delete maps an upstream 404 to
// {ok:true, already_gone:true} and a real 200/204 to {ok:true,
// already_gone:false}, deliberately, so a real deletion and a no-op cannot be
// confused in the audit log. Editor.jsx and SelfService.jsx both threw that away
// and said "deleted." either way — telling an operator they deleted a record a
// colleague had already removed. Both arms are asserted, and the wording must
// differ.

const CARD_XPATH = 'xpath=ancestor::div[contains(@class,"bg-card")]';
const FETCH_ERROR = /could not load current data/i;

const SPACE = { id: 'space1', name: 'Default' };
const BLOCK = { id: 'block1', name: 'core', address: '10.0.0.0', cidr: 16 };
const TEMPLATE = { name: 'amer-site-1', region: 'amer', environment: 'prod', type: 'site' };

type Json = Record<string, unknown> | unknown[];

/** Stub one endpoint with either a payload or an upstream failure status. */
function stub(page: Page, glob: string, body: Json | number) {
  return page.route(glob, (route: Route) =>
    typeof body === 'number'
      ? route.fulfill({ status: body, json: { error: 'upstream failed' } })
      : route.fulfill({ json: body }),
  );
}

const SPACES = '**/api/ipam/spaces*';
const BLOCKS = '**/api/ipam/blocks*';
const TEMPLATES = '**/api/templates*';

function card(page: Page, title: string) {
  return page.locator('h2', { hasText: title }).locator(CARD_XPATH);
}

// ---------------------------------------------------------------------------
// Provision — Subnet mode (spaces + blocks)
// ---------------------------------------------------------------------------

test.describe('Provision / Subnet — failed read vs genuine empty', () => {
  test('a failed /api/ipam/spaces read shows a fetch-error, not "no IP spaces"', async ({ page }) => {
    await stub(page, SPACES, 502);
    await stub(page, BLOCKS, { blocks: [] });
    await stub(page, TEMPLATES, []);

    await page.goto('/#provision');

    const request = card(page, 'Request');
    await expect(request.getByText(FETCH_ERROR)).toBeVisible();
    await expect(request.getByText(/could not load current data: 502/i)).toBeVisible();
    await expect(request.getByText('no IP spaces', { exact: true })).toHaveCount(0);
  });

  test('a genuinely empty /api/ipam/spaces read still shows "no IP spaces"', async ({ page }) => {
    await stub(page, SPACES, { spaces: [] });
    await stub(page, BLOCKS, { blocks: [] });
    await stub(page, TEMPLATES, []);

    await page.goto('/#provision');

    const request = card(page, 'Request');
    await expect(request.getByText('no IP spaces', { exact: true })).toBeVisible();
    await expect(request.getByText(FETCH_ERROR)).toHaveCount(0);
  });

  test('a failed /api/ipam/blocks read shows a fetch-error, not "no address blocks"', async ({ page }) => {
    await stub(page, SPACES, { spaces: [SPACE] });
    await stub(page, BLOCKS, 502);
    await stub(page, TEMPLATES, []);

    await page.goto('/#provision');

    const request = card(page, 'Request');
    await request.locator('select').first().selectOption(SPACE.id);

    await expect(request.getByText(FETCH_ERROR)).toBeVisible();
    await expect(request.getByText('no address blocks', { exact: true })).toHaveCount(0);
  });

  test('a genuinely empty /api/ipam/blocks read still shows "no address blocks"', async ({ page }) => {
    await stub(page, SPACES, { spaces: [SPACE] });
    await stub(page, BLOCKS, { blocks: [] });
    await stub(page, TEMPLATES, []);

    await page.goto('/#provision');

    const request = card(page, 'Request');
    await request.locator('select').first().selectOption(SPACE.id);

    await expect(request.getByText('no address blocks', { exact: true })).toBeVisible();
    await expect(request.getByText(FETCH_ERROR)).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Provision — Full site mode (templates)
// ---------------------------------------------------------------------------

test.describe('Provision / Full site — failed read vs genuine empty', () => {
  test('a failed /api/templates read shows a fetch-error, not "no templates"', async ({ page }) => {
    await stub(page, SPACES, { spaces: [SPACE] });
    await stub(page, TEMPLATES, 500);

    await page.goto('/#provision');
    await page.getByRole('button', { name: 'Full site' }).click();

    const request = card(page, 'Request');
    await expect(request.getByText(/could not load current data: 500/i)).toBeVisible();
    await expect(request.getByText('no templates', { exact: true })).toHaveCount(0);
  });

  test('a genuinely empty /api/templates read still shows "no templates"', async ({ page }) => {
    await stub(page, SPACES, { spaces: [SPACE] });
    await stub(page, TEMPLATES, []);

    await page.goto('/#provision');
    await page.getByRole('button', { name: 'Full site' }).click();

    const request = card(page, 'Request');
    await expect(request.getByText('no templates', { exact: true })).toBeVisible();
    await expect(request.getByText(FETCH_ERROR)).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Provision — Seed demo mode (spaces)
// ---------------------------------------------------------------------------

test.describe('Provision / Seed demo — failed read vs genuine empty', () => {
  test('a failed /api/ipam/spaces read shows a fetch-error, not "no IP spaces"', async ({ page }) => {
    await stub(page, SPACES, 502);
    await stub(page, TEMPLATES, [TEMPLATE]);

    await page.goto('/#provision');
    await page.getByRole('button', { name: 'Seed demo' }).click();

    const seed = card(page, 'Seed multi-region demo data');
    await expect(seed.getByText(FETCH_ERROR)).toBeVisible();
    await expect(seed.getByText('no IP spaces', { exact: true })).toHaveCount(0);
  });

  test('a genuinely empty /api/ipam/spaces read still shows "no IP spaces"', async ({ page }) => {
    await stub(page, SPACES, { spaces: [] });
    await stub(page, TEMPLATES, [TEMPLATE]);

    await page.goto('/#provision');
    await page.getByRole('button', { name: 'Seed demo' }).click();

    const seed = card(page, 'Seed multi-region demo data');
    await expect(seed.getByText('no IP spaces', { exact: true })).toBeVisible();
    await expect(seed.getByText(FETCH_ERROR)).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// Drift — templates + spaces
// ---------------------------------------------------------------------------

test.describe('Drift pickers — failed read vs genuine empty', () => {
  test('a failed /api/templates read shows a fetch-error, not "no templates"', async ({ page }) => {
    await stub(page, TEMPLATES, 500);
    await stub(page, SPACES, { spaces: [SPACE] });

    await page.goto('/#drift');

    const check = card(page, 'Check drift');
    await expect(check.getByText(/could not load current data: 500/i)).toBeVisible();
    await expect(check.getByText('no templates', { exact: true })).toHaveCount(0);
  });

  test('a genuinely empty /api/templates read still shows "no templates"', async ({ page }) => {
    await stub(page, TEMPLATES, []);
    await stub(page, SPACES, { spaces: [SPACE] });

    await page.goto('/#drift');

    const check = card(page, 'Check drift');
    await expect(check.getByText('no templates', { exact: true })).toBeVisible();
    await expect(check.getByText(FETCH_ERROR)).toHaveCount(0);
  });

  test('a failed /api/ipam/spaces read shows a fetch-error, not "no IP spaces"', async ({ page }) => {
    await stub(page, TEMPLATES, [TEMPLATE]);
    await stub(page, SPACES, 502);

    await page.goto('/#drift');

    const check = card(page, 'Check drift');
    await expect(check.getByText(/could not load current data: 502/i)).toBeVisible();
    await expect(check.getByText('no IP spaces', { exact: true })).toHaveCount(0);
  });

  test('a genuinely empty /api/ipam/spaces read still shows "no IP spaces"', async ({ page }) => {
    await stub(page, TEMPLATES, [TEMPLATE]);
    await stub(page, SPACES, { spaces: [] });

    await page.goto('/#drift');

    const check = card(page, 'Check drift');
    await expect(check.getByText('no IP spaces', { exact: true })).toBeVisible();
    await expect(check.getByText(FETCH_ERROR)).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// already_gone — a delete that removed something vs one that found nothing
// ---------------------------------------------------------------------------

/** Answer only the DELETE on `glob`; every other method passes through. */
function stubDelete(page: Page, glob: string, body: Json) {
  return page.route(glob, (route: Route) =>
    route.request().method() === 'DELETE' ? route.fulfill({ json: body }) : route.continue(),
  );
}

test.describe('Editor delete — already_gone must not read as "deleted"', () => {
  async function armAndDelete(page: Page) {
    await page.goto('/#editor?type=dns_zone&id=zone-1');
    const btn = page.getByRole('button', { name: 'Delete DNS Zone' });
    await btn.click();
    await page.getByRole('button', { name: 'Click again to permanently delete' }).click();
  }

  test('already_gone:false says the zone was deleted', async ({ page }) => {
    await stubDelete(page, '**/api/edit/dns_zone/**', { ok: true, already_gone: false });
    await armAndDelete(page);

    await expect(page.getByText('DNS Zone deleted.', { exact: true })).toBeVisible();
    await expect(page.getByText(/already gone/i)).toHaveCount(0);
  });

  test('already_gone:true says it was already gone, not that we deleted it', async ({ page }) => {
    await stubDelete(page, '**/api/edit/dns_zone/**', { ok: true, already_gone: true });
    await armAndDelete(page);

    await expect(page.getByText(/DNS Zone was already gone — nothing was deleted\./)).toBeVisible();
    await expect(page.getByText('DNS Zone deleted.', { exact: true })).toHaveCount(0);
  });
});

test.describe('SelfService delete — already_gone must not read as "deleted"', () => {
  const ZONE = { id: 'zone1', fqdn: 'example.com' };
  const RECORD = { id: 'rec-a', type: 'A', name_in_zone: 'www', ttl: 300, dns_rdata: '192.0.2.10', comment: '' };

  async function armAndDelete(page: Page, alreadyGone: boolean) {
    await stub(page, '**/api/dns/zones*', { zones: [ZONE] });
    await stub(page, SPACES, { spaces: [SPACE] });
    await stub(page, '**/api/ipam/subnets*', { subnets: [] });
    await page.route('**/api/dns/records**', (route: Route) =>
      route.request().method() === 'DELETE'
        ? route.fulfill({ json: { ok: true, already_gone: alreadyGone } })
        : route.fulfill({ json: { records: [RECORD] } }),
    );

    await page.goto('/#selfservice');
    const manage = card(page, 'Manage Records');
    await manage.locator('select').selectOption(ZONE.id);
    await manage.getByRole('button', { name: 'Delete' }).click();
    await manage.getByRole('button', { name: 'Confirm delete' }).click();
    return manage;
  }

  test('already_gone:false says the record was deleted', async ({ page }) => {
    const manage = await armAndDelete(page, false);
    await expect(manage.getByText('DNS record deleted.', { exact: true })).toBeVisible();
    await expect(manage.getByText(/already gone/i)).toHaveCount(0);
  });

  test('already_gone:true says it was already gone, not that we deleted it', async ({ page }) => {
    const manage = await armAndDelete(page, true);
    await expect(manage.getByText(/DNS record was already gone — nothing was deleted\./)).toBeVisible();
    await expect(manage.getByText('DNS record deleted.', { exact: true })).toHaveCount(0);
  });
});
