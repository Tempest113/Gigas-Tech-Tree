"""Tests for tools/merge.py and tools/graph.py."""
from tools.graph import build_graph, to_json_model
from tools.loc import LocTable
from tools.merge import Source, merge_sources
from tools.pdx.values import VarTable


def loc_of(text: bytes) -> LocTable:
    t = LocTable()
    t.load_file(b"l_english:\n" + text, "test.yml")
    return t


def build(sources, loc=None, vars_=None):
    merged = merge_sources(sources)
    return merged, build_graph(merged.techs, vars_ or VarTable(),
                               loc or LocTable())


# -- merge: same-ID override ------------------------------------------------

def test_same_id_later_file_wins_and_marks_override():
    vanilla = Source("vanilla", "Vanilla")
    vanilla.add("00_soc.txt", b"tech_a = { tier = 1 cost = 100 }")
    mod = Source("gigas", "Gigas")
    mod.add("zz_overwrites.txt", b"tech_a = { tier = 2 cost = 999 }")
    merged = merge_sources([vanilla, mod])
    td = merged.techs["tech_a"]
    assert td.source_id == "gigas"
    assert td.overrides_earlier_source is True
    assert td.body.get("tier") == "2"


def test_same_id_within_one_source_no_override_flag():
    mod = Source("gigas", "Gigas")
    mod.add("a.txt", b"tech_x = { tier = 1 }")
    mod.add("zz.txt", b"tech_x = { tier = 2 }")
    merged = merge_sources([mod])
    assert merged.techs["tech_x"].body.get("tier") == "2"
    assert merged.techs["tech_x"].overrides_earlier_source is False


# -- merge: whole-file replacement ------------------------------------------

def test_file_replacement_warns_and_names_deleted_techs():
    vanilla = Source("vanilla", "Vanilla")
    vanilla.add("00_phys.txt", b"tech_gone = { tier = 1 }\ntech_also = { tier = 1 }")
    mod = Source("gigas", "Gigas")
    mod.add("00_phys.txt", b"tech_new = { tier = 1 }")
    merged = merge_sources([vanilla, mod])
    assert "tech_gone" not in merged.techs
    assert "tech_new" in merged.techs
    w = [w for w in merged.warnings if w["kind"] == "file-replacement"]
    assert len(w) == 1
    assert set(w[0]["deleted_techs"]) == {"tech_gone", "tech_also"}


def test_alphabetical_file_order_within_source():
    mod = Source("gigas", "Gigas")
    mod.add("zz_late.txt", b"tech_x = { tier = 9 }")
    mod.add("aa_early.txt", b"tech_x = { tier = 1 }")
    merged = merge_sources([mod])
    assert merged.techs["tech_x"].body.get("tier") == "9"


def test_parse_error_tolerated_per_file():
    mod = Source("gigas", "Gigas")
    mod.add("bad.txt", b"tech_broken = { tier = 1 ")  # unclosed
    mod.add("good.txt", b"tech_ok = { tier = 1 }")
    merged = merge_sources([mod])
    assert "tech_ok" in merged.techs
    assert len(merged.parse_errors) == 1
    assert merged.parse_errors[0]["file"] == "bad.txt"


# -- graph ------------------------------------------------------------------

def test_reverse_edges_and_dangling():
    mod = Source("gigas", "Gigas")
    mod.add("a.txt",
            b"tech_a = { tier = 1 }\n"
            b"tech_b = { tier = 2 prerequisites = { tech_a tech_vanilla } }")
    _, g = build([mod])
    assert g.techs["tech_a"].unlocks == ["tech_b"]
    assert len(g.dangling) == 1
    assert g.dangling[0]["missing"] == "tech_vanilla"


def test_cycle_detection():
    mod = Source("gigas", "Gigas")
    mod.add("a.txt",
            b"tech_a = { prerequisites = { tech_b } }\n"
            b"tech_b = { prerequisites = { tech_a } }")
    _, g = build([mod])
    assert len(g.cycles) == 1
    assert set(g.cycles[0]) == {"tech_a", "tech_b"}


def test_tier_inversion_flagged():
    mod = Source("gigas", "Gigas")
    mod.add("a.txt",
            b"tech_hi = { tier = 5 }\n"
            b"tech_lo = { tier = 3 prerequisites = { tech_hi } }")
    _, g = build([mod])
    assert len(g.tier_inversions) == 1
    inv = g.tier_inversions[0]
    assert (inv["techId"], inv["prereq"]) == ("tech_lo", "tech_hi")


def test_cross_mod_gating_via_compat_file():
    vars_ = VarTable()
    vars_.define("acot_tier6cost2", 0, "zz_giga_compat_overwrite_me.txt")
    mod = Source("gigas", "Gigas")
    mod.add("a.txt", b"tech_acot = { cost = @acot_tier6cost2 tier = 6 }\n"
                     b"tech_norm = { cost = 100 tier = 1 }")
    _, g = build([mod], vars_=vars_)
    assert g.techs["tech_acot"].cross_mod_gated is True
    assert g.techs["tech_norm"].cross_mod_gated is False


def test_unresolved_var_stays_symbolic_in_output():
    mod = Source("gigas", "Gigas")
    mod.add("a.txt", b"tech_v = { cost = @tier5cost2 tier = 5 }")
    _, g = build([mod])
    assert g.techs["tech_v"].cost == "@tier5cost2"
    assert any(w["kind"] == "unresolved-variable" for w in g.warnings)


def test_repeatable_levels():
    mod = Source("gigas", "Gigas")
    mod.add("a.txt", b"tech_r = { levels = -1 cost_per_level = 500 tier = 5 }")
    _, g = build([mod])
    t = g.techs["tech_r"]
    assert t.is_repeatable and t.levels == -1 and t.cost_per_level == 500


def test_loc_and_swaps_and_unlock_text():
    loc = loc_of(
        b' tech_s:0 "Swappy"\n'
        b' swap_name:0 "Alt Name"\n'
        b' allow_thing:0 "\xc2\xa7HUnlocks:\xc2\xa7! Thing"\n')
    mod = Source("gigas", "Gigas")
    mod.add("a.txt",
            b'tech_s = { tier = 1\n'
            b'  prereqfor_desc = { custom = { title = allow_thing } }\n'
            b'  technology_swap = { name = swap_name trigger = { x = yes } }\n'
            b'  technology_swap = { name = swap_name }\n'
            b'}')
    _, g = build([mod], loc=loc)
    t = g.techs["tech_s"]
    assert t.name == "Swappy"
    assert t.unlock_text == ["Unlocks: Thing"]
    assert len(t.swaps) == 2
    assert t.swaps[0]["displayName"] == "Alt Name"
    assert t.swaps[0]["trigger"] == "x = yes"


def test_json_model_sorted_and_complete():
    mod = Source("gigas", "Gigas")
    mod.add("a.txt", b"tech_z = { tier = 1 }\ntech_a = { tier = 1 }")
    merged, g = build([mod])
    model = to_json_model(g, {}, {"schemaVersion": 1})
    ids = [t["id"] for t in model["technologies"]]
    assert ids == sorted(ids)
    assert model["technologies"][0]["nameMissing"] is True
    assert "health" in model and "dangling" in model["health"]
