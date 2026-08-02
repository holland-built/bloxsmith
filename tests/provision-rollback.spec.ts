import { test, expect } from './fixtures';

// Coverage for the rollback report on a FAILED provision.
//
// The failure frame carries a `rollback` object alongside `error`, and the UI
// used to keep the error string and throw the report away — so the one fact
// the operator most needs (which objects the failed run created that cleanup
// could NOT delete, and are therefore still live on the customer's network)
// was only findable by digging through the audit log.
//
// The three silent/calm outcomes matter as much as the loud one: an absent
// `rollback` key (an older server) is an UNKNOWN answer and must render
// nothing at all — not an empty box, and above all not a green all-clear.
//
// Everything here runs against a stubbed SSE stream. No tenant is contacted.

function sseFrame(obj: unknown) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

// A clean dry-run plan, so Preview succeeds and reveals Apply. Apply is the
// run under test.
const PREVIEW_OK = [
  sseFrame({ step: 'Planning seed…' }),
  sseFrame({ done: true, summary: { succeeded: [], failed: [], skipped: [] }, succeeded: 1, failed: 0, skipped: 0, total: 1 }),
].join('');

function failureBody(rollback?: unknown) {
  const frame: Record<string, unknown> = { error: 'upstream 500 creating dhcp range' };
  if (rollback !== undefined) frame.rollback = rollback;
  return [sseFrame({ step: 'Creating objects…' }), sseFrame(frame)].join('');
}

const INCOMPLETE = failureBody({
  outcome: 'incomplete',
  attempted: 6,
  deleted: 4,
  residual: [
    { kind: 'subnet', id: 'ipam/subnet/s-1', label: '10.10.1.0/24', status: 500 },
    // Empty label on purpose: the id has to be shown instead, or this object is
    // unidentifiable to whoever has to go delete it by hand.
    { kind: 'dns record', id: 'dns/record/r-9', label: '', status: 409 },
  ],
});

const COMPLETE = failureBody({ outcome: 'complete', attempted: 3, deleted: 3, residual: [] });
const SKIPPED_DRY_RUN = failureBody({ outcome: 'skipped_dry_run', attempted: 0, deleted: 0, residual: [] });
const NO_ROLLBACK_KEY = failureBody(); // older server: key absent entirely

// Preview must succeed (to reveal Apply) and Apply must fail — same endpoint,
// told apart by the dry flag the UI already sends.
async function stubSeedStream(page: import('@playwright/test').Page, applyBody: string) {
  await page.route('**/api/provision/seed-demo/stream*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: route.request().url().includes('dry=1') ? PREVIEW_OK : applyBody,
    }));
}

async function seedApply(page: import('@playwright/test').Page) {
  await page.goto('/#provision');
  await page.getByRole('button', { name: 'Seed demo', exact: true }).click();
  await page.getByRole('button', { name: 'Preview', exact: true }).first().click();
  await page.getByRole('button', { name: 'Seed demo data', exact: true }).click();
  await expect(page.getByText('upstream 500 creating dhcp range').first()).toBeVisible();
}

// The apostrophe is a typographic ’, so the wording is matched with . for it.
const STILL_LIVE = /still live on the customer.s network/i;

test.describe('Provision → rollback report on a failed run', () => {
  test('incomplete: names every object left behind, and says it is still live', async ({ page }) => {
    await stubSeedStream(page, INCOMPLETE);
    await seedApply(page);

    await expect(page.getByText(STILL_LIVE).first()).toBeVisible();
    await expect(page.getByText('10.10.1.0/24').first()).toBeVisible();
    await expect(page.getByText('dns/record/r-9').first()).toBeVisible();
    await expect(page.getByText(/4 of 6 removed/).first()).toBeVisible();
    await expect(page.getByText(/HTTP 500/).first()).toBeVisible();
    await expect(page.getByText(/HTTP 409/).first()).toBeVisible();
  });

  test('complete: one calm line, and none of the critical wording', async ({ page }) => {
    await stubSeedStream(page, COMPLETE);
    await seedApply(page);

    await expect(page.getByText(/Cleanup removed all 3 objects it had created/i).first()).toBeVisible();
    await expect(page.getByText(STILL_LIVE)).toHaveCount(0);
    await expect(page.getByText(/could not remove/i)).toHaveCount(0);
  });

  test('skipped_dry_run: nothing was attempted, so nothing is claimed', async ({ page }) => {
    await stubSeedStream(page, SKIPPED_DRY_RUN);
    await seedApply(page);

    await expect(page.getByText(/cleanup/i)).toHaveCount(0);
    await expect(page.getByText(STILL_LIVE)).toHaveCount(0);
    await expect(page.getByText(/nothing needed removing/i)).toHaveCount(0);
  });

  test('no rollback key (older server): renders nothing about cleanup at all', async ({ page }) => {
    await stubSeedStream(page, NO_ROLLBACK_KEY);
    await seedApply(page);

    await expect(page.getByText(/cleanup/i)).toHaveCount(0);
    await expect(page.getByText(STILL_LIVE)).toHaveCount(0);
    await expect(page.getByText(/nothing needed removing/i)).toHaveCount(0);
    await expect(page.getByText(/left behind/i)).toHaveCount(0);
  });
});
