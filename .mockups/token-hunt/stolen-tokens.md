# Stolen Tokens
Extracted: 2026-06-26
Target: NOC / Network Monitoring Dashboard — light + dark both fully realized

---

## Site 1 — Grafana (grafana.com)
**Aesthetic:** Dark-first monitoring console · orange + cyan data viz · no-frills operator UI  
**Design system:** Hard-coded (no CSS vars) — tokens inferred from brand assets  
**CSS vars found:** 0 (uses CSS modules)

```css
:root {
  /* Dark mode surfaces */
  --color-background:  #161A1F;
  --color-surface:     #1F2933;
  --color-surface-2:   #22313F;
  --color-border:      rgba(255,255,255,0.08);

  /* Brand */
  --color-accent:      #FF671D;   /* Grafana Orange */
  --color-accent-2:    #3FC6EB;   /* Cyan */

  /* Text */
  --color-text:        #D8DEE4;
  --color-muted:       rgba(216,222,228,0.55);

  /* Status */
  --color-danger:      #F2495C;
  --color-warning:     #FADE2A;
  --color-success:     #73BF69;

  /* Light mode overrides */
  --color-background-light:  #F4F5F5;
  --color-surface-light:     #FFFFFF;
  --color-text-light:        #1A2127;
  --color-accent-light:      #E34B0E;

  /* Type */
  --font-sans:    "Inter","Helvetica Neue",Arial,sans-serif;
  --font-mono:    "Roboto Mono","Fira Code",monospace;
  --radius:       4px;
  --spacing-base: 8px;
}
```

**Palette Seed (dark):**
```
background: #161A1F
surface:    #1F2933
accent:     #FF671D
text:       #D8DEE4
muted:      rgba(216,222,228,0.55)
```

**Palette Seed (light):**
```
background: #F4F5F5
surface:    #FFFFFF
accent:     #E34B0E
text:       #1A2127
muted:      rgba(26,33,39,0.55)
```

---

## Site 2 — Datadog (datadoghq.com)
**Aesthetic:** Bold purple/deep-dark enterprise · data-dense · high information contrast  
**Design system:** Hard-coded (CSS modules) — tokens inferred  
**CSS vars found:** 2 (marketing page only)

```css
:root {
  /* Dark mode */
  --color-background:  #110617;
  --color-surface:     #1C222D;
  --color-surface-2:   #24303D;
  --color-border:      rgba(255,255,255,0.10);

  /* Brand */
  --color-accent:      #8000FF;   /* Datadog Purple */
  --color-accent-2:    #0060FF;   /* Blue */
  --color-accent-3:    #FF0080;   /* Magenta */

  /* Text */
  --color-text:        #E8ECF0;
  --color-muted:       rgba(232,236,240,0.55);

  /* Status */
  --color-danger:      #FF2222;
  --color-warning:     #FFCC00;
  --color-success:     #00C389;

  /* Light mode */
  --color-background-light:  #FFFFFF;
  --color-surface-light:     #F5F5FA;
  --color-text-light:        #1B1B2C;
  --color-accent-light:      #6600CC;

  /* Type */
  --font-sans:    "DD-DIN","Inter","Helvetica Neue",sans-serif;
  --radius:       6px;
  --spacing-base: 8px;
}
```

**Palette Seed (dark):**
```
background: #110617
surface:    #1C222D
accent:     #8000FF
text:       #E8ECF0
muted:      rgba(232,236,240,0.55)
```

**Palette Seed (light):**
```
background: #F5F5FA
surface:    #FFFFFF
accent:     #6600CC
text:       #1B1B2C
muted:      rgba(27,27,44,0.55)
```

---

## Site 3 — New Relic (newrelic.com) ★ RECOMMENDED
**Aesthetic:** Clean professional monitoring · deep blue primary · sharp corners · Inter-driven  
**Design system:** Full CSS design system — 290 vars  
**CSS vars found:** 290

```css
:root {
  /* Surfaces (light default) */
  --color-background:  #f9fafa;
  --color-surface:     #FFFFFF;
  --color-surface-2:   #f3f4f9;
  --color-border:      #d4d4d8;
  --color-text:        #232429;
  --color-muted:       #919297;

  /* Brand */
  --color-accent:         #003ecc;   /* blue-600 */
  --color-accent-hover:   #002e9a;   /* blue-700 */
  --color-accent-2:       #26a769;   /* lightninggreen */
  --color-accent-3:       #ffd23f;   /* sunglow yellow */

  /* Ramps */
  --color-blue-900:  #000f33;
  --color-blue-700:  #002e9a;
  --color-blue-600:  #003ecc;
  --color-blue-500:  #004eff;
  --color-blue-400:  #3371ff;
  --color-blue-300:  #6694ff;
  --color-gray-900:  #393a3f;
  --color-gray-700:  #75767b;
  --color-gray-500:  #919297;
  --color-gray-200:  #d4d4d8;
  --color-gray-050:  #f3f4f9;

  /* Status */
  --color-danger:    #c81f0c;
  --color-warning:   #977405;
  --color-success:   #26a769;
  --color-info:      #003ecc;

  /* Dark mode overrides */
  --color-background-dark:  #1a1b1e;
  --color-surface-dark:     #24252a;
  --color-surface-2-dark:   #2e2f35;
  --color-border-dark:      rgba(255,255,255,0.10);
  --color-text-dark:        #e8e8ea;
  --color-muted-dark:       #75767b;
  --color-accent-dark:      #6694ff;   /* blue-300 for dark bg */

  /* Type */
  --font-sans:  "Inter",BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  --font-hero:  "Mona Sans",sans-serif;
  --font-mono:  "Geist Mono","SF Mono","Monaco","Courier New",monospace;

  /* Scale */
  --font-size-base: 1rem;
  --font-size-h6:   1.125rem;
  --font-size-h5:   1.266rem;
  --font-size-h4:   1.424rem;
  --font-size-h3:   1.602rem;
  --font-size-h2:   1.802rem;
  --font-size-h1:   2.027rem;

  /* Shape */
  --radius:          2px;   /* Very sharp — precision instrument aesthetic */
  --spacing-base:    1rem;
}
```

**Palette Seed (light):**
```
background: #f9fafa
surface:    #FFFFFF
accent:     #003ecc
text:       #232429
muted:      #919297
```

**Palette Seed (dark):**
```
background: #1a1b1e
surface:    #24252a
accent:     #6694ff
text:       #e8e8ea
muted:      #75767b
```

**Font Stack:** Inter (sans), Mona Sans (display/hero), Geist Mono (code)

---

## Site 4 — Dynatrace (dynatrace.com)
**Aesthetic:** Enterprise ops · purple-violet primary · bold dark + clean white  
**Design system:** Hard-coded — tokens inferred from brand  
**CSS vars found:** 0

```css
:root {
  /* Dark mode */
  --color-background:  #1A1A2E;
  --color-surface:     #232340;
  --color-surface-2:   #2D2D4E;
  --color-border:      rgba(255,255,255,0.12);

  /* Brand */
  --color-accent:      #712F90;   /* Dynatrace Purple */
  --color-accent-2:    #2583EE;   /* Blue */

  /* Text */
  --color-text:        #E0E2E8;
  --color-muted:       rgba(224,226,232,0.55);

  /* Status */
  --color-danger:      #FF4040;
  --color-warning:     #FFB800;
  --color-success:     #4CAF50;

  /* Light mode */
  --color-background-light:  #FFFFFF;
  --color-surface-light:     #F3F4F8;
  --color-text-light:        #1A1A2E;
  --color-accent-light:      #5A1F75;

  /* Type */
  --font-sans:    "Roboto","Helvetica Neue",Arial,sans-serif;
  --radius:       4px;
  --spacing-base: 8px;
}
```

**Palette Seed (dark):**
```
background: #1A1A2E
surface:    #232340
accent:     #712F90
text:       #E0E2E8
muted:      rgba(224,226,232,0.55)
```

---

## Site 5 — PagerDuty (pagerduty.com)
**Aesthetic:** Alert-driven NOC · neutral gray foundation · oklch precision · modern sharp-to-round radius scale  
**Design system:** Full CSS design system (Tailwind-based) — 246 vars  
**CSS vars found:** 246

```css
:root {
  /* Surfaces */
  --color-background:  #fafafa;   /* gray-50 */
  --color-surface:     #FFFFFF;
  --color-surface-2:   #f5f5f5;   /* gray-100 */
  --color-border:      #e5e5e5;   /* gray-200 */
  --color-text:        #171717;   /* gray-900 */
  --color-muted:       #737373;   /* gray-500 */

  /* Brand accent — inferred from brand kit */
  --color-accent:      #00804a;   /* PD green */
  --color-accent-2:    oklch(70.7% .165 254.624);  /* blue-400 */

  /* Gray ramp */
  --color-gray-50:   #fafafa;
  --color-gray-100:  #f5f5f5;
  --color-gray-200:  #e5e5e5;
  --color-gray-300:  #d4d4d4;
  --color-gray-400:  #a3a3a3;
  --color-gray-500:  #737373;
  --color-gray-600:  #525252;
  --color-gray-700:  #404040;
  --color-gray-800:  #262626;
  --color-gray-900:  #171717;
  --color-gray-950:  #0a0a0a;

  /* Red alert ramp (oklch) */
  --color-red-400:  oklch(70.4% .191 22.216);
  --color-red-500:  oklch(63.7% .237 25.331);
  --color-red-600:  oklch(57.7% .245 27.325);

  /* Status */
  --color-danger:  oklch(57.7% .245 27.325);
  --color-warning: oklch(84.1% .238 128.85);  /* lime */
  --color-success: #22c55e;

  /* Dark mode */
  --color-background-dark:  #0a0a0a;   /* gray-950 */
  --color-surface-dark:     #171717;   /* gray-900 */
  --color-surface-2-dark:   #262626;   /* gray-800 */
  --color-border-dark:      #404040;   /* gray-700 */
  --color-text-dark:        #fafafa;
  --color-muted-dark:       #a3a3a3;   /* gray-400 */

  /* Type */
  --font-sans:  "Plain","Helvetica Neue","Arial Nova",Arial,sans-serif;
  --font-mono:  ui-monospace,"Cascadia Code","Source Code Pro",Menlo,Consolas,monospace;

  /* Radius scale */
  --radius-sm:  0.25rem;
  --radius-md:  0.375rem;
  --radius-lg:  0.5rem;
  --radius-xl:  0.75rem;
  --radius-2xl: 1rem;

  /* Spacing */
  --spacing: 0.25rem;
}
```

**Palette Seed (light):**
```
background: #fafafa
surface:    #FFFFFF
accent:     #00804a
text:       #171717
muted:      #737373
```

**Palette Seed (dark):**
```
background: #0a0a0a
surface:    #171717
accent:     #22c55e
text:       #fafafa
muted:      #a3a3a3
```

**Font Stack:** Plain (display), system sans fallback, monospace code
