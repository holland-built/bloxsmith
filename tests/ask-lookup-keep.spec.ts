import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Ask tab, threat lookup: when a retry of the SAME search fails, the last good
// answer of the part that failed stays on screen under its failure, labelled
// "from your earlier lookup of X, at HH:MM". A different search shows only its
// own answer or error. Block domain (and Unblock) are off while a kept answer
// is shown, because they write to the tenant.
//
// Every check below takes ONE reading after the lookup has settled. A retrying
// assertion that "the old answer is absent" can pass by waiting for new data
// to replace old.

const Q = 'bad.example.com';
const LOOKUP = '[data-panel-id="ai-threat-lookup"]';
const KEPT = `${LOOKUP} [data-kept-result]`;

const goodEntities = (name: string) => ({ entities: [{ name, threat_level: 'high' }], availability: 'ok' });
const goodDossier = (country: string) => ({
  query: Q,
  summary: { malicious: false, assessed: true, country },
  sources: [{ source: 'geo', detail: { country } }],
});
// A null body is sent as an empty response, which is not readable JSON.
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: body === null ? '' : JSON.stringify(body) });

// Answers each request with the next entry; the last entry repeats.
function sequence(page, pattern: string, answers: Array<{ status?: number; body: unknown }>) {
  let n = 0;
  return page.route(pattern, (route) => {
    const a = answers[Math.min(n++, answers.length - 1)];
    return route.fulfill(json(a.body, a.status));
  });
}

async function lookUp(page, text: string) {
  await page.getByPlaceholder('domain, IP, or host…').fill(text);
  await page.getByRole('button', { name: 'Lookup', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Lookup', exact: true })).toBeEnabled();
}

async function hhmm(page) {
  return page.evaluate(() => {
    const t = new Date();
    return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  });
}

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
  await page.setViewportSize({ width: 1440, height: 900 });
});

for (const [name, failure, failText] of [
  ['the server errors', { status: 500, body: { error: 'upstream exploded' } }, 'upstream exploded'],
  ['the search reports itself unavailable', { status: 200, body: { entities: [], availability: 'error', reason: 'upstream timed out' } }, 'Threat lookup unavailable'],
  ['the answer is not readable', { status: 200, body: null }, 'unreadable response'],
] as const) {
  test(`a retry of the same search whose entity search fails (${name}) keeps the last good matches, labelled`, async ({ page }) => {
    await sequence(page, '**/api/threat-lookup*', [{ body: goodEntities('first-answer.example') }, failure]);
    await sequence(page, '**/api/dossier*', [{ body: goodDossier('ZZ') }]);
    await page.goto('/#ai');
    await lookUp(page, Q);
    await expect(page.locator(LOOKUP).getByText('first-answer.example')).toBeVisible();
    await lookUp(page, Q);
    await expect(page.locator(KEPT)).toHaveCount(1);

    const kept = page.locator(KEPT);
    await expect(kept.getByText(`from your earlier lookup of ${Q}, at ${await hhmm(page)}`, { exact: true })).toBeVisible();
    await expect(kept.getByText('first-answer.example')).toBeVisible();
    // The failure itself is still said, above the kept answer.
    await expect(page.locator(LOOKUP).getByText(failText)).toBeVisible();
  });
}

for (const [name, failure] of [
  ['the server refuses', { status: 503, body: { error: 'vault locked' } }],
  ['the answer is not readable', { status: 200, body: null }],
] as const) {
  test(`a retry of the same search whose dossier fails (${name}) keeps the last good dossier, labelled, and shows the fresh matches`, async ({ page }) => {
    await sequence(page, '**/api/threat-lookup*', [{ body: goodEntities('first-answer.example') }, { body: goodEntities('second-answer.example') }]);
    await sequence(page, '**/api/dossier*', [{ body: goodDossier('KEPTLAND') }, failure]);
    await page.goto('/#ai');
    await lookUp(page, Q);
    await expect(page.locator(LOOKUP).getByText('KEPTLAND').first()).toBeVisible();
    await lookUp(page, Q);
    await expect(page.locator(LOOKUP).getByText('Dossier unavailable')).toBeVisible();
    await expect(page.locator(KEPT)).toHaveCount(1);

    const kept = page.locator(KEPT);
    await expect(kept.getByText(`from your earlier lookup of ${Q}, at ${await hhmm(page)}`, { exact: true })).toBeVisible();
    await expect(kept.getByText('KEPTLAND').first()).toBeVisible();
    // The entity search worked this time: its fresh answer shows, the old one does not.
    const text = (await page.locator(LOOKUP).allTextContents()).join(' ');
    expect(text).toContain('second-answer.example');
    expect(text).not.toContain('first-answer.example');
  });
}

test('a different search that fails shows only its own error, never the earlier answer', async ({ page }) => {
  await sequence(page, '**/api/threat-lookup*', [{ body: goodEntities('first-answer.example') }, { status: 500, body: { error: 'upstream exploded' } }]);
  await sequence(page, '**/api/dossier*', [{ body: goodDossier('KEPTLAND') }, { status: 503, body: { error: 'vault locked' } }]);
  await page.goto('/#ai');
  await lookUp(page, Q);
  await expect(page.locator(LOOKUP).getByText('KEPTLAND').first()).toBeVisible();
  await lookUp(page, 'other.example.com');
  await expect(page.locator(LOOKUP).getByText('Dossier unavailable')).toBeVisible();
  await expect(page.locator(LOOKUP).getByText('upstream exploded')).toBeVisible();

  // One reading, after both parts have answered.
  const text = (await page.locator(LOOKUP).allTextContents()).join(' ');
  expect(text).not.toContain('first-answer.example');
  expect(text).not.toContain('KEPTLAND');
  expect(text).not.toContain('from your earlier lookup');
});

test('Block domain and Unblock are off while a kept answer is shown, and back on for a fresh one', async ({ page }) => {
  await page.route('**/api/block-domain', (route) => route.fulfill(json({ ok: true })));
  await sequence(page, '**/api/threat-lookup*', [
    { body: goodEntities('first-answer.example') },
    { status: 500, body: { error: 'upstream exploded' } },
    { body: goodEntities('third-answer.example') },
  ]);
  await sequence(page, '**/api/dossier*', [{ body: goodDossier('ZZ') }]);
  await page.goto('/#ai');
  await lookUp(page, Q);
  // Blocked on the fresh answer, so the next state to guard is Unblock.
  await page.getByRole('button', { name: 'Block domain' }).click();
  await expect(page.getByRole('button', { name: 'Unblock' })).toBeVisible();

  await lookUp(page, Q);
  await expect(page.locator(KEPT)).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Block domain' })).toBeDisabled();
  expect(await page.getByRole('button', { name: 'Unblock' }).count()).toBe(0);
  await expect(page.locator(LOOKUP).getByText('off while an earlier result is shown')).toBeVisible();

  await lookUp(page, Q);
  await expect(page.locator(LOOKUP).getByText('third-answer.example')).toBeVisible();
  expect(await page.locator(KEPT).count()).toBe(0);
  await expect(page.getByText('off while an earlier result is shown')).toHaveCount(0);
});

test('a late dossier from an earlier search does not land under a newer one', async ({ page }) => {
  await page.route('**/api/threat-lookup*', (route) => route.fulfill(json(goodEntities('x.example'))));
  await page.route('**/api/dossier*', async (route) => {
    const q = new URL(route.request().url()).searchParams.get('q');
    if (q === 'slow.example.com') {
      await new Promise((r) => setTimeout(r, 1500));
      return route.fulfill(json(goodDossier('SLOWLAND'))).catch(() => {});
    }
    return route.fulfill(json(goodDossier('FASTLAND')));
  });
  await page.goto('/#ai');
  await lookUp(page, 'slow.example.com');
  await lookUp(page, 'fast.example.com');
  await expect(page.locator(LOOKUP).getByText('FASTLAND').first()).toBeVisible();
  await page.waitForTimeout(2000);
  const text = (await page.locator(LOOKUP).allTextContents()).join(' ');
  expect(text).toContain('FASTLAND');
  expect(text).not.toContain('SLOWLAND');
});
