#!/usr/bin/env python3
# Needs Python with fontTools and brotli installed (pip install fonttools brotli).
"""Split the Inter variable font into two files by unicode-range.

The app used to ship one 352 KB InterVariable.woff2, and main.jsx holds the
first draw until it has loaded. Almost every character the app draws is Latin,
so the first file holds Latin plus the punctuation, arrows and symbols the UI
itself uses, and the second holds every other character in the font (Greek,
Cyrillic, Vietnamese and the rest). index.css gives each one a unicode-range,
so the browser downloads the second only on a page that shows one of its
characters, and it is still Inter when it does.

Both files keep every glyph, variation axis and OpenType feature for the
characters they cover (layout features '*', all name records, glyph names), so
a Latin page draws exactly as before. Glyph names are kept on purpose: without
them Chrome on macOS drew small text with slightly different anti-aliasing
(about 2,500 pixels on an Overview screenshot), even though every outline,
advance and kerning value was the same. With them the screenshots match the
single file pixel for pixel.
Kerning between a Latin character and one from the second file is the one
thing a split cannot keep; no UI string mixes the two.

Needs fontTools with brotli (pip install fonttools brotli). Run from the repo
root; it rewrites both font files and prints the unicode-range for each, which
must match the two @font-face rules in ui/src/index.css.

    python3 scripts/split-inter.py
"""
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

SRC = "third_party/inter/InterVariable.woff2"
OUT = "ui/src/assets/fonts"

# Google Fonts' "latin" range, plus every non-ASCII character ui/src, the help
# text and the Go server put on screen (arrows, ≥, ≈, ▲▼, ✓, ✕ and so on).
LATIN = [
    (0x0000, 0x00FF), (0x0131, 0x0131), (0x0152, 0x0153), (0x02BB, 0x02BC),
    (0x02C6, 0x02C6), (0x02DA, 0x02DA), (0x02DC, 0x02DC), (0x0304, 0x0304),
    (0x0308, 0x0308), (0x0329, 0x0329), (0x0394, 0x0394), (0x2000, 0x206F),
    (0x20AC, 0x20AC), (0x2122, 0x2122), (0x2190, 0x21FF), (0x2212, 0x2215),
    (0x2248, 0x2248), (0x2260, 0x2265), (0x22EF, 0x22EF), (0x2318, 0x2318),
    (0x24D8, 0x24D8), (0x2500, 0x257F), (0x25A0, 0x25FF), (0x2603, 0x2603),
    (0x2699, 0x2699), (0x2713, 0x2715), (0x283F, 0x283F), (0xFEFF, 0xFEFF),
    (0xFFFD, 0xFFFD),
]


def ranges(cps):
    """Sorted code points as CSS unicode-range text."""
    out, cps = [], sorted(cps)
    i = 0
    while i < len(cps):
        j = i
        while j + 1 < len(cps) and cps[j + 1] == cps[j] + 1:
            j += 1
        a, b = cps[i], cps[j]
        out.append(f"U+{a:04X}" if a == b else f"U+{a:04X}-{b:04X}")
        i = j + 1
    return ", ".join(out)


def write(cps, name):
    opts = subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    opts.name_legacy = True
    opts.notdef_outline = True
    opts.glyph_names = True
    opts.recalc_timestamp = False
    font = subset.load_font(SRC, opts)
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=cps)
    sub.subset(font)
    path = os.path.join(OUT, name)
    subset.save_font(font, path, opts)
    print(f"{path}: {os.path.getsize(path):,} bytes\n  unicode-range: {ranges(cps)}\n")


def main():
    cmap = set(TTFont(SRC).getBestCmap())
    latin = {cp for cp in cmap if any(a <= cp <= b for a, b in LATIN)}
    other = cmap - latin
    os.makedirs(OUT, exist_ok=True)
    write(latin, "Inter-latin.woff2")
    write(other, "Inter-other.woff2")


if __name__ == "__main__":
    sys.exit(main())
