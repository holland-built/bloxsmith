import { test, expect, type Page } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// GUI audit round 2, job r2b: the Risk pages (Security, Incidents, Audit,
// Changes). Each test names the finding it pins. Every page is served from the
// fixed baseline world, so nothing here reaches a tenant.

test.use({ timezoneId: 'UTC', locale: 'en-US' });

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

// A read that fails with no body, the audit's "fail" state.
async function fail(page: Page, glob: string) {
  await page.route(glob, (r) => r.fulfill({ status: 503, body: '' }));
}

const panel = (page: Page, id: string) => page.locator(`[data-panel-id="${id}"]`);

test('R2-C1: Block is offered on a row that was only logged, not on one already blocked', async ({ page }) => {
  await page.goto('/#security');
  const triage = panel(page, 'security-triage-inbox');
  const blocked = triage.getByRole('row').filter({ hasText: 'bad.baseline.example' });
  const logged = triage.getByRole('row').filter({ hasText: 'watch.baseline.example' });
  await expect(logged).toBeVisible();
  // The blocked row says so, with nothing to press.
  await expect(blocked.getByRole('button', { name: 'Block' })).toHaveCount(0);
  await expect(blocked.getByRole('cell', { name: 'Blocked' }).last()).toBeVisible();
  // The logged row still offers Block (a medium row shows it on hover).
  await logged.hover();
  await expect(logged.getByRole('button', { name: 'Block' })).toHaveCSS('opacity', '1');
});

test('R2-C2: each Blocked number says the time it covers', async ({ page }) => {
  await page.goto('/#security');
  await expect(panel(page, 'security-response-summary')).toContainText('Blocked, last hour');
  await expect(panel(page, 'security-threat-feed-activity')).toContainText('Blocked, last 7 days');
});

test('R2-C4 C15: Security says its labels in plain words', async ({ page }) => {
  await page.goto('/#security');
  const triage = panel(page, 'security-triage-inbox');
  await expect(triage).toBeVisible();
  await expect(triage.getByRole('columnheader', { name: 'Seen' })).toBeVisible();
  await expect(triage.getByRole('cell', { name: 'Logged', exact: true })).toBeVisible();
  // The text itself, not as drawn: column headers are capitals by design.
  const text = (await page.locator('main').textContent()) ?? '';
  for (const word of ['ACK', 'BLOCK', 'LOG', 'HIGH', 'MEDIUM', 'Total Events', 'Total Findings', 'Last Seen']) {
    expect(text, word).not.toContain(word);
  }
});

test('R2-C4 C15: Incidents says Severity and Action volume', async ({ page }) => {
  await page.goto('/#incidents');
  await expect(page.getByRole('heading', { level: 2, name: 'Action volume', exact: true })).toBeVisible();
  const text = await page.locator('main').innerText();
  expect(text).not.toMatch(/\bSEV\b/i);
  expect(text).not.toContain('Action Volume');
});

test('C7 C12: Incidents failure starts in plain words and the pill matches other pages', async ({ page }) => {
  await fail(page, '**/api/incidents');
  await page.goto('/#incidents');
  await expect(page.getByText('Information is unavailable').first()).toBeVisible();
  const text = await page.locator('main').innerText();
  expect(text).not.toContain('could not load incidents');
  expect(text).not.toContain("Couldn't load");
});

test('R2-C4 C11: Audit Portal rows say Worked or Refused, newest first, in plain words', async ({ page }) => {
  await page.goto('/#audit');
  const portal = panel(page, 'audit-csp-portal');
  await expect(portal.getByRole('cell', { name: 'Deleted', exact: true })).toBeVisible();
  const text = await portal.innerText();
  for (const word of ['success', 'failed: denied', '(service)', 'external', 'total unknown']) expect(text, word).not.toContain(word);
  await expect(portal.getByRole('cell', { name: 'Refused', exact: true })).toBeVisible();
  await expect(portal).toContainText('From the Infoblox Portal');
  // Newest first, like the Audit log above it.
  const times = await portal.getByRole('row').evaluateAll((rows) =>
    rows.slice(1).map((r) => (r.querySelector('[role="cell"], td') as HTMLElement | null)?.innerText ?? ''),
  );
  const parsed = times.map((t) => Date.parse(t)).filter((n) => !Number.isNaN(n));
  expect(parsed.length).toBeGreaterThan(1);
  expect(parsed).toEqual([...parsed].sort((a, b) => b - a));
});

test('R2-C7: Audit "Not verified" reason starts with a capital', async ({ page }) => {
  await fail(page, '**/api/audit/log**');
  await page.goto('/#audit');
  await expect(page.getByText('The check could not be loaded')).toBeVisible();
});

test('R2-C5: Changes advice under Needs action is plain grey text, not link-like', async ({ page }) => {
  await page.goto('/#changes');
  const tile = page.locator('[data-changes-cell="deletions"]');
  const advice = tile.locator('[data-changes-do]');
  await expect(advice).toBeVisible();
  const [adviceColour, mutedColour] = await Promise.all([
    advice.evaluate((el) => getComputedStyle(el).color),
    tile.locator('.chg-line').first().evaluate((el) => getComputedStyle(el).color),
  ]);
  expect(adviceColour).toBe(mutedColour);
  expect(await advice.evaluate((el) => el.closest('a,button'))).toBeNull();
});

test('R2-C4 C13: Changes says its window, results and groups in plain words', async ({ page }) => {
  await page.goto('/#changes');
  const feed = page.getByRole('table', { name: /Changed objects/ });
  await expect(feed).toBeVisible();
  const text = await feed.innerText();
  for (const word of ['success', 'failed: denied', 'rows', 'not successful']) expect(text, word).not.toContain(word);
  expect(text).not.toMatch(/\bservice\b/);
  await expect(page.locator('[data-changes-window]')).not.toContainText(/\d h\b/);
});

test('R2-C6 C12: Changes failure names the list and matches the other pages', async ({ page }) => {
  await fail(page, '**/api/csp-audit**');
  await page.goto('/#changes');
  await expect(page.getByText('The list of changes is unavailable').first()).toBeVisible();
  await expect(page.locator('[data-updated]')).toContainText('Information is unavailable');
  const text = await page.locator('main').innerText();
  expect(text).not.toContain('Portal audit information');
  expect(text).not.toMatch(/(^|\n)the list of changes/);
});

test('R2-C9: a failed Security panel shows no dash where its count would be', async ({ page }) => {
  await fail(page, '**/api/lookalikes*');
  await fail(page, '**/api/axur*');
  await page.goto('/#security');
  const lookalikes = panel(page, 'security-lookalike-domains');
  const axur = panel(page, 'security-axur-incidents');
  await expect(lookalikes.getByText('Lookalike domain information is unavailable')).toBeVisible();
  await expect(axur.getByText('Axur information is unavailable')).toBeVisible();
  await expect(lookalikes.getByText(/detected/)).toHaveCount(0);
  await expect(axur.getByText('—', { exact: true })).toHaveCount(0);
});

test('Changes list on a phone: each row is a stacked block with every column on screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/#changes');
  const feed = page.getByRole('table', { name: /Changed objects/ });
  const row = feed.getByRole('row').filter({ hasText: 'Refused' }).first();
  await expect(row).toBeVisible();
  // Result and Flags are on screen, inside the list's own box, not off to the right.
  const box = (await feed.boundingBox())!;
  for (const cell of [row.getByRole('cell', { name: /Refused/ }), row.locator('[data-flag="failed"]')]) {
    const b = (await cell.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(box.x);
    expect(b.x + b.width).toBeLessThanOrEqual(Math.min(box.x + box.width, 390) + 1);
  }
  // Each value says what it is, in a label drawn before it.
  const labels = await row.locator('[role="cell"]').evaluateAll((cells) => cells.map((c) => getComputedStyle(c, '::before').content));
  expect(labels.join(' ')).toContain('Result');
  expect(labels.join(' ')).toContain('Flags');
  // Nothing scrolls sideways.
  expect(await feed.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
});

test('Changes list on a desktop keeps its one-line rows with no visible labels', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#changes');
  const feed = page.getByRole('table', { name: /Changed objects/ });
  const row = feed.getByRole('row').filter({ hasText: 'Refused' }).first();
  await expect(row).toBeVisible();
  expect((await row.boundingBox())!.height).toBeLessThanOrEqual(31);
  const labels = await row.locator('[role="cell"]').evaluateAll((cells) => cells.map((c) => getComputedStyle(c, '::before').content));
  expect(labels.filter((c) => c !== 'none' && c !== 'normal')).toEqual([]);
});
