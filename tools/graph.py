"""Technology graph construction and validation (spec §4).

Consumes merged :class:`~tools.merge.TechDef` entries, produces the JSON data
model plus the QA signals that make this a mod-development instrument:
dangling prerequisites, cycles, tier inversions, missing localisation, and
cross-mod gating (the ACOT-placeholder pattern).
"""
from __future__ import annotations

import re
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

#: Supplying another mod's variables (data/external-techs.json) changes where
#: the winning definition comes from, but the technology still needs that mod.
EXTERNAL_VAR_FILE = "external-techs.json"

#: Techs matching these id prefixes are grouped into a synthetic category,
#: overriding the category declared in script. Used for content lines that
#: are thematically one thing but scattered across research areas.
#: Friendly names for non-perk requirements that appear as alternatives.
#: Extend via data/manual-perk-grants.json ("conditionLabels").
#: `prereqfor_desc` customs whose title is a decorative tooltip heading
#: rather than something the technology grants. Gigastructures uses these to
#: classify a megastructure's scale (header_01_gigac, header_02_tetra); their
#: localised text is a technology-sounding phrase, so treating them as grants
#: makes a technology look like it grants its own prerequisite.
_IS_TOOLTIP_HEADER = re.compile(r"^(?:[a-z0-9]+_)*header_", re.I)

CONDITION_LABELS: dict = {
    "has_genetically_ascended": "Genetic Ascension",
    "is_machine_empire": "a machine empire",
    "has_psionic_ascension": "Psionic Ascension",
    "has_cybernetic_ascension": "Cybernetic Ascension",
    "is_hive_empire": "a hive mind",
}

SYNTHETIC_CATEGORIES = (
    ("giga_tech_eawaf_", "sirenalia"),
)


def _collect_perk_groups(block: Block, groups: list,
                         triggers: Optional[dict] = None,
                         inside_or: bool = False,
                         flags: Optional[dict] = None) -> None:
    """Ascension perk requirements as *alternative groups*.

    `OR = { has_ascension_perk = ap_a  has_ascension_perk = ap_b }` is one
    requirement satisfied either way, not two requirements — Gargantuan
    Cloning Facilities needs Genetic Ascension *or* Mechromancy depending on
    the empire. Each group is a list of interchangeable perks; separate
    groups must all be satisfied.
    """
    triggers = triggers or {}
    flags = flags or {}
    local: list = []
    techs: list = []     # technologies named as an alternative route
    conds: list = []     # non-perk alternatives seen at this level
    for p in block.pairs():
        if p.key == "has_ascension_perk" and isinstance(p.value, str):
            local.append(p.value)
        elif p.key == "has_technology" and isinstance(p.value, str):
            techs.append(p.value)
        elif p.key in triggers and p.value == "yes" and triggers[p.key]:
            local.append(triggers[p.key])
        elif p.key == "has_country_flag" and isinstance(p.value, str) \
                and p.value in flags:
            # The flag is only obtainable from a perk, so it is that perk.
            for perk in flags[p.value]:
                if perk not in local:
                    local.append(perk)
        elif isinstance(p.value, Block) and p.key not in ("NOT", "NOR"):
            if p.key in ("OR", "or"):
                sub: list = []
                _collect_perk_groups(p.value, sub, triggers,
                                     inside_or=True, flags=flags)
                perks = [x for grp in sub for x in grp["perks"]]
                # An OR may offer routes that are not perks at all — The Vat
                # accepts genetic ascension, a tradition, or Mechromancy. The
                # perk is then one option among several, not a requirement.
                sub_conds = [c for grp in sub for c in grp["conditions"]]
                sub_conds += _non_perk_options(p.value, triggers)
                if perks or sub_conds:
                    groups.append({
                        "perks": sorted(set(perks), key=perks.index),
                        "conditions": sorted(set(sub_conds),
                                             key=sub_conds.index),
                    })
            else:
                _collect_perk_groups(p.value, groups, triggers, inside_or,
                                     flags)
        elif inside_or and p.key not in _NOT_AN_OPTION \
                and not isinstance(p.value, Block):
            # Store what a player would call it, not the script key.
            label = _condition_label(p.key, p.value)
            if label not in conds:
                conds.append(label)
    if local:
        if inside_or:
            groups.append({"perks": local, "conditions": conds, "techs": techs})
        else:
            for perk in local:
                groups.append({"perks": [perk], "conditions": [], "techs": techs})
    elif inside_or and conds and not groups:
        groups.append({"perks": [], "conditions": conds, "techs": techs})


#: Conditions that appear as alternatives to an ascension perk, mapped to
#: what a player would call them. Anything unlisted keeps a prettified form
#: of its script name, so a new condition is readable rather than invisible.
#: technology id -> display name, for conditions that name a technology.
#: Filled by build_graph once localisation is available.
_TECH_NAMES: dict = {}

CONDITION_LABELS = {
    "is_wilderness_empire": "Wilderness empire",
    "is_nomadic": "Nomadic empire",
    "country_uses_bio_ships": "Bio-ships",
    "giga_can_use_habitables": "Habitable megastructures enabled",
    "has_genetically_ascended": "Genetic Ascension",
    "has_psionically_ascended": "Psionic Ascension",
    "has_cybernetically_ascended": "Cybernetic Ascension",
    "has_synthetically_ascended": "Synthetic Ascension",
    "is_machine_empire": "Machine Intelligence",
    "is_hive_empire": "Hive Mind",
}

#: Keys that qualify a requirement rather than offering an alternative
#: route; they must never be listed as a way to obtain a technology.
#: conditions that say nothing a reader can act on
_NOISE = {"has_global_flag", "count", "always", "hidden_trigger",
          "num_owned_planets", "years_passed"}

_NOT_AN_OPTION = {"NOT", "NOR", "AND", "hidden_trigger", "has_global_flag",
                  "uses_district_set", "any_owned_planet",
                  "has_valid_civic", "always",
                  # A finished tradition tree is the same route as the
                  # ascension it completes; listing both says it twice.
                  "has_active_tradition"}


def _condition_label(key: str, value) -> str:
    # Value-aware first: "has_country_flag = blokkat_bureau_unlocked" should
    # say what the flag means, not just that a flag is involved.
    if isinstance(value, str):
        keyed = f"{key}:{value}"
        if keyed in CONDITION_LABELS:
            return CONDITION_LABELS[keyed]
    if key in CONDITION_LABELS:
        return CONDITION_LABELS[key]
    if key == "has_country_flag" and isinstance(value, str):
        return value.replace("_", " ").strip().capitalize()
    if key == "has_crisis_level" and isinstance(value, str):
        return (value.replace("crisis_", "").replace("_", " ")
                .strip().capitalize())
    if key == "has_technology" and isinstance(value, str):
        return _TECH_NAMES.get(value) or value
    if key == "has_active_tradition" and isinstance(value, str):
        stem = value.replace("tr_", "").split("_")[0]
        return f"{stem.capitalize()} tradition"
    pretty = key.replace("has_", "").replace("is_", "").replace("_", " ")
    return pretty.strip().capitalize()


def _non_perk_options(block: Block, triggers: dict) -> list:
    """Alternatives inside an OR that are not ascension perks, named as a
    player would say them ("Genetic Ascension"), so the requirement can be
    stated exactly instead of as "another qualifying condition".

    Keys that qualify a requirement rather than offering a route out of it
    (flags, prerequisite technologies, planet checks) are not alternatives
    and are skipped.
    """
    out = []
    for p in block.pairs():
        if p.key == "has_ascension_perk" or p.key in _NOT_AN_OPTION:
            continue
        if p.key in triggers and p.value == "yes":
            continue
        if isinstance(p.value, Block):
            continue
        label = _condition_label(p.key, p.value)
        if label and label not in out:
            out.append(label)
    return out


def _collect_ascension_perks(block: Block, out: list,
                             triggers: Optional[dict] = None) -> None:
    """Ascension perks required anywhere inside a `potential` block.

    Two forms occur: `has_ascension_perk = ap_x` directly, and scripted
    triggers that wrap one — Gigastructures gates most of its content on
    `has_galactic_wonders = yes` and `has_gigastructural_constructs = yes`,
    which resolve to `ap_galactic_wonders` and `ap_gigastructural_constructs`
    (plus the legacy DLC variants, which name the same perk).

    `NOT`/`NOR` groups are skipped: those gate a technology *out*.
    """
    triggers = triggers or {}
    for p in block.pairs():
        if p.key == "has_ascension_perk" and isinstance(p.value, str):
            if p.value not in out:
                out.append(p.value)
        elif p.key in triggers and p.value == "yes":
            perk = triggers[p.key]
            if perk and perk not in out:
                out.append(perk)
        elif isinstance(p.value, Block) and p.key not in ("NOT", "NOR"):
            _collect_ascension_perks(p.value, out, triggers)


def load_ascension_triggers(mod_dir) -> dict:
    """Map scripted-trigger name -> the ascension perk it requires.

    Only triggers whose whole purpose is an ascension-perk check are useful
    here; the first perk named wins, since the alternatives in these triggers
    are legacy DLC variants of the same perk.
    """
    from pathlib import Path
    from .pdx.parser import parse_bytes, ParseError
    from .pdx.lexer import LexError

    out: dict = {}
    d = Path(mod_dir) / "common" / "scripted_triggers"
    if not d.is_dir():
        return out
    for f in sorted(d.glob("*.txt")):
        try:
            ast = parse_bytes(f.read_bytes())
        except (ParseError, LexError):
            continue
        for p in ast.pairs():
            if not isinstance(p.value, Block):
                continue
            perks: list = []
            _collect_ascension_perks(p.value, perks)
            if perks:
                out[p.key] = perks[0]
    return out


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
    #: {"all": id} or {"any": [ids]} — an OR group needs only one member
    prerequisite_groups: list = field(default_factory=list)
    unlocks: list[str] = field(default_factory=list)
    unlock_text: list[str] = field(default_factory=list)
    weight_modifiers: list[dict] = field(default_factory=list)
    #: plain-word statements of what makes the technology available at all
    availability: list = field(default_factory=list)
    #: prerequisites some empires are exempt from
    conditional_prerequisites: list = field(default_factory=list)
    swaps: list[dict] = field(default_factory=list)
    gateway: Optional[str] = None
    icon: Optional[str] = None
    gated: bool = False  # has a non-trivial `potential` block
    ascension_perks: list[str] = field(default_factory=list)
    #: perks required only via a prerequisite, not by this tech's own script
    inherited_perks: list[str] = field(default_factory=list)
    #: perks that hand this technology to the player outright
    granted_by: list[str] = field(default_factory=list)
    #: perks that are one route among several — used for placement and for
    #: the "requires A or B" line, but never asserted as a hard requirement
    soft_perks: list[str] = field(default_factory=list)
    #: alternative requirement groups: each inner list is satisfied by any
    #: one of its perks; every group must be satisfied
    perk_groups: list = field(default_factory=list)
    #: why each perk is attached: perk id -> "potential" | "granted" |
    #: "via <tech id>". Written to data/perk-audit.json for review.
    perk_reasons: dict = field(default_factory=dict)
    cross_mod_gated: bool = False
    cross_mod_reason: Optional[str] = None
    #: short id of the mod required, from the placeholder variable's name
    cross_mod_id: Optional[str] = None


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


def _conditional_prereqs(pot: Block, triggers: dict) -> list:
    """Technologies required only by some empires.

    `potential = { OR = { is_nomadic = yes has_technology = X } }` means X is
    a prerequisite unless the empire is nomadic — Orbital Ecosystems does
    this so nomads, who cannot take the usual route, still reach it. That is
    a prerequisite with an exemption, not a perk requirement, and belongs in
    the prerequisite list rather than in a banner of its own.
    """
    out = []
    for p in pot.pairs():
        if p.key not in ("OR", "or") or not isinstance(p.value, Block):
            continue
        techs, others = [], []
        for q in p.value.pairs():
            if q.key == "has_technology" and isinstance(q.value, str):
                techs.append(q.value)
            elif q.key == "has_ascension_perk" or q.key in triggers:
                others = None
                break
            elif q.key not in _NOISE and not isinstance(q.value, Block):
                others.append(_condition_label(q.key, q.value))
        if others is None or not techs:
            continue
        for tid in techs:
            out.append({"tech": tid, "unless": others})
    return out


def _availability(body: Block) -> list:
    """What stops a technology coming up in research, in plain words.

    Some technologies have neither prerequisites nor a `potential` gate:
    they carry a weight modifier of zero unless a condition holds. The
    Nano-Assembler is weightless until the empire reaches cosmogenesis
    level 5, which is the only thing that makes it available.
    """
    out = []
    wm = body.get_last("weight_modifier")
    if not isinstance(wm, Block):
        return out
    for p in wm.pairs():
        if p.key != "modifier" or not isinstance(p.value, Block):
            continue
        factor = p.value.get_last("factor")
        if str(factor) not in ("0", "0.0"):
            continue
        rest = Block()
        rest.items = [i for i in p.value.items
                      if not (isinstance(i, Pair) and i.key == "factor")]
        # `factor = 0` under a NOT is a requirement stated backwards.
        negated = [i for i in rest.items
                   if isinstance(i, Pair) and i.key in ("NOT", "NOR")
                   and isinstance(i.value, Block)]
        if negated and len(rest.items) == len(negated):
            for n in negated:
                terms = _readable_conditions(n.value)
                if terms:
                    out.append(f"Only with {', '.join(terms)}")
        # The positive form ("weight zero while X") is nearly always an
        # internal detail — a flag, a count, another technology already
        # held — and says nothing useful about how to get the technology.
    return out


def _readable_conditions(block: Block) -> list:
    """A trigger as short readable phrases rather than script.

    `is_wilderness_empire = yes` becomes "Wilderness empire"; `= no` negates
    it. Used for technology swaps, where the trigger decides which variant
    an empire gets and is worth stating plainly.
    """
    out = []
    for p in block.pairs():
        if isinstance(p.value, Block):
            out.extend(_readable_conditions(p.value))
            continue
        if p.key in _NOISE:
            continue
        keyed = f"{p.key}:{p.value}"
        if keyed in CONDITION_LABELS:
            label = CONDITION_LABELS[keyed]
        else:
            label = _condition_label(p.key, p.value)
            if p.value == "no":
                label = f"Not: {label[0].lower()}{label[1:]}"
        if label and label not in out:
            out.append(label)
    return out


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


def weight_is_zero(body: Block, vars_: VarTable) -> bool:
    """True when a technology cannot come up in research on its own.

    Either `weight = 0`, or a `weight_modifier` that multiplies by zero
    unconditionally — written as a bare `factor = 0` directly inside the
    weight_modifier block, not as a conditional `modifier = { … }`. Ring
    World does exactly this: the perk hands it over and nothing else can.
    """
    w, _err, _src = _resolve_field(body.get_last("weight"), vars_, vars_)
    if isinstance(w, (int, float)) and w == 0:
        return True
    wm = body.get_last("weight_modifier")
    if isinstance(wm, Block):
        for p in wm.pairs():
            if p.key != "factor":
                continue
            f, _e, _s = _resolve_field(p.value, vars_, vars_)
            if isinstance(f, (int, float)) and f == 0:
                return True
    return False


def _ai_only(limit: Block) -> bool:
    """True when a branch applies to AI empires alone."""
    for p in limit.pairs():
        if p.key == "is_ai" and p.value == "yes":
            return True
        if isinstance(p.value, Block) and p.key in ("AND", "and"):
            if _ai_only(p.value):
                return True
    return False


def load_perk_flags(root) -> dict:
    """Map country flag -> perks that set it.

    A technology gated on `has_country_flag = can_spawn_smbh` needs whatever
    perk sets that flag, which is only visible from the perk's own effects.
    """
    from pathlib import Path
    from .pdx.parser import parse_bytes, ParseError
    from .pdx.lexer import LexError

    out: dict = {}
    d = Path(root) / "common" / "ascension_perks"
    if not d.is_dir():
        return out

    def collect(block: Block, flags: list) -> None:
        limit = block.get_last("limit")
        if isinstance(limit, Block) and _ai_only(limit):
            return
        for p in block.pairs():
            if p.key == "set_country_flag" and isinstance(p.value, str):
                if p.value not in flags:
                    flags.append(p.value)
            elif p.key == "set_country_flag" and isinstance(p.value, Block):
                f = p.value.get_last("flag")
                if isinstance(f, str) and f not in flags:
                    flags.append(f)
            elif isinstance(p.value, Block) and p.key != "limit":
                collect(p.value, flags)

    for f in sorted(d.glob("*.txt")):
        try:
            ast = parse_bytes(f.read_bytes())
        except (ParseError, LexError):
            continue
        for p in ast.pairs():
            if not isinstance(p.value, Block) or not p.key.startswith("ap_"):
                continue
            flags: list = []
            collect(p.value, flags)
            for flag in flags:
                out.setdefault(flag, [])
                if p.key not in out[flag]:
                    out[flag].append(p.key)
    return out


def load_perk_tech_grants(root) -> dict:
    """Map technology id -> perks that grant it.

    Some technologies are not gated by a `potential` block at all: they carry
    zero research weight and are handed to the player by an ascension perk
    (`add_research_option = tech_ring_world` inside the perk's effect). That
    is still an ascension perk requirement from a player's point of view, so
    it belongs on the card.
    """
    from pathlib import Path
    from .pdx.parser import parse_bytes, ParseError
    from .pdx.lexer import LexError

    out: dict = {}
    d = Path(root) / "common" / "ascension_perks"
    if not d.is_dir():
        return out

    def ai_only(limit: Block) -> bool:  # noqa: D401 - see _ai_only
        """True when a branch applies to the AI alone. Galactic Wonders
        hands Mega-Engineering to AI empires only:

            if = { limit = { is_ai = yes … } add_research_option = … }

        A human player never receives it, so it is not a requirement."""
        for p in limit.pairs():
            if p.key == "is_ai" and p.value == "yes":
                return True
            if isinstance(p.value, Block) and p.key in ("AND", "and"):
                if ai_only(p.value):
                    return True
        return False

    def collect(block: Block, techs: list) -> None:
        # An `if` block's grants are conditional on its own `limit`.
        limit = block.get_last("limit")
        if isinstance(limit, Block) and ai_only(limit):
            return
        for p in block.pairs():
            if p.key in ("add_research_option", "give_technology") and \
                    isinstance(p.value, str):
                if p.value not in techs:
                    techs.append(p.value)
            elif p.key == "give_technology" and isinstance(p.value, Block):
                t = p.value.get_last("tech")
                if isinstance(t, str) and t not in techs:
                    techs.append(t)
            elif isinstance(p.value, Block) and p.key != "limit":
                collect(p.value, techs)

    for f in sorted(d.glob("*.txt")):
        try:
            ast = parse_bytes(f.read_bytes())
        except (ParseError, LexError):
            continue
        for p in ast.pairs():
            if not isinstance(p.value, Block) or not p.key.startswith("ap_"):
                continue
            techs: list = []
            collect(p.value, techs)
            for tid in techs:
                out.setdefault(tid, [])
                if p.key not in out[tid]:
                    out[tid].append(p.key)
    return out


def build_graph(techdefs: dict[str, TechDef], vars_: VarTable,
                loc: LocTable, var_provenance: Optional[VarTable] = None,
                icon_stems: Optional[set] = None,
                categories: Optional[dict] = None,
                ascension_triggers: Optional[dict] = None,
                perk_grants: Optional[dict] = None,
                perk_flags: Optional[dict] = None) -> GraphResult:
    res = GraphResult()
    provenance = var_provenance or vars_
    _TECH_NAMES.clear()
    for _tid, _td in techdefs.items():
        _n = loc.name(_tid)
        if _n:
            _TECH_NAMES[_tid] = strip_markup(_n)

    icon_stems = icon_stems or set()
    categories = categories or {}
    ascension_triggers = ascension_triggers or {}
    perk_grants = perk_grants or {}
    perk_flags = perk_flags or {}

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
            before = list(t.ascension_perks)
            _collect_perk_groups(pot, t.perk_groups, ascension_triggers,
                                 flags=perk_flags)
            # Only a group with exactly one perk and no other route is a
            # requirement; anything else is an alternative and must not
            # propagate to dependent technologies.
            for grp in t.perk_groups:
                if len(grp["perks"]) > 1 or (grp["perks"] and grp["conditions"]):
                    for perk in grp["perks"]:
                        if perk not in t.soft_perks:
                            t.soft_perks.append(perk)
                if len(grp["perks"]) == 1 and not grp["conditions"]:
                    perk = grp["perks"][0]
                    if perk not in t.ascension_perks:
                        t.ascension_perks.append(perk)
                        t.perk_reasons[perk] = "potential"
        # A perk that hands a technology over is a genuine requirement: the
        # grants that are not player-facing (AI-only branches) are already
        # excluded when the perk files are read, so no weight test is needed
        # here — an earlier attempt to use one wrongly dropped Dyson Sphere
        # and Matter Decompressor.
        for perk in perk_grants.get(tid, []):
            if perk not in t.granted_by:
                t.granted_by.append(perk)
            if perk not in t.ascension_perks:
                t.ascension_perks.append(perk)
                t.perk_reasons[perk] = "granted"
            if not any(grp["perks"] == [perk] for grp in t.perk_groups):
                t.perk_groups.append({"perks": [perk], "conditions": []})

        t.prerequisites, t.prerequisite_groups = parse_prerequisites(
            b.get_last("prerequisites"))

        if isinstance(pot, Block):
            t.conditional_prerequisites = _conditional_prereqs(
                pot, ascension_triggers)
            for cp in t.conditional_prerequisites:
                # Counts for edges and ordering like any prerequisite.
                if cp["tech"] not in t.prerequisites:
                    t.prerequisites.append(cp["tech"])
                    t.prerequisite_groups.append(
                        {"all": cp["tech"], "unless": cp["unless"]})
            # Those groups described a prerequisite, not a perk requirement.
            t.perk_groups = [grp for grp in t.perk_groups if grp["perks"]]

        pfd = b.get_last("prereqfor_desc")
        if isinstance(pfd, Block):
            for custom in pfd.get_all("custom"):
                if isinstance(custom, Block):
                    title = _plain(custom.get_last("title"))
                    # `header_*` customs are decorative section headings in
                    # the game's tooltip ("Tetradimensional Engineering",
                    # "Gigastructural Constructs") that classify the scale of
                    # the megastructure. They are not things the technology
                    # grants, and reading them as such made a technology
                    # appear to grant its own prerequisite.
                    if title and not _IS_TOOLTIP_HEADER.match(title):
                        t.unlock_text.append(
                            strip_markup(loc.name(title) or title))

        t.availability = _availability(b)

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

        # Icon: explicit key -> id -> category -> None (viewer placeholder).
        t.icon = resolve_icon(tid, _plain(b.get_last("icon")),
                              icon_stems, categories, t.categories)

        for swap in b.get_all("technology_swap"):
            if isinstance(swap, Block):
                sname = _plain(swap.get_last("name"))
                trig = swap.get_last("trigger")
                t.swaps.append({
                    "name": sname,
                    "displayName": strip_markup(loc.name(sname) or sname or "?"),
                    "trigger": _cond_text(trig) if isinstance(trig, Block) else None,
                    "conditions": (_readable_conditions(trig)
                                   if isinstance(trig, Block) else []),
                    "desc": (strip_markup(loc.name(f"{sname}_desc") or "")
                             or None) if sname else None,
                    # A swap uses its own icon file when one exists, and
                    # otherwise the parent technology's — the mod ships an
                    # icon for the bio-ship ring world variant but not the
                    # other, and the game falls back the same way.
                    "icon": resolve_icon(
                        sname or "", _plain(swap.get_last("icon")),
                        icon_stems, categories, t.categories) or t.icon,
                    "inheritIcon": _as_bool(swap.get_last("inherit_icon")),
                })

        # Cross-mod gating: cost/weight variable won by the compat file.
        for src, fieldname in ((cost_src, "cost"), (weight_src, "weight")):
            if src and (CROSSMOD_VAR_FILE in src or EXTERNAL_VAR_FILE in src):
                t.cross_mod_gated = True
                t.cross_mod_reason = (
                    f"{fieldname} uses a cross-mod placeholder variable "
                    f"defined in {CROSSMOD_VAR_FILE}")
                # @acot_tier6cost2 -> "acot": which mod supplies the value.
                var = b.get_last(fieldname)
                if isinstance(var, VarRef):
                    t.cross_mod_id = var.name.split("_")[0]
                break

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

    # -- ascension perks inherited through prerequisites -------------------
    # A technology behind a Galactic Wonders tech is just as unreachable
    # without the perk, so the requirement propagates down the graph.
    order: list[str] = []
    seen: set = set()

    def visit(tid: str) -> None:
        if tid in seen:
            return
        seen.add(tid)
        t = res.techs.get(tid)
        if t:
            for pid in t.prerequisites:
                visit(pid)
        order.append(tid)

    for tid in sorted(res.techs):
        visit(tid)

    for tid in order:
        t = res.techs.get(tid)
        if not t:
            continue
        for pid in t.prerequisites:
            p = res.techs.get(pid)
            if not p:
                continue
            for perk in p.ascension_perks + p.inherited_perks:
                if perk not in t.ascension_perks and \
                        perk not in t.inherited_perks:
                    t.inherited_perks.append(perk)
                    t.perk_reasons.setdefault(perk, f"via {pid}")

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


def parse_prerequisites(block: Block) -> tuple:
    """Prerequisites as a flat list and as groups.

    Most are a plain list, but an `OR = { … }` group is satisfied by any one
    of its members — vanilla Titans need battleships *or* the bio-ship
    equivalent. Returning both keeps edges and ordering working off the flat
    list while the requirement can still be stated correctly.
    """
    flat: list = []
    groups: list = []
    if not isinstance(block, Block):
        return flat, groups

    for v in block.bare_values():
        tid = str(v)
        if tid not in flat:
            flat.append(tid)
        groups.append({"all": tid})

    for p in block.pairs():
        if p.key in ("OR", "or") and isinstance(p.value, Block):
            alts = [str(v) for v in p.value.bare_values()]
            for tid in alts:
                if tid not in flat:
                    flat.append(tid)
            if alts:
                groups.append({"any": alts})
        elif isinstance(p.value, Block):
            sub_flat, sub_groups = parse_prerequisites(p.value)
            for tid in sub_flat:
                if tid not in flat:
                    flat.append(tid)
            groups.extend(sub_groups)
    return flat, groups


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
            "prerequisiteGroups": t.prerequisite_groups,
            "unlocks": sorted(t.unlocks),
            "unlockText": t.unlock_text,
            "weightModifiers": t.weight_modifiers,
            "availability": t.availability,
            "conditionalPrerequisites": t.conditional_prerequisites,
            "swaps": t.swaps,
            "gateway": t.gateway,
            "icon": t.icon,
            "gated": t.gated,
            "ascensionPerks": t.ascension_perks,
            "inheritedPerks": t.inherited_perks,
            "grantedByPerks": t.granted_by,
            "perkReasons": t.perk_reasons,
            "perkGroups": t.perk_groups,
            "softPerks": t.soft_perks,
            "crossModGated": t.cross_mod_gated,
            "crossModReason": t.cross_mod_reason,
            "crossModId": t.cross_mod_id,
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
