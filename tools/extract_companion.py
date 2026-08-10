#!/usr/bin/env python3
"""Extract the parts of another mod that Gigastructures references.

Gigastructures hooks into other mods: its ACOT supertensile chain depends on
technologies defined by the Ancient Cache of Technologies, and its costs use
`@acot_*` variables that resolve to zero without it. Those technologies would
otherwise render as bare ids with no name, icon or cost.

`build_data.py` writes `data/needed-external.json` listing exactly what is
missing. This reads it and takes only those pieces from the mod you point it
at — the referenced technologies, the named variables, their localisation and
their icons. Nothing else is copied.

    python tools/extract_companion.py \\
        --mod-dir "~/.local/share/Steam/steamapps/workshop/content/281990/<id>" \\
        --id acot --label "Ancient Cache of Technologies" \\
        --out data/companion-acot.json --icons assets/icons

Run once per mod. Each companion file is listed in `data/manifest.json` and
loaded by the viewer alongside the vanilla data.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools.icons import convert_icons
from tools.loc import LocTable, strip_markup
from tools.pdx.lexer import LexError
from tools.pdx.parser import Block, ParseError, VarRef, parse_bytes
from tools.pdx.values import VarTable, resolve


def load_loc(mod_dir: Path) -> LocTable:
    table = LocTable()
    for sub in ("localisation", "localization"):
        d = mod_dir / sub / "english"
        if d.is_dir():
            for f in sorted(d.rglob("*.yml")):
                table.load_file(f.read_bytes(), f.name)
        d2 = mod_dir / sub
        if d2.is_dir():
            for f in sorted(d2.glob("*_l_english.yml")):
                table.load_file(f.read_bytes(), f.name)
    return table


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mod-dir", type=Path, required=True)
    ap.add_argument("--id", required=True, help="short id, e.g. acot")
    ap.add_argument("--label", required=True, help="display name")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--needed", type=Path,
                    default=Path("data/needed-external.json"))
    ap.add_argument("--icons", type=Path, default=None, metavar="OUTDIR")
    ap.add_argument("--all", action="store_true",
                    help="take every technology, not only referenced ones")
    args = ap.parse_args()

    mod_dir = args.mod_dir.expanduser()
    if not (mod_dir / "common").is_dir():
        raise SystemExit(f"{mod_dir} has no common/ — point at the mod's root")

    wanted_techs: set[str] = set()
    wanted_vars: set[str] = set()
    if args.needed.is_file():
        doc = json.loads(args.needed.read_text(encoding="utf-8"))
        wanted_techs = set(doc.get("technologies") or [])
        wanted_vars = set(doc.get("variables") or [])

    # -- variables -------------------------------------------------------
    table = VarTable()
    var_dir = mod_dir / "common" / "scripted_variables"
    if var_dir.is_dir():
        for f in sorted(var_dir.glob("*.txt")):
            try:
                table.load_definitions(parse_bytes(f.read_bytes()), f.name)
            except (ParseError, LexError):
                continue
    variables = {name: d.value for name, d in sorted(table.defs.items())
                 if not wanted_vars or name in wanted_vars}

    # -- technologies ----------------------------------------------------
    loc = load_loc(mod_dir)
    techs = []
    errors = []
    tech_dir = mod_dir / "common" / "technology"
    if tech_dir.is_dir():
        for f in sorted(tech_dir.glob("*.txt")):
            try:
                ast = parse_bytes(f.read_bytes())
            except (ParseError, LexError) as e:
                errors.append({"file": f.name, "message": str(e)})
                continue
            table.load_definitions(ast, f.name)
            for p in ast.pairs():
                if not isinstance(p.value, Block) or p.key.startswith("@"):
                    continue
                if not args.all and wanted_techs and p.key not in wanted_techs:
                    continue
                b = p.value

                def num(key):
                    v = b.get_last(key)
                    if isinstance(v, VarRef):
                        r, _ = resolve(v, table)
                        return r if isinstance(r, (int, float)) else None
                    try:
                        return int(str(v))
                    except (TypeError, ValueError):
                        return None

                cat = b.get_last("category")
                prereq = b.get_last("prerequisites")
                icon = b.get_last("icon")
                name = loc.get(p.key)
                desc = loc.get(p.key + "_desc")
                techs.append({
                    "id": p.key,
                    **({"name": strip_markup(loc.resolve_substitutions(name))}
                       if name else {}),
                    **({"desc": strip_markup(loc.resolve_substitutions(desc))}
                       if desc else {}),
                    **({"icon": str(icon)}
                       if icon is not None and not isinstance(icon, Block)
                       else {}),
                    "tier": num("tier"),
                    "cost": num("cost"),
                    "weight": num("weight"),
                    "area": (None if isinstance(b.get_last("area"), Block)
                             else (str(b.get_last("area"))
                                   if b.get_last("area") is not None else None)),
                    "categories": ([str(v) for v in cat.bare_values()]
                                   if isinstance(cat, Block)
                                   else [str(cat)] if cat is not None else []),
                    "prerequisites": ([str(v) for v in prereq.bare_values()]
                                      if isinstance(prereq, Block) else []),
                    "isRare": b.get_last("is_rare") == "yes",
                    "isDangerous": b.get_last("is_dangerous") == "yes",
                    "isRepeatable": b.get_last("levels") is not None,
                })

    techs.sort(key=lambda t: t["id"])
    model = {
        "schemaVersion": 1,
        "kind": "companion",
        "id": args.id,
        "label": args.label,
        "note": ("Only the pieces Gigastructures references: technologies "
                 "named as prerequisites, the variables its costs use, and "
                 "their names, descriptions and icons."),
        "variables": variables,
        "technologies": techs,
        "errors": errors,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(model, sort_keys=True, separators=(",", ":"),
                   ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"technologies : {len(techs)}"
          + (f" of {len(wanted_techs)} wanted" if wanted_techs else ""))
    print(f"variables    : {len(variables)}")
    print(f"parse errors : {len(errors)}")

    if args.icons:
        stems = {t.get("icon") or t["id"] for t in techs}
        src = mod_dir / "gfx" / "interface" / "icons" / "technologies"
        if src.is_dir():
            r = convert_icons(src, args.icons, args.icons / "companion-atlas.png",
                              args.icons / "companion-atlas.json", only=stems)
            print(f"icons        : {len(r.converted)} converted")
        else:
            print("icons        : no gfx/interface/icons/technologies")

    missing = sorted(wanted_techs - {t["id"] for t in techs})
    if missing:
        print("still missing :", ", ".join(missing))
        print("  (defined by a different mod — run this again against it)")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
