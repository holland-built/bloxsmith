import { test, expect } from './fixtures';
import { domOrder, dragOntoRightHalfOf, gotoTab, liveText, tabToHandle } from './layout-helpers';

// THE COMPLAINT THIS FILE EXISTS FOR, and it was asked three times: "how do I
// save the layout?" The layout has always saved itself and has never once said
// so, because the only channel it spoke on — the `sr-only` live region — is
// invisible to a sighted operator by design.
//
// The fix had to land in two parts and in this order, and this file proves both:
//
//   1. HONEST FIRST. saveLayout used to `return res.ok`, so a 500 resolved
//      false and CardGrid's `.catch`-only handler dropped it. A visible "Saved"
//      bolted on top of that would have been worse than silence — it would have
//      lied on exactly the occasions the operator most needed the truth. So the
//      failing half is tested here as carefully as the passing half.
//   2. VISIBLE SECOND. `[data-layout-toast]` is a sibling of the live region,
//      not the region itself: the region is sr-only and must stay so (a screen
//      reader would otherwise hear every message twice), and tests/layout-drag
//      .spec.ts pins its exact text with `toBe` in eight places.
//
// #security rather than #overview on purpose: layout-drag.spec.ts owns
// `__layout_overview` and this file must not become a second writer of it.
// This file is the exclusive owner of nothing — it borrows `__layout_security`
// from layout-drag.spec.ts — so it deletes that view before AND after every
// test, exactly as that spec does, and playwright.config.ts pins workers to 1
// so the two files can never interleave.

const VIEW = '__layout_security';

// Read off Security.jsx's <CardGrid layoutKey="security">, by hand. The first
// three are one hiddenPanelGroup run.
const DECLARED = [
  'security-threat-events',
  'security-response-summary',
  'security-triage-inbox',
  'security-lookalike-domains',
  'security-ctem-exposure',
  'security-asset-insights',
  'security-exposures',
  'security-asset-risk',
  'security-exposed-surface',
  'security-ctem-assets',
  'security-threat-feed-activity',
  'security-soc-insights',
];

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ request }) => {
  await request.delete(`/api/views/${VIEW}`);
});
// afterEach rather than afterAll: `request` is a test-scoped fixture and
// Playwright refuses it in an afterAll hook.
test.afterEach(async ({ request }) => {
  await request.delete(`/api/views/${VIEW}`);
});

const gotoSecurity = (page: import('@playwright/test').Page) =>
  gotoTab(page, 'security', DECLARED.length, 1600, 2400);

// EVERY TEXT THE PILL EVER HELD, recorded rather than sampled.
//
// The pill takes itself away after 2.5s, so a plain `expect(pill).toHaveText`
// after a gesture is a race against that timer — it would pass on a fast
// machine and flake on a loaded one, and a flaky test about a save message is
// worse than no test. A MutationObserver installed BEFORE the gesture sees
// every value the element passed through, so the assertions below are about
// what happened rather than about what was still on screen when we looked.
async function recordPill(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const el = document.querySelector('[data-layout-toast]');
    if (!el) throw new Error('no [data-layout-toast] on this page');
    (window as any).__pillSeen = [];
    const push = () => {
      const t = (el.textContent ?? '').trim();
      const seen = (window as any).__pillSeen as string[];
      if (seen[seen.length - 1] !== t) seen.push(t);
    };
    new MutationObserver(push).observe(el, { childList: true, characterData: true, subtree: true });
  });
}

const pillSeen = (page: import('@playwright/test').Page) =>
  page.evaluate(() => ((window as any).__pillSeen ?? []) as string[]);

const pillNow = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-layout-toast]') as HTMLElement | null;
    return el ? { text: (el.textContent ?? '').trim(), className: el.className } : null;
  });

// The exact copy, written out here rather than imported from the component:
// this is a test of what the operator READS, and importing the constant would
// make a silent rewording pass.
const SAVED = 'Saved';
const FAILED = 'Could not save — your change is only on this screen.';

// Fails only the POST. loadLayout GETs the same URL on every mount, so a blanket
// fulfill(500) would break the page's own layout read and this test would be
// proving something about a broken load instead of about a rejected save.
async function breakTheSave(page: import('@playwright/test').Page) {
  await page.route('**/api/views', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"nope"}' });
      return;
    }
    await route.continue();
  });
}

test('a drag that saves says so, in words a sighted operator can actually see', async ({ page, request }) => {
  test.setTimeout(180_000);
  await gotoSecurity(page);
  expect(await domOrder(page)).toEqual(DECLARED);

  // Standing state: the element exists on every managed grid, and it is
  // display:none with nothing in it until something has been saved.
  const before = await pillNow(page);
  expect(before?.text).toBe('');
  expect(before?.className).toContain('hidden');

  await recordPill(page);
  await dragOntoRightHalfOf(page, DECLARED[0], 1);

  expect(await pillSeen(page), 'the drag saved but the screen never said so').toContain(SAVED);
  // And the save really happened — the message is not decoration over nothing.
  expect((await request.get(`/api/views/${VIEW}`)).status()).toBe(200);
  // The other channel said its own piece, in its own words, unchanged.
  expect(await liveText(page)).toContain('Layout saved');

  // It goes away on its own. A status that stays forever is chrome, and the
  // 2.5s timer is the whole difference.
  await page.waitForTimeout(3000);
  const after = await pillNow(page);
  expect(after?.text, 'the pill never cleared').toBe('');
  expect(after?.className).toContain('hidden');
});

test('a save the server rejects says THAT, and claims no success anywhere', async ({ page, request }) => {
  test.setTimeout(180_000);
  await gotoSecurity(page);
  await breakTheSave(page);
  await recordPill(page);

  await dragOntoRightHalfOf(page, DECLARED[0], 1);

  const seen = await pillSeen(page);
  expect(seen, 'a rejected save showed the operator nothing').toContain(FAILED);
  // THE POINT OF THE ORDERING. Not one frame of this may have read "Saved".
  expect(seen.filter((t) => t.includes(SAVED)), 'a rejected save claimed success on screen').toEqual([]);

  const live = await liveText(page);
  expect(live).toContain('Layout could not be saved');
  expect(live, 'a rejected save claimed success to a screen reader').not.toContain('Layout saved');

  // The words are true: nothing reached the server.
  expect((await request.get(`/api/views/${VIEW}`)).status()).toBe(404);
});

test('the keyboard path claims nothing until the server has answered', async ({ page, request }) => {
  test.setTimeout(180_000);
  await gotoSecurity(page);
  await breakTheSave(page);

  await tabToHandle(page, DECLARED[0]);
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);

  // Enter used to announce "…placed at position 2 of 12. Layout saved."
  // synchronously, before the POST had left. It still says where the panel
  // landed — that part was always true — and now says nothing about saving
  // until there is something true to say.
  const live = await liveText(page);
  expect(live).toContain('placed at position 2 of 12');
  expect(live, 'Enter is still claiming a save it has not got').not.toContain('Layout saved');
  expect(live).toContain('Layout could not be saved');
  expect((await request.get(`/api/views/${VIEW}`)).status()).toBe(404);
});

test('the newest save is the only one that may speak', async ({ page }) => {
  test.setTimeout(180_000);
  await gotoSecurity(page);

  // Two POSTs, resolving OUT OF ORDER: the first is held for 1.5s and then
  // rejected, the second answers 200 straight away. Without the sequence guard
  // in ctx.apply the stale rejection would land last and leave the page
  // reading "Could not save" about a layout that is, in fact, saved.
  let posts = 0;
  await page.route('**/api/views', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    posts++;
    if (posts === 1) {
      await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"slow no"}' });
      return;
    }
    await route.continue();
  });

  await recordPill(page);
  await tabToHandle(page, DECLARED[0]);
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter'); // save #1 — slow, and doomed
  await page.keyboard.press('Enter'); // back into move mode
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter'); // save #2 — fast, and fine
  // Long enough for the held first POST to come home after the second.
  await page.waitForTimeout(3000);

  expect(posts, 'this test needs two POSTs to prove anything').toBe(2);
  const seen = await pillSeen(page);
  expect(seen).toContain(SAVED);
  expect(seen.filter((t) => t.includes('Could not save')), 'a stale rejection overwrote a newer success').toEqual([]);
  expect(await liveText(page), 'a stale rejection overwrote a newer success').not.toContain('could not be saved');
});
