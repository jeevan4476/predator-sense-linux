#!/usr/bin/env python3
"""Generate the Predator Sense Linux launcher icon.

Source artwork: their app's own light_area_coverlogo@2x.png (the Predator
"war wings" mark, RGBA). Composited centered on a dark rounded tile so it
holds up in GNOME's launcher grid. Requires Pillow.

  python3 packaging/gen-icon.py            # writes the default 256px PNG
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps

REPO = Path(__file__).resolve().parent.parent
SRC = (REPO / "analysis/reference/predator-sense/PredatorSense_5.0.1463/UWP/"
       "asar-extract/app/resources/asar-out/dist/widgets/main/assets/images/"
       "light/light_area_coverlogo@2x.png")
OUT = REPO / "packaging/predator-sense-icon.png"
TILE = (7, 7, 11)          # near-black Predator base
ROUND = 44                 # tile corner radius @256

def main(size=256, out=OUT):
    src = Image.open(SRC).convert("RGBA")
    # fit mark to 78% of the tile, LANCZOS from 288px source
    inner = round(size * 0.78)
    mark = ImageOps.contain(src, (inner, inner), Image.LANCZOS)
    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(tile)
    s = size // 256
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=ROUND * s, fill=TILE + (255,))
    # subtle teal top glow line, their accent #44e2ff at low alpha
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=ROUND * s, outline=(68, 226, 255, 110), width=2 * s)
    tile.alpha_composite(mark, ((size - mark.width) // 2, (size - mark.height) // 2))
    tile.save(out)
    print(f"wrote {out} ({size}x{size})")

if __name__ == "__main__":
    args = sys.argv[1:]
    main(int(args[0]) if args else 256)
