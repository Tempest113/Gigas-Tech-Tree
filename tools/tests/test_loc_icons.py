"""Tests for tools/loc.py and tools/icons.py."""
from pathlib import Path

from PIL import Image

from tools.icons import convert_icons, resolve_icon
from tools.loc import LocTable, strip_markup

BOM = b"\xef\xbb\xbf"


def make_table(*files: tuple[bytes, str]) -> LocTable:
    t = LocTable()
    for data, name in files:
        t.load_file(data, name)
    return t


# -- loc parsing ------------------------------------------------------------

def test_loc_basic_with_bom_and_tabs():
    t = make_table((BOM + b'l_english:\n\ttech_x:0 "Example Tech"\n', "a.yml"))
    assert t.get("tech_x") == "Example Tech"


def test_loc_space_indent_and_no_version():
    t = make_table((b'l_english:\n  tech_y: "No Version"\n', "a.yml"))
    assert t.get("tech_y") == "No Version"


def test_loc_escaped_quotes_and_newlines():
    t = make_table(
        (rb'l_english:' + b"\n" +
         rb' k:0 "say \"hi\"\nsecond line"' + b"\n", "a.yml"))
    assert t.get("k") == 'say "hi"\nsecond line'


def test_loc_later_file_wins():
    t = make_table(
        (b'l_english:\n k:0 "vanilla"\n', "vanilla.yml"),
        (b'l_english:\n k:0 "modded"\n', "zz_mod.yml"))
    assert t.get("k") == "modded"
    assert t.entries["k"].source_file == "zz_mod.yml"


def test_loc_other_language_section_ignored():
    t = make_table((b'l_german:\n k:0 "nein"\nl_english:\n k:0 "yes"\n',
                    "a.yml"))
    assert t.get("k") == "yes"


def test_loc_substitution_resolved_recursively():
    t = make_table((
        b'l_english:\n'
        b' name_alderson:0 "Alderson Disk"\n'
        b' tech_ad:0 "The $name_alderson$"\n'
        b' allow:0 "Unlocks: $tech_ad$"\n', "a.yml"))
    assert t.name("tech_ad") == "The Alderson Disk"
    assert t.name("allow") == "Unlocks: The Alderson Disk"


def test_loc_runtime_params_left_visible_and_cycles_terminate():
    t = make_table((
        b'l_english:\n'
        b' a:0 "$b$"\n b:0 "$a$"\n'
        b' c:0 "value is $VALUE$"\n', "a.yml"))
    assert "$" in t.resolve_substitutions("$a$")   # cycle: depth-limited
    assert t.name("c") == "value is $VALUE$"       # unknown key stays


def test_loc_missing_key_recorded():
    t = make_table((b'l_english:\n k:0 "x"\n', "a.yml"))
    assert t.name("nope") is None
    assert "nope" in t.missing


def test_strip_markup():
    assert strip_markup("\u00a7GGiga\u00a7! \u00a3energy\u00a3 done") == "Giga done"


# -- icons ------------------------------------------------------------------

def test_icon_conversion_and_determinism(tmp_path: Path):
    src = tmp_path / "dds"
    src.mkdir()
    for name, size in [("a", (52, 52)), ("b", (58, 58)), ("c", (52, 52))]:
        Image.new("RGBA", size, (255, 0, 0, 255)).save(src / f"{name}.dds")

    o1, o2 = tmp_path / "o1", tmp_path / "o2"
    r1 = convert_icons(src, o1 / "icons", o1 / "atlas.png", o1 / "atlas.json")
    r2 = convert_icons(src, o2 / "icons", o2 / "atlas.png", o2 / "atlas.json")
    assert r1.converted == ["a", "b", "c"]
    assert not r1.warnings
    assert (o1 / "atlas.png").read_bytes() == (o2 / "atlas.png").read_bytes()
    assert (o1 / "atlas.json").read_bytes() == (o2 / "atlas.json").read_bytes()
    # cell = max dims, 52px icons centred inside 58px cells
    assert r1.atlas_map["a"] == {"x": 3, "y": 3, "w": 52, "h": 52}
    assert r1.atlas_map["b"]["w"] == 58


def test_icon_failure_gets_placeholder_and_warning(tmp_path: Path):
    src = tmp_path / "dds"
    src.mkdir()
    (src / "broken.dds").write_bytes(b"not a dds file at all")
    out = tmp_path / "out"
    r = convert_icons(src, out / "icons", out / "atlas.png", out / "atlas.json")
    assert len(r.warnings) == 1 and "broken" in r.warnings[0]["file"]
    assert (out / "icons" / "broken.png").exists()  # placeholder written


def test_icon_resolution_order():
    avail = {"explicit", "tech_id", "cat_icon"}
    cats = {"computing": {"icon": "cat_icon"}}
    assert resolve_icon("tech_id", "explicit", avail, cats, ["computing"]) == "explicit"
    assert resolve_icon("tech_id", None, avail, cats, ["computing"]) == "tech_id"
    assert resolve_icon("nope", None, avail, cats, ["computing"]) == "cat_icon"
    assert resolve_icon("nope", None, {"x"}, cats, ["other"]) is None
