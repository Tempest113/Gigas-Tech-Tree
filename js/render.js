/* render.js — canvas map renderer.

   Cards were DOM elements inside a CSS-transformed container. That is fine
   for a few hundred nodes but not for ~1000: every zoom step forces the
   browser to re-rasterise the whole layer, and no amount of culling or
   level-of-detail hides that. Everything on the map — tier washes, category
   bands, labels, edges and cards — is now drawn on one canvas, so a zoom is
   a redraw of only what is on screen (typically well under a hundred cards)
   rather than a repaint of a 12000×10000 layer.

   Icons come from the sprite atlas the build produces, so the whole map
   costs one image, not a thousand.

   All picking and culling logic lives in viewmodel.js and is unit-tested;
   this file is drawing and event plumbing. */

import { CARD_W, CARD_H, buildIndex, clampScale, hitTest, lineageOf,
         viewportRect, visibleCards } from "./viewmodel.js";
import { APP_VERSION } from "./version.js";

const FONT_DISPLAY = '600 12.5px "Chakra Petch", system-ui, sans-serif';
const FONT_DATA = '11px ui-monospace, "Cascadia Mono", monospace';

/* Below this zoom, text is sub-pixel; cards still draw with their fill,
   border and area accent so the map keeps its shape. */
const TEXT_SCALE = 0.38;
const ICON_SCALE = 0.30;

export class MapView {
  constructor(stage, worldEl, canvas, model, lay, onSelect) {
    this.stage = stage;
    this.canvas = canvas;
    this.model = model;
    this.lay = lay;
    this.onSelect = onSelect;
    this.tx = 40; this.ty = 20; this.scale = 1;
    this.selected = null;
    this.hovered = null;
    this.lineage = null;
    this.visible = null;
    this.index = buildIndex(lay, null);
    this.colours = readColours();
    this.atlas = null;
    this.atlasMap = null;
    this.patterns = {};   // lazily built canvas patterns, keyed by category
    this._raf = 0;
    this._frames = [];        // rolling frame times for the ?dev meter
    this._edgePaths = null;   // cached; world coords are view-independent
    this._lineagePath = null;
    this._phase = { furniture: 0, edges: 0, cards: 0 };
    this.interacting = false;
    this.degraded = false;    // set by _updateQuality on slow machines
    this._idleTimer = 0;

    worldEl.replaceChildren();
    worldEl.style.display = "none";   // cards are drawn, not laid out

    this._loadAtlas();
    this._bind();
    this.resizeCanvas();
  }

  async _loadAtlas() {
    try {
      const meta = await fetch(`assets/icons/atlas.json?v=${APP_VERSION}`)
        .then(r => r.json());
      const img = new Image();
      img.decoding = "async";
      await new Promise((res, rej) => {
        img.onload = res; img.onerror = rej;
        img.src = `assets/icons/atlas.png?v=${APP_VERSION}`;
      });
      this.atlasMap = meta.icons;
      this.atlas = img;
      this.redraw();
    } catch { /* icons are optional; cards render without them */ }
  }

  // -- events ---------------------------------------------------------

  _bind() {
    const stage = this.stage;
    let panning = false, px = 0, py = 0, moved = false, downId = null;

    stage.addEventListener("pointerdown", e => {
      panning = true; moved = false;
      px = e.clientX; py = e.clientY;
      downId = this.pickAt(e.clientX, e.clientY);
      stage.classList.add("panning");
      stage.setPointerCapture?.(e.pointerId);
    });

    stage.addEventListener("pointermove", e => {
      if (panning) {
        const dx = e.clientX - px, dy = e.clientY - py;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        this.tx += dx; this.ty += dy;
        px = e.clientX; py = e.clientY;
        this.applyTransform();
        return;
      }
      // Hover preview only when nothing is selected; a selection owns the
      // highlight until it is cleared.
      if (this.selected) return;
      const id = this.pickAt(e.clientX, e.clientY);
      if (id !== this.hovered) {
        this.hovered = id;
        this.lineage = id ? lineageOf(this.model.techs, id) : null;
        this._lineagePath = null;
        this.redraw();
      }
    });

    stage.addEventListener("pointerup", () => {
      panning = false;
      stage.classList.remove("panning");
      if (!moved) this.select(downId);
      downId = null;
    });

    stage.addEventListener("pointerleave", () => {
      if (!this.selected && this.hovered) {
        this.hovered = null; this.lineage = null;
        this._lineagePath = null; this.redraw();
      }
    });

    stage.addEventListener("wheel", e => {
      e.preventDefault();
      this.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });

    new ResizeObserver(() => this.resizeCanvas()).observe(stage);
  }

  pickAt(clientX, clientY) {
    const r = this.stage.getBoundingClientRect();
    const wx = (clientX - r.left - this.tx) / this.scale;
    const wy = (clientY - r.top - this.ty) / this.scale;
    return hitTest(this.index, wx, wy);
  }

  // -- view state -----------------------------------------------------

  relayout(lay, visibleSet) {
    this.lay = lay;
    this.visible = visibleSet;
    this.index = buildIndex(lay, visibleSet);
    this._edgePaths = null;
    this._lineagePath = null;
    if (this.selected && !lay.pos.has(this.selected)) {
      this.selected = null;
      this.lineage = null;
      this.onSelect(null);
    }
    this.redraw();
  }

  select(id) {
    this.selected = id;
    this.hovered = null;
    this.lineage = id ? lineageOf(this.model.techs, id) : null;
    this._lineagePath = null;
    this.redraw();
    this.onSelect(id);
  }

  zoomAt(cx, cy, factor) {
    const r = this.stage.getBoundingClientRect();
    const sx = cx - r.left, sy = cy - r.top;
    const ns = clampScale(this.scale * factor);
    const k = ns / this.scale;
    this.tx = sx - (sx - this.tx) * k;
    this.ty = sy - (sy - this.ty) * k;
    this.scale = ns;
    this.applyTransform();
  }

  resetView() {
    this.tx = 40; this.ty = 20; this.scale = 1;
    this.applyTransform();
  }

  centreOn(id) {
    const p = this.lay.pos.get(id);
    if (!p) return;
    const { clientWidth: w, clientHeight: h } = this.stage;
    this.tx = w / 2 - (p.x + CARD_W / 2) * this.scale;
    this.ty = h / 2 - (p.y + CARD_H / 2) * this.scale;
    this.applyTransform();
  }

  /* Self-tuning quality: measure our own draw times and only trade fidelity
     for speed on machines that need it. A GPU-accelerated canvas draws this
     map in single-digit milliseconds and keeps full resolution and textures
     throughout; a software-rasterised one (Firefox falling back to Software
     WebRender, which also blocklists accelerated canvas2d) degrades while
     the view is moving and restores when it settles. Hysteresis stops it
     oscillating. */
  _updateQuality() {
    const f = this._frames;
    if (f.length < 12) return;
    const s = [...f].sort((a, b) => a - b);
    const med = s[s.length >> 1];
    if (med > 12) this.degraded = true;
    else if (med < 6) this.degraded = false;
  }

  /* Mark the view as moving; restore full fidelity shortly after it stops. */
  _touch() {
    this.interacting = true;
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      this.interacting = false;
      this.redraw();
    }, 160);
  }

  applyTransform() {
    this._touch();
    const readout = document.getElementById("zoom-readout");
    if (readout) readout.textContent = `${Math.round(this.scale * 100)}%`;
    this.redraw();
  }

  resizeCanvas() {
    const { clientWidth: w, clientHeight: h } = this.stage;
    const dpr = renderScale(w, h, this.interacting && this.degraded);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.redraw();
  }

  redraw() {
    if (this._raf) return;                 // coalesce to one draw per frame
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      const t0 = performance.now();
      this._draw();
      const dt = performance.now() - t0;
      this._frames.push(dt);
      if (this._frames.length > 60) this._frames.shift();
      this._updateQuality();
      if (this.onFrame) this.onFrame(dt, this._frames);
    });
  }

  // -- drawing --------------------------------------------------------

  _draw() {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    const dpr = renderScale(w, h, this.interacting && this.degraded);
    // Resize only when the target actually changes: assigning width/height
    // clears and reallocates the backing store.
    const cw = Math.round(w * dpr), chh = Math.round(h * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== chh) {
      this.canvas.width = cw;
      this.canvas.height = chh;
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    const C = this.colours;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(this.tx, this.ty);
    ctx.scale(this.scale, this.scale);

    const rect = viewportRect(this.tx, this.ty, this.scale, w, h);
    const t0 = performance.now();
    this._drawFurniture(ctx, rect, C);
    const t1 = performance.now();
    this._drawEdges(ctx, rect, C);
    const t2 = performance.now();

    const cards = visibleCards(this.index, rect);
    const withText = this.scale >= TEXT_SCALE;
    const withIcons = this.scale >= ICON_SCALE && this.atlas;
    for (const it of cards) this._drawCard(ctx, it, C, withText, withIcons);
    const t3 = performance.now();
    this._phase = { furniture: t1 - t0, edges: t2 - t1, cards: t3 - t2,
                    n: cards.length, dpr: dpr, degraded: this.degraded,
                    px: Math.round(cw * chh / 1e6 * 10) / 10 };

    ctx.restore();
  }

  _drawFurniture(ctx, rect, C) {
    for (const f of this.lay.furniture) {
      switch (f.kind) {
        case "tiercolumn":
          if (f.x + f.w < rect.x0 || f.x > rect.x1) continue;
          ctx.fillStyle = f.parity ? C.tierB : C.tierA;
          ctx.fillRect(f.x, f.y, f.w, f.h);
          break;
        case "band": {
          if (f.y + f.h < rect.y0 || f.y > rect.y1) continue;
          const accent = C.area[bandKey(f)] ?? C.stub;
          roundRect(ctx, f.x, f.y, f.w, f.h, 10);
          ctx.fillStyle = withAlpha(accent, 0.09);
          ctx.fill();
          // Signature categories get a texture on top of the wash.
          if (this.scale > 0.15 && !(this.interacting && this.degraded)) {
            const pat = this._pattern(ctx, f.cat, accent);
            if (pat) {
              ctx.save();
              ctx.clip();
              ctx.fillStyle = pat;
              ctx.fillRect(f.x, f.y, f.w, f.h);
              ctx.restore();
            } else if (f.cat === "sirenalia") {
              ctx.save();
              ctx.clip();
              drawWaves(ctx, f, accent, rect);
              ctx.restore();
            }
          }
          ctx.strokeStyle = withAlpha(accent, 0.22);
          ctx.lineWidth = 1 / this.scale;
          ctx.stroke();
          break;
        }
        case "header": {
          if (f.y + 30 < rect.y0 || f.y > rect.y1) continue;
          if (this.scale < 0.12) continue;
          const accent = C.area[bandKey(f)] ?? C.muted;
          const label = f.text.toUpperCase();
          ctx.font = '600 15px "Chakra Petch", system-ui, sans-serif';
          const tw = measureCached(ctx, label) + 2.6 * label.length;
          const cw = tw + 46;
          ctx.fillStyle = withAlpha(accent, 0.18);
          roundRect(ctx, f.x, f.y, cw, 26, 6);
          ctx.fill();
          ctx.strokeStyle = withAlpha(accent, 0.4);
          ctx.lineWidth = 1 / this.scale;
          ctx.stroke();
          ctx.fillStyle = accent;
          drawTracked(ctx, label, f.x + 12, f.y + 18, 2.6);
          ctx.font = FONT_DATA;
          ctx.fillStyle = C.muted;
          ctx.fillText(String(f.count), f.x + cw - 26, f.y + 18);
          break;
        }
        case "tierlabel": {
          if (f.y + 20 < rect.y0 || f.y > rect.y1) continue;
          if (f.x > rect.x1 || f.x + 300 < rect.x0) continue;
          if (this.scale < (f.small ? 0.3 : 0.12)) continue;
          ctx.font = f.small
            ? '600 10px "Chakra Petch", system-ui, sans-serif'
            : '600 13px "Chakra Petch", system-ui, sans-serif';
          ctx.fillStyle = f.small ? withAlpha(C.muted, 0.55) : C.muted;
          drawTracked(ctx, f.text.toUpperCase(), f.x, f.y + 12,
                      f.small ? 1.6 : 1.8);
          break;
        }
        case "tierdivider":
          if (f.x < rect.x0 || f.x > rect.x1) continue;
          ctx.strokeStyle = withAlpha(C.line, 0.35);
          ctx.lineWidth = 1 / this.scale;
          ctx.beginPath();
          ctx.moveTo(f.x, f.y);
          ctx.lineTo(f.x, f.y + f.h);
          ctx.stroke();
          break;
      }
    }
  }

  /* Tiled textures, drawn once into an offscreen canvas and reused as a
     fill pattern — cheap regardless of band size. */
  _pattern(ctx, cat, accent) {
    if (cat !== "blokkats") return null;
    if (this.patterns[cat] !== undefined) return this.patterns[cat];

    const c = document.createElement("canvas");
    const g = c.getContext("2d");
    if (!g) { this.patterns[cat] = null; return null; }

    if (cat === "blokkats") {
      // Pointy-top honeycomb: one hexagon plus the single centre connector,
      // which is the only edge a real lattice shares between tiles.
      const w = 56, h = 97;
      c.width = w; c.height = h;
      g.strokeStyle = withAlpha(accent, 0.16);
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(28, 0); g.lineTo(56, 16.17); g.lineTo(56, 48.5);
      g.lineTo(28, 64.67); g.lineTo(0, 48.5); g.lineTo(0, 16.17);
      g.closePath();
      g.moveTo(28, 64.67); g.lineTo(28, 97);
      g.stroke();
    }
    this.patterns[cat] = ctx.createPattern(c, "repeat");
    return this.patterns[cat];
  }

  /* Edge geometry is in world coordinates and does not change as the view
     moves, so the paths are built once per layout and merely stroked under
     the canvas transform. Rebuilding them per frame — roughly 880 bezier
     curves — was the dominant cost when zoomed out. */
  _buildEdgePaths() {
    const near = new Path2D(), far = new Path2D();
    for (const it of this.index.items) {
      const t = this.model.techs.get(it.id);
      if (!t) continue;
      for (const pid of t.prerequisites) {
        const pp = this.lay.pos.get(pid);
        if (!pp) continue;
        if (this.visible !== null && !this.visible.has(pid)) continue;
        addEdge(Math.abs(pp.y - it.y) < 2200 ? near : far, pp, it);
      }
    }
    this._edgePaths = { near, far };
  }

  _buildLineagePath() {
    const lin = new Path2D();
    if (this.lineage) {
      for (const id of this.lineage) {
        const p = this.lay.pos.get(id);
        const t = this.model.techs.get(id);
        if (!p || !t) continue;
        for (const pid of t.prerequisites) {
          if (!this.lineage.has(pid)) continue;
          const pp = this.lay.pos.get(pid);
          if (pp) addEdge(lin, pp, p);
        }
      }
    }
    this._lineagePath = lin;
  }

  _drawEdges(ctx, rect, C) {
    if (!this._edgePaths) this._buildEdgePaths();
    if (!this._lineagePath) this._buildLineagePath();
    const dim = this.lineage ? 0.06 : 1;

    ctx.setLineDash([]);
    ctx.lineWidth = 1.25 / this.scale;
    ctx.strokeStyle = C.line;
    ctx.globalAlpha = 0.5 * dim;
    ctx.stroke(this._edgePaths.near);
    ctx.globalAlpha = 0.12 * dim;
    ctx.setLineDash([5 / this.scale, 5 / this.scale]);
    ctx.stroke(this._edgePaths.far);
    ctx.setLineDash([]);
    if (this.lineage) {
      ctx.strokeStyle = C.accent;
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 2 / this.scale;
      ctx.stroke(this._lineagePath);
    }
    ctx.globalAlpha = 1;
  }

  _drawCard(ctx, it, C, withText, withIcons) {
    const t = this.model.techs.get(it.id);
    if (!t) return;
    const dimmed = this.lineage && !this.lineage.has(it.id);
    ctx.globalAlpha = dimmed ? 0.25 : 1;

    const accent = t.stub ? C.rare
      : t.isRare ? C.rare
      : (t.categories?.[0] === "blokkats" ? C.area.blokkat
         : C.area[t.area] ?? C.line);

    // body
    ctx.fillStyle = t.stub ? "transparent" : C.card;
    roundRect(ctx, it.x, it.y, CARD_W, CARD_H, 4);
    if (!t.stub) ctx.fill();
    ctx.strokeStyle = it.id === this.selected ? accent : C.line;
    ctx.lineWidth = (it.id === this.selected ? 2 : 1) / this.scale;
    if (t.stub) ctx.setLineDash([4 / this.scale, 3 / this.scale]);
    ctx.stroke();
    ctx.setLineDash([]);

    // area accent bar
    ctx.fillStyle = accent;
    roundRect(ctx, it.x, it.y, 3, CARD_H, 2);
    ctx.fill();

    let textX = it.x + 12;
    if (withIcons && t.icon && this.atlasMap?.[t.icon]) {
      const s = this.atlasMap[t.icon];
      ctx.drawImage(this.atlas, s.x, s.y, s.w, s.h,
                    it.x + 9, it.y + 12, 40, 40);
      textX = it.x + 57;
    }

    if (!withText) { ctx.globalAlpha = 1; return; }

    ctx.font = FONT_DISPLAY;
    ctx.fillStyle = t.nameMissing ? C.muted : C.text;
    ctx.fillText(fit(ctx, t.name ?? t.id, it.x + CARD_W - 10 - textX),
                 textX, it.y + 26);

    ctx.font = FONT_DATA;
    ctx.fillStyle = C.muted;
    const cost = t.stub ? "external mod"
      : (t.cost === null || t.cost === undefined ? "" : String(t.cost));
    if (cost) ctx.fillText(cost, textX, it.y + 42);

    if (t.tier !== null || t.isRepeatable) {
      const rep = !t.isRepeatable ? ""
        : t.levels > 0 ? ` \u00d7${t.levels}`
        : t.levels === -1 ? " \u221e" : " \u21bb";
      const badge = (t.tier !== null ? `T${t.tier}` : "") + rep;
      ctx.font = '600 10px "Chakra Petch", system-ui, sans-serif';
      const bw = measureCached(ctx, badge);
      ctx.fillText(badge, it.x + CARD_W - 8 - bw, it.y + 42);
    }

    if (t.ascensionPerks?.length) {
      ctx.font = FONT_DATA;
      ctx.fillStyle = C.rare;
      ctx.fillText(`\u2726 ${apName(t.ascensionPerks[0])}`, textX, it.y + 56);
    } else if (t.isDangerous) {
      ctx.font = FONT_DATA;
      ctx.fillStyle = C.danger;
      ctx.fillText("Dangerous technology", textX, it.y + 56);
    }
    ctx.globalAlpha = 1;
  }
}

// -- helpers ----------------------------------------------------------------

function addEdge(path, from, to) {
  const x1 = from.x + CARD_W, y1 = from.y + CARD_H / 2;
  const x2 = to.x, y2 = to.y + CARD_H / 2;
  const reach = Math.max(40, Math.min(160, (x2 - x1) * 0.5));
  path.moveTo(x1, y1);
  path.bezierCurveTo(x1 + reach, y1, x2 - reach, y2, x2, y2);
}

/* ap_celestial_printing -> "Celestial Printing" */
export function apName(id) {
  return String(id).replace(/^ap_/, "").replace(/_/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase());
}

/* Canvas cost is fill-rate bound: a 4K display asks for four times the
   pixels of a 1080p one at the same window size, and if the browser is not
   accelerating canvas2d that difference lands squarely on the CPU.

   Three defences:
     - cap the device pixel ratio (past 1.5x the gain is invisible here),
     - cap total pixels, so an ultrawide or 4K window cannot blow the budget,
     - drop resolution further while the view is actually moving, and
       restore it once it settles.

   `?render=<n>` overrides the cap for testing. */
const PIXEL_BUDGET = 4.5e6;          // ~2560x1760 backing store
const INTERACTIVE_FACTOR = 0.6;

function renderScale(w, h, reduce) {
  const override = Number(
    new URLSearchParams(location.search).get("render"));
  let dpr = Number.isFinite(override) && override > 0
    ? override : Math.min(window.devicePixelRatio || 1, 1.5);
  if (reduce) dpr *= INTERACTIVE_FACTOR;
  const px = w * h * dpr * dpr;
  if (px > PIXEL_BUDGET) dpr *= Math.sqrt(PIXEL_BUDGET / px);
  return Math.max(0.4, dpr);
}

/* Layered wave art: overlapping sine bands in the accent hue, each darker
   and lower than the last. Four filled paths per visible band — the cost
   does not scale with the map, only with what is on screen. */
function drawWaves(ctx, f, accent, rect) {
  const x0 = Math.max(f.x, rect.x0), x1 = Math.min(f.x + f.w, rect.x1);
  if (x1 <= x0) return;
  const step = 60;
  const layers = [
    { amp: 0.10, phase: 0.0, base: 0.30, alpha: 0.05, period: 1600 },
    { amp: 0.08, phase: 1.1, base: 0.52, alpha: 0.06, period: 1150 },
    { amp: 0.07, phase: 2.4, base: 0.72, alpha: 0.07, period: 900 },
    { amp: 0.05, phase: 3.6, base: 0.88, alpha: 0.09, period: 700 },
  ];
  for (const L of layers) {
    ctx.beginPath();
    ctx.moveTo(x0, f.y + f.h);
    for (let x = x0; x <= x1 + step; x += step) {
      const t = ((x - f.x) / L.period) * Math.PI * 2 + L.phase;
      const y = f.y + f.h * (L.base + Math.sin(t) * L.amp);
      ctx.lineTo(Math.min(x, x1), y);
    }
    ctx.lineTo(x1, f.y + f.h);
    ctx.closePath();
    ctx.fillStyle = withAlpha(accent, L.alpha);
    ctx.fill();
  }
}

function bandKey(f) {
  if (f.cat === "blokkats") return "blokkat";
  if (f.cat === "sirenalia") return "siren";
  return f.area;
}

function expand(r, m) {
  return { x0: r.x0 - m, y0: r.y0 - m, x1: r.x1 + m, y1: r.y1 + m };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* Tracked text. Per-glyph drawing with a measureText call each was costing
   well over a thousand measures per frame once labels multiplied; use the
   native letterSpacing where the engine has it, and memoise glyph widths
   otherwise. */
const NATIVE_TRACKING = (() => {
  try {
    const c = document.createElement("canvas").getContext("2d");
    return c && "letterSpacing" in c;
  } catch { return false; }
})();

const glyphWidths = new Map();

function drawTracked(ctx, text, x, y, spacing) {
  if (NATIVE_TRACKING) {
    const prev = ctx.letterSpacing;
    ctx.letterSpacing = `${spacing}px`;
    ctx.fillText(text, x, y);
    ctx.letterSpacing = prev;
    return;
  }
  let cx = x;
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    const key = ctx.font + ch;
    let w = glyphWidths.get(key);
    if (w === undefined) {
      w = ctx.measureText(ch).width;
      glyphWidths.set(key, w);
    }
    cx += w + spacing;
  }
}

const textWidths = new Map();
function measureCached(ctx, text) {
  const key = ctx.font + "\u0000" + text;
  let w = textWidths.get(key);
  if (w === undefined) {
    w = ctx.measureText(text).width;
    textWidths.set(key, w);
  }
  return w;
}

const fitCache = new Map();

function fit(ctx, text, maxWidth) {
  const key = ctx.font + "\u0000" + text + "\u0000" + Math.round(maxWidth);
  const hit = fitCache.get(key);
  if (hit !== undefined) return hit;
  const out = fitUncached(ctx, text, maxWidth);
  fitCache.set(key, out);
  return out;
}

function fitUncached(ctx, text, maxWidth) {
  if (measureCached(ctx, text) <= maxWidth) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measureCached(ctx, text.slice(0, mid) + "\u2026") <= maxWidth)
      lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "\u2026";
}

function withAlpha(colour, a) {
  const c = colour.trim();
  if (c.startsWith("#") && (c.length === 7 || c.length === 4)) {
    const hex = c.length === 4
      ? c[1] + c[1] + c[2] + c[2] + c[3] + c[3] : c.slice(1);
    const n = parseInt(hex, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  return c;
}

function readColours() {
  const s = getComputedStyle(document.documentElement);
  const v = (name, dflt) => (s.getPropertyValue(name) || dflt).trim();
  return {
    bg: v("--bg", "#141414"),
    card: v("--card", "#212125"),
    line: v("--line", "#38363c"),
    text: v("--text", "#eef0f2"),
    muted: v("--muted", "#8f8b94"),
    rare: v("--rare", "#a07be0"),
    danger: v("--danger", "#e05c5c"),
    stub: v("--stub", "#726e75"),
    accent: v("--physics", "#53a8e2"),
    tierA: "rgba(255,255,255,0.014)",
    tierB: "rgba(255,255,255,0.038)",
    area: {
      physics: v("--physics", "#53a8e2"),
      society: v("--society", "#63c78a"),
      engineering: v("--engineering", "#e0a458"),
      blokkat: v("--blokkat", "#52d97e"),
      siren: v("--siren", "#b07be0"),
    },
  };
}
