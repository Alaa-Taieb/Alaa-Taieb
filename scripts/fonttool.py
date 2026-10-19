"""Font helper for build.mjs.

  python scripts/fonttool.py widths <font.ttf>        -> JSON {char: advance in em}
  python scripts/fonttool.py subset <font.ttf> <text>  -> base64 WOFF holding only <text>
"""
import base64
import io
import json
import sys

from fontTools import subset
from fontTools.ttLib import TTFont


def widths(path):
    font = TTFont(path)
    upem = font["head"].unitsPerEm
    cmap = font.getBestCmap()
    hmtx = font["hmtx"]
    out = {}
    for code, glyph in cmap.items():
        if code < 0x2600:
            out[chr(code)] = round(hmtx[glyph][0] / upem, 4)
    print(json.dumps(out, ensure_ascii=False))


def subset_font(path, text):
    options = subset.Options()
    options.flavor = "woff"
    options.layout_features = ["kern", "liga", "calt", "tnum"]
    options.name_IDs = []
    options.drop_tables += ["meta"]
    options.notdef_outline = True
    font = subset.load_font(path, options)
    subsetter = subset.Subsetter(options)
    subsetter.populate(text=text)
    subsetter.subset(font)
    buf = io.BytesIO()
    subset.save_font(font, buf, options)
    print(base64.b64encode(buf.getvalue()).decode("ascii"))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    if sys.argv[1] == "widths":
        widths(sys.argv[2])
    else:
        subset_font(sys.argv[2], sys.stdin.read())
