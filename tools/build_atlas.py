#!/usr/bin/env python3
"""Rebuild the sprite atlas from the PNGs in the icon directory.

The renderer draws every icon from `assets/icons/atlas.png` using the
coordinates in `atlas.json`, so the atlas must be regenerated whenever icons
are added or removed. `build_data.py` does this as part of a full build, but
that needs a Gigastructures checkout; this script needs only the icons
already present, so it can be run straight after `extract_vanilla.py`.

    python tools/build_atlas.py
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools.icons import build_atlas_from_pngs


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--icons", type=Path, default=Path("assets/icons"))
    args = ap.parse_args()

    if not args.icons.is_dir():
        raise SystemExit(f"{args.icons} not found")

    coords = build_atlas_from_pngs(args.icons, args.icons / "atlas.png",
                                   args.icons / "atlas.json")
    size = (args.icons / "atlas.png").stat().st_size
    print(f"atlas: {len(coords)} icons, {size / 1024:.0f} KiB")


if __name__ == "__main__":
    main()
