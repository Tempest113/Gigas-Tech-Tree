/* layout.js — spec §8, revised after first-look feedback.

   Columns = tier, but each tier is subdivided into dependency *sub-columns*:
   a tech's sub-rank is the longest chain of same-tier prerequisites feeding
   it, so a T5 tech that needs two other T5 techs sits two sub-columns right
   of the tier's left edge — a flowchart within the tier instead of one tall
   stack.

   Sections = category (deduplicated across areas; a category appears once).
   Ordered by the area owning most of its techs, then name. Node order within
   each cell via barycentre sweeps, alphabetical tie-breaks. Deterministic. */

export const CARD_W = 208, CARD_H = 64;
const SUBCOL_GAP = 44;        // between sub-columns inside a tier
const TIER_GAP = 140;         // between tiers
const ROW_GAP = 16, SECTION_GAP = 90, SECTION_PAD_TOP = 108;
const MAX_ROWS = 8;           // wrap taller stacks into extra columns
const AREA_ORDER = ["physics", "society", "engineering", null];

export function layout(techs, visible = null) {
  // `visible` (a Set of ids, or null) lets the caller lay out only the
  // filtered subset, so hidden categories collapse their row entirely
  // rather than leaving an empty band.
  const nodes = [...techs.values()]
    .filter(t => visible === null || visible.has(t.id));
  if (!nodes.length) {
    return { pos: new Map(), furniture: [], width: 0, height: 0 };
  }

  const tiers = [...new Set(nodes.filter(t => !t.isRepeatable)
    .map(t => t.tier).filter(t => t !== null))].sort((a, b) => a - b);
  const tierIndex = new Map(tiers.map((t, i) => [t, i + 1])); // 0 = untiered
  // Column slots: [untiered] [tier…] [repeatables]. Repeatables live in
  // their own trailing column regardless of numeric tier (their tier still
  // shows on the card badge).
  const nTiers = tiers.length + 2;
  const REP = nTiers - 1;
  const tierOf = t => t.isRepeatable ? REP
    : (t.tier === null || !tierIndex.has(t.tier)) ? 0
    : tierIndex.get(t.tier);

  // -- within-tier sub-rank: longest same-tier prerequisite chain ---------
  const subRank = new Map();
  const visiting = new Set();
  const rankOf = t => {
    if (subRank.has(t.id)) return subRank.get(t.id);
    if (visiting.has(t.id)) return 0;          // cycle guard
    visiting.add(t.id);
    let r = 0;
    for (const pid of t.prerequisites) {
      const p = techs.get(pid);
      if (p && tierOf(p) === tierOf(t)) {
        r = Math.max(r, rankOf(p) + 1);
      }
    }
    visiting.delete(t.id);
    subRank.set(t.id, r);
    return r;
  };
  for (const t of nodes) rankOf(t);

  // Per-(section, tier) cells: sub-ranks are compressed to the ranks
  // actually used in that cell (a cell whose techs are all rank 0 is one
  // column wide even if another section's chains reach rank 5), and stacks
  // taller than MAX_ROWS wrap into extra columns. Global tier width = the
  // widest cell in that tier, so tier bands still align vertically without
  // every band paying for the deepest chain anywhere in the tree.

  // -- sections: one per category, area-independent -----------------------
  const sections = new Map();
  const sectionArea = new Map();  // category -> area counts
  for (const t of nodes) {
    const cat = t.categories[0] ?? "~none";
    if (!sections.has(cat)) {
      sections.set(cat, []);
      sectionArea.set(cat, new Map());
    }
    sections.get(cat).push(t);
    const ac = sectionArea.get(cat);
    ac.set(t.area, (ac.get(t.area) ?? 0) + 1);
  }
  // Matches panels.js: a category spread across areas is not filed under
  // any single one.
  const dominantArea = cat => {
    const m = sectionArea.get(cat);
    let best = null, n = -1, total = 0;
    for (const [a, c] of m) {
      total += c;
      if (c > n || (c === n && String(a) < String(best))) { best = a; n = c; }
    }
    if (m.size > 1 && n / total < 0.8) return null;
    return best;
  };
  const sectionKeys = [...sections.keys()].sort((a, b) => {
    const ai = AREA_ORDER.indexOf(dominantArea(a));
    const bi = AREA_ORDER.indexOf(dominantArea(b));
    if (ai !== bi) return ai - bi;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  // Globally used ranks per tier (sorted) — the shared column skeleton.
  const tierRanks = Array.from({ length: nTiers }, () => new Set());
  for (const t of nodes) tierRanks[tierOf(t)].add(subRank.get(t.id));
  const tierRanksSorted = tierRanks.map(s => [...s].sort((a, b) => a - b));
  for (let i = 0; i < nTiers; i++) tierRanks[i] = tierRanksSorted[i];

  // Pass 1: build every section's cells, measure tier widths.
  const sectionCells = new Map();   // key -> cells[tier] = [col][row of techs]
  const tierColsMax = new Array(nTiers).fill(1);

  for (const key of sectionKeys) {
    const members = sections.get(key);
    const byTier = Array.from({ length: nTiers }, () => new Map());
    for (const t of members) {
      const m = byTier[tierOf(t)];
      const r = subRank.get(t.id);
      if (!m.has(r)) m.set(r, []);
      m.get(r).push(t);
    }
    const cells = byTier.map((m, ti) => {
      // Columns follow the tier's *globally used* rank list so a tech is
      // never left of a same-tier prerequisite in another section
      // ("techs ahead of their prerequisites"); ranks this section doesn't
      // use become empty columns (cheap: width only, no cards). Over-tall
      // ranks wrap into extra columns, which only ever push later ranks
      // right — still forward.
      const globalRanks = tierRanks[ti];
      const out = [];
      for (const r of globalRanks) {
        const col = m.get(r);
        if (!col) { out.push([]); continue; }
        col.sort((a, b) => (a.id < b.id ? -1 : 1));
        for (let i = 0; i < col.length; i += MAX_ROWS)
          out.push(col.slice(i, i + MAX_ROWS));
      }
      return out.length ? out : [[]];
    });
    cells.forEach((c, ti) => {
      tierColsMax[ti] = Math.max(tierColsMax[ti], c.length);
    });
    sectionCells.set(key, cells);
  }

  const tierX = new Array(nTiers);
  const tierW = new Array(nTiers);
  {
    let x = 0;
    for (let i = 0; i < nTiers; i++) {
      tierX[i] = x;
      tierW[i] = tierColsMax[i] * CARD_W + (tierColsMax[i] - 1) * SUBCOL_GAP;
      x += tierW[i] + TIER_GAP;
    }
  }
  const worldW = tierX[nTiers - 1] + tierW[nTiers - 1];

  const pos = new Map();
  const furniture = [];
  const sectionTops = [];
  let yCursor = SECTION_PAD_TOP;

  for (const key of sectionKeys) {
    sectionTops.push(yCursor);
    const cells = sectionCells.get(key);
    const flatCols = [];
    for (const tierCols of cells) for (const c of tierCols) flatCols.push(c);
    orderByBarycentre(flatCols);

    const rows = Math.max(1, ...flatCols.map(c => c.length));
    const sectionH = rows * (CARD_H + ROW_GAP);

    {
      const label = key === "~none" ? "uncategorised"
        : key.replace(/_/g, " ");
      const area = dominantArea(key);
      const count = sections.get(key).length;
      furniture.push({ kind: "band", x: -24, y: yCursor - 46,
                       w: worldW + 48, h: sectionH + 58, area, cat: key });
      furniture.push({ kind: "header", text: label, count,
                       x: -8, y: yCursor - 40, area, cat: key });
    }

    for (let ti = 0; ti < nTiers; ti++) {
      cells[ti].forEach((col, si) => {
        const x = tierX[ti] + si * (CARD_W + SUBCOL_GAP);
        col.forEach((t, ri) => {
          pos.set(t.id, { x, y: yCursor + ri * (CARD_H + ROW_GAP) });
        });
      });
    }
    yCursor += sectionH + SECTION_GAP;
  }

  // Tier columns: a full-height wash alternating in brightness so tier
  // boundaries read at any zoom, plus labels repeated above every section
  // (not just at the top of the world).
  const colLabel = i =>
    i === 0 ? "Untiered" : i === REP ? "Repeatables" : `Tier ${tiers[i - 1]}`;
  for (let i = 0; i < nTiers; i++) {
    furniture.push({
      kind: "tiercolumn", index: i, parity: i % 2,
      x: tierX[i] - TIER_GAP / 2, y: 0,
      w: tierW[i] + TIER_GAP, h: yCursor,
    });
    furniture.push({ kind: "tierlabel", text: colLabel(i), x: tierX[i], y: 14 });
    for (const y of sectionTops) {
      furniture.push({ kind: "tierlabel", text: colLabel(i),
                       x: tierX[i], y: y - 34, small: true });
    }
  }

  return { pos, furniture, width: worldW, height: yCursor };
}

function orderByBarycentre(cols) {
  const rowOf = new Map();
  const reindex = () =>
    cols.forEach(c => c.forEach((t, i) => rowOf.set(t.id, i)));
  reindex();

  const neighboursIn = (t, colSet) => {
    const out = [];
    for (const pid of t.prerequisites)
      if (colSet.has(pid)) out.push(rowOf.get(pid));
    for (const uid of t.unlocks)
      if (colSet.has(uid)) out.push(rowOf.get(uid));
    return out;
  };

  for (let pass = 0; pass < 8; pass++) {
    const forward = pass % 2 === 0;
    const idxs = forward
      ? [...cols.keys()].slice(1)
      : [...cols.keys()].slice(0, -1).reverse();
    for (const ci of idxs) {
      const ref = cols[forward ? ci - 1 : ci + 1];
      if (!ref.length || !cols[ci].length) continue;
      const refSet = new Set(ref.map(t => t.id));
      cols[ci].sort((a, b) => {
        const na = neighboursIn(a, refSet), nb = neighboursIn(b, refSet);
        const ba = na.length ? na.reduce((s, v) => s + v, 0) / na.length : rowOf.get(a.id);
        const bb = nb.length ? nb.reduce((s, v) => s + v, 0) / nb.length : rowOf.get(b.id);
        if (ba !== bb) return ba - bb;
        return a.id < b.id ? -1 : 1;
      });
      reindex();
    }
  }
}
