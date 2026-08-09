"""Parser test suite. One test (or group) per §3 bullet of the spec, plus
integration fixtures copied verbatim from the Gigastructures repo."""
from pathlib import Path

import pytest

from tools.pdx.lexer import LexError, decode_bytes
from tools.pdx.parser import (Block, MathExpr, Pair, ParseError, VarRef,
                              parse, parse_bytes)
from tools.pdx.values import VarTable, eval_math, resolve, MathError

FIXTURES = Path(__file__).parent / "fixtures"


# -- blocks & nesting -------------------------------------------------------

def test_nested_blocks():
    ast = parse("a = { b = { c = 1 } }")
    a = ast.get("a")
    assert isinstance(a, Block)
    b = a.get("b")
    assert isinstance(b, Block)
    assert b.get("c") == "1"


def test_empty_block():
    ast = parse("potential = { }")
    assert isinstance(ast.get("potential"), Block)
    assert len(ast.get("potential")) == 0


# -- operators --------------------------------------------------------------

@pytest.mark.parametrize("op", ["=", "==", "!=", "<", ">", "<=", ">="])
def test_operators_preserved(op):
    ast = parse(f"tier {op} 3")
    pair = next(ast.pairs())
    assert pair.op == op
    assert pair.value == "3"


def test_tier_gt_is_not_tier_eq():
    """`tier > 3` in a trigger must not collapse to `tier = 3`."""
    ast = parse("NOT = { years_passed > 50 }")
    inner = next(ast.get("NOT").pairs())
    assert (inner.key, inner.op, inner.value) == ("years_passed", ">", "50")


# -- comments ---------------------------------------------------------------

def test_comment_full_line_and_trailing():
    ast = parse(
        "# leading comment\n"
        "factor = 2.5\t#Moons!\n"
        "weight = 10 # another\n"
    )
    assert ast.get("factor") == "2.5"
    assert ast.get("weight") == "10"
    assert len(list(ast.pairs())) == 2


def test_commented_out_tech_is_invisible():
    """The 'banished' pattern: whole techs commented line-by-line."""
    text = "# dead_tech = {\n# \tcost = 100\n# }\nlive = 1\n"
    ast = parse(text)
    assert ast.keys() == ["live"]


def test_hash_inside_string_is_not_comment():
    ast = parse('name = "value # not a comment"')
    assert ast.get("name") == "value # not a comment"


# -- strings ----------------------------------------------------------------

def test_quoted_string_with_spaces_and_equals():
    ast = parse('desc = "a = b, with spaces"')
    assert ast.get("desc") == "a = b, with spaces"


def test_escaped_quotes():
    ast = parse(r'desc = "she said \"hi\" twice"')
    assert ast.get("desc") == 'she said "hi" twice'


def test_multiline_string():
    """`code = "…"` inline-script parameters span lines (real construct in
    common/scripted_triggers/zzz_overwrites.txt)."""
    ast = parse('inline_script = {\n  script = x\n  code = "\n'
                '    has_building = a\n    has_building = b\n  "\n}\n')
    code = ast.get("inline_script").get("code")
    assert "has_building = a" in code and "has_building = b" in code


def test_unterminated_string_reports_open_quote_position():
    with pytest.raises(LexError) as ei:
        parse('a = "never closed\nb = 1')
    assert ei.value.line == 1


# -- duplicate keys ---------------------------------------------------------

def test_duplicate_keys_preserved_in_order():
    ast = parse(
        "weight_modifier = {\n"
        "  modifier = { factor = 0.1 years_passed < 10 }\n"
        "  modifier = { factor = 2 years_passed > 20 }\n"
        "  modifier = { factor = 3 years_passed > 30 }\n"
        "}\n"
    )
    mods = ast.get("weight_modifier").get_all("modifier")
    assert len(mods) == 3
    assert [m.get("factor") for m in mods] == ["0.1", "2", "3"]
    # And the trigger operator survived on each.
    ops = [next(p.op for p in m.pairs() if p.key == "years_passed")
           for m in mods]
    assert ops == ["<", ">", ">"]


def test_duplicate_technology_swap_blocks():
    ast = parse(
        "t = {\n"
        "  technology_swap = { name = a }\n"
        "  technology_swap = { name = b }\n"
        "}\n"
    )
    swaps = ast.get("t").get_all("technology_swap")
    assert [s.get("name") for s in swaps] == ["a", "b"]


# -- implicit lists & mixed blocks ------------------------------------------

def test_implicit_list_bare_and_quoted():
    ast = parse('prerequisites = { tech_a "tech b" tech_c }')
    vals = ast.get("prerequisites").bare_values()
    assert vals == ["tech_a", "tech b", "tech_c"]


def test_mixed_block():
    ast = parse("b = { bare_one key = val bare_two }")
    b = ast.get("b")
    assert b.bare_values() == ["bare_one", "bare_two"]
    assert b.get("key") == "val"
    # Source order fully preserved.
    kinds = ["pair" if isinstance(i, Pair) else "bare" for i in b]
    assert kinds == ["bare", "pair", "bare"]


# -- scripted variables -----------------------------------------------------

def test_varref_parsed_symbolically():
    ast = parse("cost = @tier5cost2")
    assert ast.get("cost") == VarRef("tier5cost2")


def test_var_definition_and_resolution():
    table = VarTable()
    defs = parse("@x = 100\n@y = 2.5\n")
    table.load_definitions(defs, "f.txt")
    v, err = resolve(VarRef("x"), table)
    assert (v, err) == (100, None)
    v, err = resolve(VarRef("y"), table)
    assert (v, err) == (2.5, None)


def test_var_redefinition_later_wins():
    table = VarTable()
    table.load_definitions(parse("@x = 1"), "a.txt")
    table.load_definitions(parse("@x = 2"), "zz_override.txt")
    assert table.lookup("x").value == 2
    assert table.lookup("x").source_file == "zz_override.txt"


def test_undefined_var_stays_symbolic_with_warning():
    v, err = resolve(VarRef("tier5cost2"), VarTable())
    assert v == VarRef("tier5cost2")
    assert "tier5cost2" in err


def test_vanilla_fallback_layer():
    vanilla = VarTable()
    vanilla.define("tier5cost2", 20000, "vanilla")
    mod = VarTable(fallback=vanilla)
    v, err = resolve(VarRef("tier5cost2"), mod)
    assert (v, err) == (20000, None)
    # Mod overwrite of a vanilla variable wins.
    mod.define("tier5cost2", 12345, "mod.txt")
    v, _ = resolve(VarRef("tier5cost2"), mod)
    assert v == 12345


def test_var_defined_in_terms_of_earlier_var():
    table = VarTable()
    table.load_definitions(parse("@base = 10\n@double = @base"), "f.txt")
    assert table.lookup("double").value == 10


# -- inline maths -----------------------------------------------------------

def test_math_token_both_forms():
    ast = parse(r"a = @[ x * 2 ]" + "\n" + r"b = @\[ y + 1 \]")
    assert ast.get("a") == MathExpr("x * 2")
    assert ast.get("b") == MathExpr("y + 1")


def test_math_evaluation():
    t = VarTable()
    t.define("tier3cost", 6000)
    assert eval_math("tier3cost * 2", t) == 12000
    assert eval_math("@tier3cost * 2", t) == 12000
    assert eval_math("( tier3cost + 1000 ) / 2", t) == 3500
    assert eval_math("-tier3cost + 7000", t) == 1000
    assert eval_math("2 + 3 * 4", t) == 14  # precedence


def test_math_division_by_zero_and_undefined_are_errors_not_crashes():
    t = VarTable()
    t.define("z", 0)
    with pytest.raises(MathError):
        eval_math("1 / z", t)
    v, err = resolve(MathExpr("1 / z"), t)
    assert v == MathExpr("1 / z") and "zero" in err
    v, err = resolve(MathExpr("nope * 2"), t)
    assert "undefined" in err


def test_no_eval_reachable():
    """Belt-and-braces: the evaluator source must not contain eval/exec."""
    import inspect
    from tools.pdx import values
    src = inspect.getsource(values)
    assert "eval(" not in src.replace("eval_math(", "")
    assert "exec(" not in src


# -- encoding & line endings ------------------------------------------------

def test_utf8_bom_stripped():
    data = b"\xef\xbb\xbfa = 1\n"
    assert parse_bytes(data).get("a") == "1"


def test_cp1252_fallback():
    # 0x92 is a cp1252 right-single-quote, invalid as UTF-8 lead byte here.
    data = b'name = "it\x92s fine"\n'
    ast = parse_bytes(data)
    assert ast.get("name") == "it\u2019s fine"


def test_crlf_and_mixed_line_endings():
    data = b"a = 1\r\nb = {\r\n  c = 2\n}\r\n"
    ast = parse_bytes(data)
    assert ast.get("a") == "1"
    assert ast.get("b").get("c") == "2"
    # Positions still count lines correctly across CRLF.
    assert next(p for p in ast.pairs() if p.key == "b").line == 2


# -- errors carry positions -------------------------------------------------

def test_parse_error_position():
    with pytest.raises(ParseError) as ei:
        parse("a = { b = 1 ")  # unclosed block
    assert ei.value.line >= 1


def test_unmatched_close_brace():
    with pytest.raises(ParseError):
        parse("a = 1 }")


# -- integration: real Gigastructures files ---------------------------------

def test_real_physics_excerpt():
    ast = parse_bytes((FIXTURES / "real_giga_physics_excerpt.txt").read_bytes())
    tech = ast.get("giga_tech_war_moon_specialization")
    assert isinstance(tech, Block)
    assert tech.get("area") == "physics"
    assert tech.get("tier") == "5"
    assert tech.get("cost") == VarRef("tier5cost2")
    assert tech.get("prerequisites").bare_values() == ["giga_tech_war_moon_2"]
    # inline_script in both value and block form inside weight_modifier.
    wm = tech.get("weight_modifier")
    scripts = wm.get_all("inline_script")
    assert len(scripts) == 2
    assert isinstance(scripts[0], str)      # value form
    assert isinstance(scripts[1], Block)    # block form with parameters
    assert scripts[1].get("TECHNOLOGY") == "giga_tech_war_moon_specialization"
    # Trailing comment after a varref factor did not eat the next line.
    ai = tech.get("ai_weight")
    assert ai.get("factor") == VarRef("giga_aiweight_multiplier_strong")


def test_real_overwrites_excerpt():
    """UTF-8 file, vanilla override, multiple technology_swap blocks."""
    ast = parse_bytes((FIXTURES / "real_overwrites_excerpt.txt").read_bytes())
    tech = ast.get("tech_ring_world")
    assert isinstance(tech, Block)
    swaps = tech.get_all("technology_swap")
    assert len(swaps) >= 2
    assert swaps[0].get("name") == "giga_tech_ring_world_swap"
    assert swaps[0].get("inherit_icon") == "yes"


def test_real_scripted_vars_excerpt():
    ast = parse_bytes(
        (FIXTURES / "real_scripted_vars_excerpt.txt").read_bytes())
    table = VarTable()
    table.load_definitions(ast, "giga_technology_scripted_variables.txt")
    assert table.lookup("giga_tier6weight1").value == 18
    assert table.lookup("giga_tech_weight_malus_medium").value == 0.75
