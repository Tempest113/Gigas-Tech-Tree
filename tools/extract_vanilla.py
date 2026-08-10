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
from tools.graph import (_collect_ascension_perks, parse_prerequisites,
                         load_ascension_triggers,
                         load_perk_flags, load_perk_tech_grants,
                         weight_is_zero)


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

    # Vanilla gates plenty of its own technologies behind ascension perks —
    # Ring World, Dyson Sphere and Matter Decompressor behind Galactic
    # Wonders, the colossus weapons behind the Colossus Project — either by
    # naming the perk or through a scripted trigger that wraps one.
    ap_triggers = load_ascension_triggers(game_dir)
    # Perks that hand a technology over outright rather than gating it.
    perk_grants = load_perk_tech_grants(game_dir)
    perk_flags = load_perk_flags(game_dir)

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
            prereq_flat, prereq_groups = parse_prerequisites(
                b.get_last("prerequisites"))
            prereq = b.get_last("prerequisites")
            levels = b.get_last("levels")
            entry_name = (strip_markup(loc.resolve_substitutions(
                loc.get(p.key) or "")) or None) if loc else None
            entry_desc = (strip_markup(loc.resolve_substitutions(
                loc.get(p.key + "_desc") or "")) or None)                 if (loc and include_desc) else None
            explicit_icon = b.get_last("icon")
            perks: list = []
            pot = b.get_last("potential")
            if isinstance(pot, Block):
                _collect_ascension_perks(pot, perks, ap_triggers)
                for pf in pot.pairs():
                    if pf.key == "has_country_flag" and \
                            isinstance(pf.value, str) and pf.value in perk_flags:
                        for perk in perk_flags[pf.value]:
                            if perk not in perks:
                                perks.append(perk)
            granted = perk_grants.get(p.key, [])
            if granted and weight_is_zero(b, table):
                for perk in granted:
                    if perk not in perks:
                        perks.append(perk)
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
                **({"ascensionPerks": perks} if perks else {}),
                **({"icon": str(explicit_icon)}
                   if explicit_icon is not None
                   and not isinstance(explicit_icon, Block) else {}),
                "tier": tier_val,
                "cost": _resolved_num("cost"),
                "weight": _resolved_num("weight"),
                "area": _s(b.get_last("area")),
                "categories": cats,
                "prerequisites": prereq_flat,
                **({"prerequisiteGroups": prereq_groups}
                   if any("any" in g for g in prereq_groups) else {}),
                "isStart": b.get_last("is_start_tech") == "yes",
                "isRare": b.get_last("is_rare") == "yes",
                "isDangerous": b.get_last("is_dangerous") == "yes",
                "isRepeatable": levels is not None,
                "levels": _resolved_num("levels"),
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


def _prereq_groups(prereq) -> list:
    """Prerequisites as alternative groups; see tools/graph.py. Vanilla uses
    this for Titans, which take battleships or the bio-ship equivalent."""
    if not isinstance(prereq, Block):
        return []
    groups = [[str(v)] for v in prereq.bare_values()]
    for p in prereq.pairs():
        if p.key in ("OR", "or") and isinstance(p.value, Block):
            alts = [str(v) for v in p.value.bare_values()]
            if alts:
                groups.append(alts)
    return groups


def _prereq_flat(prereq) -> list:
    return [x for grp in _prereq_groups(prereq) for x in grp]


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
    ap.add_argument("--fill-loc-keys", type=Path,
                    default=Path("data/unresolved-loc-keys.json"),
                    help="JSON list of loc keys the mod couldn't resolve; "
                         "their vanilla values are captured into locExtra")
    ap.add_argument("--icons", type=Path, default=None, metavar="OUTDIR",
                    help="convert referenced vanilla icons (.dds) to PNG "
                         "in OUTDIR")
    ap.add_argument("--needed-icons", type=Path,
                    default=Path("data/needed-icons.json"),
                    help="JSON list of icon keys the site actually uses; "
                         "only these are converted. Pass a missing path to "
                         "convert everything.")
    args = ap.parse_args()

    model = extract(args.game_dir, args.game_version,
                    include_names=args.loc or args.desc,
                    include_desc=args.desc)

    # Capture vanilla values for substitution keys the mod references but
    # does not define (e.g. $orbital_arc_furnace_4$).
    if args.fill_loc_keys and args.fill_loc_keys.is_file():
        wanted = json.loads(args.fill_loc_keys.read_text(encoding="utf-8"))
        loc_all = load_loc(args.game_dir)
        extra = {}
        for k in wanted:
            v = loc_all.get(k)
            if v:
                # Resolve nested $refs$ now: capturing a raw value only
                # exposes the next unresolved key, needing another run. Strip
                # markup too — these are substituted into names and
                # descriptions that are otherwise markup-free.
                extra[k] = strip_markup(loc_all.resolve_substitutions(v))
        model["locExtra"] = dict(sorted(extra.items()))
        print(f"loc keys filled: {len(extra)}/{len(wanted)}")

    # Ascension perk display names, so gated technologies can name the perk
    # properly ("Master Builders", not "Qso"). Names only, no descriptions.
    loc_all = load_loc(args.game_dir)
    perks = {}
    for key, entry in loc_all.entries.items():
        if key.startswith("ap_") and not key.endswith("_desc"):
            name = strip_markup(loc_all.resolve_substitutions(entry.value))
            if name:
                perks[key] = name
    model["ascensionPerks"] = dict(sorted(perks.items()))
    print(f"perk names    : {len(perks)}")
    if args.icons:
        from tools.icons import convert_icons
        wanted = None
        if args.needed_icons and args.needed_icons.is_file():
            wanted = set(json.loads(
                args.needed_icons.read_text(encoding="utf-8")))
            print(f"icon filter   : {len(wanted)} keys referenced")
        icon_src = (args.game_dir / "gfx" / "interface" / "icons"
                    / "technologies")
        import tempfile
        _tmp0 = Path(tempfile.mkdtemp())
        r = convert_icons(icon_src, args.icons,
                          _tmp0 / "atlas.png", _tmp0 / "atlas.json",
                          only=wanted)
        print(f"icons         : {len(r.converted)} converted, "
              f"{len(r.warnings)} failed")
        # Ascension perk icons land in the same directory, so the build's
        # atlas covers them and the viewer can draw a perk's own icon on a
        # gated technology.
        ap_src = (args.game_dir / "gfx" / "interface" / "icons"
                  / "ascension_perks")
        if ap_src.is_dir():
            import tempfile
            _tmp = Path(tempfile.mkdtemp())
            # Perk icons are converted in full rather than filtered. Which
            # perks the tree references depends on gating this extraction is
            # about to reveal, so filtering against the previous build's
            # list can never catch up. They are small, and the pruner
            # removes any that turn out to be unreferenced.
            ra = convert_icons(ap_src, args.icons,
                               _tmp / "ap-atlas.png",
                               _tmp / "ap-atlas.json")
            print(f"perk icons    : {len(ra.converted)} converted")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(model, sort_keys=True, separators=(",", ":"),
                   ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"vanilla techs : {len(model['technologies'])}")
    print(f"perk-gated    : "
          f"{sum(1 for t in model['technologies'] if t.get('ascensionPerks'))}")
    print(f"variables     : {len(model['variables'])}")
    print(f"parse errors  : {len(model['errors'])}")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
