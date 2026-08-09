#!/usr/bin/env python3
"""Build entry point: mod checkout → data/*.json (+ icons).

Usage:
    python tools/build_data.py --mod-dir /path/to/gigas-checkout \
        --out data --icons-out assets/icons \
        [--commit <sha>] [--skip-icons]

Determinism: inputs read in sorted order, JSON keys sorted, no timestamps in
layout-relevant data (``fetchedAt`` lives only in meta and is derived from
the pinned commit, not the clock).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tools.graph import (build_graph, load_ascension_triggers,
                         load_perk_tech_grants, to_json_model, weight_is_zero)
from tools.inline_scripts import InlineScriptLibrary
from tools.loc import LocEntry, LocTable, strip_markup
from tools.merge import MergeResult, Source, merge_sources
from tools.pdx.parser import Block, parse_bytes
from tools.pdx.values import VarTable

SCHEMA_VERSION = 1
#: Build fails (spec §3) below this many techs — catches catastrophic
#: parse regressions without being fragile to normal mod churn.
TECH_COUNT_FLOOR = 150


def load_variables(mod_dir: Path, vanilla_vars: VarTable | None) -> VarTable:
    table = VarTable(fallback=vanilla_vars)
    var_dir = mod_dir / "common" / "scripted_variables"
    if var_dir.is_dir():
        for f in sorted(var_dir.glob("*.txt")):
            table.load_definitions(parse_bytes(f.read_bytes()), f.name)
    return table


def load_vanilla_loc(path: Path, loc: LocTable) -> int:
    """Seed the loc table with vanilla entries the extractor captured for
    keys the mod references but doesn't define (e.g. $orbital_arc_furnace_4$).
    Loaded BEFORE mod loc so mod definitions still win."""
    if not path.is_file():
        return 0
    doc = json.loads(path.read_text(encoding="utf-8"))
    extra = doc.get("locExtra") or {}
    for k, v in extra.items():
        loc.entries[k] = LocEntry(v, "vanilla-structural.json", 0)
    return len(extra)


def load_vanilla_structural(path: Path) -> VarTable:
    """Variable table from a vanilla-structural.json (option C artefact)."""
    table = VarTable()
    doc = json.loads(path.read_text(encoding="utf-8"))
    for name, value in doc.get("variables", {}).items():
        table.define(name, value, "vanilla-structural.json")
    return table


def load_categories(mod_dir: Path, loc: LocTable) -> dict:
    cats: dict = {}
    cat_dir = mod_dir / "common" / "technology" / "category"
    if cat_dir.is_dir():
        for f in sorted(cat_dir.glob("*.txt")):
            ast = parse_bytes(f.read_bytes())
            for p in ast.pairs():
                if isinstance(p.value, Block):
                    cats[p.key] = {
                        "area": None,  # category files don't declare area
                        "name": loc.name(p.key) or p.key,
                        "icon": _scalar(p.value.get_last("icon")),
                    }
    return cats


def _scalar(v):
    return None if v is None or isinstance(v, Block) else str(v)


def build(mod_dir: Path, out_dir: Path, icons_out: Path | None,
          commit: str = "unknown", mod_id: str = "gigas",
          mod_label: str = "Gigastructural Engineering & More (Pouchkinn)",
          vanilla_path: Path | None = None,
          ) -> dict:
    loc = LocTable()
    if vanilla_path:
        load_vanilla_loc(vanilla_path, loc)
    loc_dir = mod_dir / "localisation" / "english"
    if loc_dir.is_dir():
        for f in sorted(loc_dir.glob("*.yml")):
            loc.load_file(f.read_bytes(), f.name)

    vanilla_vars = (load_vanilla_structural(vanilla_path)
                    if vanilla_path and vanilla_path.is_file() else None)
    vars_ = load_variables(mod_dir, vanilla_vars=vanilla_vars)

    gigas = Source(id=mod_id, label=mod_label)
    tech_dir = mod_dir / "common" / "technology"
    for f in sorted(tech_dir.glob("*.txt")):
        gigas.add(f.name, f.read_bytes())

    icon_dir = mod_dir / "gfx" / "interface" / "icons" / "technologies"
    icon_stems = ({f.stem for f in icon_dir.glob("*.dds")}
                  if icon_dir.is_dir() else set())

    categories = load_categories(mod_dir, loc)

    merged: MergeResult = merge_sources([gigas])

    lib = InlineScriptLibrary.from_dir(mod_dir)
    for td in merged.techs.values():
        td.body = lib.expand_block(td.body, context=td.id)
    td_bodies = {tid: td.body for tid, td in merged.techs.items()}

    graph = build_graph(merged.techs, vars_, loc,
                        icon_stems=icon_stems, categories=categories,
                        ascension_triggers=load_ascension_triggers(mod_dir),
                        perk_grants=load_perk_tech_grants(mod_dir))

    meta = {
        "schemaVersion": SCHEMA_VERSION,
        "sources": [{
            "id": mod_id, "label": mod_label, "kind": "mod",
            "repo": "Pouchkinn-s-Gigastructures/Gigastructures",
            "branch": "Master-Dev", "commit": commit,
        }],
        "counts": {
            "technologies": len(graph.techs),
            "crossModGated": sum(t.cross_mod_gated
                                 for t in graph.techs.values()),
            "overrides": sum(t.raw.overrides_earlier_source
                             for t in graph.techs.values()),
        },
        "locWarnings": loc.warnings,
        "unexpandedInlineScripts": sorted(
            {u["script"] for u in lib.unexpanded}),
        "parseErrors": merged.parse_errors,
        "mergeWarnings": merged.warnings,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    # Record substitution keys that stayed unresolved so the maintainer can
    # capture them from vanilla loc on the next extractor run.
    import re as _re
    unresolved = sorted({
        m for t in graph.techs.values()
        for m in _re.findall(r"\$([A-Za-z0-9_.\-']+)\$",
                             f"{t.name or ''} {t.desc or ''}")
    })
    meta["unresolvedLocKeys"] = unresolved
    (out_dir if out_dir.is_dir() else Path(".")).mkdir(parents=True, exist_ok=True)
    (out_dir / "unresolved-loc-keys.json").write_text(
        json.dumps(unresolved, indent=1) + "\n", encoding="utf-8")

    perk_grants = load_perk_tech_grants(mod_dir)
    manual_path = out_dir / "manual-perk-grants.json"
    manual = {}
    if manual_path.is_file():
        manual = (json.loads(manual_path.read_text(encoding="utf-8"))
                  .get("grants") or {})
        for tid, perks in manual.items():
            merged_perks = perk_grants.setdefault(tid, [])
            for p in perks:
                if p not in merged_perks:
                    merged_perks.append(p)

    # The exact icon keys the site references: every technology's resolved
    # icon plus every ascension perk named by a gated technology. The
    # extractor reads this so it converts only what is needed, rather than
    # every icon in the game's folders.
    needed = {t.icon for t in graph.techs.values() if t.icon}
    needed |= {p for t in graph.techs.values()
               for p in t.ascension_perks + t.inherited_perks}
    needed |= {p for perks in perk_grants.values() for p in perks}
    # Vanilla technologies are composed into the map client-side, so their
    # icons are referenced too even though they are not in this dataset.
    if vanilla_path and vanilla_path.is_file():
        vdoc = json.loads(vanilla_path.read_text(encoding="utf-8"))
        for v in vdoc.get("technologies", []):
            needed.add(v.get("icon") or v["id"])
            for p in v.get("ascensionPerks", []):
                needed.add(p)
    needed = sorted(needed)
    (out_dir / "needed-icons.json").write_text(
        json.dumps(needed, indent=1) + "\n", encoding="utf-8")

    # Display names for the perks this dataset references. Mod-defined
    # perks are named in the mod's own localisation; vanilla ones come from
    # data/vanilla-structural.json and are merged client-side.
    # The mod's ascension perks grant base-game technologies too (Galactic
    # Wonders hands over Ring World, Dyson Sphere and Matter Decompressor).
    # Those are vanilla technologies, composed client-side, so the map has
    # to travel with the dataset.
    meta["perkGrants"] = {k: sorted(v) for k, v in sorted(perk_grants.items())}
    meta["manualPerkGrants"] = manual

    meta["perkNames"] = {
        p: strip_markup(loc.name(p) or "") or p
        for p in sorted({q for t in graph.techs.values()
                         for q in t.ascension_perks + t.inherited_perks} |
                        {q for v in meta["perkGrants"].values() for q in v})
        if loc.get(p)
    }

    # An auditable record of every ascension perk marking: which perk, and
    # whether it comes from the technology's own `potential`, from a perk
    # granting it outright, or from a prerequisite.
    audit = []
    for tid in sorted(graph.techs):
        t = graph.techs[tid]
        if not (t.ascension_perks or t.inherited_perks):
            continue
        audit.append({
            "techId": tid,
            "name": t.name or tid,
            "perks": {p: ("manual" if p in manual.get(tid, [])
                          else t.perk_reasons.get(p, "?"))
                      for p in t.ascension_perks + t.inherited_perks},
            "weightZero": weight_is_zero(td_bodies[tid], vars_),
            "source": f"common/technology/{t.raw.source_file}#L{t.raw.line}",
        })
    (out_dir / "perk-audit.json").write_text(
        json.dumps(audit, indent=1, ensure_ascii=False) + "\n",
        encoding="utf-8")

    model = to_json_model(graph, categories, meta)

    n = len(graph.techs)
    if n < TECH_COUNT_FLOOR:
        raise SystemExit(
            f"BUILD FAILED: {n} technologies < floor {TECH_COUNT_FLOOR}")

    dataset = f"{mod_id}-{commit[:12]}.json" if commit != "unknown" \
        else f"{mod_id}.json"
    (out_dir / dataset).write_text(
        json.dumps(model, sort_keys=True, separators=(",", ":"),
                   ensure_ascii=False) + "\n",
        encoding="utf-8")

    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "datasets": [{
            "id": mod_id, "label": mod_label,
            "file": dataset, "commit": commit,
            "technologies": n,
        }],
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, sort_keys=True, indent=1) + "\n",
        encoding="utf-8")

    if icons_out is not None:
        from tools.icons import convert_icons
        # Gigastructures defines several of its own ascension perks
        # (Celestial Printing, Gigastructural Constructs, QSO, Supermassive
        # EHOF, Vast Expanses), so their icons come from the mod, not the
        # game — the vanilla extractor cannot supply them.
        ap_src = mod_dir / "gfx" / "interface" / "icons" / "ascension_perks"
        if ap_src.is_dir():
            convert_icons(ap_src, icons_out,
                          icons_out / "mod-ap-atlas.png",
                          icons_out / "mod-ap-atlas.json",
                          only=set(needed))
        icon_src = mod_dir / "gfx" / "interface" / "icons" / "technologies"
        if icon_src.is_dir():
            r = convert_icons(icon_src, icons_out,
                              icons_out / "atlas.png",
                              icons_out / "atlas.json")
            model["meta"]["iconWarnings"] = r.warnings

    # Atlas always covers every PNG present (mod + any vanilla icons the
    # maintainer added), since the canvas renderer draws from it alone.
    if icons_out is not None and icons_out.is_dir():
        from tools.icons import build_atlas_from_pngs
        build_atlas_from_pngs(icons_out, icons_out / "atlas.png",
                              icons_out / "atlas.json")

    return model


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mod-dir", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=Path("data"))
    ap.add_argument("--icons-out", type=Path, default=Path("assets/icons"))
    ap.add_argument("--commit", default="unknown")
    ap.add_argument("--skip-icons", action="store_true")
    ap.add_argument("--vanilla", type=Path, default=None,
                    help="vanilla-structural.json for variable fallback")
    args = ap.parse_args()

    model = build(args.mod_dir, args.out,
                  None if args.skip_icons else args.icons_out,
                  commit=args.commit, vanilla_path=args.vanilla)
    h = model["health"]
    print(f"technologies : {len(model['technologies'])}")
    print(f"dangling     : {len(h['dangling'])}")
    print(f"cycles       : {len(h['cycles'])}")
    print(f"tier inv.    : {len(h['tierInversions'])}")
    print(f"missing loc  : {len(h['missingLoc'])}")
    print(f"warnings     : {len(h['warnings'])}")
    print(f"perk-marked  : {len([t for t in model['technologies'] if t['ascensionPerks'] or t['inheritedPerks']])}"
          f"  (see data/perk-audit.json)")


if __name__ == "__main__":
    main()
