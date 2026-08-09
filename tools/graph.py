"""Technology graph construction and validation (spec §4).

Consumes merged :class:`~tools.merge.TechDef` entries, produces the JSON data
model plus the QA signals that make this a mod-development instrument:
dangling prerequisites, cycles, tier inversions, missing localisation, and
cross-mod gating (the ACOT-placeholder pattern).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Union

from .icons import resolve_icon
from .loc import LocTable, strip_markup
from .merge import TechDef
from .pdx.parser import Block, MathExpr, Pair, Scalar, VarRef
from .pdx.values import VarTable, resolve

#: Variables whose winning definition file marks a tech as gated on another
#: mod being present (see docs/observed-grammar.md, compat pattern).
CROSSMOD_VAR_FILE = "zz_giga_compat_overwrite_me.txt"

#: Techs matching these id prefixes are grouped into a synthetic category,
#: overriding the category declared in script. Used for content lines that
#: are thematically one thing but scattered across research areas.
SYNTHETIC_CATEGORIES = (
    ("giga_tech_eawaf_", "sirenalia"),
)


def _collect_ascension_perks(block: Block, out: list) -> None:
    """Ascension perks named anywhere inside a `potential` block, including
    nested boolean groups. `NOT = { has_ascension_perk = x }` is skipped —
    that gates the tech *out*, not in."""
    for p in block.pairs():
        if p.key == "has_ascension_perk" and isinstance(p.value, str):
            if p.value not in out:
                out.append(p.value)
        elif isinstance(p.value, Block) and p.key not in ("NOT", "NOR"):
            _collect_ascension_perks(p.value, out)


@dataclass
class Tech:
    id: str
    raw: TechDef
    name: Optional[str] = None
    desc: Optional[str] = None
    area: Optional[str] = None
    categories: list[str] = field(default_factory=list)
    tier: Optional[int] = None
    cost: Optional[Union[int, float, str]] = None
    weight: Optional[Union[int, float, str]] = None
    levels: Optional[int] = None
    cost_per_level: Optional[Union[int, float, str]] = None
    is_start: bool = False
    is_rare: bool = False
    is_dangerous: bool = False
    is_repeatable: bool = False
    reverse_engineerable: bool = True
    prerequisites: list[str] = field(default_factory=list)
    unlocks: list[str] = field(default_factory=list)
    unlock_text: list[str] = field(default_factory=list)
    weight_modifiers: list[dict] = field(default_factory=list)
    swaps: list[dict] = field(default_factory=list)
    gateway: Optional[str] = None
    icon: Optional[str] = None
    gated: bool = False  # has a non-trivial `potential` block
    ascension_perks: list[str] = field(default_factory=list)
    cross_mod_gated: bool = False
    cross_mod_reason: Optional[str] = None


@dataclass
class GraphResult:
    techs: dict[str, Tech] = field(default_factory=dict)
    warnings: list[dict] = field(default_factory=list)
    #: QA lists, each entry {techId, detail, file, line}
    dangling: list[dict] = field(default_factory=list)
    cycles: list[list[str]] = field(default_factory=list)
    tier_inversions: list[dict] = field(default_factory=list)
    missing_loc: list[dict] = field(default_factory=list)


def _as_bool(v: Optional[Scalar]) -> Optional[bool]:
    if v == "yes":
        return True
    if v == "no":
        return False
    return None


def _as_int(v) -> Optional[int]:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _cond_text(block: Block) -> str:
    """Compact human-readable rendering of a trigger/condition block."""
    parts: list[str] = []
    for item in block:
        if isinstance(item, Pair):
            if isinstance(item.value, Block):
                parts.append(f"{item.key} {item.op} {{ {_cond_text(item.value)} }}")
            else:
                parts.append(f"{item.key} {item.op} {item.value}")
        else:
            parts.append(str(item))
    return " ".join(parts)


def build_graph(techdefs: dict[str, TechDef], vars_: VarTable,
                loc: LocTable, var_provenance: Optional[VarTable] = None,
                icon_stems: Optional[set] = None,
                categories: Optional[dict] = None) -> GraphResult:
    res = GraphResult()
    provenance = var_provenance or vars_
    icon_stems = icon_stems or set()
    categories = categories or {}

    # -- extraction ------------------------------------------------------
    for tid, td in techdefs.items():
        b = td.body
        t = Tech(id=tid, raw=td)

        t.area = _plain(b.get_last("area"))
        cat = b.get_last("category")
        if isinstance(cat, Block):
            t.categories = [str(v) for v in cat.bare_values()]
        elif cat is not None:
            t.categories = [str(cat)]
        for prefix, synthetic in SYNTHETIC_CATEGORIES:
            if tid.startswith(prefix):
                t.categories = [synthetic]
                break
        tier_v, tier_err, _ = _resolve_field(b.get_last("tier"), vars_,
                                             provenance)
        t.tier = int(tier_v) if isinstance(tier_v, (int, float)) else None
        if tier_err:
            res.warnings.append({
                "kind": "unresolved-variable", "techId": tid,
                "field": "tier", "file": td.source_file,
                "line": td.line, "message": tier_err,
            })

        t.cost, cost_err, cost_src = _resolve_field(b.get_last("cost"), vars_, provenance)
        t.weight, weight_err, weight_src = _resolve_field(b.get_last("weight"), vars_, provenance)
        for err, fieldname in ((cost_err, "cost"), (weight_err, "weight")):
            if err:
                res.warnings.append({
                    "kind": "unresolved-variable", "techId": tid,
                    "field": fieldname, "file": td.source_file,
                    "line": td.line, "message": err,
                })

        lv, _lerr, _ = _resolve_field(b.get_last("levels"), vars_, provenance)
        t.levels = int(lv) if isinstance(lv, (int, float)) else None
        t.is_repeatable = t.levels is not None and t.levels != 0
        t.cost_per_level, _, _ = _resolve_field(b.get_last("cost_per_level"),
                                                vars_, provenance)
        t.is_start = _as_bool(b.get_last("is_start_tech")) or False
        t.is_rare = _as_bool(b.get_last("is_rare")) or False
        t.is_dangerous = _as_bool(b.get_last("is_dangerous")) or False
        rev = _as_bool(b.get_last("is_reverse_engineerable"))
        t.reverse_engineerable = True if rev is None else rev
        t.gateway = _plain(b.get_last("gateway"))
        pot = b.get_last("potential")
        t.gated = isinstance(pot, Block) and len(pot) > 0
        if isinstance(pot, Block):
            _collect_ascension_perks(pot, t.ascension_perks)

        prereq = b.get_last("prerequisites")
        if isinstance(prereq, Block):
            t.prerequisites = [str(v) for v in prereq.bare_values()]

        pfd = b.get_last("prereqfor_desc")
        if isinstance(pfd, Block):
            for custom in pfd.get_all("custom"):
                if isinstance(custom, Block):
                    title = _plain(custom.get_last("title"))
                    if title:
                        t.unlock_text.append(
                            strip_markup(loc.name(title) or title))

        wm = b.get_last("weight_modifier")
        if isinstance(wm, Block):
            for item in wm.pairs():
                if item.key == "modifier" and isinstance(item.value, Block):
                    mb = item.value
                    factor, _, _ = _resolve_field(mb.get_last("factor"),
                                                  vars_, provenance)
                    conds = Block([i for i in mb.items
                                   if not (isinstance(i, Pair)
                                           and i.key == "factor")])
                    t.weight_modifiers.append({
                        "factor": factor, "conditions": _cond_text(conds),
                    })
                elif item.key == "inline_script":
                    script = (item.value if isinstance(item.value, str)
                              else _plain(item.value.get_last("script"))
                              if isinstance(item.value, Block) else None)
                    t.weight_modifiers.append({
                        "inlineScript": script or "?",
                        "conditions": None, "factor": None,
                    })

        for swap in b.get_all("technology_swap"):
            if isinstance(swap, Block):
                sname = _plain(swap.get_last("name"))
                trig = swap.get_last("trigger")
                t.swaps.append({
                    "name": sname,
                    "displayName": strip_markup(loc.name(sname) or sname or "?"),
                    "trigger": _cond_text(trig) if isinstance(trig, Block) else None,
                    "inheritIcon": _as_bool(swap.get_last("inherit_icon")),
                })

        # Cross-mod gating: cost/weight variable won by the compat file.
        for src, fieldname in ((cost_src, "cost"), (weight_src, "weight")):
            if src and CROSSMOD_VAR_FILE in src:
                t.cross_mod_gated = True
                t.cross_mod_reason = (
                    f"{fieldname} uses a cross-mod placeholder variable "
                    f"defined in {CROSSMOD_VAR_FILE}")
                break

        # Icon: explicit key -> id -> category -> None (viewer placeholder).
        t.icon = resolve_icon(tid, _plain(b.get_last("icon")),
                              icon_stems, categories, t.categories)

        # Localisation. Names/descs are stored markup-free: colour keys are
        # visual clutter on cards (user decision), icon tokens unrenderable.
        raw_name = loc.name(tid)
        t.name = strip_markup(raw_name) if raw_name else None
        raw_desc = loc.name(f"{tid}_desc")
        t.desc = strip_markup(raw_desc) if raw_desc else None
        if t.name is None:
            res.missing_loc.append({"techId": tid, "key": tid,
                                    "file": td.source_file, "line": td.line})
        if t.desc is None:
            res.missing_loc.append({"techId": tid, "key": f"{tid}_desc",
                                    "file": td.source_file, "line": td.line})

        res.techs[tid] = t

    # -- reverse edges + dangling ---------------------------------------
    for t in res.techs.values():
        for pid in t.prerequisites:
            if pid in res.techs:
                res.techs[pid].unlocks.append(t.id)
            else:
                res.dangling.append({
                    "techId": t.id, "missing": pid,
                    "file": t.raw.source_file, "line": t.raw.line,
                })

    # -- cycles (iterative DFS, deterministic order) ---------------------
    WHITE, GREY, BLACK = 0, 1, 2
    colour = {tid: WHITE for tid in res.techs}
    for start in sorted(res.techs):
        if colour[start] != WHITE:
            continue
        stack: list[tuple[str, int]] = [(start, 0)]
        path: list[str] = []
        while stack:
            node, idx = stack.pop()
            if idx == 0:
                colour[node] = GREY
                path.append(node)
            kids = [p for p in sorted(res.techs[node].prerequisites)
                    if p in res.techs]
            if idx < len(kids):
                stack.append((node, idx + 1))
                kid = kids[idx]
                if colour[kid] == GREY:
                    cyc = path[path.index(kid):] + [kid]
                    if cyc not in res.cycles:
                        res.cycles.append(cyc)
                elif colour[kid] == WHITE:
                    stack.append((kid, 0))
            else:
                colour[node] = BLACK
                path.pop()

    # -- tier inversions --------------------------------------------------
    for t in res.techs.values():
        if t.tier is None:
            continue
        for pid in t.prerequisites:
            p = res.techs.get(pid)
            if p and p.tier is not None and p.tier > t.tier:
                res.tier_inversions.append({
                    "techId": t.id, "tier": t.tier,
                    "prereq": pid, "prereqTier": p.tier,
                    "file": t.raw.source_file, "line": t.raw.line,
                })
    return res


def _plain(v) -> Optional[str]:
    if v is None or isinstance(v, Block):
        return None
    return str(v) if not isinstance(v, str) else v


def _resolve_field(v, vars_: VarTable, provenance: VarTable
                   ) -> tuple[Optional[Union[int, float, str]],
                              Optional[str], Optional[str]]:
    """Resolve a scalar field. Returns (value, error, winning_def_file)."""
    if v is None or isinstance(v, Block):
        return None, None, None
    src = None
    if isinstance(v, VarRef):
        hit = provenance.lookup(v.name)
        src = hit.source_file if hit else None
    out, err = resolve(v, vars_)
    if isinstance(out, (VarRef, MathExpr)):
        return str(out), err, src
    return out, err, src


# -- JSON emission ----------------------------------------------------------

def to_json_model(res: GraphResult, categories: dict, meta: dict) -> dict:
    techs = []
    for tid in sorted(res.techs):
        t = res.techs[tid]
        techs.append({
            "id": t.id,
            "name": t.name if t.name is not None else t.id,
            "nameMissing": t.name is None,
            "desc": t.desc,
            "area": t.area,
            "categories": t.categories,
            "tier": t.tier,
            "cost": t.cost,
            "costPerLevel": t.cost_per_level,
            "levels": t.levels,
            "weight": t.weight,
            "isStart": t.is_start,
            "isRare": t.is_rare,
            "isDangerous": t.is_dangerous,
            "isRepeatable": t.is_repeatable,
            "reverseEngineerable": t.reverse_engineerable,
            "prerequisites": t.prerequisites,
            "unlocks": sorted(t.unlocks),
            "unlockText": t.unlock_text,
            "weightModifiers": t.weight_modifiers,
            "swaps": t.swaps,
            "gateway": t.gateway,
            "icon": t.icon,
            "gated": t.gated,
            "ascensionPerks": t.ascension_perks,
            "crossModGated": t.cross_mod_gated,
            "crossModReason": t.cross_mod_reason,
            "source": t.raw.source_id,
            "overridesVanilla": t.raw.overrides_earlier_source,
            "sourceFile": f"common/technology/{t.raw.source_file}#L{t.raw.line}",
        })
    return {
        "meta": meta,
        "categories": categories,
        "technologies": techs,
        "health": {
            "dangling": sorted(res.dangling,
                               key=lambda d: (d["techId"], d["missing"])),
            "cycles": res.cycles,
            "tierInversions": sorted(res.tier_inversions,
                                     key=lambda d: d["techId"]),
            "missingLoc": sorted(res.missing_loc,
                                 key=lambda d: (d["techId"], d["key"])),
            "warnings": res.warnings,
        },
    }
