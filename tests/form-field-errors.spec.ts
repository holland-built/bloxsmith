import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Every /api/ response is faked from tests/page-fixtures.ts.
//
// A form that refuses to go on says why next to the box that needs fixing,
// marks that box, and puts the cursor in it. A message far away in another
// column, or no message at all, leaves the person hunting for what is wrong.
test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

// Editor (round 3, R3-D4): like Get an address, Preview stays grey until the
// required boxes are filled, and the hint beside it names each empty one.
test('Editor: Preview is grey until the required boxes are filled, and the hint names them', async ({ page }) => {
  await page.goto('/#editor');
  const preview = page.getByRole('button', { name: 'Preview' }).first();
  await expect(preview).toBeVisible({ timeout: 20_000 });
  await expect(preview).toBeDisabled();
  await expect(preview).toHaveAccessibleDescription('To preview, fill in the zone name and pick a DNS view.');

  // Each box filled drops out of the hint; Preview comes on once none are left.
  await page.getByRole('textbox', { name: 'Zone name' }).fill('lab.example.com.');
  await expect(preview).toHaveAccessibleDescription('To preview, pick a DNS view.');
  const view = page.getByRole('combobox', { name: 'DNS view' });
  await view.selectOption({ index: 1 });
  await expect(preview).toBeEnabled();
});

test('Editor: an empty device count keeps Preview grey and is named in the hint', async ({ page }) => {
  await page.goto('/#editor');
  await page.getByRole('button', { name: 'Subnet', exact: true }).click();
  await page.getByRole('combobox', { name: 'IP space' }).selectOption('ipam/ip_space/baseline-1');
  await page.getByRole('combobox', { name: 'Address block' }).selectOption('ipam/address_block/baseline-1');
  const preview = page.getByRole('button', { name: 'Preview' }).first();
  await expect(preview).toBeDisabled();
  await expect(preview).toHaveAccessibleDescription('To preview, enter how many devices need an address.');
  await page.getByRole('spinbutton', { name: 'How many devices need an address?' }).fill('200');
  await expect(preview).toBeEnabled();
});

test('Unlock: an empty passphrase says so under the box', async ({ page }) => {
  await page.route('**/api/vault/status', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ vaultMode: true, exists: true, unlocked: false, ready: false, tenants: [] }) }));
  let calls = 0;
  await page.route('**/api/vault/unlock', (route) => { calls++; return route.fulfill({ contentType: 'application/json', body: '{"ok":false}' }); });
  await page.goto('/');
  const box = page.locator('#vu-pass');
  await expect(box).toBeVisible({ timeout: 20_000 });

  await box.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('Enter your passphrase.');
  await expect(box).toHaveAttribute('aria-invalid', 'true');

  // The button answers a press the same way rather than sitting greyed out.
  await page.reload();
  await expect(box).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Enter your passphrase.');
  await expect(box).toBeFocused();
  expect(calls).toBe(0);
});

test('Settings: a greyed-out Add says a key is needed', async ({ page }) => {
  await page.goto('/#overview');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await sheet.getByRole('button', { name: '+ Add connection' }).click();
  const add = sheet.getByRole('button', { name: 'Add', exact: true });
  await expect(add).toBeDisabled();
  await expect(add).toHaveAccessibleDescription('Paste an API key to add the connection.');
  await expect(sheet.getByText('Paste an API key to add the connection.')).toBeVisible();
  await sheet.getByLabel('Infoblox API key').fill('k');
  await expect(add).toBeEnabled();
  await expect(sheet.getByText('Paste an API key to add the connection.')).toHaveCount(0);
});

// A hint that is cut off mid-word is worse than none. At phone width each
// search box's hint must fit inside the box.
// The Assets box is left out at 320: its card header gives the box 66px there,
// too little for any useful hint, and widening it is a header layout change.
const HINTS: [string, string, number[]][] = [
  ['#automate', 'Find an address, network or name', [320, 390]],
  ['#automate', 'Or describe it in one sentence', [320, 390]],
  ['#network', 'Search address, hostname, MAC', [320, 390]],
  ['#assets', 'Search assets by name, IP or MAC address', [390]],
];
for (const [hash, label, widths] of HINTS) {
  for (const width of widths) {
    test(`${hash} "${label}" hint fits at ${width} wide`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/${hash}`);
      const box = page.getByLabel(label, { exact: true });
      await expect(box).toBeVisible({ timeout: 20_000 });
      const { need, room, hint } = await box.evaluate((el: HTMLInputElement) => {
        const cs = getComputedStyle(el);
        const ctx = document.createElement('canvas').getContext('2d')!;
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const room = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        return { need: ctx.measureText(el.placeholder).width, room, hint: el.placeholder };
      });
      expect(need, `"${hint}" needs ${need}px, box has ${room}px`).toBeLessThanOrEqual(room);
    });
  }
}

// Round 3 (R3-D4): an empty new form greys Preview instead of marking a box,
// so picking an existing item is what clears the hint and turns Preview on.
test('Editor: picking an existing item clears the empty-box hint and turns Preview on', async ({ page }) => {
  await page.route('**/api/edit/dns_zone/find**', (r) => r.fulfill({ json: {
    items: [{ id: 'dns/auth_zone/abc', label: 'lab.example.com.', fields: { fqdn: 'lab.example.com.', view: 'dns/view/1' } }],
  } }));
  await page.goto('/#editor');
  const preview = page.getByRole('button', { name: 'Preview' }).first();
  await expect(preview).toBeVisible({ timeout: 20_000 });
  await expect(preview).toBeDisabled();
  await expect(page.getByText(/^To preview, fill in the zone name/)).toBeVisible();

  await page.getByRole('searchbox').first().fill('lab');
  await page.getByRole('button', { name: 'lab.example.com.' }).click();
  await expect(preview).toBeEnabled();
  await expect(page.getByText(/^To preview,/)).toHaveCount(0);
  await expect(page.locator('[aria-invalid="true"]')).toHaveCount(0);
});

test('Unlock: retyping after a wrong passphrase clears the red mark', async ({ page }) => {
  await page.route('**/api/vault/status', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ vaultMode: true, exists: true, unlocked: false, ready: false, tenants: [] }) }));
  await page.route('**/api/vault/unlock', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"ok":false,"error":"wrong passphrase"}' }));
  await page.goto('/');
  const box = page.locator('#vu-pass');
  await expect(box).toBeVisible({ timeout: 20_000 });
  await box.fill('not-it');
  await box.press('Enter');
  await expect(box).toHaveAttribute('aria-invalid', 'true');
  await box.fill('another-try');
  await expect(box).not.toHaveAttribute('aria-invalid', 'true');
});
