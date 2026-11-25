import { test, expect, type Page } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// GUI audit round 1, job w4: plain words on Security, Audit, Changes, Made,
// AI, Site lists and Demo server (findings C8, C13-C16, C20, C21, E8, E10).
// Every page is served from the fixed baseline world, so nothing here reaches
// a tenant.

test.use({ timezoneId: 'UTC', locale: 'en-US' });

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

// Words after the first may start with a capital only when they are names.
const NAMES = new Set(['Axur', 'DNS', 'IP', 'Infoblox', 'Portal', 'Bloxsmith', 'AI', 'DHCP', 'NIOS-X']);
async function titleCaseHeadings(page: Page) {
  const texts = await page.locator('main h2').allInnerTexts();
  return texts.filter((t) => t.trim().split(/\s+/).slice(1).some((w) => /^[A-Z]/.test(w) && !NAMES.has(w)));
}

async function visibleText(page: Page) {
  return page.locator('main').innerText();
}

test('C8 C15: Security says its labels in plain words and sentence case', async ({ page }) => {
  await page.goto('/#security');
  await expect(page.getByRole('heading', { level: 2, name: 'Security inventory' })).toBeVisible();
  await expect(page.getByText('Critical, not yet reviewed', { exact: false })).toBeVisible();
  const text = await visibleText(page);
  for (const word of ['Unacked', 'CTEM', 'Anycast', 'Roaming']) expect(text, word).not.toContain(word);
  expect(await titleCaseHeadings(page)).toEqual([]);
});

test('C8 C15 C16 C21: Audit says what happened in plain words', async ({ page }) => {
  await page.goto('/#audit');
  await expect(page.getByText('Tried to create a DNS record; changes are turned off')).toBeVisible();
  const text = await visibleText(page);
  for (const word of ['POST /api/edit', 'tenant-read-only', 'bloxsmith audit verify', 'UPDATE', 'DELETE', 'addressservice', 'dnsrecord', 'auth_zone', 'subnetservice']) {
    expect(text, word).not.toContain(word);
  }
  // The portal table names the action and the object in words.
  const portal = page.locator('[data-panel-id="audit-csp-portal"]');
  await expect(portal.getByRole('cell', { name: 'DNS record', exact: true })).toBeVisible();
  await expect(portal.getByRole('cell', { name: 'Deleted', exact: true })).toBeVisible();
  // The command moved into a tip under a plain-words line.
  const how = page.getByText('How to check it yourself');
  await how.hover();
  await expect(page.getByText('bloxsmith audit verify')).toBeVisible();
  // Intact and Not saved say what they mean.
  await expect(page.getByText('none changed or removed', { exact: false })).toBeVisible();
  await expect(page.getByText("Couldn't be saved", { exact: true })).toBeVisible();
  expect(await titleCaseHeadings(page)).toEqual([]);
});

test('C21: Audit "Last entry" shows the whole event on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/#audit');
  const strip = page.locator('section[aria-label="Can you trust this log"]');
  const ev = strip.getByText("Couldn't delete a DNS record", { exact: true });
  await expect(ev).toBeVisible();
  const cut = await ev.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(cut).toBe(false);
});

test('C8 C13 C14 C15 C20: Changes says its rows, limits and actions in plain words', async ({ page }) => {
  await page.goto('/#changes');
  await expect(page.getByRole('heading', { level: 1, name: 'Changes' })).toBeVisible();
  const feed = page.getByRole('table', { name: /Changed objects/ });
  await expect(feed).toBeVisible();
  const text = await feed.innerText();
  for (const word of ['UPDATE', 'DELETE', 'addressservice', 'dnsrecord', 'auth_zone', 'subnetservice']) expect(text, word).not.toContain(word);
  await expect(feed.getByRole('heading', { level: 3, name: 'DNS record' })).toBeVisible();
  // C20: the coloured dots have a legend in words.
  const legend = page.locator('[data-changes-legend]');
  await expect(legend).toContainText('Deleted or failed');
  await expect(legend).toContainText('Out of hours');
  await expect(legend).toContainText('Everything else');
  // C13: "1+" is said in words beside it, and no "rows" jargon in the tiles, tips included.
  await expect(page.locator('[data-changes-cell="deletions"]')).toContainText('at least 1');
  expect(await page.locator('[data-changes-band]').textContent()).not.toMatch(/older rows|row limit/);
  // C14: the alarm tiles say what to do.
  await expect(page.locator('[data-changes-cell="deletions"] [data-changes-do]')).toHaveText('Check it was meant');
  await expect(page.locator('[data-changes-cell="failures"] [data-changes-do]')).toHaveText('See why it failed');
  expect(await titleCaseHeadings(page)).toEqual([]);
});

test('C15: on a phone every Changes tile puts "Needs action" in the same place', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/#changes');
  const places = [];
  for (const key of ['deletions', 'failures']) {
    const cell = page.locator(`[data-changes-cell="${key}"]`);
    const label = await cell.locator('.ov-kpi-top > span').first().boundingBox();
    const word = await cell.locator('.ov-verdict').boundingBox();
    places.push(word!.y > label!.y + label!.height - 1 ? 'below' : 'beside');
  }
  expect(places).toEqual(['below', 'below']);
});

test('E8: Made, AI and Site lists say who and what in plain words', async ({ page }) => {
  await page.goto('/#made');
  await expect(page.getByRole('heading', { level: 1, name: 'Made with Bloxsmith' })).toBeVisible();
  expect(await visibleText(page)).not.toContain('made_by=bloxsmith');
  await expect(page.getByText('Bloxsmith marks the items it makes', { exact: false })).toBeVisible();

  await page.goto('/#ai');
  await expect(page.getByText(/Groq/).first()).toBeVisible();
  expect(await visibleText(page)).not.toMatch(/tenant/i);

  await page.goto('/#lists');
  await expect(page.getByText('kept for this account', { exact: false })).toBeVisible();
  expect(await visibleText(page)).not.toMatch(/tenant/i);
});

test('E8 E10: Demo server says its settings in plain words with e.g. hints', async ({ page }) => {
  await page.goto('/#demo');
  await expect(page.getByRole('heading', { level: 1, name: 'Demo server' })).toBeVisible();
  // Open the form, which is folded when settings are saved and ready.
  const change = page.getByRole('button', { name: 'Change settings' });
  if (await change.isVisible()) await change.click();
  await expect(page.getByLabel('Disk (GB)')).toBeVisible();
  // The Build panel's step list is the server's own text (go/internal/demo/build.go), outside this page.
  const text = (await page.locator('[data-panel-id="demo-settings"], [data-panel-id="demo-code"], [data-panel-id="demo-runs"]').allInnerTexts()).join('\n');
  for (const word of ['vault', 'OpenTofu', 'join token', 'VM', '.qcow2', 'Demo bridge']) expect(text, word).not.toContain(word);
  const boxes = page.locator('[data-panel-id="demo-settings"] input:not([type="password"])');
  const hints = await boxes.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).placeholder));
  expect(hints.length).toBeGreaterThanOrEqual(12);
  for (const h of hints) expect(h).toMatch(/^e\.g\. /);
});

// Codex review (b): a refusal for lack of a role keeps the role it needed on
// screen, and an object the word map does not know keeps its real name.
test('Audit keeps the needed role and an unknown object name on screen', async ({ page }) => {
  const entries = [
    { actor: 'viewer', event: 'rbac_denied', detail: { required: 'admin', path: '/api/update/apply' }, hash: 'h1', prev_hash: '', seq: 0, ts: 1767225600 },
    { actor: 'baseline-operator', event: 'write-refused-read-only', detail: { method: 'POST', path: '/api/edit/widget_pool', reason: 'tenant-read-only' }, hash: 'h2', prev_hash: 'h1', seq: 1, ts: 1767229200 },
  ];
  await page.route('**/api/audit/log*', (route) =>
    route.fulfill({ json: { chain_valid: true, chain_state: 'ok', append_failures: 0, entries, total: 2, returned: 2, truncated: false } }),
  );
  await page.goto('/#audit');
  const log = page.locator('[data-panel-id="audit-log"]');
  await expect(log.getByText('Needs the Admin role', { exact: false })).toBeVisible();
  await expect(log.getByText('widget_pool', { exact: false })).toBeVisible();
});
