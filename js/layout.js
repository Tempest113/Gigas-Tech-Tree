/* layout.js — column assignment and section placement.

   The x axis was tier index, with dependency ordering applied only within a
   tier. That let a technology sit left of a prerequisite whenever the two
   disagreed with the tier numbers (Exodus Jump Coordinator ahead of Jump
   Drives), and it could not express progression through ascension perks.

   Columns are now assigned by relaxation: every technology starts at a seed
   column and is then pushed right until it sits strictly right of every one
   of its prerequisites. Two seeds are available:

     "tier"  seed = the technology's tier, nudged right by its ascension
             gate, so tier progression reads left to right and gated
             technologies sit beyond ungated ones of the same tier;
     "gate"  seed = the ascension gate alone — no gate, Mega-Engineering,
             Galactic Wonders, Gigastructural Constructs — for reading
             progression through the perks.

   Because relaxation only ever moves a technology right, the invariant
   "every prerequisite is to the left" holds in both modes. */

import { MISC_CATEGORIES } from "./viewmodel.js";

export const CARD_W = 208, CARD_H = 64;
const COL_GAP = 56;
const SUBCOL_GAP = 24;        // between sub-columns of one crowded column
const GROUP_GAP = 120;        // extra space at a tier/gate boundary
const ROW_GAP = 16, SECTION_GAP = 90, SECTION_PAD_TOP = 108;
const MAX_ROWS = 8;
const AREA_ORDER = ["physics", "society", "engineering", null];

export const GATES = [
  { id: "none", label: "No Gate" },
  { id: "mega", label: "Mega-Engineering", tech: "tech_mega_engineering" },
  { id: "galwon", label: "Galactic Wonders", perk: "ap_galactic_wonders" },
  { id: "gigacon", label: "Gigastructural Constructs",
    perk: "ap_gigastructural_constructs" },
];

/* Highest gate a technology sits behind. Perks are checked first because
   they are the stronger statement; Mega-Engineering counts when it is
   somewhere in the prerequisite chain. */
function gateRank(t, needsMega) {
  // Soft perks count here: a technology reachable only through
  // Gigastructural Constructs or a questline flag belongs with the gated
  // ones, not among those needing nothing.
  const perks = [...(t.ascensionPerks ?? []), ...(t.inheritedPerks ?? []),
                 ...(t.softPerks ?? [])];
  if (perks.includes("ap_gigastructural_constructs")) return 3;
  if (perks.includes("ap_galactic_wonders")) return 2;
  if (needsMega.has(t.id)) return 1;
  return 0;
}

function megaDescendants(techs) {
  const out = new Set();
  const start = techs.get("tech_mega_engineering");
  if (!start) return out;
  const stack = ["tech_mega_engineering"];
  while (stack.length) {
    const t = techs.get(stack.pop());
    if (!t) continue;
    for (const n of t.unlocks ?? []) {
      if (!out.has(n)) { out.add(n); stack.push(n); }
    }
  }
  return out;
}

export function layout(techs, visible = null, mode = "tier") {
  const nodes = [...techs.values()]
    .filter(t => visible === null || visible.has(t.id));
  if (!nodes.length) {
    return { pos: new Map(), furniture: [], width: 0, height: 0, mode };
  }

  const present = new Set(nodes.map(t => t.id));
  const needsMega = megaDescendants(techs);

  const tiers = [...new Set(nodes.filter(t => !t.isRepeatable)
    .map(t => t.tier).filter(t => t !== null))].sort((a, b) => a - b);
  const tierIndex = new Map(tiers.map((t, i) => [t, i + 1]));

  // -- seeds ------------------------------------------------------------
  // Repeatables are placed after every ordinary column (see below); the seed
  // only needs to be beyond the tier seeds.
  const REPEATABLE_SEED = (tiers.length + 1) * 4;

  const seedOf = t => {
    const gate = gateRank(t, needsMega);
    if (mode === "gate") return gate;
    if (t.isRepeatable) return REPEATABLE_SEED;
    const base = t.tier === null || !tierIndex.has(t.tier)
      ? 0 : tierIndex.get(t.tier);
    // Within the same tier, a gated technology sits right of an ungated one.
    return base * 4 + gate;
  };

  const col = new Map();
  for (const t of nodes) col.set(t.id, seedOf(t));

  /* Gate mode assigns each gate a disjoint range of columns: every
     technology behind Galactic Wonders sits right of every technology that
     needs only Mega-Engineering, and so on. This is sound because a gate is
     inherited by everything downstream, so no technology can depend on one
     with a higher gate. Without it, relaxation spread long ungated chains
     across the whole map and the bands interleaved. */
  const gateOf = new Map(nodes.map(t => [t.id, gateRank(t, needsMega)]));
  const gateBase = [0, 0, 0, 0];

  // -- relaxation: strictly right of every prerequisite -----------------
  // Longest-path order via depth-first post-order, cycle-safe.
  const order = [];
  const seen = new Set(), busy = new Set();
  const visit = id => {
    if (seen.has(id) || busy.has(id)) return;
    busy.add(id);
    const t = techs.get(id);
    if (t) for (const p of t.prerequisites) if (present.has(p)) visit(p);
    busy.delete(id);
    seen.add(id);
    order.push(id);
  };
  for (const t of nodes) visit(t.id);

  if (mode === "gate") {
    // One gate at a time, each starting past the last column the previous
    // gate used.
    for (let g = 0; g < GATES.length; g++) {
      // gateBase[g] was set when the previous gate finished; overwriting it
      // here would discard the offset and let the bands interleave.
      for (const id of order) {
        if (gateOf.get(id) !== g) continue;
        const t = techs.get(id);
        let c = gateBase[g];
        for (const p of t.prerequisites ?? []) {
          if (present.has(p)) c = Math.max(c, col.get(p) + 1);
        }
        col.set(id, c);
      }
      let maxCol = gateBase[g];
      for (const id of order) {
        if (gateOf.get(id) === g) maxCol = Math.max(maxCol, col.get(id));
      }
      if (g + 1 < GATES.length) gateBase[g + 1] = maxCol + 1;
    }
  } else {
    // Ordinary technologies first, then repeatables in a band of their own
    // beyond every one of them. Without the second stage a filtered view
    // could compress the tiers until repeatables shared columns with them.
    for (const id of order) {
      const t = techs.get(id);
      if (!t || t.isRepeatable) continue;
      let c = col.get(id);
      for (const p of t.prerequisites) {
        if (!present.has(p)) continue;
        c = Math.max(c, col.get(p) + 1);
      }
      col.set(id, c);
    }
    let repBase = 0;
    for (const t of nodes) {
      if (!t.isRepeatable) repBase = Math.max(repBase, col.get(t.id) + 1);
    }
    for (const id of order) {
      const t = techs.get(id);
      if (!t || !t.isRepeatable) continue;
      let c = repBase;
      for (const p of t.prerequisites) {
        if (!present.has(p)) continue;
        c = Math.max(c, col.get(p) + 1);
      }
      col.set(id, c);
    }
  }

  // Compact unused columns so the map has no empty stripes.
  const used = [...new Set([...col.values()])].sort((a, b) => a - b);
  const compact = new Map(used.map((c, i) => [c, i]));
  for (const [id, c] of col) col.set(id, compact.get(c));
  const nCols = used.length;

  // -- column x positions, with a wider gap at group boundaries ---------
  // A boundary is where the dominant tier (or gate) of the column changes.
  const colLabel = new Array(nCols).fill(null);
  for (const t of nodes) {
    const c = col.get(t.id);
    const key = mode === "gate"
      ? GATES[gateRank(t, needsMega)].label
      : t.isRepeatable ? "Repeatables"
      : t.tier === null ? "Untiered" : `Tier ${t.tier}`;
    if (!colLabel[c]) colLabel[c] = new Map();
    colLabel[c].set(key, (colLabel[c].get(key) ?? 0) + 1);
  }
  /* A column's label comes from where each group *starts*, not from which
     group happens to have the most cards in it. Dominance mislabelled
     columns that a long chain had reached into — an ACOT prerequisite of a
     tier 7 technology sat in a column labelled tier 5 because tier 5 had
     more cards there. Groups are ordered by their first column, so labels
     are monotonic and never repeat. */
  const labels = new Array(nCols).fill("");
  {
    const firstCol = new Map();       // group label -> its earliest column
    for (const t of nodes) {
      const c = col.get(t.id);
      const key = mode === "gate"
        ? GATES[gateRank(t, needsMega)].label
        : t.isRepeatable ? "Repeatables"
        : t.tier === null ? "Untiered" : `Tier ${t.tier}`;
      if (!firstCol.has(key) || c < firstCol.get(key)) firstCol.set(key, c);
    }
    const starts = [...firstCol.entries()].sort((a, b) => a[1] - b[1]);
    let gi = 0;
    for (let c = 0; c < nCols; c++) {
      while (gi + 1 < starts.length && starts[gi + 1][1] <= c) gi++;
      labels[c] = starts[gi]?.[0] ?? "";
    }
  }
  const dominant = c => labels[c];

  /* A column can be very tall — every Blokkat technology is tier 5, so they
     stacked into one column forty deep. Split an over-tall column into
     side-by-side slots: the column keeps its place in the ordering (its
     dependants are still further right), it just occupies more width and
     less height. Slot counts are global so sections stay aligned. */
  const slotCount = new Array(nCols).fill(1);
  {
    const perSection = new Map();
    for (const t of nodes) {
      const cat = t.categories?.[0] ?? "~none";
      const key = `${cat}\u0000${col.get(t.id)}`;
      perSection.set(key, (perSection.get(key) ?? 0) + 1);
    }
    for (const [key, n] of perSection) {
      const c = Number(key.split("\u0000")[1]);
      slotCount[c] = Math.max(slotCount[c], Math.ceil(n / MAX_ROWS));
    }
  }

  const colX = new Array(nCols);
  {
    let x = 0, prev = null;
    for (let c = 0; c < nCols; c++) {
      const label = dominant(c);
      if (prev !== null && label !== prev) x += GROUP_GAP;
      colX[c] = x;
      x += slotCount[c] * CARD_W + (slotCount[c] - 1) * (COL_GAP / 2) + COL_GAP;
      prev = label;
    }
  }
  const worldW = colX[nCols - 1]
    + slotCount[nCols - 1] * CARD_W
    + (slotCount[nCols - 1] - 1) * (COL_GAP / 2);

  // -- sections ---------------------------------------------------------
  const sections = new Map();
  const sectionArea = new Map();
  for (const t of nodes) {
    const cat = t.categories?.[0] ?? "~none";
    if (!sections.has(cat)) { sections.set(cat, []); sectionArea.set(cat, new Map()); }
    sections.get(cat).push(t);
    const ac = sectionArea.get(cat);
    ac.set(t.area, (ac.get(t.area) ?? 0) + 1);
  }
  const dominantArea = cat => {
    if (MISC_CATEGORIES.includes(cat)) return null;
    const m = sectionArea.get(cat);
    let best = null, n = -1, total = 0;
    for (const [a, c] of m) {
      total += c;
      if (c > n || (c === n && String(a) < String(best))) { best = a; n = c; }
    }
    if (m.size > 1 && n / total < 0.8) return null;
    return best;
  };
  const miscRank = c => {
    const i = MISC_CATEGORIES.indexOf(c);
    return i === -1 ? MISC_CATEGORIES.length : i;
  };
  const sectionKeys = [...sections.keys()].sort((a, b) => {
    const ai = AREA_ORDER.indexOf(dominantArea(a));
    const bi = AREA_ORDER.indexOf(dominantArea(b));
    if (ai !== bi) return ai - bi;
    const ma = miscRank(a), mb = miscRank(b);
    if (ma !== mb) return ma - mb;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const forwardLinks = t => {
    let n = 0;
    for (const u of t.unlocks ?? []) {
      if (present.has(u) && col.get(u) > col.get(t.id)) n++;
    }
    return n;
  };

  const pos = new Map();
  const furniture = [];
  const sectionTops = [];
  let yCursor = SECTION_PAD_TOP;

  for (const key of sectionKeys) {
    sectionTops.push(yCursor);
    const cells = Array.from({ length: nCols }, () => []);
    for (const t of sections.get(key)) cells[col.get(t.id)].push(t);

    // Wrap over-tall stacks into extra rows within the same column.
    const columns = cells.map(c => {
      c.sort((a, b) => (a.id < b.id ? -1 : 1));
      return c;
    });
    orderByBarycentre(columns, techs, col, present);

    const rows = Math.max(1, ...columns.map(c => Math.min(c.length, MAX_ROWS) ||
                                                 c.length));
    const tallest = Math.max(1, ...columns.map(
      (c, ci) => Math.ceil(c.length / slotCount[ci]) || 1));
    const sectionH = tallest * (CARD_H + ROW_GAP);

    columns.forEach((c, ci) => {
      const slots = slotCount[ci];
      const rows = Math.ceil(c.length / slots) || 1;
      // Technologies whose dependants sit further right go in the rightmost
      // slot, so their edges leave from the outside rather than crossing the
      // cards beside them.
      const ordered = [...c].sort((a, b) => {
        const fa = (a.unlocks ?? []).some(u => (col.get(u) ?? -1) > ci) ? 1 : 0;
        const fb = (b.unlocks ?? []).some(u => (col.get(u) ?? -1) > ci) ? 1 : 0;
        return fa - fb;
      });
      ordered.forEach((t, i) => {
        const slot = Math.floor(i / rows);
        const row = i % rows;
        pos.set(t.id, {
          x: colX[ci] + slot * (CARD_W + COL_GAP / 2),
          y: yCursor + row * (CARD_H + ROW_GAP),
        });
      });
    });

    furniture.push({
      kind: "band", x: -24, y: yCursor - 46,
      w: worldW + 48, h: sectionH + 58,
      area: dominantArea(key), cat: key,
    });
    furniture.push({
      kind: "header",
      text: key === "~none" ? "uncategorised" : key.replace(/_/g, " "),
      count: sections.get(key).length,
      x: -8, y: yCursor - 40, area: dominantArea(key), cat: key,
    });
    yCursor += sectionH + SECTION_GAP;
  }

  // -- column labels, once at the top and again above every section ------
  /* Alternating wash per group: untiered plain, tier 1 lifted, tier 2 plain
     again, and so on. The bands must meet exactly — a gap between them
     reads as a stripe of its own, which is what the first attempt looked
     like. */
  {
    const bounds = [];
    let prevLabel = null;
    for (let c = 0; c < nCols; c++) {
      const label = dominant(c);
      if (label !== prevLabel) { bounds.push([c, c]); prevLabel = label; }
      else bounds[bounds.length - 1][1] = c;
    }
    bounds.forEach(([s], i) => {
      const x0 = i === 0 ? -40 : colX[s] - GROUP_GAP / 2;
      const next = bounds[i + 1];
      const x1 = next === undefined
        ? worldW + 40
        : colX[next[0]] - GROUP_GAP / 2;
      furniture.push({ kind: "tiercolumn", parity: i % 2,
                       x: x0, y: 0, w: x1 - x0, h: yCursor });
    });
  }

  let prev = null;
  for (let c = 0; c < nCols; c++) {
    const label = dominant(c);
    if (label === prev) continue;      // label each group once
    prev = label;
    furniture.push({ kind: "tierlabel", text: label, x: colX[c], y: 14 });
    for (const y of sectionTops) {
      furniture.push({ kind: "tierlabel", text: label, x: colX[c],
                       y: y - 66, small: true });
    }
    if (c > 0) {
      furniture.push({ kind: "tierdivider", x: colX[c] - GROUP_GAP / 2,
                       y: 0, h: yCursor });
    }
  }

  return { pos, furniture, width: worldW, height: yCursor, mode };
}

function orderByBarycentre(cols, techs, col, present) {
  const rowOf = new Map();
  const reindex = () => cols.forEach(c => c.forEach((t, i) => rowOf.set(t.id, i)));
  reindex();

  const neighbours = (t, refSet) => {
    const out = [];
    for (const pid of t.prerequisites ?? [])
      if (refSet.has(pid)) out.push(rowOf.get(pid));
    for (const uid of t.unlocks ?? [])
      if (refSet.has(uid)) out.push(rowOf.get(uid));
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
        const na = neighbours(a, refSet), nb = neighbours(b, refSet);
        const ba = na.length ? na.reduce((s, v) => s + v, 0) / na.length : rowOf.get(a.id);
        const bb = nb.length ? nb.reduce((s, v) => s + v, 0) / nb.length : rowOf.get(b.id);
        if (ba !== bb) return ba - bb;
        return a.id < b.id ? -1 : 1;
      });
      reindex();
    }
  }
}
