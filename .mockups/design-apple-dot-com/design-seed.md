# Design Seed — apple.com aesthetic for Infoblox NOC Dashboard

Source: apple.com visual language (not iOS HIG) applied to a dense NOC data tool.

## Palette

### Light mode
- Page bg: #ffffff
- Section bg: #f5f5f7
- Nav bg: rgba(255,255,255,0.85) + backdrop-blur(20px)
- Surface (cards): #ffffff
- Surface raised: #f5f5f7
- Text primary: #1d1d1f
- Text secondary: #6e6e73
- Text tertiary: #86868b
- Accent: #0071e3
- Border hairline: rgba(0,0,0,0.08)
- Shadow: 0 2px 12px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)
- Status red: #ff3b30 | red bg: rgba(255,59,48,0.08)
- Status amber: #ff9500 | amber bg: rgba(255,149,0,0.08)
- Status green: #28cd41 | green bg: rgba(40,205,65,0.08)

### Dark mode
- Page bg: #1d1d1f (apple.com charcoal — NOT pure black)
- Section bg: #000000
- Nav bg: rgba(29,29,31,0.85) + backdrop-blur(20px)
- Surface (cards): #2d2d2f
- Surface raised: #3a3a3c
- Text primary: #f5f5f7
- Text secondary: #86868b
- Text tertiary: #6e6e73
- Accent: #2997ff
- Border hairline: rgba(255,255,255,0.08)
- Shadow: 0 2px 20px rgba(0,0,0,0.4)
- Status red: #ff453a | red bg: rgba(255,69,58,0.12)
- Status amber: #ff9f0a | amber bg: rgba(255,159,10,0.12)
- Status green: #30d158 | green bg: rgba(48,209,88,0.10)

## Typography
- Font: -apple-system, "SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif
- Mono: "SF Mono", "Menlo", ui-monospace, monospace
- Scale: 28px headline / 17px body / 12px caption (max 3 per section)
- Weight: 700 headline, 500 label, 400 body
- Letter-spacing: -0.5px headlines, 0 body
- NO all-caps card headers. NO serif.

## Radius (contextual — NOT global)
- Large cards: 18px | Medium components: 12px | Small badges: 6px

## Spacing (4pt grid strict)
- Page gutter: 80px | Section gap: 48px | Card padding: 24px | Row gap: 16px

## apple.com DNA
- Frosted glass nav (backdrop-blur behind content)
- Hairline borders only — never thick strokes
- Monochrome + one accent per section
- Big numbers with tight tracking as primary data hero
- Status: small colored dot + text (not full-color pill badges)
- Clean table rows with hairline separators, no grid lines

## Ban list (never use)
- #000000 as dark page bg → use #1d1d1f
- #0a84ff iOS blue → use #2997ff dark / #0071e3 light
- Global 12px radius on everything
- Heavy shadows rgba(0,0,0,0.5)
- Gradient CTAs | Glassmorphism | Sidebar nav + icon rows
- All-caps card headers | Rounded pill badges as primary stat

## NOC constraints
- Data-dense: apple.com spaciousness WITHIN sections, not instead of data
- Status (13 CRIT / 3 FIRING / ALL OK) must be prominent at 6ft
- Tabs: Overview / Topology Map / IPAM / DNS / Hosts / Security / Alerts / Audit Logs
- Brand: "Infoblox NOC" + "Cisco" org — clickable
