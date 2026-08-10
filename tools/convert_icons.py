#!/usr/bin/env python3
"""Convert icons from any mod folder into the site's icon directory.

Used for technologies that belong to a mod outside the build — the Ancient
Cache of Technologies power cores that the Gigastructures supertensile chain
depends on, for instance — so their cards have icons like any other.

    python tools/convert_icons.py --src /path/to/mod/gfx/interface/icons/technologies \\
        --only tech_dark_matter_power_core_ae tech_dark_matter_power_core_dm

Without --only every icon in the folder is converted, which is rarely what
you want; the site only draws icons it references. Run tools/build_atlas.py
afterwards, or the new icons will not appear.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools.icons import convert_icons


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, required=True,
                    help="folder of .dds icons")
    ap.add_argument("--out", type=Path, default=Path("assets/icons"))
    ap.add_argument("--only", nargs="*", default=None,
                    help="icon names to convert (without extension)")
    args = ap.parse_args()

    if not args.src.is_dir():
        raise SystemExit(f"{args.src} not found")

    res = convert_icons(args.src, args.out,
                        args.out / "_tmp-atlas.png",
                        args.out / "_tmp-atlas.json",
                        only=set(args.only) if args.only else None)
    for junk in ("_tmp-atlas.png", "_tmp-atlas.json"):
        (args.out / junk).unlink(missing_ok=True)

    print(f"converted {len(res.converted)} icons into {args.out}")
    for w in res.warnings:
        print(f"  warning: {w['file']}: {w['message']}")
    if args.only:
        missing = sorted(set(args.only) - set(res.converted))
        for m in missing:
            print(f"  not found in {args.src.name}: {m}")
    print("now run: python tools/build_atlas.py")


if __name__ == "__main__":
    main()
