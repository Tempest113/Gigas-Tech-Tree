// Parity test for js/pdxparse.js against the SAME real Gigastructures
// fixtures the Python suite uses (tools/tests/fixtures/). Run:
//   node tests/pdxparse-test.mjs
import { readFileSync } from "fs";
import { parseBytes, parse, Block, VarRef, MathExpr, VarTable,
         resolve, evalMath, InlineScriptLibrary, LocTable, stripMarkup }
  from "../js/pdxparse.js" ;

let failures = 0;
const ok = (cond, msg) => {
  if (!cond) { console.error("FAIL:", msg); failures++; }
};

// -- real physics excerpt ---------------------------------------------------
{
  const ast = parseBytes(readFileSync(
    new URL("../tools/tests/fixtures/real_giga_physics_excerpt.txt",
            import.meta.url)));
  const tech = ast.get("giga_tech_war_moon_specialization");
  ok(tech instanceof Block, "physics: tech block parsed");
  ok(tech.get("area") === "physics", "physics: area");
  ok(tech.get("tier") === "5", "physics: tier");
  ok(tech.get("cost") instanceof VarRef &&
     tech.get("cost").name === "tier5cost2", "physics: cost varref");
  ok(tech.get("prerequisites").bareValues()[0] === "giga_tech_war_moon_2",
     "physics: quoted prerequisite");
  const scripts = tech.get("weight_modifier").getAll("inline_script");
  ok(scripts.length === 2, "physics: two inline_script forms");
  ok(typeof scripts[0] === "string" && scripts[1] instanceof Block,
     "physics: value + block inline_script");
}

// -- real overrides excerpt (UTF-8, technology_swap) ------------------------
{
  const ast = parseBytes(readFileSync(
    new URL("../tools/tests/fixtures/real_overwrites_excerpt.txt",
            import.meta.url)));
  const swaps = ast.get("tech_ring_world").getAll("technology_swap");
  ok(swaps.length >= 2, "overrides: multiple technology_swap preserved");
  ok(swaps[0].get("name") === "giga_tech_ring_world_swap", "overrides: swap name");
}

// -- real scripted variables ------------------------------------------------
{
  const ast = parseBytes(readFileSync(
    new URL("../tools/tests/fixtures/real_scripted_vars_excerpt.txt",
            import.meta.url)));
  const t = new VarTable();
  t.loadDefinitions(ast, "vars.txt");
  ok(t.lookup("giga_tier6weight1").value === 18, "vars: int");
  ok(t.lookup("giga_tech_weight_malus_medium").value === 0.75, "vars: float");
}

// -- operators, duplicates, mixed blocks, maths, encoding -------------------
{
  const ast = parse("NOT = { years_passed > 50 }");
  const inner = [...ast.get("NOT").pairs()][0];
  ok(inner.op === ">", "operator preserved");

  const dup = parse("w = { modifier = { factor = 1 } modifier = { factor = 2 } }");
  ok(dup.get("w").getAll("modifier").length === 2, "duplicates preserved");

  const t = new VarTable();
  t.define("x", 6000);
  ok(evalMath("( x + 1000 ) / 2", t) === 3500, "maths precedence/parens");
  ok(evalMath("2 + 3 * 4", t) === 14, "maths precedence");
  const [v, err] = resolve(new VarRef("nope"), t);
  ok(v instanceof VarRef && err.includes("nope"), "unresolved stays symbolic");

  const ml = parse('inline_script = {\n script = x\n code = "\n  a = b\n "\n}\n');
  ok(ml.get("inline_script").get("code").includes("a = b"),
     "multi-line string parameter");

  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("a = 1\n")]);
  ok(parseBytes(bom.buffer).get("a") === "1", "BOM stripped");
  const cp = new Uint8Array([...new TextEncoder().encode('n = "it'), 0x92,
                             ...new TextEncoder().encode('s"\n')]);
  ok(parseBytes(cp.buffer).get("n") === "it\u2019s", "cp1252 fallback");
}

// -- inline script expansion ------------------------------------------------
{
  const lib = new InlineScriptLibrary();
  lib.add("tech/tmpl",
    "cost = $cost$\narea = $area$\n[[rare] is_rare = yes ]\n[[!rare] is_rare = no ]");
  const src = parse(
    'x = { inline_script = { script = tech/tmpl cost = 100 area = physics } }');
  const out = lib.expandBlock(src.get("x"), 0, "x");
  ok(out.get("cost") === "100" && out.get("area") === "physics",
     "inline: $param$ substitution");
  ok(out.get("is_rare") === "no", "inline: [[!opt]] blocks");
  ok(lib.unexpanded.length === 0, "inline: nothing unexpanded");
}

// -- localisation ------------------------------------------------------------
{
  const loc = new LocTable();
  loc.loadText('l_english:\n name_ad:0 "Alderson Disk"\n' +
               ' t:0 "The $name_ad$"\n h:0 "§GGiga§! £energy£ x"\n');
  ok(loc.resolveSubst(loc.get("t")) === "The Alderson Disk", "loc: substitution");
  ok(stripMarkup(loc.get("h")) === "Giga x", "loc: markup stripped");
}

if (failures) { console.error(`pdxparse parity: ${failures} FAILURES`); process.exit(1); }
console.log("pdxparse parity: all assertions passed");
