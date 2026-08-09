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
        ascensionPerks: v.ascensionPerks ?? [], inheritedPerks: [],
        softPerks: v.softPerks ?? [],
        grantedByPerks: v.grantedByPerks ?? [],
        perkReasons: v.perkReasons ?? {},
        perkGroups: v.perkGroups ?? [],
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

  // Perk grants from the mod apply to base-game technologies as well.
  for (const [techId, perks] of Object.entries(model.meta?.perkGrants ?? {})) {
    const t = byId.get(techId);
    if (!t) continue;
    t.grantedByPerks = [...new Set([...(t.grantedByPerks ?? []), ...perks])];
    t.perkReasons = { ...(t.perkReasons ?? {}) };
    const manual = model.meta?.manualPerkGrants?.[techId] ?? [];
    for (const p of perks) {
      if (!(t.ascensionPerks ?? []).includes(p)) {
        t.ascensionPerks = [...(t.ascensionPerks ?? []), p];
        t.perkReasons[p] = manual.includes(p) ? "manual" : "granted";
      }
    }
  }

  propagatePerks(byId);

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
    // Mod perk names override vanilla's: a mod may redefine a perk's name,
    // and several of these perks exist only in the mod.
    perkNames: { ...(model.meta?.perkNamesFallback ?? {}),
                 ...(vanilla?.ascensionPerks ?? {}),
                 ...(model.meta?.perkNames ?? {}) },
    meta: model.meta,
    categories: model.categories,
    health: model.health,
    vanillaKind: vanilla ? "structural" : "none",
    techs: byId,
    stubIds: stubs.sort(),
  };
}

/* An ascension perk requirement carries down the prerequisite graph: a
   technology behind Ring World is equally unreachable without Galactic
   Wonders. Recomputed here rather than at build time because the mod and
   vanilla halves are only joined once composed. Depth-first with a visiting
   set, so prerequisite cycles terminate. */
function propagatePerks(byId) {
  const done = new Set();
  const visiting = new Set();

  const visit = id => {
    if (done.has(id) || visiting.has(id)) return;
    visiting.add(id);
    const t = byId.get(id);
    if (t) {
      const inherited = new Set(t.inheritedPerks ?? []);
      const soft = new Set(t.softPerks ?? []);
      for (const pid of t.prerequisites) {
        visit(pid);
        const p = byId.get(pid);
        if (!p) continue;
        for (const perk of [...(p.ascensionPerks ?? []),
                            ...(p.inheritedPerks ?? [])]) {
          if (!(t.ascensionPerks ?? []).includes(perk)) inherited.add(perk);
        }
        // A perk that is one route of several carries down the same way,
        // so a technology behind Tetradimensional Engineering is placed
        // with it rather than among the ungated ones.
        for (const perk of p.softPerks ?? []) {
          if (!(t.ascensionPerks ?? []).includes(perk) &&
              !inherited.has(perk)) soft.add(perk);
        }
      }
      t.inheritedPerks = [...inherited].sort();
      t.softPerks = [...soft].sort();
    }
    visiting.delete(id);
    done.add(id);
  };

  for (const id of [...byId.keys()].sort()) visit(id);
}

function makeStub(id) {
  return {
    id, name: id, nameMissing: false, desc: null,
    area: null, categories: [], tier: null,
    cost: null, weight: null, levels: null, costPerLevel: null,
    isStart: false, isRare: false, isDangerous: false, isRepeatable: false,
    prerequisites: [], unlocks: [],
    ascensionPerks: [], inheritedPerks: [],
    unlockText: [], weightModifiers: [], swaps: [],
    crossModGated: false, source: "vanilla", overridesVanilla: false,
    sourceFile: null, stub: true,
  };
}
