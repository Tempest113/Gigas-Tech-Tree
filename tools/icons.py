"""Icon conversion: ``.dds`` → individual PNGs + a sprite atlas.

Determinism requirements (spec §1.6): input files processed in sorted order,
atlas layout is a pure function of the sorted name list, and PNGs are written
without timestamps or ancillary chunks, so byte-identical inputs give
byte-identical outputs.

Per-file failure tolerance: a DDS that Pillow cannot decode gets a recorded
warning and a generated placeholder; the build continues. (All 327 current
Gigastructures icons decode fine; this is armour for future commits.)
"""
from __future__ import annotations

import hashlib
import io
import json
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from PIL import Image, PngImagePlugin

ATLAS_COLUMNS = 16


@dataclass
class IconResult:
    converted: list[str] = field(default_factory=list)
    warnings: list[dict] = field(default_factory=list)
    atlas_map: dict = field(default_factory=dict)


def _save_png_deterministic(im: Image.Image, path: Path) -> None:
    """PNG without tEXt/tIME chunks; fixed compression level."""
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=False, compress_level=9,
            pnginfo=PngImagePlugin.PngInfo())
    path.write_bytes(buf.getvalue())


def _placeholder(size: tuple[int, int] = (52, 52)) -> Image.Image:
    """Flat neutral tile with a border — obvious but not ugly."""
    im = Image.new("RGBA", size, (60, 66, 82, 255))
    px = im.load()
    w, h = size
    for x in range(w):
        for y in (0, h - 1):
            px[x, y] = (120, 130, 150, 255)
    for y in range(h):
        for x in (0, w - 1):
            px[x, y] = (120, 130, 150, 255)
    return im


def convert_icons(src_dir: Path, out_icons: Path, out_atlas_png: Path,
                  out_atlas_json: Path,
                  only: Optional[set] = None) -> IconResult:
    """Convert ``*.dds`` files in ``src_dir``.

    ``only`` restricts conversion to those stems (the icon keys the site
    actually references), so the game's full icon folders are not copied
    wholesale.

    - ``out_icons/<stem>.png`` per icon (detail panel).
    - One atlas PNG + JSON coordinate map ``{stem: {x,y,w,h}}`` (map view).
    """
    res = IconResult()
    out_icons.mkdir(parents=True, exist_ok=True)

    files = sorted((f for f in src_dir.glob("*.dds")
                    if only is None or f.stem in only),
                   key=lambda p: p.name)
    images: list[tuple[str, Image.Image]] = []
    for f in files:
        stem = f.stem
        try:
            im = Image.open(f)
            im.load()
            im = im.convert("RGBA")
        except Exception as e:  # per-file tolerance, spec §3
            res.warnings.append({
                "file": str(f.name),
                "message": f"DDS decode failed: {e}",
            })
            im = _placeholder()
        images.append((stem, im))
        _save_png_deterministic(im, out_icons / f"{stem}.png")
        res.converted.append(stem)

    if not images:
        return res

    # Atlas: fixed column count, cell = max icon dimensions (icons centred).
    cell_w = max(im.width for _, im in images)
    cell_h = max(im.height for _, im in images)
    cols = min(ATLAS_COLUMNS, len(images))
    rows = math.ceil(len(images) / cols)
    atlas = Image.new("RGBA", (cols * cell_w, rows * cell_h), (0, 0, 0, 0))

    for idx, (stem, im) in enumerate(images):
        cx = (idx % cols) * cell_w + (cell_w - im.width) // 2
        cy = (idx // cols) * cell_h + (cell_h - im.height) // 2
        atlas.paste(im, (cx, cy))
        res.atlas_map[stem] = {"x": cx, "y": cy,
                               "w": im.width, "h": im.height}

    out_atlas_png.parent.mkdir(parents=True, exist_ok=True)
    _save_png_deterministic(atlas, out_atlas_png)
    out_atlas_json.parent.mkdir(parents=True, exist_ok=True)
    out_atlas_json.write_text(
        json.dumps({"cell": {"w": cell_w, "h": cell_h},
                    "columns": cols,
                    "icons": dict(sorted(res.atlas_map.items()))},
                   indent=0, sort_keys=True) + "\n",
        encoding="utf-8")
    return res


def resolve_icon(tech_id: str, explicit_icon: Optional[str],
                 available: set[str], categories: dict,
                 tech_categories: list[str]) -> Optional[str]:
    """Spec §6.4 resolution order: explicit `icon` key → file matching the
    tech id → category icon → None (viewer shows the area placeholder)."""
    if explicit_icon and explicit_icon in available:
        return explicit_icon
    if tech_id in available:
        return tech_id
    for c in tech_categories:
        ci = categories.get(c, {}).get("icon")
        if ci and ci in available:
            return ci
    return None


def build_atlas_from_pngs(icon_dir: Path, out_png: Path,
                          out_json: Path) -> dict:
    """Build a sprite atlas over every PNG in ``icon_dir`` (mod icons plus
    any vanilla icons the maintainer has added). The viewer draws cards on
    canvas and takes every icon from this one image, so it must cover the
    whole set, not just the mod's own icons."""
    # Never treat an atlas as an icon. The extractor and the build write
    # intermediate atlases, and folding one of those back in as if it were a
    # 52-pixel icon inflates the cell size to its dimensions — which both
    # corrupts every coordinate and tries to allocate a canvas of gigapixels.
    MAX_ICON = 256
    files = []
    for f in sorted(icon_dir.glob("*.png"), key=lambda p: p.name):
        if f.stem == "atlas" or f.stem.endswith("-atlas"):
            continue
        files.append(f)
    if not files:
        return {}
    images = []
    oversized = []
    for f in files:
        try:
            im = Image.open(f)
            im.load()
        except Exception:
            continue
        if im.width > MAX_ICON or im.height > MAX_ICON:
            # Whatever this is, it is not a technology icon.
            oversized.append((f.name, im.size))
            continue
        images.append((f.stem, im.convert("RGBA")))
    for name, size in oversized:
        print(f"  skipped {name}: {size[0]}x{size[1]} is too large to be "
              f"an icon")

    cell_w = max(im.width for _, im in images)
    cell_h = max(im.height for _, im in images)
    cols = 32
    rows = math.ceil(len(images) / cols)
    atlas = Image.new("RGBA", (cols * cell_w, rows * cell_h), (0, 0, 0, 0))
    coords = {}
    for idx, (stem, im) in enumerate(images):
        cx = (idx % cols) * cell_w + (cell_w - im.width) // 2
        cy = (idx // cols) * cell_h + (cell_h - im.height) // 2
        atlas.paste(im, (cx, cy))
        coords[stem] = {"x": cx, "y": cy, "w": im.width, "h": im.height}

    _save_png_deterministic(atlas, out_png)
    # The coordinate file carries a hash of the image it describes, so the
    # viewer can request that exact image. Rebuilding the atlas without
    # bumping the tool version previously left browsers pairing new
    # coordinates with a cached image.
    digest = hashlib.sha256(out_png.read_bytes()).hexdigest()[:12]
    out_json.write_text(
        json.dumps({"cell": {"w": cell_w, "h": cell_h}, "columns": cols,
                    "hash": digest,
                    "icons": dict(sorted(coords.items()))},
                   indent=0, sort_keys=True) + "\n", encoding="utf-8")
    return coords
