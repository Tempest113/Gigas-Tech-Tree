/* viewmodel.js — pure, canvas-independent view logic.

   Split out so it can be tested in Node without a canvas: which cards fall
   in the viewport, which card is under a point, and which nodes form the
   highlighted lineage. render.js does drawing only. */

export const CARD_W = 208, CARD_H = 64;

/* Categories that stand outside the physics/society/engineering grouping:
   crisis and event lines that are their own thing regardless of which
   research area their technologies happen to sit in. Ordered as listed. */
export const MISC_CATEGORIES = ["blokkats", "sirenalia"];

/* Sorted index of placed cards for range queries. Built once per layout. */
export function buildIndex(lay, visible) {
  const items = [];
  for (const [id, p] of lay.pos) {
    if (visible !== null && !visible.has(id)) continue;
    items.push({ id, x: p.x, y: p.y });
  }
  items.sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1));
  return { items, ys: items.map(i => i.y) };
}

function lowerBound(arr, value) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/* World-space rectangle currently on screen, with a margin. */
export function viewportRect(tx, ty, scale, w, h, margin = 120) {
  return {
    x0: (-tx - margin) / scale,
    y0: (-ty - margin) / scale,
    x1: (w - tx + margin) / scale,
    y1: (h - ty + margin) / scale,
  };
}

/* Cards intersecting the viewport. Binary search on y, linear scan across
   the band — the map is far wider than tall per row, so this is cheap. */
export function visibleCards(index, rect) {
  const start = lowerBound(index.ys, rect.y0 - CARD_H);
  const out = [];
  for (let i = start; i < index.items.length; i++) {
    const it = index.items[i];
    if (it.y > rect.y1) break;
    if (it.x + CARD_W < rect.x0 || it.x > rect.x1) continue;
    out.push(it);
  }
  return out;
}

/* Card under a world-space point, or null. Later items win so the topmost
   drawn card is picked. */
export function hitTest(index, wx, wy) {
  const start = lowerBound(index.ys, wy - CARD_H);
  let hit = null;
  for (let i = start; i < index.items.length; i++) {
    const it = index.items[i];
    if (it.y > wy) break;
    if (wx >= it.x && wx <= it.x + CARD_W &&
        wy >= it.y && wy <= it.y + CARD_H) hit = it;
  }
  return hit ? hit.id : null;
}

/* Full ancestor + descendant closure of a technology. */
export function lineageOf(techs, id) {
  const keep = new Set([id]);
  const walk = key => {
    const stack = [id];
    while (stack.length) {
      const t = techs.get(stack.pop());
      if (!t) continue;
      for (const n of t[key] ?? []) {
        if (!keep.has(n)) { keep.add(n); stack.push(n); }
      }
    }
  };
  walk("prerequisites");
  walk("unlocks");
  return keep;
}

export function clampScale(s) {
  return Math.min(2.5, Math.max(0.05, s));
}
