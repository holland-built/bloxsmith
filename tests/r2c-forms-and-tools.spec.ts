import { test, expect } from './fixtures';
import { installBaselineWorld, openTask } from './page-fixtures';

// GUI audit round 2, change forms (round2-D.md) and tools (round2-E.md).
// Each test names the finding it pins. All reads are faked; nothing live.

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const DOWN = { status: 503, body: '' };

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

// R2-E1: a failed settings read is not "nothing saved".
test('R2-E1: Demo server says the settings could not be read, and offers no blank form or Preview', async ({ page }) => {
  await page.route('**/api/demo/status', (r) => r.fulfill(DOWN));
  await page.goto('/#demo');
  await expect(page.getByText('Settings unavailable')).toBeVisible();
  // No empty form that could be saved over the real settings.
  await expect(page.getByRole('button', { name: 'Save settings' })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: /Proxmox login/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Preview', exact: true })).toBeDisabled();
});

// R2-D1: each load error sits under the box it is about.
test('R2-D1: Get an address puts "Could not load IP spaces" inside the IP space box', async ({ page }) => {
  await page.route('**/api/ipam/spaces*', (r) => r.fulfill(json({ error: 'x' }, 502)));
  await page.goto('/#selfservice');
  const card = await openTask(page, 'address');
  await expect(card.getByRole('group', { name: 'IP space', exact: true }).getByText(/Could not load IP spaces/)).toBeVisible();
});

test('R2-D1: Compare to template puts each load error inside its own box', async ({ page }) => {
  await page.route('**/api/templates*', (r) => r.fulfill(json({ error: 'x' }, 500)));
  await page.route('**/api/ipam/spaces*', (r) => r.fulfill(json({ error: 'x' }, 502)));
  await page.goto('/#drift');
  const form = page.locator('[data-drift-form]');
  await expect(form.getByRole('group', { name: 'Template' }).getByText(/Could not load site templates/)).toBeVisible();
  await expect(form.getByRole('group', { name: /^IP space/ }).getByText(/Could not load IP spaces/)).toBeVisible();
  await expect(form.getByRole('group', { name: 'Template' }).getByText(/Could not load IP spaces/)).toHaveCount(0);
});

// R2-D2: plain name for the Drift page.
test('R2-D2: the Drift page is called "Compare to template", with a Compare button', async ({ page }) => {
  await page.goto('/#drift');
  await expect(page.locator('h1').first()).toHaveText(/^Compare to template/);
  await expect(page.getByRole('button', { name: 'Compare', exact: true })).toBeVisible();
  await expect(page.getByText(/drift/i)).toHaveCount(0);
});

// R2-D3: the Tags form picks template and site from lists, and sizes in plain words.
test('R2-D3: Editor Tags picks the site template and site from lists', async ({ page }) => {
  await page.route('**/api/templates*', (r) => r.fulfill(json([{ name: 'amer-site-1', type: 'site' }])));
  await page.route('**/api/ipam/blocks*', (r) => r.fulfill(json({ blocks: [
    { id: 'b1', address: '10.20.0.0', cidr: 16, name: 'core', tags: { Site: 'dallas-01' } },
  ] })));
  await page.goto('/#editor?type=tags');
  const form = page.locator('[data-editor-form]');
  await form.getByRole('combobox', { name: 'IP space' }).selectOption({ label: 'Baseline Space' });
  await expect(form.getByRole('combobox', { name: 'Site template' }).locator('option', { hasText: 'amer-site-1' })).toBeAttached();
  await expect(form.getByRole('combobox', { name: 'Site', exact: true }).locator('option', { hasText: 'dallas-01' })).toBeAttached();
  await expect(form.getByText(/number after the slash/)).toHaveCount(0);
  await expect(form.getByRole('combobox', { name: 'Address block' }).locator('option', { hasText: '10.20.0.0/16 (65,536 addresses)' })).toBeAttached();
});

// R2-D4 and D6: one name per thing.
test('R2-D4: Get an address and Provision label the box "IP space"', async ({ page }) => {
  await page.goto('/#selfservice');
  const card = await openTask(page, 'address');
  await expect(card.getByRole('combobox', { name: 'IP space', exact: true })).toBeVisible();
  await expect(card.getByRole('combobox', { name: 'Address block', exact: true })).toBeVisible();
  await expect(card.getByText('Select space…')).toHaveCount(0);
  await expect(card.getByText(/DHCP reservation/)).toHaveCount(0);
  await page.goto('/#provision');
  await expect(page.getByRole('combobox', { name: 'IP space', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Address block', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Seed demo', exact: true })).toHaveCount(0);
  await page.goto('/#drift');
  await expect(page.getByText('IP space (override)')).toHaveCount(0);
  await expect(page.getByText('— template default —')).toHaveCount(0);
});

// R2-D5: Automate's Made here panel.
test('R2-D5: Automate "Made here" uses the same words as the other pages', async ({ page }) => {
  await page.route('**/api/desk/runs', (r) => r.fulfill(json({ runs: [] })));
  await page.goto('/#automate');
  await expect(page.getByText('Nothing made here yet.')).toBeVisible();
  await expect(page.getByText('Changes made on this page. Each one can be removed.')).toBeVisible();
});

// R2-D6: an account with no IP spaces says so in a sentence.
test('R2-D6: no IP spaces reads "No IP spaces yet."', async ({ page }) => {
  await page.route('**/api/ipam/spaces*', (r) => r.fulfill(json({ spaces: [] })));
  await page.goto('/#drift');
  await expect(page.getByText('No IP spaces yet.')).toBeVisible();
  await expect(page.getByText('no IP spaces', { exact: true })).toHaveCount(0);
});

// R2-D9, R2-D10: the Compare button matches Preview, with its hint beside it.
test('R2-D9/D10: Compare is the Preview button size, with its hint on the same row', async ({ page }) => {
  await page.goto('/#drift');
  const btn = page.getByRole('button', { name: 'Compare', exact: true });
  const hint = page.locator('#drift-needs');
  const b = (await btn.boundingBox())!;
  const h = (await hint.boundingBox())!;
  expect(b.height).toBeLessThan(34);
  expect(Math.abs((b.y + b.height / 2) - (h.y + h.height / 2))).toBeLessThan(8);
});

// R2-D11: counts read "1 subnet", not "1 subnets".
test('R2-D11: one subnet reads "1 subnet"', async ({ page }) => {
  await page.route('**/api/templates*', (r) => r.fulfill(json([{ name: 'dal', type: 'site' }])));
  await page.route('**/api/drift/check', (r) => r.fulfill(json({ found: true, drifted: false, drifts: [], subnet_count: 1, site: 'dal' })));
  await page.goto('/#drift');
  await page.getByRole('combobox', { name: 'Template' }).selectOption('dal');
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(page.getByText('1 subnet', { exact: true })).toBeVisible();
});

// R2-D12: the Tags hint is a plain sentence.
test('R2-D12: the Tags hint explains tags in plain words', async ({ page }) => {
  await page.goto('/#editor?type=dns_zone');
  const form = page.locator('[data-editor-form]');
  await expect(form.getByText('Each tag is a name and a value, like env=prod. Separate tags with commas.')).toBeVisible();
  await expect(form.getByText('name=value, separated by commas')).toHaveCount(0);
});

// R2-E5: the Site lists hint does not ask for a policy that cannot be picked.
test('R2-E5: with policies failed, Site lists says to wait for them, not to pick one', async ({ page }) => {
  await page.route('**/api/lists/targets', (r) => r.fulfill(json({ error: 'x' }, 502)));
  await page.goto('/#lists');
  await expect(page.getByText(/pick a policy/)).toHaveCount(0);
  await expect(page.getByText(/wait for the security policies to load/)).toBeVisible();
});

// R2-E7: no keyboard tip on a phone.
test('R2-E7: AI hides "Shift+Enter" on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#ai');
  await expect(page.getByRole('textbox').first()).toBeVisible();
  await expect(page.getByText('Enter to send, Shift+Enter for a new line.')).toBeHidden();
});

// R2-E8, R2-E9: verb button, plain suggestions.
test('R2-E8/E9: AI says "Look up" and asks plain questions', async ({ page }) => {
  await page.goto('/#ai');
  await expect(page.getByRole('button', { name: 'Look up', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lookup', exact: true })).toHaveCount(0);
  await expect(page.getByText('Which address ranges are nearly full?')).toBeVisible();
  await expect(page.getByText(/threat feeds|misconfigured/)).toHaveCount(0);
});

// R2-E10: example hints start with "e.g.".
test('R2-E10: Made with Bloxsmith hints start with "e.g."', async ({ page }) => {
  await page.goto('/#made');
  const box = page.getByRole('search', { name: 'Find something to delete' }).getByRole('textbox');
  await expect(box).toHaveAttribute('placeholder', /^e\.g\. /);
});

// Codex on R2-D3: the Tags form's blocks come from the picked IP space only, as
// the Subnet form's do, so a same-address block in another space can't be sent.
test('R2-D3: Editor Tags lists only the picked IP space\'s blocks', async ({ page }) => {
  await page.route('**/api/ipam/spaces*', (r) => r.fulfill(json({ spaces: [
    { id: 'ipam/ip_space/a', name: 'Space A' }, { id: 'ipam/ip_space/b', name: 'Space B' }] })));
  const A = { id: 'ipam/address_block/in-a', address: '10.20.0.0', cidr: 16, name: 'lab', tags: { Site: 'site-a' } };
  const B = { id: 'ipam/address_block/in-b', address: '10.20.0.0', cidr: 16, name: 'lab', tags: { Site: 'site-b' } };
  await page.route('**/api/ipam/blocks*', (r) => {
    const space = new URL(r.request().url()).searchParams.get('space');
    return r.fulfill(json({ blocks: space === 'ipam/ip_space/a' ? [A] : space === 'ipam/ip_space/b' ? [B] : [A, B] }));
  });
  let sent: Record<string, unknown> | null = null;
  await page.route('**/api/retag/block', (r) => { sent = r.request().postDataJSON(); return r.fulfill(json({ ok: true, dry_run: true })); });
  await page.goto('/#editor?type=tags');
  const form = page.locator('[data-editor-form]');
  const blocks = form.getByRole('combobox', { name: 'Address block' });
  const sites = form.getByRole('combobox', { name: 'Site', exact: true });
  // Nothing to pick until a space is chosen.
  await expect(blocks).toBeDisabled();
  await expect(sites).toBeDisabled();

  await form.getByRole('combobox', { name: 'IP space' }).selectOption({ label: 'Space B' });
  await expect(blocks).toBeEnabled();
  await expect(blocks.locator('option')).toHaveCount(2); // placeholder + B
  await expect(sites.locator('option', { hasText: 'site-a' })).toHaveCount(0);
  await blocks.selectOption({ index: 1 });

  // A new space clears the block picked in the old one.
  await form.getByRole('combobox', { name: 'IP space' }).selectOption({ label: 'Space A' });
  await expect(blocks).toHaveValue('');
  await blocks.selectOption({ index: 1 });
  await form.getByRole('button', { name: 'Preview' }).click();
  await expect.poll(() => sent).not.toBeNull();
  expect(sent).toMatchObject({ ip_space: 'Space A', address: '10.20.0.0', cidr: 16 });
});
