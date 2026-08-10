import { test, expect } from './fixtures';

// Switching tabs must never blank the page, now that every tab is a lazily
// fetched chunk.
//
// WHY THIS ASSERTS ON THE HEADING AND NOT MERELY ON "main is non-empty".
// When a switch does go wrong, `main` is not EMPTY — it is full of Suspense
// skeleton bars, which is a perfectly non-empty box. What the reader actually
// loses is the page they were reading: the h1 vanishes and comes back. So the
// emptiness check alone would sit there watching nothing, and the heading check
// is the one that bites.
//
// WHAT THIS TEST DOES AND DOES NOT PROVE — measured, because the intuitive
// story about it turned out to be wrong:
//   - It does NOT distinguish startTransition from a plain setState, which is
//     why src/App.jsx ships the plain one. React 19 keeps already-committed
//     content on screen when an update suspends, all by itself: with the chunk
//     fetch held for 2.5s and no transition anywhere, the outgoing tab stayed
//     put for all 304 sampled frames.
//   - It DOES catch a boundary that discards the old tab. Keying the <Suspense>
//     by tab makes the heading disappear for 37 of 97 frames, and this file
//     fails on the first switch. That is its negative control (2026-08-10).
//
// It is therefore a characterisation test: it pins the behaviour a reader can
// see, whatever mechanism happens to be providing it, so that a future React
// upgrade or a refactor of the boundary cannot quietly take it away.
//
// The sampler runs inside the page rather than as a Playwright poll because the
// gap being measured is a handful of frames wide — a round trip per sample
// through the driver would step straight over it.
//
// WHY THE CHUNK FETCHES ARE DELAYED ON PURPOSE. Against an unthrottled dev
// server on loopback a tab chunk arrives inside a single animation frame, so
// there is no frame in which anything could be missing and this file would pass
// no matter how the boundary behaved. Holding each chunk for CHUNK_DELAY_MS
// reproduces the ordinary condition the behaviour exists for — a real network —
// and is what lets the keyed-boundary regression above actually show up.
//
// The delay is installed AFTER the first load, so it costs the initial
// navigation nothing and applies only to the switches being measured.
const CHUNK_DELAY_MS = 300;

// Destination headings, so the sampler can be stopped when the NEW tab is
// genuinely on screen. Waiting merely for "an h1 is visible" is not enough and
// is the second way this test can quietly watch nothing: the OUTGOING tab's h1
// is still visible the instant the hash changes, so that wait returns
// immediately and sampling stops before the switch has happened at all.
// Verified — with that weaker wait, the naive build passed too.
const SWITCHES: [string, string, string][] = [
  ['#overview', '#provision', 'Provision'],
  ['#provision', '#security', 'Security'],
  ['#security', '#ai', 'AI Assistant'],
  ['#ai', '#network', 'Network'],
  ['#network', '#editor', 'Editor'],
  ['#editor', '#overview', 'Overview'],
];

function isNoise(text: string) {
  return /favicon|net::ERR_/i.test(text);
}

test('switching tabs never blanks the page, and logs no console error', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isNoise(msg.text())) errors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    if (!isNoise(err.message)) errors.push(err.message);
  });

  await page.goto('/#overview');
  await expect(page.locator('main h1')).toBeVisible();

  await page.route('**/assets/*.js', async (route) => {
    await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
    await route.continue();
  });

  for (const [from, to, heading] of SWITCHES) {
    // Start a per-frame sampler, then change the hash from inside the same
    // evaluate so no frame can slip by between arming and navigating.
    await page.evaluate((hash) => {
      const w = window as any;
      w.__flashSamples = [] as { h1: string | null; kids: number }[];
      w.__sampling = true;
      const main = document.querySelector('main');
      const tick = () => {
        if (!w.__sampling) return;
        w.__flashSamples.push({
          h1: main?.querySelector('h1')?.textContent?.trim() ?? null,
          kids: main?.childElementCount ?? 0,
        });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      location.hash = hash;
    }, to);

    // The destination tab is up only when its OWN heading is on screen.
    await expect(page.locator('main h1')).toHaveText(heading);
    await page.evaluate(() => {
      (window as any).__sampling = false;
    });

    const samples: { h1: string | null; kids: number }[] = await page.evaluate(
      () => (window as any).__flashSamples,
    );

    const blank = samples.filter((s) => s.kids === 0);
    expect(
      blank.length,
      `${from} → ${to}: <main> had zero children on ${blank.length} of ${samples.length} frames`,
    ).toBe(0);

    const headless = samples.filter((s) => !s.h1);
    expect(
      headless.length,
      `${from} → ${to}: the tab heading disappeared on ${headless.length} of ${samples.length} ` +
        `frames — the outgoing tab was thrown away before the next chunk arrived, so the ` +
        `reader watched their page turn into skeleton bars. The usual cause is a <Suspense> ` +
        `boundary that gets a new identity per tab (e.g. key={tab}) instead of staying put.`,
    ).toBe(0);
  }

  expect(errors, `console errors during tab switching:\n${errors.join('\n')}`).toEqual([]);
});
