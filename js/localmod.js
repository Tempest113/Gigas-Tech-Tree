/* localmod.js — dev feature (?dev): load one or more mod folders entirely
   client-side and render the assembled tech tree, composed with the baked
   vanilla structural data. Nothing is uploaded; parsing happens in this tab
   via pdxparse.js.

   Load order matters in Paradox and is the user's to control: mods are
   merged in list order, later sources overriding earlier ones by tech ID,
   and a filename collision replacing the earlier source's whole file (the
   semantics tools/merge.py models, ported here). Because this picker has no
   access to the launcher's real ordering or .mod dependencies, the order is
   an approximation the user sets by hand.

   v1 limitation: browsers can't decode .dds, so locally-loaded mods render
   without icons unless a tech id matches a shipped PNG. */

import { parseBytes, Block, VarRef, VarTable, resolve,
         InlineScriptLibrary, LocTable, stripMarkup } from "./pdxparse.js";

const relPath = f => (f.webkitRelativePath || f.name)
  .split("/").slice(1).join("/");

function collect(files, re) {
  const out = [];
  for (const f of files) {
    const p = relPath(f);
    if (re.test(p)) out.push({ path: p, file: f });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
}

const bytesOf = async entry => entry.file.arrayBuffer();

/* Read a picked folder into an in-memory mod source. */
export async function readModSource(files) {
  const folder = files[0]?.webkitRelativePath?.split("/")[0] ?? "mod";
  const src = {
    id: folder,
    label: folder,
    enabled: true,
    tech: [], vars: [], inline: [], loc: [],
    errors: [],
  };

  // descriptor.mod gives the mod's real name.
  const desc = [...files].find(f => relPath(f) === "descriptor.mod");
  if (desc) {
    try {
      const ast = parseBytes(await desc.arrayBuffer());
      const name = ast.getLast("name");
      if (typeof name === "string" && name.trim()) src.label = name.trim();
      const version = ast.getLast("supported_version");
      if (typeof version === "string") src.gameVersion = version;
    } catch (e) {
      src.errors.push({ file: "descriptor.mod", message: e.message });
    }
  }

  for (const e of collect(files, /^common\/technology\/[^/]+\.txt$/))
    src.tech.push({ path: e.path, data: await bytesOf(e) });
  for (const e of collect(files, /^common\/scripted_variables\/[^/]+\.txt$/))
    src.vars.push({ path: e.path, data: await bytesOf(e) });
  for (const e of collect(files, /^common\/inline_scripts\/.+\.txt$/))
    src.inline.push({ path: e.path, data: await bytesOf(e) });
  for (const e of collect(files, /^localisation\/english\/.*\.yml$/))
    src.loc.push({ path: e.path, data: await bytesOf(e) });

  if (!src.tech.length) {
    throw new Error(
      `${src.label}: no common/technology/*.txt found — pick the mod's root ` +
      `folder (the one containing 'common').`);
  }
  return src;
}

/* Merge an ordered list of enabled sources into a dataset model. */
export async function buildFromSources(sources) {
  const active = sources.filter(s => s.enabled);
  const errors = [];
  const warnings = [];

  // -- variables: vanilla base, then each mod in order ------------------
  const vanillaVars = new VarTable();
  try {
    const vs = await fetch("data/vanilla-structural.json").then(r => r.json());
    for (const [k, v] of Object.entries(vs.variables ?? {}))
      vanillaVars.define(k, v, "vanilla-structural.json");
  } catch { /* mod-only resolution */ }
  const vars = new VarTable(vanillaVars);
  for (const s of active) {
    for (const f of s.vars) {
      try { vars.loadDefinitions(parseBytes(f.data), `${s.label}/${f.path}`); }
      catch (e) { errors.push({ file: `${s.label}/${f.path}`, message: e.message }); }
    }
  }

  // -- inline scripts: later sources overwrite same script id -----------
  const lib = new InlineScriptLibrary();
  for (const s of active) {
    for (const f of s.inline) {
      const id = f.path.replace(/^common\/inline_scripts\//, "")
                       .replace(/\.txt$/, "");
      lib.add(id, new TextDecoder().decode(new Uint8Array(f.data)));
    }
  }

  // -- localisation: later sources win per key --------------------------
  const loc = new LocTable();
  for (const s of active) {
    for (const f of s.loc) {
      try {
        loc.loadText(new TextDecoder("utf-8").decode(new Uint8Array(f.data)),
                     `${s.label}/${f.path}`);
      } catch { /* tolerate */ }
    }
  }

  // -- whole-file replacement across sources (tools/merge.py semantics) --
  const fileWinner = new Map();   // filename -> {source, entry}
  for (const s of active) {
    for (const f of s.tech) {
      const prev = fileWinner.get(f.path);
      if (prev && prev.source !== s) {
        warnings.push({
          kind: "file-replacement", file: f.path,
          message: `${s.label} replaces ${prev.source.label}'s ${f.path} ` +
                   `entirely; techs defined only in that file are removed.`,
        });
      }
      fileWinner.set(f.path, { source: s, entry: f });
    }
  }

  // -- same-ID override in load order -----------------------------------
  const defs = new Map();
  const firstSeen = new Map();
  for (const s of active) {
    for (const f of s.tech) {
      const win = fileWinner.get(f.path);
      if (win.source !== s) continue;     // replaced by a later mod
      let ast;
      try { ast = parseBytes(f.data); }
      catch (e) {
        errors.push({ file: `${s.label}/${f.path}`, message: e.message });
        continue;
      }
      for (const p of ast.pairs()) {
        if (!(p.value instanceof Block) || p.key.startsWith("@")) continue;
        const overrides = firstSeen.has(p.key) && firstSeen.get(p.key) !== s.id;
        if (!firstSeen.has(p.key)) firstSeen.set(p.key, s.id);
        defs.set(p.key, {
          body: lib.expandBlock(p.value, 0, p.key),
          file: f.path, line: p.line, source: s,
          overridesEarlierMod: overrides,
        });
      }
    }
  }

  const num = v => {
    const [r] = resolve(v, vars);
    return typeof r === "number" ? r : (r instanceof VarRef ? String(r) : null);
  };
  const yes = v => v === "yes";

  const technologies = [];
  for (const [id, d] of defs) {
    const b = d.body;
    const cat = b.getLast("category");
    const prereq = b.getLast("prerequisites");
    const levels = num(b.getLast("levels"));
    const tier = num(b.getLast("tier"));
    const rawName = loc.get(id);
    const rawDesc = loc.get(id + "_desc");
    const pot = b.getLast("potential");
    const explicitIcon = b.getLast("icon");
    technologies.push({
      id,
      name: rawName ? stripMarkup(loc.resolveSubst(rawName)) : id,
      nameMissing: !rawName,
      desc: rawDesc ? stripMarkup(loc.resolveSubst(rawDesc)) : null,
      area: typeof b.getLast("area") === "string" ? b.getLast("area") : null,
      categories: cat instanceof Block
        ? cat.bareValues().map(String)
        : cat != null ? [String(cat)] : [],
      tier: typeof tier === "number" ? tier : null,
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
      // Shipped PNGs exist for Gigas + vanilla ids; other mods' .dds can't
      // be decoded in-browser, so those cards render iconless.
      icon: typeof explicitIcon === "string" ? explicitIcon : id,
      gated: pot instanceof Block && pot.items.length > 0,
      crossModGated: false,
      source: d.source.id,
      sourceLabel: d.source.label,
      overridesVanilla: d.overridesEarlierMod,
      sourceFile: `${d.file}#L${d.line}`,
    });
  }

  return {
    meta: {
      schemaVersion: 1,
      sources: active.map(s => ({ id: s.id, label: s.label, kind: "mod",
                                  commit: "local" })),
      counts: {
        technologies: technologies.length,
        crossModGated: 0,
        overrides: technologies.filter(t => t.overridesVanilla).length,
      },
      parseErrors: errors, mergeWarnings: warnings, locWarnings: [],
    },
    categories: {},
    technologies,
    health: {
      dangling: [], cycles: [], tierInversions: [], missingLoc: [],
      warnings: [...warnings,
                 ...errors.map(e => ({ kind: "parse-error", ...e }))],
    },
  };
}
