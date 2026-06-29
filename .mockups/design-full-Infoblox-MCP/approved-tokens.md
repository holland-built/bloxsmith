# Approved Design Tokens
Source: v4 — Alert-First Split
Approved: 2026-06-29

## Layout Paradigm
Alert-first split: 38% persistent alert/incident panel (left) + 62% data grid (right).
Topbar 48px. No icon rail sidebar. Both light + dark fully realized.

## CSS Custom Properties

```css
:root {
  /* === DARK MODE (default) === */
  --bg:           #0d0f0e;
  --surface:      #161a18;
  --surface2:     #1e2420;
  --left-panel:   #100808;
  --border:       rgba(240,240,236,0.08);
  --border-solid: rgba(240,240,236,0.12);
  --accent:       #e86340;
  --text:         #f0f0ec;
  --muted:        #7a7d79;
  --critical:     #e85050;
  --warning:      #e8a030;
  --ok:           #38c06c;
  --critical-bg:  rgba(232,80,80,0.10);
  --warning-bg:   rgba(232,160,48,0.10);
  --ok-bg:        rgba(56,192,108,0.10);
  --topbar-h:     48px;
  --left-w:       38%;
  --radius:       3px;
  --font-ui:      "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-data:    "JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace;
}

[data-theme="light"] {
  --bg:           #f5f2ed;
  --surface:      #ede9e3;
  --surface2:     #e3ddd7;
  --left-panel:   #fdf0ef;
  --border:       rgba(26,24,20,0.09);
  --border-solid: rgba(26,24,20,0.15);
  --accent:       #c04a1f;
  --text:         #1a1814;
  --muted:        #7a7568;
  --critical:     #c83030;
  --warning:      #b86a14;
  --ok:           #2a9a56;
  --critical-bg:  rgba(200,48,48,0.08);
  --warning-bg:   rgba(184,106,20,0.09);
  --ok-bg:        rgba(42,154,86,0.09);
}
```

## Typography

```css
--font-ui:   "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--font-data: "JetBrains Mono", ui-monospace, "SF Mono", Consolas, monospace;

/* Scale */
--fs-xs:   11px;   /* labels, timestamps, badges */
--fs-sm:   12px;   /* secondary text, table cells */
--fs-base: 13px;   /* body, nav, descriptions */
--fs-md:   14px;   /* section headers */
--fs-lg:   18px;   /* panel headers */
--fs-xl:   28px;   /* KPI numbers */
```

**Rule:** `--font-data` ONLY on IP addresses, MAC addresses, subnet CIDRs, timestamps, raw numeric data in table cells. All UI chrome, labels, headings, nav, buttons use `--font-ui`.

## Spacing

```
Card padding:        12px
Row height:          32-34px (dense, scannable)
Section gap:         12-16px
Topbar height:       48px
Left panel width:    38% (flex, min 280px, max 480px)
Right panel width:   62% (flex remainder)
```

## Component Rules

- Border-radius: 3px everywhere. 50% only for status dots.
- Status dots: 8px circle, color matches semantic var.
- Alert cards: left 3px solid border = severity color. bg = severity-bg tint.
- Table rows: 1px bottom border (--border). Hover: --surface2.
- Buttons primary: bg = --accent, text = white, 3px radius.
- Buttons secondary: transparent bg, border = --border-solid, text = --text.
- Status badges: bg = severity-bg, color = severity var, font-weight 600, 11px, 3px radius.
- Mono data rule: IPs/MACs/CIDRs/timestamps/counts only. Never on labels/headings/nav.

## Severity Ramp

| Level    | Var         | Use case |
|----------|-------------|----------|
| critical | --critical  | Pool exhausted, host down, security breach |
| warning  | --warning   | Elevated usage, approaching threshold |
| ok/info  | --ok        | Healthy, resolved |

Red reserved for critical only. Never decorative.

## Palette Seed Summary

```
Dark:   bg #0d0f0e  surface #161a18  accent #e86340  text #f0f0ec  muted #7a7d79
Light:  bg #f5f2ed  surface #ede9e3  accent #c04a1f  text #1a1814  muted #7a7568
```
