import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

// The Overnight updates part of Settings. The answers are stubbed because the
// test server runs with update checks off, where this section only says it is
// unavailable. Nothing here can install anything.

const base = {
  available: true,
  unavailableReason: '',
  enabled: false,
  time: '',
  zone: '',
  needsPassphrase: false,
  blockedTag: '',
  last: null,
};

async function open(page: Page, answer: Record<string, unknown>) {
  const posts: Record<string, unknown>[] = [];
  await page.route('**/api/update/auto', (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      posts.push(body);
      return route.fulfill({ json: { ...answer, ok: true, enabled: body.enabled, time: body.time || '', zone: body.zone || '' } });
    }
    return route.fulfill({ json: answer });
  });
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await sheet.getByRole('button', { name: 'Updates' }).click();
  await expect(sheet.getByRole('heading', { name: 'Overnight updates' })).toBeVisible();
  return { sheet, posts };
}

test('it starts off, and turning it on sends the chosen time', async ({ page }) => {
  const { sheet, posts } = await open(page, base);
  await expect(sheet.getByText('Off. New versions install only')).toBeVisible();
  await sheet.getByLabel(/^Time \(/).fill('02:15');
  await sheet.getByRole('button', { name: 'Turn on overnight updates' }).click();
  await expect(sheet.getByText('On. Installs new versions at 02:15')).toBeVisible();
  expect(posts[0]).toMatchObject({ enabled: true, time: '02:15' });
});

test('the passphrase notice is on screen before it can be turned on', async ({ page }) => {
  const warning = 'After an overnight update, you will need to enter your passphrase.';
  const { sheet } = await open(page, { ...base, needsPassphrase: true, passphraseWarning: warning });
  await expect(sheet.getByText(warning)).toBeVisible();
});

test('Docker says why it is unavailable and offers no controls', async ({ page }) => {
  const reason = 'Overnight updates are not available in Docker. Update by pulling the new image.';
  const { sheet } = await open(page, { ...base, available: false, unavailableReason: reason });
  await expect(sheet.getByText(reason)).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Turn on overnight updates' })).toHaveCount(0);
});

test('an unfinished update is shown as unfinished', async ({ page }) => {
  const message = 'The update to v9.0.0 started, but the new version has not confirmed it is running.';
  const { sheet } = await open(page, { ...base, enabled: true, time: '03:00', zone: 'UTC', last: { outcome: 'incomplete', tag: 'v9.0.0', message } });
  await expect(sheet.getByText(`Last result: ${message}`)).toBeVisible();
});
