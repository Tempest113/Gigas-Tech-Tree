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

  // dev local-mod flow: feed real mod files through the browser-side path
  {
    const { loadLocalMod } = await import(pathToFileURL("js/localmod.js").href);
    const { compose } = await import(pathToFileURL("js/data.js").href);
    const { readFileSync: rf, readdirSync, existsSync } = await import("fs");
    if (existsSync("/home/claude/gigas-src/common/technology")) {
      const mk = (p, root) => ({
        name: p.split("/").pop(),
        webkitRelativePath: "mod/" + p,
        // Node Buffers view a shared pool; slice to this file's bytes
        // (browser File.arrayBuffer() has no such trap).
        arrayBuffer: async () => {
          const b = rf(root + "/" + p);
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        },
      });
      const files = [];
      const root = "/home/claude/gigas-src";
      for (const f of readdirSync(root + "/common/technology"))
        if (f.endsWith(".txt")) files.push(mk("common/technology/" + f, root));
      for (const f of readdirSync(root + "/common/scripted_variables"))
        files.push(mk("common/scripted_variables/" + f, root));
      const walk = (dir, relp) => {
        for (const e of readdirSync(root + "/" + dir, { withFileTypes: true })) {
          if (e.isDirectory()) walk(dir + "/" + e.name, relp + "/" + e.name);
          else if (e.name.endsWith(".txt"))
            files.push(mk(dir + "/" + e.name, root));
        }
      };
      walk("common/inline_scripts", "common/inline_scripts");
      for (const f of readdirSync(root + "/localisation/english"))
        if (f.endsWith(".yml"))
          files.push(mk("localisation/english/" + f, root));
      const localModel = await loadLocalMod(files, "Gigas-local");
      console.log("localmod techs:", localModel.technologies.length,
        " parse errors:", localModel.meta.parseErrors.length);
      const t = localModel.technologies.find(
        x => x.id === "giga_tech_repeatable_dyson_swarm_cap");
      console.log("localmod dyson swarm:", t?.name, "T", t?.tier,
        "cost", t?.cost);
      if (localModel.technologies.length < 250) fail2("localmod too few techs");
      if (t?.name !== "Dyson Swarm Management Protocols")
        fail2("localmod inline/loc pipeline broken: " + t?.name);
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
  console.log("search 'mega-engineering' hits:", $("search-results").children.length);
  sb.value = "tech_mega_engineering";
  sb.dispatchEvent(new window.Event("input", { bubbles: true }));
  console.log("search 'tech_mega_engineering' hits:", $("search-results").children.length);
  // hard assertions
  const fail = msg => { console.error("FAIL:", msg); process.exit(1); };
  globalThis.fail2 = fail;
  if (!$("status").hidden) fail("status not hidden: " + $("status").textContent);
  if (window.document.querySelectorAll(".tech-card").length < 100) fail("too few cards");
  if ($("explore-tab").hidden) fail("Explore tab did not open");
  if ($("health-panel").hidden) fail("Health panel did not open");
  if ($("search-results").children.length < 1) fail("search by name found nothing");
  if (selected !== 1) fail("map click did not select");
  if (dimmed < 100) fail("map click did not dim unrelated cards");
  if (dimmed !== dimmed2) fail("hover stole highlight from selection");
  if (dimmed3 !== 0) fail("blank click did not clear highlight");
  console.log("dom-smoke: all assertions passed");
} catch (e) {
  console.log("IMPORT/BOOT ERROR:", e.stack);
}
