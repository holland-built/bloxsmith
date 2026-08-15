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

/**
 * Record every stream request so the URL, not just the outcome, is asserted.
 *
 * `body` may be one body for every call, or an array answered in order with the
 * last entry repeating. The teardown test needs the second form: its preview has
 * to succeed before the apply button is rendered at all, so a stub that returned
 * the failure frame to both calls could never reach the destructive path.
 */
async function stubStream(page: import('@playwright/test').Page, path: string, body: string | string[]) {
  const seen: string[] = [];
  const bodies = Array.isArray(body) ? body : [body];
  await page.route(`**${path}*`, (route) => {
    const next = bodies[Math.min(seen.length, bodies.length - 1)];
    seen.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: next });
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
  //
  // BY VALUE, NOT BY LABEL, and that one word is what kept both site tests
  // switched off. The option's value is the bare template name, but what it
  // RENDERS is `{name} — {region}/{environment}` (Provision.jsx:377-379), so
  // for this fixture the visible label is `baseline-site — baseline-region/test`.
  // `selectOption({ label: 'baseline-site' })` matches a label exactly, never as
  // a substring, so it matched nothing and timed out at the picker — which is why
  // the stream stubs were never hit and the failure looked like it was upstream
  // of the endpoints these tests exist to check.
  const templatePicker = page.getByRole('combobox').filter({ hasText: /baseline-site/ }).first();
  await templatePicker.selectOption('baseline-site');
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

test('Full site mode uses /api/provision/site/stream, not the subnet one', async ({ page }) => {
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

// THE APPLY BUTTON DOES NOT EXIST UNTIL A PREVIEW HAS SUCCEEDED. PreviewApply
// renders it only when `status === 'previewed' && !stale && !busy`
// (ui/src/components/ui.jsx:2583), so "click the destructive button" is a
// three-step sequence here, not one click: preview, type the site name to
// confirm, then apply. The earlier version of this test clicked the first thing
// matching /Tear down this site/i, which is the CARD HEADER — that is why it
// found a control, clicked it, and never opened a stream.
//
// So the stub has to answer differently per call: the preview must SUCCEED or
// the apply button is never rendered and the destructive path cannot be reached
// at all, and only then does the failure frame have somewhere to land. That is
// what `sequence` is for, and it is also a stronger assertion than the original
// — it pins dry=1 on preview and dry=0 on apply, the same pair the Subnet test
// above proves for its own endpoint.
test('site teardown uses /api/teardown/site/stream and surfaces a failure', async ({ page }) => {
  const teardown = await stubStream(page, '/api/teardown/site/stream', [OK_RUN, FAILED_RUN]);
  await openMode(page, 'Full site');

  const card = page.locator('[data-panel-id="provision-site-teardown"]');

  // Not a test.skip. The baseline whoami is `role: 'admin'`
  // (tests/page-fixtures.ts:210), so this control MUST render — the previous
  // version skipped itself when it could not find the button, which would have
  // hidden a regression that removed the teardown control entirely.
  const confirm = card.getByLabel(/Type the site name to confirm/i);
  await expect(confirm).toBeVisible();

  // CONFIRM FIRST, THEN PREVIEW, and that order is a property of the UI rather
  // than a preference. The confirm field calls `teardown.markStale()` on every
  // keystroke (ui/src/tabs/Provision.jsx:438), and PreviewApply hides Apply while
  // `stale` is set — so typing the site name AFTER previewing retracts the
  // preview and the destructive button vanishes again. Which is correct
  // behaviour: changing what you are about to delete should invalidate the
  // preview of deleting it.
  await confirm.fill('baseline-site');

  await card.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect.poll(() => teardown.length, { message: 'teardown preview never opened its stream' }).toBeGreaterThan(0);
  expect(teardown[0], 'teardown preview must run with dry=1').toContain('dry=1');

  const tearDown = card.getByRole('button', { name: 'Tear down this site', exact: true });
  await expect(tearDown, 'apply appears only after a clean preview').toBeVisible();
  await tearDown.click();

  await expect.poll(() => teardown.length, { message: 'teardown apply never opened its stream' }).toBeGreaterThan(1);
  expect(teardown[1], 'teardown apply must run with dry=0').toContain('dry=0');
  // The failure frame carries a rollback report, and the operator has to be told
  // the run aborted rather than left on a spinner.
  await expect(page.getByText(/run aborted/i).first()).toBeVisible();
});
