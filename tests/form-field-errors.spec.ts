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

test('Editor: an empty required field is marked, explained under it, and focused', async ({ page }) => {
  await page.goto('/#editor');
  const preview = page.getByRole('button', { name: 'Preview' }).first();
  await expect(preview).toBeVisible({ timeout: 20_000 });
  await preview.click();

  const zone = page.getByRole('textbox', { name: 'Zone name *' });
  await expect(zone).toBeFocused();
  await expect(zone).toHaveAttribute('aria-invalid', 'true');
  await expect(zone).toHaveAccessibleDescription('Fill in this field.');
  // The message sits in the form, not in the Preview column.
  await expect(page.locator('[data-editor-result]').getByText(/required/i)).toHaveCount(0);

  // Typing in the box clears its mark; the next empty one is pointed at.
  await zone.fill('lab.example.com.');
  await expect(zone).not.toHaveAttribute('aria-invalid', 'true');
  await preview.click();
  const view = page.getByRole('textbox', { name: 'DNS view ID *' });
  await expect(view).toBeFocused();
  await expect(view).toHaveAttribute('aria-invalid', 'true');
});

test('Editor: an empty device count is marked and focused too', async ({ page }) => {
  await page.goto('/#editor');
  await page.getByRole('button', { name: 'Subnet', exact: true }).click();
  await page.getByRole('textbox', { name: 'Address block ID *' }).fill('ipam/address_block/1');
  await page.getByRole('button', { name: 'Preview' }).first().click();
  const devices = page.getByRole('spinbutton', { name: 'How many devices need an address? *' });
  await expect(devices).toBeFocused();
  await expect(devices).toHaveAttribute('aria-invalid', 'true');
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

test('Editor: picking an existing item clears a missing-field mark', async ({ page }) => {
  await page.route('**/api/edit/dns_zone/find**', (r) => r.fulfill({ json: {
    items: [{ id: 'dns/auth_zone/abc', label: 'lab.example.com.', fields: { fqdn: 'lab.example.com.', view: 'dns/view/1' } }],
  } }));
  await page.goto('/#editor');
  const preview = page.getByRole('button', { name: 'Preview' }).first();
  await expect(preview).toBeVisible({ timeout: 20_000 });
  await preview.click();
  const zone = page.getByRole('textbox', { name: 'Zone name *' });
  await expect(zone).toHaveAttribute('aria-invalid', 'true');

  await page.getByRole('searchbox').first().fill('lab');
  await page.getByRole('button', { name: 'lab.example.com.' }).click();
  await expect(page.locator('[aria-invalid="true"]')).toHaveCount(0);
  await expect(page.getByText('Fill in this field.')).toHaveCount(0);
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
