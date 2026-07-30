import { test, expect } from './fixtures';

// The per-tenant write lock through the real UI. The Go tests in
// go/internal/server/writelock_test.go prove the server refuses; this proves the
// operator can SEE that it is read-only and is told why when a write is refused,
// rather than watching a button do nothing.
//
// Nothing here grants write permission. Doing so would leave the dev server's
// real tenant writable after the run, which is precisely the state this control
// exists to prevent.

test.describe('per-tenant write lock', () => {
  test('Settings states plainly whether this tenant can be changed', async ({ page }) => {
    await page.goto('/#overview');
    await page.getByRole('button', { name: 'Settings' }).click();

    const section = page.getByText('Changing this tenant');
    await expect(section).toBeVisible();

    // WAIT FOR THE READ TO FINISH FIRST.
    //
    // The panel shows "Checking…" while the permission read is in flight, and
    // that is correct: a read in progress is not a verdict, and rendering one of
    // the three verdicts before the answer arrives would be exactly the invented
    // state this test exists to catch.
    //
    // Counting the three verdicts without waiting therefore raced the fetch, and
    // won often enough to fail about 1 run in 3 — reporting "got counts [0,0,0]",
    // which reads like the panel is broken when it is mid-read. Asserting the
    // transient state has CLEARED (rather than loosening the count assertion
    // below, which is the load-bearing one) fixes the race without weakening what
    // is being proven.
    await expect(page.getByText('Checking…')).toHaveCount(0);

    // Exactly one of the three states, and they must be distinguishable — a
    // failed permission read must never render as "read-only", which would be a
    // verdict we never reached.
    const readOnly = page.getByText('● Read-only');
    const allowed = page.getByText('● Changes allowed');
    const unknown = page.getByText(/Cannot tell which tenant|Write permission unknown/);

    const states = await Promise.all([readOnly.count(), allowed.count(), unknown.count()]);
    expect(
      states.filter((n) => n > 0).length,
      `expected exactly one of read-only / changes-allowed / unknown, got counts ${JSON.stringify(states)}`,
    ).toBe(1);

    // On a freshly built dev server nothing has been opted in, so this is the
    // state that must be showing. If a future run legitimately has permission
    // granted, that is a real difference worth failing on rather than skipping.
    await expect(readOnly).toBeVisible();
    await expect(page.getByText(/Provisioning, teardown and record edits are refused/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Allow changes to this tenant/ })).toBeVisible();
  });

  test('granting is behind an explicit confirmation that names the risk', async ({ page }) => {
    await page.goto('/#overview');
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: /Allow changes to this tenant/ }).click();

    // The confirmation has to say what it actually enables, in those words.
    await expect(page.getByText(/teardown delete real DNS zones, subnets and address blocks/)).toBeVisible();
    const confirm = page.getByRole('button', { name: 'Yes, allow changes' });
    await expect(confirm).toBeVisible();

    // Backing out must leave it read-only. Deliberately NOT clicking confirm.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByText('● Read-only')).toBeVisible();
  });

  test('a refused write comes back naming the tenant, not a bare failure', async ({ page }) => {
    await page.goto('/#overview');

    // Hit a real write route through the browser so the whole chain runs: CSRF
    // gate, write lock, refusal body. No page.route stub — a stub here would
    // test the stub.
    const res = await page.evaluate(async () => {
      const r = await fetch('/api/dns/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    });

    expect(res.status).toBe(403);
    expect(res.body.reason).toBe('tenant-read-only');
    expect(res.body.writable).toBe(false);
    // "Nothing was changed" is the sentence that matters to an operator.
    expect(String(res.body.error)).toContain('Nothing was changed');
    // And it must name which tenant, so the fix is obvious.
    expect(String(res.body.tenant || '')).not.toBe('');
  });

  test('a teardown stream is refused before it streams anything', async ({ page }) => {
    await page.goto('/#overview');

    // The most destructive route in the program, reached the way the UI reaches
    // it. A refusal here must be a JSON 403, never a 200 event-stream that then
    // reports what it deleted.
    //
    // dry=1 AND no confirm=DELETE, deliberately. The write lock refuses a dry run
    // exactly as it refuses a real one, so this proves the same thing — and the
    // first version of this test did NOT do that. It sent confirm=DELETE&dry=0,
    // and when the lock was temporarily removed to prove these assertions were
    // load-bearing, a real teardown fired at the live dev tenant. It deleted
    // nothing (checked three ways: zero of 1,936 objects in first_seen.json ever
    // matched a seed site, zero of 487 subnets and zero of 131 zones match one
    // now, and the tenant's own CSP audit log holds no DELETE of any kind across
    // the whole day) — but that was luck, not design. A test whose failure mode
    // is "destroys a live tenant" must not be written when a harmless request
    // proves the identical property.
    const res = await page.evaluate(async () => {
      const r = await fetch('/api/teardown/seed-demo/stream?dry=1');
      return { status: r.status, type: r.headers.get('content-type') || '', body: await r.text() };
    });

    expect(res.status).toBe(403);
    expect(res.type).toContain('application/json');
    expect(res.type).not.toContain('event-stream');
    expect(res.body).toContain('read-only');
    // Nothing that reads like progress or a result.
    expect(res.body).not.toContain('data:');
    expect(res.body).not.toContain('succeeded');
  });
});
