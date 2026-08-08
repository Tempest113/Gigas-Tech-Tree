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
// canvas 2d stub
const noop = new Proxy({}, { get: () => () => noop, set: () => true });
window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
  get: (t, p) => (typeof p === "string" ? (() => {}) : undefined),
  set: () => true,
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
  console.log("cards rendered:", window.document.querySelectorAll(".tech-card").length);
  console.log("sidebar cats:", window.document.querySelectorAll(".sidebar-cat").length);
  console.log("explore rows:", window.document.querySelectorAll(".explore-table tbody tr").length);
  console.log("health sections:", $("health-body").querySelectorAll("h3").length);
  // map click: pointerdown/up on a card must select it and persist the
  // lineage highlight (dimmed classes on unrelated cards)
  window.HTMLElement.prototype.setPointerCapture ??= function(){};
  const card = window.document.querySelector('.tech-card[data-id]');
  const pev = t => new window.Event(t, { bubbles: true });
  card.dispatchEvent(pev("pointerdown"));
  card.dispatchEvent(pev("pointerup"));
  await new Promise(r => setTimeout(r, 50));
  const dimmed = window.document.querySelectorAll(".tech-card.dimmed").length;
  const selected = window.document.querySelectorAll(".tech-card.selected").length;
  console.log("after map click — selected:", selected, "dimmed:", dimmed);
  // hover another card while selected: highlight must NOT move
  const other = window.document.querySelectorAll('.tech-card[data-id]')[5];
  other.dispatchEvent(pev("pointerover"));
  const dimmed2 = window.document.querySelectorAll(".tech-card.dimmed").length;
  console.log("after hovering other card — dimmed unchanged:", dimmed === dimmed2);
  // click blank space clears
  window.document.getElementById("world").dispatchEvent(pev("pointerdown"));
  window.document.getElementById("world").dispatchEvent(pev("pointerup"));
  const dimmed3 = window.document.querySelectorAll(".tech-card.dimmed").length;
  console.log("after blank click — dimmed:", dimmed3);

  // unchecking a category must remove its band and cards from the DOM
  {
    const before = window.document.querySelectorAll(".section-band").length;
    const cb = [...window.document.querySelectorAll("#sidebar-cats input")]
      .find(c => c.dataset.cat === "new_worlds");
    if (cb) {
      cb.checked = false;
      cb.dispatchEvent(new window.Event("change", { bubbles: true }));
      await new Promise(r => setTimeout(r, 100));
      const after = window.document.querySelectorAll(".section-band").length;
      const headers = [...window.document.querySelectorAll(".section-header")]
        .map(h => h.textContent);
      console.log("bands after unchecking a category:", before, "->", after);
      if (after !== before - 1) fail2("category filter did not collapse its band");
      if (headers.some(h => h.startsWith("new worlds")))
        fail2("filtered category header still rendered");
      cb.checked = true;
      cb.dispatchEvent(new window.Event("change", { bubbles: true }));
      await new Promise(r => setTimeout(r, 100));
      if (window.document.querySelectorAll(".section-band").length !== before)
        fail2("re-checking category did not restore its band");
    }
  }

  // filter -> jump -> clear filter: cards must reappear without a zoom
  sbPre: {
    const sb0 = $("search-box");
    sb0.value = "blokkat";
    sb0.dispatchEvent(new window.Event("input", { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    sb0.value = "";
    sb0.dispatchEvent(new window.Event("input", { bubbles: true }));
    await new Promise(r => setTimeout(r, 50));
    const ghosts = [...window.document.querySelectorAll(".tech-card")]
      .filter(el => !el.classList.contains("hidden") &&
                    el.style.display === "none" && el._culled === false);
    console.log("stale-culled cards after filter clear:", ghosts.length);
    if (ghosts.length) fail2("cards stayed culled after filter clear");
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
  if (window.document.querySelectorAll(".tech-card").length < 100) fail("too few cards");
  if (!$("app-version").textContent.startsWith("v")) fail("version badge missing");
  if ($("explore-tab").hidden) fail("Explore tab did not open");
  if ($("health-panel").hidden) fail("Health panel did not open");
  if (nameHits < 1) fail("search by name found nothing");
  if (selected !== 1) fail("map click did not select");
  if (dimmed < 100) fail("map click did not dim unrelated cards");
  if (dimmed !== dimmed2) fail("hover stole highlight from selection");
  if (dimmed3 !== 0) fail("blank click did not clear highlight");
  console.log("dom-smoke: all assertions passed");
} catch (e) {
  console.log("IMPORT/BOOT ERROR:", e.stack);
}
