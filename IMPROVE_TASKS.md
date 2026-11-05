# Tasks a person does, and what they should see

Used by the improve skill: run each at phone size (iPhone profile) and desktop
size (1440 x 900) on the live page, before and after every change. Also run
`npm test` and `npm run lint` in `ui/`, and the e2e specs for the page touched
with `E2E_SKIP_LIVE=1`.

## Overview header

1. Open Overview. The title, the one Needs a look line and the first row of
   number tiles are on the first screen at desktop size.
2. Read the Needs a look line. It says in words how many things need a look and
   how many are urgent, and the urgent count is shown as urgent (red).
3. Click or tap the Needs a look line. The list opens; a second click closes it.
4. Read the intro under it on a phone. The lines are evenly spaced, with no tall
   gap before the last line.
5. Press Docs. The help opens at the Overview section.
