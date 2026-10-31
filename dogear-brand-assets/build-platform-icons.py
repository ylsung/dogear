#!/usr/bin/env python3
"""Export the Dogear mark into every platform's icon slots.

Run from anywhere:  python3 dogear-brand-assets/build-platform-icons.py
Needs Pillow and macOS `iconutil`. Source of truth is dogear-mark-1024.png
(primary colors); reversed and one-color variants are recolored from it so
every export shares the same geometry.
"""
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

BRAND = Path(__file__).resolve().parent
ROOT = BRAND.parent
EXT_ICONS = ROOT / 'extension' / 'icons'
VSCODE_MEDIA = ROOT / 'vscode' / 'media'
DESKTOP_RES = ROOT / 'desktop' / 'App' / 'Resources'

INK = (0x16, 0x18, 0x27)  # palette Ink, matches extension/theme.js
LEAD = (0x59, 0x60, 0xB3)  # palette Lead (`primary`)
WHITE = (0xFF, 0xFF, 0xFF)
TILE_BORDER = (0xE5, 0xE7, 0xEB)

master = Image.open(BRAND / 'dogear-mark-1024.png').convert('RGBA')
master = master.crop(master.getchannel('A').getbbox())  # artwork only


def recolor(img, body, ear):
    """Swap the ink body / lead ear colors, keeping anti-aliased alpha."""
    out = img.copy()
    px = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = px[x, y]
            if a:
                px[x, y] = (*(ear if b - r > 60 else body), a)
    return out


VARIANTS = {
    'primary': master,
    'reversed': recolor(master, WHITE, LEAD),
    'black': recolor(master, (0, 0, 0), (0, 0, 0)),
}


def fit(variant, width, height, pad=0.0):
    """Mark centered on a transparent width×height canvas, `pad` = fraction of each side."""
    art = VARIANTS[variant]
    scale = min(width * (1 - 2 * pad) / art.width, height * (1 - 2 * pad) / art.height)
    w, h = max(1, round(art.width * scale)), max(1, round(art.height * scale))
    canvas = Image.new('RGBA', (width, height))
    canvas.alpha_composite(art.resize((w, h), Image.LANCZOS), ((width - w) // 2, (height - h) // 2))
    return canvas


def tile(size, inset, radius, mark_width, shadow=False):
    """White rounded tile with the primary mark; rendered at 1024 then downsampled.

    inset / radius / mark_width are fractions of the canvas / tile side.
    """
    S = 1024
    canvas = Image.new('RGBA', (S, S))
    x0 = round(S * inset)
    side = S - 2 * x0
    box = (x0, x0, x0 + side - 1, x0 + side - 1)
    r = round(side * radius)
    if shadow:  # macOS icon grid: soft drop shadow under the tile
        sh = Image.new('RGBA', (S, S))
        ImageDraw.Draw(sh).rounded_rectangle(
            (box[0], box[1] + 12, box[2], box[3] + 12), r, fill=(0, 0, 0, 70))
        canvas.alpha_composite(sh.filter(ImageFilter.GaussianBlur(14)))
    # Hairline keeps the white tile's edge visible on white store pages; the
    # macOS shadow already does that job.
    ImageDraw.Draw(canvas).rounded_rectangle(
        box, r, fill=WHITE, outline=None if shadow else TILE_BORDER,
        width=max(2, round(side * 0.012)))
    art = VARIANTS['primary']
    w = round(side * mark_width)
    h = round(art.height * w / art.width)
    canvas.alpha_composite(art.resize((w, h), Image.LANCZOS),
                           (x0 + (side - w) // 2, x0 + (side - h) // 2))
    return canvas.resize((size, size), Image.LANCZOS)


def save(img, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, optimize=True)
    print('wrote', path.relative_to(ROOT))


# ---- Chrome extension ----------------------------------------------------
# Static extension icons (`icons` in the manifest): the context menu, side
# panel title, extensions menu/page, install dialog and Web Store. Chrome
# stable cannot switch these with the browser theme (`icon_variants` is still
# Canary-only), so a white tile keeps the charcoal mark readable on dark UI.
# 128 follows the store's 96px-art / 16px-padding rule.
save(tile(16, inset=0.0, radius=0.22, mark_width=0.84), EXT_ICONS / 'icon16.png')
save(tile(32, inset=0.0, radius=0.22, mark_width=0.8), EXT_ICONS / 'icon32.png')
# Toolbar button (`action.default_icon`): bare symbol, swapped to the reversed
# variant at runtime by background.js when the browser is dark.
for s in (16, 32):
    save(fit('primary', s, s, pad=0.0 if s == 16 else 0.03), EXT_ICONS / f'toolbar{s}.png')
    save(fit('reversed', s, s, pad=0.0 if s == 16 else 0.03), EXT_ICONS / f'toolbar{s}-dark.png')
save(tile(48, inset=0.03, radius=0.22, mark_width=0.76), EXT_ICONS / 'icon48.png')
save(tile(128, inset=0.125, radius=0.22, mark_width=0.74), EXT_ICONS / 'icon128.png')
# Vector mark for the side panel header (also copied into the VS Code webview).
shutil.copyfile(BRAND / 'dogear-mark-primary.svg', EXT_ICONS / 'mark.svg')
print('wrote', (EXT_ICONS / 'mark.svg').relative_to(ROOT))

# ---- VS Code -------------------------------------------------------------
# Marketplace / Extensions view icon: 256px for retina, tile for dark themes.
save(tile(256, inset=0.02, radius=0.22, mark_width=0.74), VSCODE_MEDIA / 'icon.png')
# Activity Bar icon: VS Code masks it to one color, so use a single-color
# currentColor silhouette with a square viewBox around the artwork.
svg = (BRAND / 'dogear-mark-black.svg').read_text()
svg = svg.replace('fill="#000000"', 'fill="currentColor"').replace('fill="#161827"', 'fill="currentColor"')
svg = svg.replace('viewBox="0 0 602 427"', 'viewBox="-13 -101 628 628" width="24" height="24"')
assert 'currentColor' in svg and '628 628' in svg, 'unexpected source SVG'
(VSCODE_MEDIA / 'dogear.svg').write_text(svg)
print('wrote', (VSCODE_MEDIA / 'dogear.svg').relative_to(ROOT))

# ---- macOS desktop app ---------------------------------------------------
# AppIcon.icns on Apple's 1024 grid (824px tile, 100px margin, drop shadow).
with tempfile.TemporaryDirectory() as tmp:
    iconset = Path(tmp) / 'AppIcon.iconset'
    iconset.mkdir()
    big = tile(1024, inset=100 / 1024, radius=0.225, mark_width=0.70, shadow=True)
    for pt in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            px = pt * scale
            name = f'icon_{pt}x{pt}{"@2x" if scale == 2 else ""}.png'
            big.resize((px, px), Image.LANCZOS).save(iconset / name)
    DESKTOP_RES.mkdir(parents=True, exist_ok=True)
    subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o', str(DESKTOP_RES / 'AppIcon.icns')], check=True)
    print('wrote', (DESKTOP_RES / 'AppIcon.icns').relative_to(ROOT))
# Menu bar template image (black + alpha; macOS tints it): 22×16 pt.
save(fit('black', 22, 16), DESKTOP_RES / 'MenuBarIcon.png')
save(fit('black', 44, 32), DESKTOP_RES / 'MenuBarIcon@2x.png')
# In-window brand mark (header, empty state), up to ~64 pt wide at @3x.
save(fit('primary', 192, 134), DESKTOP_RES / 'DogearMark.png')
save(fit('reversed', 192, 134), DESKTOP_RES / 'DogearMarkReversed.png')
