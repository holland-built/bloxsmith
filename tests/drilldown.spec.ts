import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Every /api/ response is faked from tests/page-fixtures.ts.
//
// This file sat in playwright.config.ts's LINUX_CI_UNPROVEN_SPECS, described as
// failing on ubuntu for "platform layout/timing" reasons. That description was
// never measured — the one run behind it (31499474048) had NO TENANT as well as
// a different OS, so it could not tell the two apart. Running these same tests
// on macOS through scripts/e2e.sh, which also has no tenant, reproduced most of
// the failures: the missing data was doing the work, not the platform.
test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});

// Overview → deeper-tab drill-downs: the click must land on the SAME data, filtered.

test('Subnets ≥90% KPI drills to Network with minUtil filter chip', async ({ page }) => {
  await page.goto('/#overview');
  await page.getByText('Subnets ≥90%').click();
  await expect(page).toHaveURL(/#network\?minUtil=90/);
  await expect(page.getByText(/util ≥ 90/)).toBeVisible();
  // dismiss chip clears the filter
  await page.getByText(/util ≥ 90/).getByText('✕').or(page.getByRole('button', { name: /✕/ }).first()).click();
  await expect(page).toHaveURL(/#network(?!\?minUtil)/);
});

test('host status legend drills to Infra with status chip', async ({ page }) => {
  await page.goto('/#overview');

  // Unlike the other two drill-downs in this file, this legend row does not
  // exist in the DOM until /api/data has resolved AND at least one host
  // buckets as Offline — 'Subnets ≥90%' and 'DNS Zones w/ Issues' are static
  // KPI labels present from first paint (they fall back to a "(loaded rows)"
  // variant while data is in flight, so the label text is there regardless).
  // A bare `getByText('Offline', { exact: true }).first()` only ever resolved
  // correctly because, today, it happens to be the sole exact-case "Offline"
  // text on the page — an accident of the current UI, not a guarantee, and it
  // gave no explicit signal that the legend had actually finished loading
  // before the click fired. Scoping to the one control whose accessible name
  // starts with "Offline" (the legend row is a role="button" element, unlike
  // any plain text on the page) removes the .first() guesswork, and waiting
  // on it explicitly before clicking mirrors write-lock's fix: wait for the
  // specific condition that makes the click meaningful, don't race the fetch.
  const offlineRow = page.getByRole('button', { name: /^Offline/ });
  // THIS is the assertion that was actually failing, not the chip below.
  //
  // Reproduced on demand at last (2026-08-01): `curl :8090/api/cache-bust`
  // then run this spec. It fails here — "element(s) not found", 5000ms — and
  // passes on retry, because the retry runs against a now-warm cache. Three
  // earlier diagnoses all missed it, and all three blamed the chip.
  //
  // The row only enters the DOM once /api/data resolves. That is 0.02s warm
  // but a measured 6.55–9.65s cold (n=4, after the fan-out change; it was
  // 16.45–27.63s before). Playwright's default 5s budget sits inside that
  // window, so a cold cache failed here every time and a warm one never did.
  //
  // 13s = worst measured cold load (9.65s) + one full observed spread
  // (9.65 − 6.55 = 3.1s). Same derivation as the client's own cold budget in
  // ui/src/lib/api.js. With n=4 there is no basis for a percentile, so one
  // step of the observed spread above the worst sample is the honest ceiling.
  // Deliberately not a round number.
  await expect(offlineRow).toBeVisible({ timeout: 13_000 });
  await offlineRow.click();
  await expect(page).toHaveURL(/#infra\?status=offline/);

  // The v3.36.0 fix above made the CLICK reliable. It did not make this
  // assertion reliable, and the entry said so: "if it returns, the diagnosis
  // was wrong." It returned twice on 2026-07-31, both times on the first full
  // run after :8090 rebuilt, and both times HERE — never on the click.
  //
  // The cause is a SECOND fetch, not the first. Arriving at #infra mounts a
  // different tab, and ui/src/tabs/Infra.jsx:187 early-returns
  // `if (loading && !data) return <Skeleton/>` — so until Infra's own
  // /api/data resolves, the Host Inventory card and this chip are not in the
  // DOM at all. The chip itself is derived from the URL, not from the data
  // (Infra.jsx:290-300), so nothing here is waiting on the right value; it is
  // waiting on the component being allowed to render.
  //
  // WHAT IS ESTABLISHED, and what is NOT.
  //
  // Established from source: this assertion waits on a SECOND fetch, and the
  // component is not merely slow to fill in — it does not exist yet.
  //
  // NOT established: why that takes so long on a cold run. The 20s budget
  // below was added on 2026-07-31 on the theory that the default 5s simply
  // was not enough. THAT THEORY IS WRONG, or at least not the whole story:
  // the very next full run after a rebuild failed here again, with 20s.
  //
  // So the honest state is: this test fails on roughly the first full-suite
  // run after :8090 rebuilds (three occurrences on 2026-07-31, every one on a
  // ~1.1-1.2m run) and passes every warm run (~33s, 126/126, many times) and
  // every solo run (~0.5s). Two diagnoses have now been offered for it and
  // both were wrong. The budget is kept because the second-fetch dependency
  // above is real and a 5s budget is genuinely too tight for it — but it is
  // NOT presented as the fix, because it demonstrably is not one.
  //
  // Do not "fix" this by widening the locator or by raising the number again
  // until someone has actually captured which line fails on a cold run and
  // what the page contains at that moment.
  await expect(page.getByText(/status: offline/)).toBeVisible({ timeout: 20_000 });
});

test('Daily zones-with-issues KPI drills to DNS issues-only view', async ({ page }) => {
  await page.goto('/#daily');
  await page.getByText('DNS Zones w/ Issues').click();
  await expect(page).toHaveURL(/#dns\?issues=1/);
  await expect(page.getByText(/issues only/)).toBeVisible();
});
