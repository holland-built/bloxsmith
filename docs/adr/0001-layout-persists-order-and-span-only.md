# 0001 — Panel layout persists order and column span only, never pixel positions

## Context

Panels live in a Tailwind grid declared `grid-cols-2 md:grid-cols-4 xl:grid-cols-6`
(`ui/src/components/ui.jsx`), so a panel's geometry is expressed entirely as "which
slot, how many tracks". Track width is a function of the viewport, not of the panel,
and the track count changes at every breakpoint — a pixel offset recorded at one
window width names a position that does not exist at another, so there is nothing
stable for a pixel to refer to. The persistence format therefore had to answer two
questions: what is worth storing, and what must be impossible to store. Storage reuses
the existing `/api/views` blob store, whose `ViewWrite`
(`go/internal/store/store.go`) builds each record from an explicit whitelist —
`name, widgets, order, layout, folder, saved_at` — and silently discards every other
top-level key, which makes a wrongly-nested field fail with `{"ok":true}` and no
visible symptom. Drag-and-drop was built after this format was fixed, and the format
was fixed first precisely so that feature could not smuggle a pixel offset into it.

## Decision

A saved layout is `{name, order, layout:{version, spans}}` and nothing else. `order`
is an array of panel ids; `spans` maps panel id to an integer column count in 1–6.
`ui/src/lib/layout.js` enforces this with two deliberately asymmetric validators.
`validateSave` is strict at both levels — an unknown key anywhere, a non-integer span,
or a span outside 1–6 throws before the POST is issued. `parseLoad` is tolerant of the
server envelope, because `ViewWrite` stamps `widgets`, `folder` and `saved_at` onto
every record whether the client sent them or not, so a strict top-level rule on load
would reject every layout the server has ever returned; it applies the identical
strict check to the payload, so an unknown key inside `layout` — where a smuggled
pixel offset would have to live — still falls back to the unsaved default. The span is
stored exactly as the operator chose it and clamped only at render, against the track
count read live from the grid (`clampSpan`, applied in `applyLayout`). A span of 6
saved on a wide window renders as 2 tracks on the base grid and returns to 6 at `xl`,
so narrowing the window never destroys the stored intent.

## Alternatives rejected

**Free-form pixel positioning.** Rejected because the grid is track-based: there is no
render path that consumes an absolute x/y, so persisting one would require replacing
the layout engine as well as the storage format. It also has no correct behaviour
across breakpoints — a position saved at one track count is meaningless at another,
and the reasonable repairs (rescale, snap, discard) are all guesses about what the
operator meant.

**Client-only layout in `localStorage`.** Simpler and needs no server work, but the
layout would not follow an operator to a second browser or machine, and it would be
invisible to anything server-side. It also loses the validation boundary: a
`localStorage` blob is written and read by the same code, so a malformed layout is
only ever discovered at render.

**A new Go endpoint and table for layouts.** A purpose-built schema would have made
spans a typed column rather than a validated blob, and would have kept layouts out of
the general views namespace. Rejected as more surface than the feature needs — the
existing views store already provides atomic writes, naming, and a listing route, and
the strict client validator supplies the type discipline a schema would have. The cost
of that reuse is the namespace collision described below.

## Consequences

Layout state is server-side, so it follows the operator across browsers, and the same
validator runs on every write regardless of which UI gesture produced it — drag,
keyboard move, or resize all go through `saveLayout`. A pixel offset is not a bug that
has to be caught in review; it is a shape the format cannot express.

Because the views store is shared, `__layout_*` entries now appear in
`GET /api/views` listings alongside operator-saved views. The UI reads that listing:
`loadLayout` checks the list before reading a view, because asking for
`/api/views/__layout_<tab>` directly logged a browser console 404 on every page load
for the common case of a tab with no saved layout, and `tests/tabs-smoke.spec.ts`
asserts Overview loads with no console errors. That means the listing now has a live
consumer, and any future views-picker UI must filter the `__layout_` prefix rather
than assume every listed view is operator-created.

Layouts cannot express anything the grid cannot render — no free placement, no
overlap, no fractional widths — and adding such a capability later means a
`layout.version` bump plus a migration path in `parseLoad`, not a field addition.
