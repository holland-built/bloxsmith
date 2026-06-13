# COLOR_CONTRACT.md — Infoblox NOC Dashboard strict palette

Single rule for every color decision. Tokens live in `index.html` `:root` block.
When in doubt → neutral gray.

## The four buckets

### 1. Neutral — the default (~90% of the UI)

`--blue-dark` `--blue-mid` `--blue-deep` `--surface` `--surface-2` `--surface-3`
`--border` `--gray-100` `--gray-200` `--gray-400` `--gray-600`

Use for: all structure, **all data/numbers**, all identity labels, table chrome,
sidebar, cards, inputs, muted text, icons. No tint, no hue.

### 2. Accent — `--teal` (`#D6D2CB`) / `--teal-bright` (`#EBE8E2`) — RARE

Allowed ONLY on:
- Active nav item (text + left rule)
- Primary CTA buttons (send, lookup)
- Card accent dots (`.dot`)
- Active/toggled state (`.on` chips, active mode buttons)
- Focus rings

**Nothing else.** If it's not one of those, it's not accent.

### 3. Status — exactly 3, ONLY for genuine severity state

| Intent | Token | Legitimate uses |
|---|---|---|
| Critical | `--red` `#EF4444` | Severity CRITICAL, validation errors, delete actions |
| Warning | `--amber` `#F59E0B` | Severity MAJOR/MINOR, UpdateBar progress, degraded |
| Healthy | `--green` `#10B981` | Severity CLEAR, online status, success |

Severity tints: badges/rows use `rgba(<severity>, .08–.15)` bg + `.2–.3` border + light text
(`--red-text`, `--amber-text`, `--green-text`). HSL triads (`--red-bg/border/text`) exist for
solid severity cards.

**Never** use a status color for non-status meaning: no amber-as-category, no green-as-label.

### 4. Charts — series colors only inside actual charts

`chart-*` vars (if any) may color data series in real charts only.
Must NOT color category labels, badges, or section headers.

## Banned (neutralize on sight)

- Hex literals (`#3b82f6`, `text-blue-500`, etc.) outside the `:root` token block
- Palette utility classes (`bg-blue-*`, `text-green-*`, `border-amber-*`) — use tokens
- Accent (`--teal`) on anything outside bucket 2
- Status hue used for non-severity meaning
- Inline `style="color: ..."` with raw color values
- New color tokens not in the 3-bucket model above

## Grading a usage

Ask: **Is this communicating severity state?** → use status bucket.
Ask: **Is this an active/selected/primary-action element?** → use accent.
Ask: **Is this anything else?** → use neutral.

If none of those questions give a clear yes, the answer is neutral gray.
