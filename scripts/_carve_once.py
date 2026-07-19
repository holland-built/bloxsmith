#!/usr/bin/env python3
"""One-shot Phase-1 carve: slice index.html's inline babel script into src/*.jsx
verbatim fragments, delete babel.min.js, point index.html at assets/app.bundle.js.

Verbatim slicing => concatenation reproduces the original script body byte-for-byte,
so behavior is identical. Run once; then `node scripts/build_ui.js`."""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IDX = os.path.join(ROOT, "index.html")
SRC = os.path.join(ROOT, "src")

with open(IDX, encoding="utf-8") as f:
    lines = f.readlines()  # keeps trailing newlines; 0-based list, 1-based line n = lines[n-1]

def find(pred):
    for i, ln in enumerate(lines):
        if pred(ln):
            return i  # 0-based
    return -1

babel_i = find(lambda l: 'src="babel.min.js"' in l)
open_i  = find(lambda l: 'type="text/babel"' in l and 'data-type="module"' in l)
assert babel_i >= 0, "babel.min.js script tag not found"
assert open_i  >= 0, "inline babel module script not found"
close_i = next(i for i in range(open_i + 1, len(lines)) if lines[i].strip() == "</script>")

body_start = open_i + 1          # first content line (0-based) == original L877
body_end   = close_i - 1         # last content line (0-based, inclusive) == mount line
orig_body  = lines[body_start:body_end + 1]
print(f"script open at L{open_i+1}, close at L{close_i+1}; body L{body_start+1}..L{body_end+1} "
      f"({len(orig_body)} lines); babel.min.js at L{babel_i+1}")

# Fragment start lines are ORIGINAL 1-based line numbers, verified between functions.
starts_1based = [877, 884, 1037, 1259, 1526, 3097, 3666, 4724, 5129, 5427, 5747,
                 5935, 6231, 6827, 7184, 7301, 7932, 8445, 8662, 8782, 9115, 9492]
names = ["00.header", "10.lib-core", "20.lib-data-power", "30.filters-time", "40.table",
         "50.routing-vault", "60.synth-charts-panel", "70.tab.overview", "72.tab.daily",
         "74.tab.network", "76.tab.dns", "78.tab.infra", "80.tab.security",
         "82.views-alerts-ai-audit", "84.tab.incidents", "86.tab.selfservice",
         "88.tab.provision", "90.tab.editor", "92.tab.drift", "94.palette-menus",
         "96.chrome-topbar", "98.shell-app"]
assert len(starts_1based) == len(names)
assert starts_1based[0] == body_start + 1, f"first fragment must start at body start L{body_start+1}"
assert starts_1based[-1] <= body_end + 1

os.makedirs(SRC, exist_ok=True)
bounds = starts_1based + [body_end + 2]   # sentinel end (exclusive, 1-based)
frag_concat = []
for k, name in enumerate(names):
    s0 = bounds[k] - 1          # 0-based inclusive
    e0 = bounds[k + 1] - 1      # 0-based exclusive
    chunk = lines[s0:e0]
    frag_concat.extend(chunk)
    with open(os.path.join(SRC, name + ".jsx"), "w", encoding="utf-8") as fh:
        fh.writelines(chunk)
    print(f"  wrote src/{name}.jsx  (L{bounds[k]}..L{bounds[k+1]-1}, {len(chunk)} lines)")

# HARD INVARIANT: verbatim slices must reconstruct the original body exactly.
assert frag_concat == orig_body, "FRAGMENT CONCAT != ORIGINAL BODY — carve is not verbatim!"
print("OK: fragments concatenate to the original script body byte-for-byte.")

# Rewrite index.html: drop babel.min.js line, replace the whole inline script block
# (open..close inclusive) with a single native-module tag. Build on ORIGINAL indices.
new = []
for i, ln in enumerate(lines):
    if i == babel_i:
        continue
    if i == open_i:
        indent = ln[:len(ln) - len(ln.lstrip())]
        new.append(f'{indent}<script type="module" src="./assets/app.bundle.js"></script>\n')
        continue
    if open_i < i <= close_i:
        continue  # swallowed by the replacement above
    new.append(ln)

with open(IDX, "w", encoding="utf-8") as f:
    f.writelines(new)
print(f"rewrote index.html: -babel.min.js, inline script -> <script type=module src=app.bundle.js> "
      f"({len(lines)} -> {len(new)} lines)")
