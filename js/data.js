/* data.js — manifest + dataset loading, vanilla composition.

   Composition order (docs/vanilla-data.md):
   1. mod dataset (always)
   2. data/vanilla-structural.json if present (option C facts)
   3. any prerequisite id still unknown becomes a stub node (option D)
*/

/* Data files keep stable names across releases, so a browser will happily
   reuse a cached copy after an update. Version the request the same way
   index.html versions its script and stylesheet. */
import { APP_VERSION } from "./version.js";

const v = url => `${url}${url.includes("?") ? "&" : "?"}v=${APP_VERSION}`;

export async function loadManifest() {
  const r = await fetch(v("data/manifest.json"));
  if (!r.ok) throw new Error(`manifest.json: HTTP ${r.status}`);
  return r.json();
}

export async function loadDataset(entry) {
  const r = await fetch(v(`data/${entry.file}`));
  if (!r.ok) throw new Error(`${entry.file}: HTTP ${r.status}`);
  const model = await r.json();
  return compose(model, await loadVanilla());
}

export async function loadVanilla() {
  try {
    const rv = await fetch(v("data/vanilla-structural.json"));
    if (rv.ok) return await rv.json();
  } catch { /* absent: mod-only mode */ }
  return null;
}

export function compose(model, vanilla) {
  const byId = new Map();
  for (const t of model.technologies) byId.set(t.id, { ...t, stub: false });

  if (vanilla) {
    for (const v of vanilla.technologies) {
      if (byId.has(v.id)) {
        // Mod override wins structurally, but its display name/desc may
        // live in vanilla loc (tech_mega_engineering, tech_ring_world):
        // backfill what the mod's own localisation couldn't provide.
        const e = byId.get(v.id);
        if (e.nameMissing && v.name) { e.name = v.name; e.nameMissing = false; }
        if (e.desc == null && v.desc) e.desc = v.desc;
        if (e.icon == null) e.icon = v.icon ?? v.id;
        continue;
      }
      byId.set(v.id, {
        id: v.id,
        name: v.name ?? v.id,   // present when extracted with --loc
        nameMissing: false,     // not a *mod* loc problem
        desc: v.desc ?? null,   // present when extracted with --desc
        icon: v.icon ?? v.id,   // explicit key, else id-named file
        area: v.area, categories: v.categories, tier: v.tier,
        cost: v.cost ?? null, weight: v.weight ?? null,
        levels: v.levels ?? null, costPerLevel: null,
        isStart: v.isStart, isRare: v.isRare, isDangerous: v.isDangerous,
        isRepeatable: v.isRepeatable,
        prerequisites: v.prerequisites, unlocks: [],
        unlockText: [], weightModifiers: [], swaps: [],
        crossModGated: false, source: "vanilla", overridesVanilla: false,
        sourceFile: null, stub: false, vanillaStructural: true,
      });
    }
  }

  // Recompute unlocks over the composed set, then stub what's left.
  for (const t of byId.values()) t.unlocks = [];
  const stubs = [];
  for (const t of [...byId.values()]) {
    for (const pid of t.prerequisites) {
      let p = byId.get(pid);
      if (!p) {
        p = makeStub(pid);
        byId.set(pid, p);
        stubs.push(pid);
      }
      p.unlocks.push(t.id);
    }
  }
  for (const t of byId.values()) t.unlocks.sort();

  // Stubs (ids referenced but defined nowhere — with vanilla data present,
  // these are external-mod techs like ACOT's) collocate with the techs that
  // need them: inherit the first dependent's section and tier band so e.g.
  // ACOT power cores sit beside the supertensile chain, not in a far-off
  // uncategorised corner.
  for (const id of stubs) {
    const s = byId.get(id);
    const dep = s.unlocks.map(u => byId.get(u))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .find(x => x && !x.stub);
    if (dep) {
      s.area = dep.area;
      s.categories = dep.categories;
      s.tier = dep.tier;
      s.inferredPlacement = true;
    }
  }

  return {
    tierReqs: vanilla?.tiers ?? {},
    meta: model.meta,
    categories: model.categories,
    health: model.health,
    vanillaKind: vanilla ? "structural" : "none",
    techs: byId,
    stubIds: stubs.sort(),
  };
}

function makeStub(id) {
  return {
    id, name: id, nameMissing: false, desc: null,
    area: null, categories: [], tier: null,
    cost: null, weight: null, levels: null, costPerLevel: null,
    isStart: false, isRare: false, isDangerous: false, isRepeatable: false,
    prerequisites: [], unlocks: [],
    unlockText: [], weightModifiers: [], swaps: [],
    crossModGated: false, source: "vanilla", overridesVanilla: false,
    sourceFile: null, stub: true,
  };
}
