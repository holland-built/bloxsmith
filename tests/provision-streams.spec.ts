import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// The three Provision streams nothing tested.
//
// Provision has five server-sent-event endpoints and coverage was uneven rather
// than absent, which is why the gap survived: `grep -rhoE
// "api/(provision|teardown)[a-z/-]*stream" tests/` finds four mocks of
// /api/provision/seed-demo/stream and one of /api/teardown/seed-demo/stream —
// the demo-data paths, exercised by provision-outcome.spec.ts and
// provision-rollback.spec.ts — and NOTHING for the three an operator actually
// uses on a real estate:
//
//   /api/provision/stream        Subnet mode — the primary path
//   /api/provision/site/stream   Full site mode
//   /api/teardown/site/stream    tearing a site back down
//
// tests/page-fixtures.ts deliberately omits all five: a probe showed they are
// never touched on page load, only on submit, so a page baseline never reaches
// them. That is correct for the baseline and is exactly why they needed a spec
// of their own.
//
// WHAT IS ASSERTED, and what deliberately is not. useStreamFlow
// (ui/src/tabs/Provision.jsx:76) is one driver shared by all five paths, so the
// state machine itself — idle → busy → previewed → applied, and the error frame
// that stops it — is already proven by the seed specs. What is NOT proven for
// these three is that each one is WIRED to the right endpoint with the right
// query, and that its own apply button and banner exist. A driver that works
// and a button pointed at the wrong URL look identical from the seed tests.

test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

// The server-sent-event body shape the driver parses: one JSON object per
// `data:` line. A frame carrying `template` updates a row; a frame carrying
// `done` ends the run; a frame carrying `error` without `template` aborts it.
const sse = (...frames: unknown[]) => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');

const OK_RUN = sse(
  { template: 'baseline-subnet', phase: 'created' },
  { done: true, succeeded: 1, failed: 0, skipped: 0 },
);

const FAILED_RUN = sse(
  { template: 'baseline-subnet', phase: 'failed', error: 'upstream refused' },
  { error: 'run aborted', rollback: { status: 'complete', residual: [] } },
);

/** Record every stream request so the URL, not just the outcome, is asserted. */
async function stubStream(page: import('@playwright/test').Page, path: string, body: string) {
  const seen: string[] = [];
  await page.route(`**${path}*`, (route) => {
    seen.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body });
  });
  return seen;
}

async function openMode(page: import('@playwright/test').Page, label: string) {
  await page.goto('/#provision');
  await expect(page.locator('h1').first()).toBeVisible();
  await page.getByRole('button', { name: label, exact: true }).click();
  // Preview is `disabled={!space}` (ui/src/tabs/Provision.jsx:298), so the space
  // has to be chosen before anything can be clicked. The seed paths need no
  // input at all, which is why their specs never had to do this.
  if (label === 'Subnet') {
    const space = page.getByRole('combobox').first();
    await space.selectOption({ label: 'Baseline Space' });
    return;
  }
  // Full site is gated on a TEMPLATE, not a space (`disabled={!siteTemplate}`,
  // ui/src/tabs/Provision.jsx:394) — a different gate from Subnet mode, which is
  // why one openMode could not serve both.
  const templatePicker = page.getByRole('combobox').filter({ hasText: /baseline-site/ }).first();
  await templatePicker.selectOption({ label: 'baseline-site' });
}

test('Subnet mode previews and applies against /api/provision/stream', async ({ page }) => {
  const seen = await stubStream(page, '/api/provision/stream', OK_RUN);
  await openMode(page, 'Subnet');

  await page.getByRole('button', { name: 'Preview', exact: true }).first().click();
  // Preview must run DRY. This is the assertion the seed specs cannot make for
  // this path: a preview that quietly submitted dry=0 would write to a real
  // estate and still look correct on screen.
  await expect.poll(() => seen.length, { message: 'preview never opened the stream' }).toBeGreaterThan(0);
  expect(seen[0], 'preview must run with dry=1').toContain('dry=1');

  await page.getByRole('button', { name: 'Provision', exact: true }).click();
  await expect.poll(() => seen.length).toBeGreaterThan(1);
  expect(seen[1], 'apply must run with dry=0').toContain('dry=0');
});

// NOT WORKING YET, and declared rather than deleted so the gap stays visible.
// Subnet mode (above) is covered and green. Full-site and site-teardown are
// gated on selecting a site TEMPLATE (`disabled={!siteTemplate}`,
// ui/src/tabs/Provision.jsx:394) rather than a space, and driving that picker
// from the test has not been worked out — the combobox lookup times out even
// with a type:'site' template in the fixture set, so something else about how
// SiteMode renders its picker is still unaccounted for. Measured, not guessed:
// the stream stubs are never hit, so the failure is upstream of the endpoints
// these tests exist to check. Finishing them is a UI-navigation problem, not a
// fixture one.
test.fixme('Full site mode uses /api/provision/site/stream, not the subnet one', async ({ page }) => {
  const site = await stubStream(page, '/api/provision/site/stream', OK_RUN);
  const subnet = await stubStream(page, '/api/provision/stream', OK_RUN);
  await openMode(page, 'Full site');

  await page.getByRole('button', { name: 'Preview', exact: true }).first().click();
  await expect.poll(() => site.length, { message: 'site preview never opened its stream' }).toBeGreaterThan(0);
  // The negative half is the point: /api/provision/stream is a live route in
  // this test, so a mis-wired site button would succeed silently and only this
  // assertion would catch it.
  expect(subnet, 'Full site must not call the subnet stream').toEqual([]);
});

// NOT WORKING YET, and declared rather than deleted so the gap stays visible.
// Subnet mode (above) is covered and green. Full-site and site-teardown are
// gated on selecting a site TEMPLATE (`disabled={!siteTemplate}`,
// ui/src/tabs/Provision.jsx:394) rather than a space, and driving that picker
// from the test has not been worked out — the combobox lookup times out even
// with a type:'site' template in the fixture set, so something else about how
// SiteMode renders its picker is still unaccounted for. Measured, not guessed:
// the stream stubs are never hit, so the failure is upstream of the endpoints
// these tests exist to check. Finishing them is a UI-navigation problem, not a
// fixture one.
test.fixme('site teardown uses /api/teardown/site/stream and surfaces a failure', async ({ page }) => {
  const teardown = await stubStream(page, '/api/teardown/site/stream', FAILED_RUN);
  await openMode(page, 'Full site');

  const tearDown = page.getByRole('button', { name: /Tear down this site/i });
  if ((await tearDown.count()) === 0) {
    test.skip(true, 'teardown control is admin-only and the fixture whoami is not an admin on this build');
  }
  await tearDown.first().click();

  await expect.poll(() => teardown.length, { message: 'teardown never opened its stream' }).toBeGreaterThan(0);
  // The failure frame carries a rollback report, and the operator has to be told
  // the run aborted rather than left on a spinner.
  await expect(page.getByText(/run aborted/i).first()).toBeVisible();
});
