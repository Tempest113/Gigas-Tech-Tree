// Unit tests for js/viewmodel.js — the picking/culling logic the canvas
// renderer depends on. Runs in plain Node: node tests/viewmodel-test.mjs
import { readFileSync } from "fs";
import { buildIndex, CARD_H, CARD_W, clampScale, hitTest, lineageOf,
         viewportRect, visibleCards } from "../js/viewmodel.js";
import { layout } from "../js/layout.js";

let failures = 0;
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); failures++; } };

// -- synthetic geometry -----------------------------------------------------
{
  const lay = { pos: new Map([
    ["a", { x: 0, y: 0 }],
    ["b", { x: 300, y: 0 }],
    ["c", { x: 0, y: 500 }],
  ]) };
  const idx = buildIndex(lay, null);
  ok(idx.items.length === 3, "index holds every placed card");

  const r = viewportRect(0, 0, 1, 400, 200, 0);
  const vis = visibleCards(idx, r).map(i => i.id);
  ok(vis.includes("a") && vis.includes("b"), "viewport keeps on-screen cards");
  ok(!vis.includes("c"), "viewport drops off-screen cards");

  ok(hitTest(idx, 10, 10) === "a", "hit test finds a card");
  ok(hitTest(idx, CARD_W + 40, 10) === null, "hit test misses the gap");
  ok(hitTest(idx, 305, CARD_H - 1) === "b", "hit test respects card bounds");

  const filtered = buildIndex(lay, new Set(["a"]));
  ok(filtered.items.length === 1, "filter excludes cards from the index");
  ok(hitTest(filtered, 305, 10) === null, "filtered card is not pickable");
}

// -- lineage ---------------------------------------------------------------
{
  const techs = new Map([
    ["root", { id: "root", prerequisites: [], unlocks: ["mid"] }],
    ["mid", { id: "mid", prerequisites: ["root"], unlocks: ["leaf"] }],
    ["leaf", { id: "leaf", prerequisites: ["mid"], unlocks: [] }],
    ["other", { id: "other", prerequisites: [], unlocks: [] }],
  ]);
  const lin = lineageOf(techs, "mid");
  ok(lin.has("root") && lin.has("leaf") && lin.has("mid"),
     "lineage spans ancestors and descendants");
  ok(!lin.has("other"), "lineage excludes unrelated technologies");

  // cycles must terminate
  const cyc = new Map([
    ["a", { prerequisites: ["b"], unlocks: ["b"] }],
    ["b", { prerequisites: ["a"], unlocks: ["a"] }],
  ]);
  ok(lineageOf(cyc, "a").size === 2, "lineage terminates on a cycle");
}

// -- zoom clamp ------------------------------------------------------------
ok(clampScale(99) === 2.5 && clampScale(0.0001) === 0.05, "zoom is clamped");

// -- real dataset: culling actually reduces work ---------------------------
{
  // Read the dataset the manifest points at. The refresh workflow names the
  // file after the upstream commit, so hardcoding it here breaks the suite —
  // and with it the deploy — on the next data refresh.
  const manifest = JSON.parse(readFileSync(
    new URL("../data/manifest.json", import.meta.url)));
  const entry = manifest.datasets.find(d => d.id === "gigas") ?? manifest.datasets[0];
  const model = JSON.parse(readFileSync(
    new URL(`../data/${entry.file}`, import.meta.url)));
  const vanilla = JSON.parse(readFileSync(
    new URL("../data/vanilla-structural.json", import.meta.url)));
  const techs = new Map();
  for (const t of model.technologies) techs.set(t.id, { ...t, unlocks: [] });
  for (const v of vanilla.technologies)
    if (!techs.has(v.id))
      techs.set(v.id, { ...v, unlocks: [], prerequisites: v.prerequisites ?? [] });
  for (const t of techs.values())
    for (const p of t.prerequisites ?? [])
      techs.get(p)?.unlocks.push(t.id);

  const lay = layout(techs);
  const idx = buildIndex(lay, null);
  const total = idx.items.length;

  // 1080p viewport at 100% zoom
  const shown = visibleCards(idx, viewportRect(0, 0, 1, 1920, 1080)).length;
  console.log(`cards placed: ${total}, drawn at 100% zoom: ${shown}`);
  ok(shown < total * 0.2,
     `culling should draw a small fraction at 1:1 (got ${shown}/${total})`);

  // Fully zoomed out, everything is legitimately on screen.
  const all = visibleCards(idx, viewportRect(0, 0, 0.05, 1920, 1080)).length;
  console.log(`drawn at 5% zoom: ${all}`);
  ok(all === total, "at minimum zoom every card is drawn");

  // Picking on the real layout hits the right technology.
  const [someId, somePos] = [...lay.pos.entries()][400];
  ok(hitTest(idx, somePos.x + 5, somePos.y + 5) === someId,
     "hit test resolves a real card");
}

if (failures) { console.error(`viewmodel: ${failures} FAILURES`); process.exit(1); }
console.log("viewmodel: all assertions passed");
