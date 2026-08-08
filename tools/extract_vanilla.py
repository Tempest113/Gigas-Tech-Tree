#!/usr/bin/env python3
"""Extract vanilla *structural facts* for the tech-tree site (option C).

Reads a Stellaris install (or any directory containing the vanilla
``common/technology`` and ``common/scripted_variables``) and emits
``vanilla-structural.json`` containing ONLY:

- tech id, tier, area, categories, prerequisite edges, and the boolean
  flags (start/rare/dangerous/repeatable)
- the scripted-variable table (``@tier3cost1`` etc.) needed to resolve mod
  cost/weight references

Deliberately excluded: names, descriptions, icons, weight modifiers,
triggers, and any script text. See docs/vanilla-data.md.

Usage:
    python tools/extract_vanilla.py --game-dir <path-to-stellaris> \
        --out data/vanilla-structural.json [--game-version 4.5.0]

Typical Steam paths:
    Linux (native):  ~/.local/share/Steam/steamapps/common/Stellaris
    Linux (Flatpak): ~/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common/Stellaris
    Windows:         C:/Program Files (x86)/Steam/steamapps/common/Stellaris
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools.pdx.parser import Block, ParseError, parse_bytes
from tools.pdx.lexer import LexError
from tools.pdx.values import VarTable, resolve
from tools.pdx.parser import VarRef
from tools.loc import LocTable, strip_markup


def load_loc(game_dir: Path) -> LocTable:
    table = LocTable()
    loc_dir = game_dir / "localisation" / "english"
    if loc_dir.is_dir():
        for f in sorted(loc_dir.rglob("*.yml")):
            table.load_file(f.read_bytes(), f.name)
    return table


def extract(game_dir: Path, game_version: str,
            include_names: bool = False,
            include_desc: bool = False) -> dict:
    tech_dir = game_dir / "common" / "technology"
    var_dir = game_dir / "common" / "scripted_variables"
    if not tech_dir.is_dir():
        raise SystemExit(f"not found: {tech_dir} — is --game-dir a Stellaris "
                         f"install (or a folder holding vanilla 'common/')?")

    loc = load_loc(game_dir) if include_names else None

    table = VarTable()
    if var_dir.is_dir():
        for f in sorted(var_dir.glob("*.txt")):
            table.load_definitions(parse_bytes(f.read_bytes()), f.name)

    techs = []
    errors = []
    for f in sorted(tech_dir.glob("*.txt")):
        try:
            ast = parse_bytes(f.read_bytes())
        except (ParseError, LexError) as e:
            errors.append({"file": f.name, "message": str(e)})
            continue
        # Inline @defs at the top of vanilla tech files (vanilla does this).
        table.load_definitions(ast, f.name)
        for p in ast.pairs():
            if not isinstance(p.value, Block) or p.key.startswith("@"):
                continue
            b = p.value
            cat = b.get_last("category")
            cats = ([str(v) for v in cat.bare_values()]
                    if isinstance(cat, Block) else
                    [str(cat)] if cat is not None else [])
            prereq = b.get_last("prerequisites")
            levels = b.get_last("levels")
            entry_name = (strip_markup(loc.resolve_substitutions(
                loc.get(p.key) or "")) or None) if loc else None
            entry_desc = (strip_markup(loc.resolve_substitutions(
                loc.get(p.key + "_desc") or "")) or None)                 if (loc and include_desc) else None
            explicit_icon = b.get_last("icon")
            def _resolved_num(key):
                v = b.get_last(key)
                if isinstance(v, VarRef):
                    rv, _e = resolve(v, table)
                    return rv if isinstance(rv, (int, float)) else None
                return _int(_s(v))
            tier_raw = b.get_last("tier")
            if isinstance(tier_raw, VarRef):
                rv, _err = resolve(tier_raw, table)
                tier_val = int(rv) if isinstance(rv, (int, float)) else None
            else:
                tier_val = _int(_s(tier_raw))
            techs.append({
                "id": p.key,
                **({"name": entry_name} if entry_name else {}),
                **({"desc": entry_desc} if entry_desc else {}),
                **({"icon": str(explicit_icon)}
                   if explicit_icon is not None
                   and not isinstance(explicit_icon, Block) else {}),
                "tier": tier_val,
                "cost": _resolved_num("cost"),
                "weight": _resolved_num("weight"),
                "area": _s(b.get_last("area")),
                "categories": cats,
                "prerequisites": ([str(v) for v in prereq.bare_values()]
                                  if isinstance(prereq, Block) else []),
                "isStart": b.get_last("is_start_tech") == "yes",
                "isRare": b.get_last("is_rare") == "yes",
                "isDangerous": b.get_last("is_dangerous") == "yes",
                "isRepeatable": levels is not None,
            })

    tiers = {}
    tier_dir = game_dir / "common" / "technology" / "tier"
    if tier_dir.is_dir():
        for f in sorted(tier_dir.glob("*.txt")):
            try:
                ast = parse_bytes(f.read_bytes())
            except (ParseError, LexError):
                continue
            for p in ast.pairs():
                if isinstance(p.value, Block):
                    pu = p.value.get_last("previously_unlocked")
                    n = _int(pu)
                    if n is not None:
                        tiers[p.key] = {"previouslyUnlocked": n}

    techs.sort(key=lambda t: t["id"])
    return {
        "schemaVersion": 1,
        "kind": "vanilla-structural",
        "gameVersion": game_version,
        "note": ("Derived structural facts: ids, tiers, areas, edges, flags, "
                 "scripted-variable numbers"
                 + (", plus display names (--loc)" if include_names else "")
                 + ". No descriptions, script text, or assets."),
        "tiers": tiers,
        "variables": {name: d.value
                      for name, d in sorted(table.defs.items())},
        "technologies": techs,
        "errors": errors,
    }


def _s(v):
    return None if v is None or isinstance(v, Block) else str(v)


def _int(v):
    try:
        return int(_s(v))
    except (TypeError, ValueError):
        return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game-dir", type=Path, required=True)
    ap.add_argument("--out", type=Path,
                    default=Path("data/vanilla-structural.json"))
    ap.add_argument("--game-version", default="unknown")
    ap.add_argument("--loc", action="store_true",
                    help="include tech display names")
    ap.add_argument("--desc", action="store_true",
                    help="include tech descriptions (implies --loc)")
    ap.add_argument("--icons", type=Path, default=None, metavar="OUTDIR",
                    help="convert vanilla tech icons (.dds) to PNG in OUTDIR")
    args = ap.parse_args()

    model = extract(args.game_dir, args.game_version,
                    include_names=args.loc or args.desc,
                    include_desc=args.desc)
    if args.icons:
        from tools.icons import convert_icons
        icon_src = (args.game_dir / "gfx" / "interface" / "icons"
                    / "technologies")
        r = convert_icons(icon_src, args.icons,
                          args.icons / "atlas.png", args.icons / "atlas.json")
        print(f"icons         : {len(r.converted)} converted, "
              f"{len(r.warnings)} failed")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(model, sort_keys=True, separators=(",", ":"),
                   ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"vanilla techs : {len(model['technologies'])}")
    print(f"variables     : {len(model['variables'])}")
    print(f"parse errors  : {len(model['errors'])}")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
