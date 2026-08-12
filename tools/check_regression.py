#!/usr/bin/env python3
"""Compare a freshly built dataset against the one already committed.

The build's only automated guard is a technology-count floor, which catches a
catastrophic parse failure and nothing else. Every real regression this repo
has hit was a *shape* change at a normal technology count: an upstream script
refactor moved a gate behind a scripted trigger the build could not see, and
24 technologies quietly lost their ascension perk while the count stayed at
301. The floor did not move; the deploy went red days later, on the far side
of a commit that had already been pushed.

This compares like for like and fails the refresh *before* bad data is
committed, which is the only point where the fix is cheap.

Usage:
    python tools/check_regression.py --old OLD.json --new NEW.json \
        [--vanilla data/vanilla-structural.json] [--json-summary out.json]

Exit codes:
    0  no regression (or old dataset absent — first build)
    1  regression detected
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# A perk losing this fraction of its technologies is treated as a regression.
# Set well below 1.0 so a partial breakage trips it too: the Gigastructural
# Constructs failure was total, but a scripted trigger that only some
# technologies use would show up as a partial drop.
PERK_DROP_RATIO = 0.5
# Total technology count is allowed to drift down by this much; mods do remove
# technologies, so this is looser than the perk check.
TECH_DROP_RATIO = 0.10


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def perk_sets(model: dict) -> dict[str, set[str]]:
    """technology id -> every perk that gates or grants it.

    Mirrors gateRank() in js/layout.js: soft perks count, because a
    technology reachable only through a perk is gated from the reader's
    point of view even when an alternative route exists.
    """
    out: dict[str, set[str]] = {}
    grants = (model.get("meta") or {}).get("perkGrants") or {}
    for t in model["technologies"]:
        perks = set(t.get("ascensionPerks") or [])
        perks |= set(t.get("inheritedPerks") or [])
        perks |= set(t.get("softPerks") or [])
        perks |= set(grants.get(t["id"]) or [])
        out[t["id"]] = perks
    return out


def perk_counts(sets: dict[str, set[str]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for perks in sets.values():
        for p in perks:
            counts[p] = counts.get(p, 0) + 1
    return counts


def classify_dangling(model: dict, vanilla_ids: set[str]) -> dict:
    """Split the dangling list into noise and genuine unknowns.

    The build resolves only mod files; vanilla technologies are composed in
    by the browser at load time. So most dangling references are references
    to vanilla that will resolve fine, and the raw count (130 at the time of
    writing, of which 0 were real) tells a maintainer nothing. Reporting only
    the unknowns makes the number actionable.
    """
    meta = model.get("meta") or {}
    external = set(meta.get("externalTechs") or [])
    unknown, via_vanilla, via_external = [], 0, 0
    for d in (model.get("health") or {}).get("dangling") or []:
        missing = d.get("missing")
        if missing in vanilla_ids:
            via_vanilla += 1
        elif missing in external:
            via_external += 1
        else:
            unknown.append(d)
    return {"viaVanilla": via_vanilla, "viaExternal": via_external,
            "unknown": unknown}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--old", type=Path, help="previously committed dataset")
    ap.add_argument("--new", type=Path, required=True)
    ap.add_argument("--vanilla", type=Path)
    ap.add_argument("--json-summary", type=Path)
    args = ap.parse_args()

    new = load(args.new)
    problems: list[str] = []
    notes: list[str] = []

    vanilla_ids: set[str] = set()
    if args.vanilla and args.vanilla.is_file():
        vanilla_ids = {t["id"] for t in load(args.vanilla)["technologies"]}

    new_sets = perk_sets(new)
    new_perks = perk_counts(new_sets)

    dang = classify_dangling(new, vanilla_ids)
    if dang["unknown"]:
        for d in dang["unknown"][:10]:
            problems.append(
                f"unknown prerequisite {d.get('missing')} "
                f"(referenced by {d.get('techId')} at "
                f"{d.get('file')}:{d.get('line')})")
    notes.append(
        f"dangling: {len(dang['unknown'])} unknown "
        f"({dang['viaVanilla']} resolve via vanilla, "
        f"{dang['viaExternal']} known external)")

    if not args.old or not args.old.is_file():
        print("No previous dataset to compare against — first build.")
        for n in notes:
            print(f"  {n}")
        _emit(args, new_perks, notes, problems)
        return 1 if problems else 0

    old = load(args.old)
    old_sets = perk_sets(old)
    old_perks = perk_counts(old_sets)

    n_old, n_new = len(old["technologies"]), len(new["technologies"])
    notes.append(f"technologies: {n_old} -> {n_new}")
    if n_old and n_new < n_old * (1 - TECH_DROP_RATIO):
        problems.append(
            f"technology count fell {n_old} -> {n_new} "
            f"(more than {TECH_DROP_RATIO:.0%})")

    for perk, was in sorted(old_perks.items()):
        now = new_perks.get(perk, 0)
        if now == was:
            continue
        arrow = f"{perk}: {was} -> {now}"
        if now == 0:
            problems.append(f"{arrow}  (perk vanished entirely)")
        elif now < was * (1 - PERK_DROP_RATIO):
            problems.append(f"{arrow}  (lost more than "
                            f"{PERK_DROP_RATIO:.0%})")
        else:
            notes.append(arrow)

    for perk in sorted(set(new_perks) - set(old_perks)):
        notes.append(f"{perk}: new, {new_perks[perk]} technologies")

    # A technology that keeps its place but silently loses every requirement
    # is the exact shape of the Ring World and Gigastructural Constructs
    # failures, and no aggregate count catches it.
    lost = [tid for tid, perks in old_sets.items()
            if perks and not new_sets.get(tid, set()) and tid in new_sets]
    if lost:
        problems.append(
            f"{len(lost)} technologies lost every ascension-perk "
            f"requirement, e.g. {', '.join(sorted(lost)[:5])}")

    print("=== dataset regression check ===")
    for n in notes:
        print(f"  {n}")
    if problems:
        print("\nREGRESSIONS:")
        for p in problems:
            print(f"  ! {p}")
        print("\nIf this is an intended upstream change, re-run with the "
              "expectation updated, or adjust data/manual-perk-grants.json.")
    else:
        print("  no regressions")

    _emit(args, new_perks, notes, problems)
    return 1 if problems else 0


def _emit(args, new_perks, notes, problems) -> None:
    if not args.json_summary:
        return
    args.json_summary.write_text(json.dumps(
        {"perkCounts": new_perks, "notes": notes, "problems": problems},
        indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
