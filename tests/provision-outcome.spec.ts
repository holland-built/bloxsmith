import { test, expect } from './fixtures';

// Regression coverage for the Provision "Seed complete." bug: the seed and
// teardown-seed-demo SSE streams used to terminate with a bare
// {"done":true,"summary":{...arrays...}} frame regardless of outcome, so an
// all-failed run rendered the identical green "Seed complete." banner as a
// fully successful one, and the per-template progress rollup only ever grew
// on failure (successes emitted nothing template-keyed, so "done" was
// structurally always 0). The fix ships explicit succeeded/failed/skipped/
// total counts in the terminal frame and a per-template frame on success too
// — this spec stubs that stream for three outcomes and asserts the banner
// wording and the progress rollup differ correctly across all three.

function sseFrame(obj: unknown) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const TEMPLATES = [
  'blocks/regional_address_blocks.yaml',
  'amer/lab/site-amer-lab.yaml',
  'amer/production/site-amer-hq.yaml',
];

function sseBody(outcomes: Array<'succeeded' | 'failed'>) {
  const frames: string[] = [sseFrame({ step: 'Seeding blocks…' })];
  const summary: Record<string, string[]> = { succeeded: [], failed: [], skipped: [] };
  outcomes.forEach((outcome, i) => {
    const template = TEMPLATES[i];
    summary[outcome].push(template);
    if (outcome === 'failed') {
      frames.push(sseFrame({ template, error: 'simulated upstream failure' }));
    } else {
      frames.push(sseFrame({ template, phase: 'succeeded', step: `[${template}] succeeded` }));
    }
  });
  const succeeded = summary.succeeded.length;
  const failed = summary.failed.length;
  const skipped = summary.skipped.length;
  frames.push(sseFrame({ done: true, summary, succeeded, failed, skipped, total: succeeded + failed + skipped }));
  return frames.join('');
}

const ALL_FAILED = sseBody(['failed', 'failed', 'failed']);
const ALL_SUCCEEDED = sseBody(['succeeded', 'succeeded', 'succeeded']);
const PARTIAL = sseBody(['succeeded', 'failed', 'succeeded']);

async function stubSeedStream(page: import('@playwright/test').Page, body: string) {
  await page.route('**/api/provision/seed-demo/stream*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body }));
}

// Runs preview then apply against the stubbed stream, landing on the
// "applied" banner (the branch under test — a dry preview must never claim
// "complete" regardless of outcome, so only apply's wording is asserted).
async function seedApply(page: import('@playwright/test').Page) {
  await page.goto('/#provision');
  await page.getByRole('button', { name: 'Seed demo', exact: true }).click();
  // Both the seed and teardown-seed cards use the default "Preview" label —
  // the seed card renders first, so .first() targets it unambiguously.
  await page.getByRole('button', { name: 'Preview', exact: true }).first().click();
  await page.getByRole('button', { name: 'Seed demo data', exact: true }).click();
}

test.describe('Provision → Seed demo data outcome banner', () => {
  test('all templates failed: no success banner, failure wording with 0 succeeded', async ({ page }) => {
    await stubSeedStream(page, ALL_FAILED);
    await seedApply(page);

    await expect(page.getByText('Seed complete.')).toHaveCount(0);
    await expect(page.getByText(/Seed failed.*0 of 3/i)).toBeVisible();
    await expect(page.getByText('0/3 done · 3 failed')).toBeVisible();
  });

  test('all templates succeeded: exact "Seed complete." wording unchanged', async ({ page }) => {
    await stubSeedStream(page, ALL_SUCCEEDED);
    await seedApply(page);

    await expect(page.getByText('Seed complete.')).toBeVisible();
    await expect(page.getByText(/Seed (failed|partial)/i)).toHaveCount(0);
    await expect(page.getByText('3/3 done')).toBeVisible();
  });

  test('partial run: distinct "partial" wording with correct counts, not "complete"', async ({ page }) => {
    await stubSeedStream(page, PARTIAL);
    await seedApply(page);

    await expect(page.getByText('Seed complete.')).toHaveCount(0);
    await expect(page.getByText(/Seed partial.*2 of 3 succeeded.*1 failed/i)).toBeVisible();
    await expect(page.getByText('2/3 done · 1 failed')).toBeVisible();
  });

  test('the three outcomes render non-overlapping banner text', async ({ page }) => {
    await stubSeedStream(page, ALL_FAILED);
    await seedApply(page);
    const failedBanner = await page.getByText(/Seed failed/i).first().textContent();

    await page.unroute('**/api/provision/seed-demo/stream*');
    await stubSeedStream(page, ALL_SUCCEEDED);
    await seedApply(page);
    const successBanner = await page.getByText('Seed complete.').first().textContent();

    await page.unroute('**/api/provision/seed-demo/stream*');
    await stubSeedStream(page, PARTIAL);
    await seedApply(page);
    const partialBanner = await page.getByText(/Seed partial/i).first().textContent();

    expect(failedBanner).not.toEqual(successBanner);
    expect(failedBanner).not.toEqual(partialBanner);
    expect(successBanner).not.toEqual(partialBanner);
  });
});
