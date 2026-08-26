import { test, expect } from './fixtures';

// The radius migration (#188) left seven rules in the built CSS that nothing
// references. Tailwind v4 auto-detects its sources and scans COMMENTS as
// readily as code, so ui/src/lib/radiusRoles.test.js documenting the names it
// replaced was enough to keep those names alive as real CSS. index.css excludes
// that one file with `@source not`; this spec is what stops them coming back.
//
// It reads the RULES THE BROWSER PARSED, not the source and not the file on
// disk, because that is the only place "does this rule ship" is a fact.
//
// IT CANNOT PASS BY EMPTINESS. A spec that only asserts absence is true of a
// stylesheet that failed to load at all — the same trap that made an earlier
// drawer test pass against the bug it was written for (an undeclared token
// emits nothing, so "no .bg-panel rule exists" was true OF THE DEFECT). So the
// live roles are asserted PRESENT in the same pass. If the CSS goes missing,
// the second half fails loudly rather than the first half passing quietly.

const MIGRATED = [
  'rounded-lg',
  'rounded-md',
  'rounded-sm',
  'rounded-xl',
  // The three the guard's own denylist draft named as spellings that slipped
  // past it. They were never used either.
  'rounded-t-control',
  'rounded-[7px]',
  'rounded-(--foo)',
];

const LIVE_ROLES = ['rounded-surface', 'rounded-control', 'rounded-mark', 'rounded-full'];

async function emittedClasses(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const out = new Set<string>();
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = (sheet as CSSStyleSheet).cssRules;
      } catch {
        continue; // cross-origin sheet; none of ours are
      }
      const walk = (list: CSSRuleList) => {
        for (const rule of Array.from(list)) {
          const anyRule = rule as any;
          if (anyRule.selectorText) out.add(anyRule.selectorText as string);
          if (anyRule.cssRules) walk(anyRule.cssRules as CSSRuleList);
        }
      };
      walk(rules);
    }
    return Array.from(out);
  });
}

// A class name inside a selector is escaped by the browser (.rounded-\[7px\]),
// so the comparison is on the ESCAPED form, built the same way the CSS is.
function selectorFor(cls: string) {
  return '.' + cls.replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
}

test('the migrated radius names emit no CSS, and the roles that replaced them do', async ({ page }) => {
  await page.goto('/#overview');
  await expect(page.locator('h1').first()).toBeVisible();
  const selectors = await emittedClasses(page);

  const present = (cls: string) => {
    const want = selectorFor(cls);
    return selectors.some((s) => s.split(',').some((part) => part.trim() === want));
  };

  // 1. The live roles must be there. This is what makes the absence below mean
  //    something rather than meaning "no stylesheet loaded".
  const missingRoles = LIVE_ROLES.filter((c) => !present(c));
  expect(
    missingRoles,
    `The radius ROLE classes are missing from the parsed CSS (${selectors.length} selectors seen). ` +
      `Either the stylesheet did not load, in which case the absence check below proves nothing, ` +
      `or the roles were renamed and this spec needs updating: ${missingRoles.join(', ')}`,
  ).toEqual([]);

  // 2. The migrated names must not be.
  const resurrected = MIGRATED.filter((c) => present(c));
  expect(
    resurrected,
    `Radius rules that nothing references are shipping again: ${resurrected.join(', ')}. ` +
      `Something now spells them where Tailwind can see it — check whether a new file ` +
      `documents the migration, and exclude it with @source not in ui/src/index.css.`,
  ).toEqual([]);
});
