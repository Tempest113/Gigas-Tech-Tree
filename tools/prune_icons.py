#!/usr/bin/env python3
"""Remove icon PNGs the site never references.

The extractor used to convert whole icon folders from the game, which
committed hundreds of files the tree never draws. `build_data.py` writes
`data/needed-icons.json` listing exactly the keys in use — every
technology's resolved icon plus every ascension perk named by a gated
technology — and this script deletes anything else.

Dry run by default:

    python tools/prune_icons.py                 # report only
    python tools/prune_icons.py --apply         # delete
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

def _is_atlas(stem: str) -> bool:
    return stem == "atlas" or stem.endswith("-atlas")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--icons", type=Path, default=Path("assets/icons"))
    ap.add_argument("--needed", type=Path,
                    default=Path("data/needed-icons.json"))
    ap.add_argument("--apply", action="store_true",
                    help="actually delete (default is a dry run)")
    args = ap.parse_args()

    if not args.needed.is_file():
        raise SystemExit(
            f"{args.needed} not found — run tools/build_data.py first "
            f"(with --vanilla, so vanilla icons count as referenced).")

    needed = set(json.loads(args.needed.read_text(encoding="utf-8")))
    present = {f for f in args.icons.glob("*.png")
               if not _is_atlas(f.stem)}
    unused = sorted(f for f in present if f.stem not in needed)
    missing = sorted(needed - {f.stem for f in present})

    total = sum(f.stat().st_size for f in unused)
    print(f"referenced : {len(needed)}")
    print(f"present    : {len(present)}")
    print(f"unused     : {len(unused)}  ({total / 1024:.0f} KiB)")
    if missing:
        print(f"missing    : {len(missing)} (icons the site wants but does "
              f"not have; re-run the extractor)")
        for m in missing[:10]:
            print(f"             {m}")

    if not args.apply:
        for f in unused[:10]:
            print(f"  would delete {f.name}")
        if len(unused) > 10:
            print(f"  … and {len(unused) - 10} more")
        print("\nDry run. Pass --apply to delete.")
        return

    for f in unused:
        f.unlink()
    print(f"deleted {len(unused)} files")


if __name__ == "__main__":
    main()
