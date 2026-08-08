/* localmod.js — dev feature (?dev): load an arbitrary mod folder entirely
   client-side and render its tech tree composed with the baked vanilla
   structural data. Nothing is uploaded; parsing happens in this tab via
   pdxparse.js. Known v1 limitation: .dds icons can't be decoded by
   browsers, so local-mod techs render without icons. */

import { parseBytes, Block, VarRef, VarTable, resolve,
         InlineScriptLibrary, LocTable, stripMarkup } from "./pdxparse.js";

const rel = f => (f.webkitRelativePath || f.name).split("/").slice(1).join("/");

async function readAll(files, filterFn) {
  const out = [];
  for (const f of files) {
    const r = rel(f);
    if (filterFn(r)) out.push({ path: r, data: await f.arrayBuffer() });
  }
  out.sort((a, b) => a.path < b.path ? -1 : 1);
  return out;
}

/* files: FileList/array from webkitdirectory input or drag-drop.
   Returns { techs: [...], meta, errors } shaped like a dataset model. */
export async function loadLocalMod(files, modLabel = "Local mod") {
  const errors = [];

  const techFiles = await readAll(files, p =>
    /^common\/technology\/[^/]+\.txt$/.test(p));
  const varFiles = await readAll(files, p =>
    /^common\/scripted_variables\/[^/]+\.txt$/.test(p));
  const inlineFiles = await readAll(files, p =>
    /^common\/inline_scripts\/.+\.txt$/.test(p));
  const locFiles = await readAll(files, p =>
    /^localisation\/english\/.*\.yml$/.test(p));

  if (!techFiles.length) {
    throw new Error(
      "No common/technology/*.txt found — pick the mod's root folder " +
      "(the one containing 'common').");
  }

  // Variables: mod defs over the baked vanilla table.
  const vanillaVars = new VarTable();
  try {
    const vs = await fetch("data/vanilla-structural.json").then(r => r.json());
    for (const [k, v] of Object.entries(vs.variables ?? {}))
      vanillaVars.define(k, v, "vanilla-structural.json");
  } catch { /* mod-only resolution */ }
  const vars = new VarTable(vanillaVars);
  for (const f of varFiles) {
    try { vars.loadDefinitions(parseBytes(f.data), f.path); }
    catch (e) { errors.push({ file: f.path, message: e.message }); }
  }

  const lib = new InlineScriptLibrary();
  for (const f of inlineFiles) {
    try {
      lib.add(f.path.replace(/^common\/inline_scripts\//, "")
                    .replace(/\.txt$/, ""),
              new TextDecoder().decode(f.data));
    } catch { /* skip */ }
  }

  const loc = new LocTable();
  for (const f of locFiles) {
    try { loc.loadText(new TextDecoder("utf-8").decode(
      new Uint8Array(f.data)), f.path); }
    catch { /* tolerate */ }
  }

  // Same-ID override within alphabetical file order (merge semantics).
  const defs = new Map();
  for (const f of techFiles) {
    let ast;
    try { ast = parseBytes(f.data); }
    catch (e) {
      errors.push({ file: f.path, message: e.message });
      continue;
    }
    for (const p of ast.pairs()) {
      if (!(p.value instanceof Block) || p.key.startsWith("@")) continue;
      defs.set(p.key, { body: lib.expandBlock(p.value, 0, p.key),
                        file: f.path, line: p.line });
    }
  }

  const num = v => {
    const [r] = resolve(v, vars);
    return typeof r === "number" ? r : (r instanceof VarRef ? String(r) : null);
  };
  const yes = v => v === "yes";

  const techs = [];
  for (const [id, d] of defs) {
    const b = d.body;
    const cat = b.getLast("category");
    const prereq = b.getLast("prerequisites");
    const levels = num(b.getLast("levels"));
    const name = loc.get(id);
    const desc = loc.get(id + "_desc");
    const pot = b.getLast("potential");
    techs.push({
      id,
      name: name ? stripMarkup(loc.resolveSubst(name)) : id,
      nameMissing: !name,
      desc: desc ? stripMarkup(loc.resolveSubst(desc)) : null,
      area: typeof b.getLast("area") === "string" ? b.getLast("area") : null,
      categories: cat instanceof Block
        ? cat.bareValues().map(String)
        : cat != null ? [String(cat)] : [],
      tier: typeof num(b.getLast("tier")) === "number"
        ? num(b.getLast("tier")) : null,
      cost: num(b.getLast("cost")),
      costPerLevel: num(b.getLast("cost_per_level")),
      levels: typeof levels === "number" ? levels : null,
      weight: num(b.getLast("weight")),
      isStart: yes(b.getLast("is_start_tech")),
      isRare: yes(b.getLast("is_rare")),
      isDangerous: yes(b.getLast("is_dangerous")),
      isRepeatable: levels !== null && levels !== 0,
      reverseEngineerable: b.getLast("is_reverse_engineerable") !== "no",
      prerequisites: prereq instanceof Block
        ? prereq.bareValues().map(String) : [],
      unlocks: [],
      unlockText: [],
      weightModifiers: [],
      swaps: [],
      gateway: null,
      icon: null,          // v1: DDS not decodable in-browser
      gated: pot instanceof Block && pot.items.length > 0,
      crossModGated: false,
      source: "local",
      overridesVanilla: false,   // recomputed against vanilla at compose
      sourceFile: `${d.file}#L${d.line}`,
    });
  }

  return {
    meta: {
      schemaVersion: 1,
      sources: [{ id: "local", label: modLabel, kind: "mod",
                  commit: "local" }],
      counts: { technologies: techs.length, crossModGated: 0, overrides: 0 },
      parseErrors: errors, mergeWarnings: [], locWarnings: [],
    },
    categories: {},
    technologies: techs,
    health: { dangling: [], cycles: [], tierInversions: [],
              missingLoc: [], warnings: errors.map(e => ({
                kind: "parse-error", ...e })) },
  };
}
