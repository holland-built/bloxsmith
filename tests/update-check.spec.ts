import type { Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';

// The settings sheet's "Check for updates" control.
//
// THE BUG THIS COVERS. The app had no way to ask "is there a new version?".
// UpdateButton.jsx checked on mount and then every six hours, and the server
// remembered its answer for thirty minutes — so on 2026-08-07 a release
// published at 12:37 was invisible until 12:51, because the answer had been
// remembered at 12:21. The only way out was restarting the service. The Go
// half of the fix (?force=1, and a five-second floor under it) already exists
// and is covered by go/update_test.go; this file covers the half a person can
// actually reach.
//
// EVERY TEST STUBS /api/update/check, and that is not laziness. The dev server
// runs with DISABLE_UPDATE_CHECK=1 (scripts/dev-serve.sh), so unstubbed it can
// only ever answer checkDisabled — one of the five states below, and not the
// interesting one. Stubbing is also the only way to assert on an answer that
// says "a newer version exists" without publishing a release to make it true.

const OPEN_SETTINGS = { name: 'Settings', exact: true };
const CHECK = { name: 'Check for updates', exact: true };

const fulfillJson = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const isoAgo = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();

const upToDate = (over: Record<string, unknown> = {}) => ({
  current: 'v3.55.0',
  latest: 'v3.55.0',
  available: false,
  url: '',
  selfUpdate: true,
  cached: false,
  checkedAt: isoAgo(3),
  ...over,
});

/**
 * Stubs the check endpoint and records every URL it was asked for, so a test
 * can prove the click asked for a FRESH answer rather than any answer.
 */
async function stubCheck(page: Page, answer: (forced: boolean) => unknown) {
  const urls: string[] = [];
  await page.route('**/api/update/check*', (route) => {
    const url = route.request().url();
    urls.push(url);
    return fulfillJson(route, answer(/[?&]force=(1|true|yes|on)\b/i.test(url)));
  });
  return urls;
}

async function openSettings(page: Page) {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();
  await page.getByRole('button', OPEN_SETTINGS).click();
  const sheet = page.getByRole('dialog', { name: 'Settings' });
  await expect(sheet).toBeVisible();
  return sheet;
}

test('the sheet says which version is running and when it last looked', async ({ page }) => {
  await stubCheck(page, () => upToDate());
  const sheet = await openSettings(page);

  await expect(sheet).toContainText('3.55.0');
  // Plain words, not a timestamp: the reader is not being asked to subtract
  // 12:21 from 12:40 in their head, which is the arithmetic that hid the bug.
  await expect(sheet).toContainText('Last checked 3 minutes ago');
});

test('the button is a real button, reachable by keyboard, and answers', async ({ page }) => {
  await stubCheck(page, () => upToDate());
  const sheet = await openSettings(page);

  const btn = sheet.getByRole('button', CHECK);
  await expect(btn).toBeVisible();
  // press() sends a real key event to a focused element — no synthesised
  // click — so this fails if the control is pointer-only.
  await btn.press('Enter');

  await expect(sheet.getByRole('status')).toContainText("You're on the latest version.");
});

test('the click asks GitHub again instead of reading the remembered answer', async ({ page }) => {
  const urls = await stubCheck(page, () => upToDate());
  const sheet = await openSettings(page);

  await sheet.getByRole('button', CHECK).click();
  await expect(sheet.getByRole('status')).toContainText("You're on the latest version.");

  // This is the whole bug in one assertion. Without force=1 the server answers
  // from a cache up to thirty minutes old and the click changes nothing.
  expect(urls.some((u) => /[?&]force=1\b/.test(u))).toBe(true);
});

test('a newer version is named, and it says where the button that installs it is', async ({ page }) => {
  await stubCheck(page, () => upToDate({ latest: 'v3.56.0', available: true, checkedAt: isoAgo(0) }));
  const sheet = await openSettings(page);

  await sheet.getByRole('button', CHECK).click();
  const said = sheet.getByRole('status');
  await expect(said).toContainText('3.56.0');
  await expect(said).toContainText('top of the screen');
  // The apply flow lives in the header pill and is not duplicated here.
  await expect(sheet.getByRole('button', { name: /^Install|^Apply/ })).toHaveCount(0);
});

test('a check that could not reach the update service says so, and claims nothing', async ({ page }) => {
  await stubCheck(page, () =>
    upToDate({ error: 'dial tcp: lookup api.github.com: no such host', checkedAt: isoAgo(0) }),
  );
  const sheet = await openSettings(page);

  await sheet.getByRole('button', CHECK).click();
  const said = sheet.getByRole('status');
  await expect(said).toContainText('could not be reached');
  // A failed check rendering as "up to date" is the lie this guards.
  await expect(said).not.toContainText('latest version');
  await expect(said).not.toContainText('available');
});

test('an answer served from memory is labelled, not passed off as fresh', async ({ page }) => {
  // What the five-second floor (forcedCheckMinInterval) returns for a second
  // click: the same answer, honestly flagged cached.
  await stubCheck(page, (forced) => upToDate({ cached: forced, checkedAt: isoAgo(4) }));
  const sheet = await openSettings(page);

  await sheet.getByRole('button', CHECK).click();
  await expect(sheet.getByRole('status')).toContainText('Just checked a moment ago');
});

test('the button is refused while a check is in flight, so a double click cannot lie', async ({ page }) => {
  await stubCheck(page, () => upToDate());
  const sheet = await openSettings(page);

  const btn = sheet.getByRole('button', CHECK);
  await btn.click();
  await expect(btn).toBeDisabled();
});

test('checks that the operator switched off are named as such, not as "up to date"', async ({ page }) => {
  // DISABLE_UPDATE_CHECK=1. Nothing was looked up, so there is nothing to
  // press and no version claim to make.
  await stubCheck(page, () => ({
    current: 'v3.55.0',
    latest: '',
    available: false,
    url: '',
    selfUpdate: true,
    cached: false,
    checkDisabled: true,
  }));
  const sheet = await openSettings(page);

  await expect(sheet).toContainText('switched off');
  await expect(sheet).not.toContainText("You're on the latest version.");
  await expect(sheet.getByRole('button', CHECK)).toHaveCount(0);
});

test('the section survives the narrow-width fold', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await stubCheck(page, () => upToDate());
  const sheet = await openSettings(page);

  await expect(sheet.getByRole('button', CHECK)).toBeVisible();
});
