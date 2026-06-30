# Approved Tokens — v5 Bento (apple.com aesthetic)

Source: `.mockups/design-apple-dot-com/v5.html`

## Dark mode (default)
- Page bg: #1d1d1f  ← was #000000 (pure black, banned)
- Section black: #000000  (section backgrounds only, not page bg)
- Surface: #2d2d2f
- Surface raised: #3a3a3c
- Nav bg: rgba(29,29,31,.85) + backdrop-filter:blur(20px)
- Ink primary: #f5f5f7  ← was #ffffff
- Ink2 (secondary): #86868b
- Ink3 (tertiary): #6e6e73
- Accent: #2997ff  ← was #0a84ff (iOS blue, banned)
- Border: rgba(255,255,255,.08)
- Shadow: 0 2px 20px rgba(0,0,0,.4)
- Red: #ff453a | red-bg: rgba(255,69,58,.12)
- Amber: #ff9f0a | amber-bg: rgba(255,159,10,.12)
- Green: #30d158 | green-bg: rgba(48,209,88,.10)

## Light mode
- Page bg: #ffffff
- Section bg: #f5f5f7
- Surface: #ffffff
- Surface raised: #f5f5f7
- Nav bg: rgba(255,255,255,.85) + backdrop-filter:blur(20px)
- Ink primary: #1d1d1f
- Ink2 (secondary): #6e6e73
- Ink3 (tertiary): #86868b
- Accent: #0071e3  ← was #007aff (iOS blue)
- Border: rgba(0,0,0,.08)
- Shadow: 0 2px 12px rgba(0,0,0,.08)
- Red: #ff3b30 | red-bg: rgba(255,59,48,.08)
- Amber: #ff9500 | amber-bg: rgba(255,149,0,.08)
- Green: #28cd41 | green-bg: rgba(40,205,65,.08)

## Typography
- Font: -apple-system, "SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif
- Mono: "SF Mono", "Menlo", ui-monospace, monospace
- REMOVE: Google Fonts imports (DM Sans, JetBrains Mono) — dead imports

## Radius (contextual)
- Cards: 18px
- Controls/chips: 12px
- Badges: 6px
- --radius CSS var stays 12px (controls); .card overrides to 18px

## Token name mapping (keep names, change values in :root)
Dark:
  --blue-dark: #000000 → #1d1d1f
  --blue-mid: #1c1c1e → #2d2d2f
  --blue-deep: #2c2c2e → #3a3a3c
  --surface: #1c1c1e → #2d2d2f
  --surface-2: #2c2c2e → #3a3a3c
  --teal: #0a84ff → #2997ff
  --teal-bright: #409cff → #6ab2ff
  --ink: #ffffff → #f5f5f7
  --gray-100: #ffffff → #f5f5f7
  --ink-dim: rgba(255,255,255,0.55) → rgba(134,134,139,1)
  --muted: rgba(235,235,245,0.60) → rgba(134,134,139,1)
  --background: #000000 → #1d1d1f
  --accent: #0a84ff → #2997ff
  --brand: #0a84ff → #2997ff
  --shadow-card: keep soft
  --shadow: 0 2px 20px rgba(0,0,0,.4),0 1px 4px rgba(0,0,0,.2)

Light:
  --teal: #007aff → #0071e3
  --brand: #007aff → #0071e3
  --accent: #007aff → #0071e3
  --background: #f2f2f7 → #ffffff
  --blue-dark: #f2f2f7 → #ffffff
  --blue-mid: #ffffff → keep #ffffff
  --surface: #ffffff → keep

## Topbar (frosted glass)
- .topbar background: rgba(29,29,31,.85) dark / rgba(255,255,255,.85) light
- .topbar: backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px)
- Remove solid bg — frosted only
- Status chips: inline-flex, 6px dot + "{N} CRIT" text, font-size 13px weight 500

## Card changes
- .card border-radius: 18px (override --radius)
- .card shadow: 0 2px 20px rgba(0,0,0,.4) dark / 0 2px 12px rgba(0,0,0,.08) light
- .card hover: no teal border — translateY(-2px) lift only
- Remove: border-left:3px solid accent on hover/crit/warn states

## Badge changes
- .badge border-radius: 6px (not 20px pill)

## Hardcoded colors to clean
- rgba(239,68,68,...) → var(--red) or var(--red-bg)
- rgba(245,158,11,...) → var(--amber) or var(--amber-bg)
