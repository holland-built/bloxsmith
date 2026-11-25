import { test, expect, type Page, type Locator } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The change forms (Editor, Provision, Automate, Made, Drift, Get an address),
// from the 2026-11-25 screen audit. Each test names its finding (D1-D19, E7,
// E11; "codex" for the extras from the second reviewer).

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

const SHELL = new Set(['/api/brand', '/api/update/check', '/api/vault/status', '/api/views', '/api/vault/write-target']);
async function failReads(page: Page) {
  await page.route('**/api/**', (r) => (SHELL.has(new URL(r.request().url()).pathname) || r.request().method() !== 'GET'
    ? r.fallback()
    : r.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"upstream timeout"}' })));
}

// A disabled button must look disabled: not the bright accent fill, and the
// not-allowed pointer. Its words must stay readable (3:1 against its fill).
async function looksDisabled(btn: Locator) {
  await expect(btn).toBeDisabled();
  const s = await btn.evaluate((el) => {
    const cs = getComputedStyle(el);
    const rgb = (c: string) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const lum = (c: string) => {
      const [r, g, b] = rgb(c).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const a = lum(cs.color), b = lum(cs.backgroundColor);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim();
    const probe = document.createElement('span');
    probe.style.color = accent;
    document.body.appendChild(probe);
    const accentRgb = getComputedStyle(probe).color;
    probe.remove();
    return { cursor: cs.cursor, bg: cs.backgroundColor, accentRgb, opacity: cs.opacity, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
  });
  expect(s.cursor).toBe('not-allowed');
  expect(s.bg).not.toBe(s.accentRgb);
  expect(s.opacity).toBe('1');
  expect(s.ratio).toBeGreaterThanOrEqual(3);
}

// ---------- Editor ----------

test('D1: the Editor asks for a DNS view, address block and IP space by name, never an internal ID', async ({ page }) => {
  let sent: Record<string, unknown> | null = null;
  await page.route('**/api/edit/dns_zone', (r) => { sent = r.request().postDataJSON(); return r.fulfill({ json: { ok: true, dry_run: true, would_create: {} } }); });
  await page.goto('/#editor');
  const form = page.locator('[data-editor-form]');
  await expect(form.getByRole('textbox', { name: /DNS view ID/ })).toHaveCount(0);
  await expect(form.getByText(/ID of an existing one/)).toHaveCount(0);
  await expect(form.getByPlaceholder(/object id/)).toHaveCount(0);
  await form.getByRole('textbox', { name: /Zone name/ }).fill('lab.example.');
  await form.getByRole('combobox', { name: 'DNS view' }).selectOption({ label: 'default' });
  await form.getByRole('button', { name: 'Preview' }).click();
  await expect.poll(() => sent).not.toBeNull();
  expect(sent).toMatchObject({ fqdn: 'lab.example.', view: 'dns/view/baseline-1' });

  await page.getByRole('button', { name: 'Subnet', exact: true }).click();
  await expect(form.getByRole('textbox', { name: /Address block ID/ })).toHaveCount(0);
  await form.getByRole('combobox', { name: 'IP space' }).selectOption({ label: 'Baseline Space' });
  await expect(form.getByRole('combobox', { name: 'Address block' }).locator('option', { hasText: '10.10.0.0/16' })).toHaveCount(1);

  await page.getByRole('button', { name: 'Address block', exact: true }).click();
  await expect(form.getByRole('textbox', { name: /IP space/i })).toHaveCount(0);
  await expect(form.getByRole('combobox', { name: 'IP space' }).locator('option', { hasText: 'Baseline Space' })).toHaveCount(1);
  await expect(form.getByText('Each tag is a name and a value, like env=prod. Separate tags with commas.')).toBeVisible();
});

test('D1: the block-tags form sends the IP space by name, as the server looks it up', async ({ page }) => {
  let sent: Record<string, unknown> | null = null;
  await page.route('**/api/retag/block', (r) => { sent = r.request().postDataJSON(); return r.fulfill({ json: { ok: true, dry_run: true } }); });
  await page.goto('/#editor?type=tags');
  const form = page.locator('[data-editor-form]');
  await form.getByRole('combobox', { name: 'IP space' }).selectOption({ label: 'Baseline Space' });
  await form.getByRole('button', { name: 'Preview' }).click();
  await expect.poll(() => sent).not.toBeNull();
  expect(sent).toMatchObject({ ip_space: 'Baseline Space' });
});

test('D15: Editor titles are in sentence case and optional fields say so', async ({ page }) => {
  await page.goto('/#editor');
  for (const name of ['DNS zone', 'Address block', 'DHCP range']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(page.locator('#editor-form-h')).toHaveText('New DNS zone');
  const form = page.locator('[data-editor-form]');
  await expect(form.getByText('*', { exact: false }).filter({ hasText: /\*$/ })).toHaveCount(0);
  await expect(form.getByRole('textbox', { name: 'Comment (optional)' })).toBeVisible();
});

// ---------- Provision ----------

test('D3: Provision shows no role until it is known, and then in sentence case', async ({ page }) => {
  let answer: (() => void) | null = null;
  const held = new Promise<void>((res) => { answer = res; });
  await page.route('**/api/whoami', async (r) => { await held; return r.fulfill({ json: { actor: 'a', role: 'admin', tenant: 't', token_auth: false } }); });
  await page.goto('/#provision');
  await expect(page.locator('main h1')).toHaveText('Provision');
  await expect(page.getByText(/viewer/i)).toHaveCount(0);
  answer!();
  const badge = page.locator('[data-role-badge]');
  await expect(badge).toHaveText('Admin');
  const { rad, h } = await badge.evaluate((el) => ({ rad: parseFloat(getComputedStyle(el).borderTopLeftRadius), h: el.getBoundingClientRect().height }));
  expect(rad).toBeLessThan(h / 2);
});

test('D3: a failed role check never shows Viewer', async ({ page }) => {
  await page.route('**/api/whoami', (r) => r.fulfill({ status: 502, json: { error: 'x' } }));
  await page.goto('/#provision');
  await expect(page.locator('main h1')).toHaveText('Provision');
  await page.waitForTimeout(500);
  await expect(page.getByText(/viewer/i)).toHaveCount(0);
});

test('D9: the device count lines up with the other rows on a wide screen', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#provision');
  const devices = page.locator('[data-devices-input]');
  const name = page.getByRole('textbox', { name: 'Name' });
  await expect(devices).toBeVisible();
  const d = (await devices.boundingBox())!;
  const n = (await name.boundingBox())!;
  expect(Math.abs(d.x - n.x)).toBeLessThan(2);
  expect(Math.abs(d.width - n.width)).toBeLessThan(2);
});

test('D9: each load error sits under its own field', async ({ page }) => {
  await failReads(page);
  await page.goto('/#provision');
  const space = page.getByRole('group', { name: 'IP space', exact: true });
  await expect(space.getByText(/Could not load IP spaces/)).toBeVisible({ timeout: 20_000 });
});

test('D10: Provision uses the page width', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#provision');
  await expect(page.locator('main h1')).toHaveText('Provision');
  const w = await page.locator('main h1').evaluate((el) => el.closest('main')!.querySelector('[data-provision-page]')!.getBoundingClientRect().width);
  expect(w).toBeGreaterThan(900);
});

test('codex D12: the Live log says nothing can run while the IP spaces failed to load', async ({ page }) => {
  await failReads(page);
  await page.goto('/#provision');
  await expect(page.getByText(/Could not load IP spaces/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Output appears here when you preview or apply.')).toHaveCount(0);
  await expect(page.getByText('Nothing can run until the IP spaces load.')).toBeVisible();
});

// ---------- Automate ----------

test('D5, D18: Find item and Plan it look disabled while empty, and are the same width', async ({ page }) => {
  await page.goto('/#automate');
  const find = page.getByRole('button', { name: 'Find item' });
  const plan = page.getByRole('button', { name: 'Plan it' });
  await looksDisabled(find);
  await looksDisabled(plan);
  const f = (await find.boundingBox())!;
  const p = (await plan.boundingBox())!;
  expect(Math.abs(f.width - p.width)).toBeLessThan(1);
  expect(Math.abs((f.x + f.width) - (p.x + p.width))).toBeLessThan(1);
});

test('D19: a failed Plan it is announced', async ({ page }) => {
  await page.route('**/api/desk/plan', (r) => r.fulfill({ status: 500, json: { error: 'The AI did not answer.' } }));
  await page.goto('/#automate');
  await page.getByRole('textbox', { name: 'Or describe it in one sentence' }).fill('make a network');
  await page.getByRole('button', { name: 'Plan it' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'The AI did not answer.' })).toBeVisible();
});

test('D7: the two-line IP space suggestion keeps the 10px control corners', async ({ page }) => {
  await page.goto('/#automate');
  const sug = page.locator('[data-space-suggestions] button').first();
  await expect(sug).toBeVisible({ timeout: 20_000 });
  expect(await sug.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('10px');
});

test('codex D11: the IP space suggestion is labelled a suggestion and says what pressing it does', async ({ page }) => {
  await page.goto('/#automate');
  await expect(page.locator('[data-space-suggestions] button').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Suggested:', { exact: true })).toBeVisible();
  await expect(page.locator('[data-space-suggestions] button').first()).toHaveAccessibleDescription(/Press to use this IP space/);
});

test('D10: Automate\'s own list is called Made here, like the other pages', async ({ page }) => {
  await page.goto('/#automate');
  await expect(page.getByRole('heading', { name: 'Made here' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Your recent changes')).toHaveCount(0);
});

// ---------- Made with Bloxsmith ----------

test('E7: Made\'s Find item looks disabled while the box is empty', async ({ page }) => {
  await page.goto('/#made');
  await looksDisabled(page.getByRole('button', { name: 'Find item' }));
});

test('E11: Made\'s find fields line up with the panel title', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#made');
  const card = page.locator('[data-panel-id="made-find"], [data-panel="made-find"]').first();
  const title = page.getByRole('heading', { name: 'Delete something else' });
  const what = page.getByRole('combobox', { name: 'What' });
  await expect(what).toBeVisible();
  const t = (await title.boundingBox())!;
  const w = (await what.boundingBox())!;
  expect(Math.abs(w.x - t.x)).toBeLessThan(2);
  void card;
});

// ---------- Drift ----------

test('D12: Compare to template says why Compare is greyed', async ({ page }) => {
  await page.goto('/#drift');
  await expect(page.getByRole('button', { name: 'Compare', exact: true })).toBeDisabled();
  await expect(page.getByText('To compare, pick a template.')).toBeVisible();
});

test('D16: the greyed Compare is readable in the light theme', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('theme', 'light'));
  await page.goto('/#drift');
  await looksDisabled(page.getByRole('button', { name: 'Compare', exact: true }));
});

test('codex D13: the Drift intro is a plain sentence', async ({ page }) => {
  await page.goto('/#drift');
  await expect(page.getByText('Shows what is missing from Infoblox, what is extra, and what differs from the template.')).toBeVisible();
});

test('D14: Drift results use plain sentence-case words', async ({ page }) => {
  await page.route('**/api/templates', (r) => r.fulfill({ json: [
    { name: 'baseline-site', type: 'site', site: 'baseline-site', region: 'baseline-region', environment: 'test', valid: true },
    { name: 'bare', type: 'site', site: 'bare', valid: true },
  ] }));
  const drifts = Array.from({ length: 7 }, (_, i) => ({ category: 'subnets', severity: 'warning', message: `subnet ${i} missing from Infoblox` }));
  let reply: Record<string, unknown> = { found: true, site: 'baseline-site', drifted: true, drifts };
  await page.route('**/api/drift/check', (r) => r.fulfill({ json: reply }));
  await page.goto('/#drift');
  const tpl = page.getByRole('combobox', { name: 'Template' });
  await expect(tpl.locator('option', { hasText: 'bare' })).toHaveText('bare');
  await tpl.selectOption('baseline-site');
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(page.getByText('7 differences')).toBeVisible();
  await expect(page.getByText('Subnets', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '+1 more' }).click();
  await expect(page.getByRole('button', { name: 'Show less' })).toBeVisible();
  reply = { found: true, site: 'baseline-site', drifted: false, drifts: [] };
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(page.getByText('Matches the template')).toBeVisible();
  await expect(page.getByText(/in-sync|no drift items/)).toHaveCount(0);
});

// ---------- Get an address ----------

test('D11: a bad MAC address gets a red FieldError linked to the box', async ({ page }) => {
  await page.goto('/#selfservice');
  const sec = page.locator('[data-task="address"]');
  await sec.getByRole('checkbox', { name: /Lock it to one device/ }).check();
  const mac = sec.getByRole('textbox', { name: 'Device MAC address' });
  await mac.fill('zz');
  await expect(mac).toHaveAttribute('aria-invalid', 'true');
  await expect(mac).toHaveAccessibleDescription(/Six pairs of letters or digits/);
  const color = await sec.getByText(/Six pairs of letters or digits/).evaluate((el) => getComputedStyle(el).color);
  const crit = await page.evaluate(() => { const p = document.createElement('span'); p.className = 'text-crit'; document.body.appendChild(p); const c = getComputedStyle(p).color; p.remove(); return c; });
  expect(color).toBe(crit);
});

test('D6: Get an address says Allocate appears after Preview', async ({ page }) => {
  await page.goto('/#selfservice');
  await expect(page.locator('[data-task="address"]').getByText(/Nothing is taken until you press Allocate, which appears after Preview\./)).toBeVisible();
});

// ---------- Leftovers (second round) ----------

test('D16: the shared greyed Preview is readable in the light theme', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('theme', 'light'));
  await page.goto('/#automate');
  await looksDisabled(page.locator('[data-panel-id="automate-job"]').getByRole('button', { name: 'Preview' }));
});

test('D6: the size line under the device count has no "/24:" in front', async ({ page }) => {
  await page.goto('/#provision');
  await expect(page.locator('[data-size-words]')).toHaveText('256 addresses, 254 usable by devices');
});

// ---------- Same-address blocks in two IP spaces (review, round 3) ----------

test('D1: a subnet\'s address block is picked within one IP space, so same-address blocks cannot be confused', async ({ page }) => {
  await page.route('**/api/ipam/spaces*', (r) => r.fulfill({ json: { spaces: [
    { id: 'ipam/ip_space/a', name: 'Space A' }, { id: 'ipam/ip_space/b', name: 'Space B' }] } }));
  const A = { id: 'ipam/address_block/in-a', address: '10.0.0.0', cidr: 16, name: 'lab' };
  const B = { id: 'ipam/address_block/in-b', address: '10.0.0.0', cidr: 16, name: 'lab' };
  await page.route('**/api/ipam/blocks*', (r) => {
    const space = new URL(r.request().url()).searchParams.get('space');
    return r.fulfill({ json: { blocks: space === 'ipam/ip_space/a' ? [A] : space === 'ipam/ip_space/b' ? [B] : [A, B] } });
  });
  let sent: Record<string, unknown> | null = null;
  await page.route('**/api/edit/subnet', (r) => { sent = r.request().postDataJSON(); return r.fulfill({ json: { ok: true, dry_run: true, would_create: {} } }); });
  await page.goto('/#editor?type=subnet');
  const form = page.locator('[data-editor-form]');
  const blocks = form.getByRole('combobox', { name: 'Address block' });
  // Every option that can be picked reads differently from the others.
  await page.waitForLoadState('networkidle');
  const labels = (await blocks.locator('option').allTextContents()).slice(1);
  expect(new Set(labels).size).toBe(labels.length);

  await form.getByRole('combobox', { name: 'IP space' }).selectOption({ label: 'Space B' });
  await expect(blocks.locator('option')).toHaveCount(2);
  await blocks.selectOption('ipam/address_block/in-b');
  await form.getByRole('spinbutton', { name: 'How many devices need an address?' }).fill('50');
  await form.getByRole('button', { name: 'Preview' }).click();
  await expect.poll(() => sent).not.toBeNull();
  expect(sent).toMatchObject({ block_id: 'ipam/address_block/in-b', cidr: 26 });
  // The space only narrows the list; the subnet create does not take it.
  expect(sent).not.toHaveProperty('space');
});
