import { test, expect } from './fixtures';
import { installBaselineWorld } from './page-fixtures';

// Every /api/ response is faked from tests/page-fixtures.ts, which is what
// took this file off playwright.config.ts's LIVE_TENANT_SPECS list on
// 2026-08-13. It was excluded from CI because it asserts on data only a live
// Infoblox tenant serves; the fixtures are that data, identical on every
// machine, so it now runs on the ubuntu runner too.
test.beforeEach(async ({ page }) => {
  await installBaselineWorld(page);
});


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

// THE TWO WAYS THIS FILE CAN PASS WHILE WATCHING NOTHING, both measured on
// 2026-08-10 and both now asserted rather than assumed.
//
// FIRST: the delay above is installed by a route glob. Nothing used to check
// that the glob still matched anything. Vite decides the `assets/` prefix and
// the chunk names, so a config change is enough to make every interception
// silently stop happening — and with no delay a switch completes inside one
// animation frame, which is a set of samples containing no risky frame at all.
// Every assertion below then passes over it. `delayed` counts the interceptions
// and is asserted non-zero at the end.
//
// SECOND, and this one was already happening: a switch to a tab whose chunk is
// ALREADY in memory does not suspend, so there is nothing to delay and nothing
// to sample. Measured per switch, unthrottled dev server, one run:
//
//     #overview  -> #provision   97 frames
//     #provision -> #security   192 frames
//     #security  -> #ai          95 frames
//     #ai        -> #network     96 frames
//     #network   -> #editor     190 frames
//     #editor    -> #overview     1 frame     <-- Overview loaded at goto()
//
// One frame satisfies "the heading was never missing" trivially. That last
// switch is still worth performing — returning to the first tab is a real thing
// a reader does — but it must not be COUNTED as evidence. So the floor below is
// applied only to switches that actually delayed a chunk, and the number of
// such switches is itself asserted, so this file cannot quietly decay into six
// instant no-ops and keep reporting success.
//
// MIN_SAMPLES is 20, well under the 95 the thinnest real switch produced: at
// ~60fps a 300 ms hold is ~18 frames, so anything at or above 20 has observed
// the whole suspended window. It is a floor against vacuity, not a timing
// assertion, and is deliberately nowhere near the observed values.
const MIN_SAMPLES = 20;
// Five of the six switches fetched a chunk in the measurement above. Four is
// the floor: it tolerates one more tab's chunk being merged or inlined by a
// future bundler change, and still fails loudly if this file degenerates into
// mostly-cached switches that prove nothing.
const MIN_REAL_SWITCHES = 4;

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

  // Counted, not assumed — see the note on MIN_SAMPLES. `delayedNow` is read
  // and reset around each switch so a switch can be told apart from a cached
  // one; `delayed` is the running total that proves the glob still matches.
  let delayed = 0;
  let delayedNow = 0;
  await page.route('**/assets/*.js', async (route) => {
    delayed++;
    delayedNow++;
    await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
    await route.continue();
  });

  let realSwitches = 0;

  for (const [from, to, heading] of SWITCHES) {
    delayedNow = 0;
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

    // A switch that fetched nothing never suspended, so the two assertions
    // below are true of it for free. Only a switch that actually held a chunk
    // is counted, and only that kind has to have watched a real window.
    if (delayedNow > 0) {
      realSwitches++;
      expect(
        samples.length,
        `${from} → ${to}: only ${samples.length} frames sampled while ${delayedNow} chunk ` +
          `request(s) were held for ${CHUNK_DELAY_MS}ms each. Fewer than ${MIN_SAMPLES} frames ` +
          `means the assertions below never saw the suspended window, so a passing result here ` +
          `would prove nothing.`,
      ).toBeGreaterThanOrEqual(MIN_SAMPLES);
    }

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

  // The vacuity guards. These say nothing about the product — they say this
  // file did its job, and they are the difference between a green tick and a
  // green tick that means something.
  expect(
    delayed,
    `the route glob '**/assets/*.js' intercepted NOTHING, so no chunk was ever held and ` +
      `every switch above completed instantly. The assertions passed over frames in which ` +
      `nothing could have gone wrong. Vite's asset directory or chunk naming has almost ` +
      `certainly changed — fix the glob, do not delete this check.`,
  ).toBeGreaterThan(0);

  expect(
    realSwitches,
    `only ${realSwitches} of ${SWITCHES.length} switches actually fetched a chunk. The rest ` +
      `were served from memory and cannot flash, so this run carries less evidence than it ` +
      `looks like. Add a switch to a tab that has not been visited yet.`,
  ).toBeGreaterThanOrEqual(MIN_REAL_SWITCHES);

  expect(errors, `console errors during tab switching:\n${errors.join('\n')}`).toEqual([]);
});
