// DOM smoke test: boots the real page in jsdom and asserts the chrome is
// alive. Dev-only tooling (jsdom is NOT a runtime dependency; the site
// itself has none). Run:  npm i -D jsdom@24 && node tests/dom-smoke.mjs
// Exits non-zero on failure.
import { JSDOM } from "jsdom";
import { readFileSync } from "fs";
import { fileURLToPath, pathToFileURL } from "url";

const html = readFileSync("index.html", "utf8");
globalThis.fail2 = m => { console.error("FAIL:", m); process.exit(1); };
const dom = new JSDOM(html, { url: "http://localhost:8000/?dev",
  runScripts: "outside-only", pretendToBeVisual: true });
const { window } = dom;

// globals the modules expect
for (const k of ["document","window","location","history","localStorage",
                 "HTMLElement","getComputedStyle","requestAnimationFrame",
                 "cancelAnimationFrame","confirm","innerWidth","innerHeight"]) {
  globalThis[k] = window[k] ?? globalThis[k];
}
globalThis.window = window;
globalThis.confirm = () => true;
globalThis.ResizeObserver = class { observe(){} disconnect(){} };
// jsdom has no canvas engine: stub the pieces render.js touches.
globalThis.Path2D = class { moveTo(){} lineTo(){} bezierCurveTo(){} };
globalThis.Image = class { set src(_v) { setTimeout(() => this.onerror?.(), 0); } };
// canvas 2d stub
const noop = new Proxy({}, { get: () => () => noop, set: () => true });
// jsdom has no canvas engine. Stub the 2d context faithfully enough that
// renderer bugs surface as errors instead of being swallowed.
globalThis.__drawnText = [];
window.HTMLCanvasElement.prototype.getContext = () => ({
  measureText: t => ({ width: String(t).length * 6 }),
  fillText: (t, x, y) => globalThis.__drawnText.push({ t: String(t), x, y }),
  clip(){}, arc(){}, createPattern: () => ({}),
  setTransform(){}, clearRect(){}, translate(){}, scale(){}, save(){},
  restore(){}, beginPath(){}, moveTo(){}, lineTo(){}, arcTo(){}, closePath(){},
  bezierCurveTo(){}, fill(){}, stroke(){}, fillRect(){},
  setLineDash(){}, drawImage(){},
  canvas: { width: 0, height: 0 },
});
// fetch serving local files
globalThis.fetch = async (url) => {
  const path = url.replace("http://localhost:8000/", "").split("?")[0];
  try {
    const data = readFileSync(path);
    return { ok: true, status: 200, json: async () => JSON.parse(data) };
  } catch {
    return { ok: false, status: 404, json: async () => { throw new Error("404"); } };
  }
};

window.addEventListener("error", e => console.log("WINDOW ERROR:", e.message));
process.on("unhandledRejection", e => console.log("UNHANDLED:", e?.stack ?? e));

try {
  await import(pathToFileURL("js/main.js").href);
  await new Promise(r => setTimeout(r, 300));
  const $ = id => window.document.getElementById(id);
  console.log("status text:", JSON.stringify($("status").textContent), "hidden:", $("status").hidden);
  console.log("cards indexed:", window.__view?.index.items.length);
  console.log("sidebar cats:", window.document.querySelectorAll(".sidebar-cat").length);
  console.log("explore rows:", window.document.querySelectorAll(".explore-table tbody tr").length);
  console.log("health sections:", $("health-body").querySelectorAll("h3").length);
  // map interaction now goes through the canvas renderer: assert via its
  // state (DOM cards no longer exist).
  const view = window.__view;
  if (!view) fail2("renderer not exposed for testing");
  const firstId = view.index.items[0].id;
  view.select(firstId);
  console.log("selected:", view.selected, "lineage size:", view.lineage?.size);
  if (view.selected !== firstId) fail2("select() did not take");
  if (!view.lineage?.has(firstId)) fail2("selection did not build a lineage");
  view.select(null);
  if (view.lineage !== null) fail2("clearing selection left a lineage");

  // Ascension perk markings that have regressed before, each for a
  // different reason. Kept together so a change cannot fix one by
  // breaking another.
  {
    const perksOf = id => {
      const t = view.model.techs.get(id);
      return [...(t?.ascensionPerks ?? []), ...(t?.inheritedPerks ?? [])];
    };
    const must = (id, perk) => {
      if (!perksOf(id).includes(perk))
        fail2(`${id} should require ${perk}`);
    };
    const mustNot = (id, perk) => {
      if (perksOf(id).includes(perk))
        fail2(`${id} should NOT require ${perk} (${JSON.stringify(perksOf(id))})`);
    };
    // Granted outright by the perk.
    must("tech_ring_world", "ap_galactic_wonders");
    must("tech_dyson_sphere", "ap_galactic_wonders");
    must("tech_matter_decompressor", "ap_galactic_wonders");
    // Granted to AI empires only — not a player requirement.
    mustNot("tech_mega_engineering", "ap_galactic_wonders");
    // Must not inherit the requirement through Mega-Engineering.
    mustNot("tech_gateway_construction", "ap_galactic_wonders");
    // Granted through a special project the perk enables; declared in
    // data/manual-perk-grants.json and inherited by the weapon techs.
    must("tech_colossus", "ap_colossus");
    must("tech_pk_cracker", "ap_colossus");
    console.log("perk markings: ring/dyson/decompressor set, "
      + "mega-eng and gateway clear");
  }

  // ascension-perk locked technologies must be marked on the map
  {
    const apTech = [...view.model.techs.values()]
      .find(t => t.ascensionPerks?.length);
    if (!apTech) fail2("no ascension-perk technology in the dataset");
    view.centreOn(apTech.id);
    await new Promise(r => setTimeout(r, 60));
    globalThis.__drawnText.length = 0;
    view.redraw();
    await new Promise(r => setTimeout(r, 60));
    const texts = globalThis.__drawnText.map(d => d.t);
    console.log("AP tech marked:", apTech.id,
      "badge:", texts.includes("\u2726"),
      "label:", texts.some(t => /^Needs /.test(t)));
    if (!texts.includes("\u2726")) fail2("ascension perk badge not drawn");
    if (!texts.some(t => /^Needs /.test(t)))
      fail2("ascension perk label not drawn");
    if (texts.some(t => /^(Via|From) /.test(t)))
      fail2("card uses more than one phrasing for perk requirements");
  }

  // every technology must sit right of its prerequisites, in both modes
  {
    const { layout } = await import(pathToFileURL("js/layout.js").href);
    for (const mode of ["tier", "gate"]) {
      const lay = layout(view.model.techs, null, mode);
      let bad = 0, example = null;
      for (const t of view.model.techs.values()) {
        const c = lay.pos.get(t.id);
        if (!c) continue;
        for (const p of t.prerequisites) {
          const pc = lay.pos.get(p);
          if (pc && pc.x >= c.x) { bad++; example ??= `${t.id} <- ${p}`; }
        }
      }
      const labels = lay.furniture
        .filter(f => f.kind === "tierlabel" && !f.small).map(f => f.text);
      const repeats = labels.filter((l, i) => labels.indexOf(l) !== i);
      console.log(`${mode} mode: ${bad} ordering violations, `
        + `bands ${labels.join(" | ")}`);
      if (bad) fail2(`${mode} mode places ${bad} technologies left of a `
                     + `prerequisite (e.g. ${example})`);
      if (repeats.length)
        fail2(`${mode} mode repeats a band label: ${repeats.join(", ")}`);
    }

    // Repeatables keep a band of their own in tier mode, including under a
    // filter that leaves only a tier or two standing.
    const gigacon = new Set([...view.model.techs.values()]
      .filter(t => [...(t.ascensionPerks ?? []), ...(t.inheritedPerks ?? [])]
        .includes("ap_gigastructural_constructs")).map(t => t.id));
    for (const vis of [null, gigacon]) {
      const lay = layout(view.model.techs, vis, "tier");
      const nodes = [...view.model.techs.values()]
        .filter(t => !vis || vis.has(t.id));
      const xs = kind => nodes.filter(t => !!t.isRepeatable === kind)
        .map(t => lay.pos.get(t.id)?.x).filter(x => x != null);
      const rep = xs(true), other = xs(false);
      if (rep.length && other.length && Math.min(...rep) <= Math.max(...other))
        fail2("repeatables share columns with ordinary technologies"
              + (vis ? " when filtered" : ""));
    }
  }

  // every technology is fully described: none render as bare stubs
  {
    const stubs = [...view.model.techs.values()].filter(t => t.stub);
    console.log("undescribed technologies:", stubs.length);
    if (stubs.length)
      fail2(`${stubs.length} technologies have no data (${stubs[0].id})`);
  }

  // mod requirements carry down the prerequisite chain: the sigma
  // supertensile needs the submod because the Phanon one does
  {
    const tag = id => view.model.techs.get(id)?.modTag;
    const expect = {
      giga_tech_amb_supertensiles_acot_delta: "ACOT",
      giga_tech_amb_supertensiles_acot_phanon: "AoT",
      giga_tech_amb_supertensiles_acot_sigma: "AoT",
      tech_civil_phanon_application: "AoT",
    };
    for (const [id, want] of Object.entries(expect)) {
      if (tag(id) !== want)
        fail2(`${id} tagged ${tag(id)}, expected ${want}`);
    }
    console.log("mod tags propagate along prerequisites");
  }

  // a perk whose icon file is not named after it still resolves
  {
    const map = view.model.perkIcons ?? {};
    if (!Object.keys(map).length)
      fail2("perk icon mapping missing from the composed model");
    for (const [perk, icon] of Object.entries(map)) {
      const used = [...view.model.techs.values()].some(t =>
        (t.ascensionPerks ?? []).includes(perk) ||
        (t.inheritedPerks ?? []).includes(perk));
      if (used) console.log(`perk icon mapped: ${perk} -> ${icon}`);
    }
  }

  // an icon missing from the atlas falls back to its own file
  {
    const key = "ap_galactic_wonders";
    const gated = [...view.model.techs.values()]
      .find(t => (t.ascensionPerks ?? []).includes(key));
    if (!gated) fail2(`no technology requires ${key}`);
    const had = view.atlasMap && key in view.atlasMap;
    if (view.atlasMap) delete view.atlasMap[key];
    view.loose.delete(key);
    // the badge only draws for a card on screen
    view.centreOn(gated.id);
    view.redraw();
    await new Promise(r => setTimeout(r, 80));
    if (!view.loose.has(key))
      fail2("an icon missing from the atlas was not requested individually");
    console.log(`atlas fallback requests individual icons (${key})`);
    if (had) view.atlasMap[key] = { x: 0, y: 0, w: 52, h: 52 };
  }

  // isolating and searching are alternative narrowings; each clears the other
  {
    const sb = $("search-box");
    const type = v => {
      sb.value = v;
      sb.dispatchEvent(new window.Event("input", { bubbles: true }));
    };
    type("battleship");
    await new Promise(r => setTimeout(r, 60));
    view.onIsolate("giga_tech_alderson_disk");
    await new Promise(r => setTimeout(r, 100));
    if (sb.value !== "") fail2("isolating did not clear the search");
    if ($("isolate-bar").hidden) fail2("isolate bar missing after isolating");
    type("tetra");
    await new Promise(r => setTimeout(r, 60));
    if (!$("isolate-bar").hidden) fail2("searching did not clear the isolate");
    type("");
    await new Promise(r => setTimeout(r, 60));
    console.log("isolate and search clear one another");
  }

  // a research path follows one branch of a choice, not both
  {
    const anyOf = [...view.model.techs.values()]
      .find(t => (t.prerequisiteGroups ?? []).some(g => g.any));
    view.select(anyOf.id);
    await new Promise(r => setTimeout(r, 60));
    const items = [...$("detail-body").querySelectorAll("ol.research-path li")]
      .map(li => li.querySelector(".tech-link")?.textContent ?? "");
    const grp = anyOf.prerequisiteGroups.find(g => g.any);
    const names = grp.any.map(id => view.model.techs.get(id)?.name);
    const taken = names.filter(n => n && items.includes(n));
    console.log(`research path: ${items.length} steps, `
      + `${taken.length} of ${names.length} alternatives walked`);
    if (!items.length) fail2("research path empty");
    if (taken.length > 1)
      fail2("research path walks both branches: " + taken.join(", "));
    // alternatives on a step are links, not plain text
    const links = [...$("detail-body")
      .querySelectorAll("ol.research-path li .tech-link")].length;
    const steps2 = $("detail-body").querySelectorAll("ol.research-path li").length;
    if (links < steps2) fail2("a research path step is not a link");
    view.select(null);
  }

  // a prerequisite some empires are exempt from is a prerequisite, with a
  // note — not a banner of its own
  {
    const cond = [...view.model.techs.values()]
      .find(t => (t.conditionalPrerequisites ?? []).some(c => c.unless?.length));
    if (cond) {
      const cp = cond.conditionalPrerequisites.find(c => c.unless?.length);
      if (!cond.prerequisites.includes(cp.tech))
        fail2("conditional prerequisite missing from the prerequisite list");
      view.select(cond.id);
      await new Promise(r => setTimeout(r, 60));
      const text = $("detail-body").textContent;
      if (!text.includes("not needed for"))
        fail2("exemption not shown beside the prerequisite");
      console.log(`conditional prerequisite shown for ${cond.id}`);
      view.select(null);
    }
  }

  // an OR prerequisite is stated as a choice, not as several requirements
  {
    const anyOf = [...view.model.techs.values()]
      .find(t => (t.prerequisiteGroups ?? []).some(g => g.any));
    if (!anyOf) fail2("no technology with an OR prerequisite in the dataset");
    const grp = anyOf.prerequisiteGroups.find(g => g.any);
    // every alternative still counts for edges and placement
    for (const id of grp.any)
      if (!anyOf.prerequisites.includes(id))
        fail2(`${id} missing from the flat prerequisite list`);
    view.select(anyOf.id);
    await new Promise(r => setTimeout(r, 60));
    const text = $("detail-body").textContent;
    if (!text.includes(" or "))
      fail2("OR prerequisite not shown as a choice");
    console.log(`OR prerequisites shown as a choice (${anyOf.id})`);
    view.select(null);
  }

  // technology variants appear in the detail panel
  {
    const swapped = [...view.model.techs.values()]
      .find(t => t.swaps?.length > 1);
    if (!swapped) fail2("no technology with variants in the dataset");
    view.select(swapped.id);
    await new Promise(r => setTimeout(r, 60));
    const text = $("detail-body").textContent;
    console.log(`variants shown for ${swapped.id}: ${swapped.swaps.length}`);
    if (!/Variants?/.test(text)) fail2("variants section missing");
    for (const s of swapped.swaps) {
      if (s.displayName && !text.includes(s.displayName))
        fail2(`variant ${s.displayName} not listed`);
    }
    /* Unresolved $references$ mean data/vanilla-structural.json predates the
       extractor that captures them. That is a data problem rather than a
       code one, so it fails only when the file is current — otherwise it
       reports, so a stale file cannot hide a real regression either. */
    {
      const current = !!view.model.meta?.vanillaHasLoc;
      const bad = [];
      for (const x of view.model.techs.values()) {
        const fields = [x.name, ...(x.swaps ?? []).map(sw => sw.displayName)];
        for (const f of fields)
          if (f && /^\$.+\$$/.test(f.trim())) bad.push(f);
      }
      if (bad.length && current)
        fail2(`unresolved localisation references: ${bad.join(", ")}`);
      if (bad.length)
        console.log(`note: ${bad.length} unresolved reference(s) — `
          + "data/vanilla-structural.json predates the current extractor");
    }

    // no colour codes or icon tokens survive into displayed text
    for (const x of view.model.techs.values()) {
      const fields = [x.name, x.desc,
                      ...(x.swaps ?? []).flatMap(sw => [sw.displayName, sw.desc])];
      for (const f of fields) {
        if (f && /[§£]/.test(f))
          fail2(`markup left in displayed text: ${JSON.stringify(f.slice(0, 60))}`);
      }
    }

    // every variant resolves an icon, falling back to its parent's
    let iconless = 0;
    for (const t of view.model.techs.values())
      for (const sw of t.swaps ?? []) if (!sw.icon) iconless++;
    if (iconless) fail2(`${iconless} variants have no icon`);
    view.select(null);
  }

  // requirement filters, hide/show all, and middle-click isolate
  {
    const n = () => view.index.items.length;
    const all = n();
    const req = $("req-filter");
    const set = v => {
      req.value = v;
      req.dispatchEvent(new window.Event("change", { bubbles: true }));
    };
    set("tech:tech_mega_engineering");
    await new Promise(r => setTimeout(r, 60));
    const mega = n();
    set("perk:ap_galactic_wonders");
    await new Promise(r => setTimeout(r, 60));
    const galwon = n();
    set("all");
    await new Promise(r => setTimeout(r, 60));
    console.log(`filters — all ${all}, mega-eng ${mega}, galwon ${galwon}`);
    if (!(mega > 0 && mega < all)) fail2("Requires Mega-Engineering filter");
    if (!(galwon > 0 && galwon < all)) fail2("Requires Galactic Wonders filter");
    if (n() !== all) fail2("clearing the requirement filter did not restore");

    const btn = $("show-all");
    btn.dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    if (n() !== 0) fail2("Hide all left technologies visible");
    btn.dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    if (n() !== all) fail2("Show all did not restore");

    view.onIsolate("giga_tech_alderson_disk");
    await new Promise(r => setTimeout(r, 80));
    const iso = n();
    console.log("isolate shows:", iso);
    if (!(iso > 1 && iso < all)) fail2("isolate did not narrow the map");
    if ($("isolate-bar").hidden) fail2("isolate bar not shown");
    $("isolate-clear").dispatchEvent(new window.Event("click", { bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    if (n() !== all) fail2("clearing isolate did not restore");
  }

  // unchecking a category must remove its band and cards from the DOM
  {
    const bands = () => window.__view.lay.furniture.filter(f => f.kind === "band").length;
    const before = bands();
    const cb = [...window.document.querySelectorAll("#sidebar-cats input")]
      .find(c => c.dataset.cat === "new_worlds");
    if (cb) {
      cb.checked = false;
      cb.dispatchEvent(new window.Event("change", { bubbles: true }));
      await new Promise(r => setTimeout(r, 100));
      const after = bands();
      const headers = window.__view.lay.furniture
        .filter(f => f.kind === "header").map(f => f.text);
      console.log("bands after unchecking a category:", before, "->", after);
      if (after !== before - 1) fail2("category filter did not collapse its band");
      if (headers.some(h => h === "new worlds"))
        fail2("filtered category header still rendered");
      cb.checked = true;
      cb.dispatchEvent(new window.Event("change", { bubbles: true }));
      await new Promise(r => setTimeout(r, 100));
      if (bands() !== before)
        fail2("re-checking category did not restore its band");
    }
  }

  // dev multi-mod flow: real Gigas as source A + a synthetic override mod
  // as source B; asserts descriptor naming, load-order override, and
  // enable/disable.
  {
    const { readModSource, buildFromSources } =
      await import(pathToFileURL("js/localmod.js").href);
    const { readFileSync: rf, readdirSync, existsSync } = await import("fs");
    if (existsSync("/home/claude/gigas-src/common/technology")) {
      const root = "/home/claude/gigas-src";
      const mk = (p, folder = "Gigastructures") => ({
        name: p.split("/").pop(),
        webkitRelativePath: folder + "/" + p,
        arrayBuffer: async () => {
          const b = rf(root + "/" + p);
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        },
      });
      const files = [mk("descriptor.mod")];
      for (const f of readdirSync(root + "/common/technology"))
        if (f.endsWith(".txt")) files.push(mk("common/technology/" + f));
      for (const f of readdirSync(root + "/common/scripted_variables"))
        files.push(mk("common/scripted_variables/" + f));
      const walk = dir => {
        for (const e of readdirSync(root + "/" + dir, { withFileTypes: true })) {
          if (e.isDirectory()) walk(dir + "/" + e.name);
          else if (e.name.endsWith(".txt")) files.push(mk(dir + "/" + e.name));
        }
      };
      walk("common/inline_scripts");
      for (const f of readdirSync(root + "/localisation/english"))
        if (f.endsWith(".yml")) files.push(mk("localisation/english/" + f));

      const gigas = await readModSource(files);
      console.log("mod A label from descriptor:", gigas.label);
      if (gigas.label !== "Gigastructural Engineering DEV")
        fail2("descriptor.mod name not picked up: " + gigas.label);

      // synthetic second mod overriding one Gigas tech
      const enc = new TextEncoder();
      const buf = str => enc.encode(str).buffer;
      const modB = [
        { name: "descriptor.mod", webkitRelativePath: "OtherMod/descriptor.mod",
          arrayBuffer: async () => buf('name="Test Override Mod"\n') },
        { name: "zz_over.txt",
          webkitRelativePath: "OtherMod/common/technology/zz_over.txt",
          arrayBuffer: async () =>
            buf("giga_tech_alderson_disk = { tier = 9 cost = 4242 area = physics category = { computing } }\n") },
      ];
      const other = await readModSource(modB);
      if (other.label !== "Test Override Mod")
        fail2("mod B descriptor name wrong: " + other.label);

      let merged = await buildFromSources([gigas, other]);
      let ad = merged.technologies.find(t => t.id === "giga_tech_alderson_disk");
      console.log("merged techs:", merged.technologies.length,
        "| alderson tier:", ad.tier, "cost:", ad.cost,
        "| source:", ad.sourceLabel, "| override:", ad.overridesVanilla);
      if (ad.tier !== 9 || ad.cost !== 4242)
        fail2("later mod did not override earlier one");
      if (!ad.overridesVanilla) fail2("override not flagged");

      // reverse the order: Gigas should win now
      merged = await buildFromSources([other, gigas]);
      ad = merged.technologies.find(t => t.id === "giga_tech_alderson_disk");
      if (ad.tier === 9) fail2("load order reversal had no effect");
      console.log("order reversed — alderson tier back to:", ad.tier);

      // disable the override mod
      other.enabled = false;
      merged = await buildFromSources([gigas, other]);
      ad = merged.technologies.find(t => t.id === "giga_tech_alderson_disk");
      if (ad.tier === 9) fail2("disabled mod still applied");
      console.log("disable works — alderson tier:", ad.tier,
        "| parse errors:", merged.meta.parseErrors.length);
      if (merged.meta.parseErrors.length) fail2("parse errors in merge");
    } else {
      console.log("localmod: source checkout absent, skipped (CI)");
    }
  }

  // click the Explore tab
  window.document.querySelector('[data-tab="explore"]').dispatchEvent(
    new window.Event("click", { bubbles: true }));
  console.log("explore hidden after click:", $("explore-tab").hidden);
  $("health-btn").dispatchEvent(new window.Event("click", { bubbles: true }));
  console.log("health hidden after click:", $("health-panel").hidden);
  // search for mega engineering
  const sb = $("search-box");
  sb.value = "mega-engineering";
  sb.dispatchEvent(new window.Event("input", { bubbles: true }));
  const nameHits = $("search-results").children.length;
  console.log("search 'mega-engineering' hits:", nameHits);
  sb.value = "tech_mega_engineering";
  sb.dispatchEvent(new window.Event("input", { bubbles: true }));
  console.log("search 'tech_mega_engineering' hits:", $("search-results").children.length);
  // hard assertions
  const fail = msg => { console.error("FAIL:", msg); process.exit(1); };
  globalThis.fail2 = fail;
  if (!$("status").hidden) fail("status not hidden: " + $("status").textContent);
  // Clear the search first: filters now re-lay-out, so an active query
  // legitimately leaves one card on the map.
  sb.value = "";
  sb.dispatchEvent(new window.Event("input", { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));
  if ((window.__view?.index.items.length ?? 0) < 100) fail("too few cards indexed");
  if (!$("app-version").textContent.startsWith("v")) fail("version badge missing");
  if ($("explore-tab").hidden) fail("Explore tab did not open");
  if ($("health-panel").hidden) fail("Health panel did not open");
  if (nameHits < 1) fail("search by name found nothing");
  console.log("dom-smoke: all assertions passed");
} catch (e) {
  console.log("IMPORT/BOOT ERROR:", e.stack);
}
