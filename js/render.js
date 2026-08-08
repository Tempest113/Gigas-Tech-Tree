/* render.js — cards as absolutely-positioned DOM inside one CSS-transformed
   world container; edges on a canvas redrawn on transform change.
   (Virtualisation and settle-throttling arrive in the performance pass.) */

import { CARD_W, CARD_H } from "./layout.js";

function addEdge(path, from, to) {
  const x1 = from.x + CARD_W, y1 = from.y + CARD_H / 2;
  const x2 = to.x, y2 = to.y + CARD_H / 2;
  const reach = Math.max(40, Math.min(160, (x2 - x1) * 0.5));
  path.moveTo(x1, y1);
  path.bezierCurveTo(x1 + reach, y1, x2 - reach, y2, x2, y2);
}

export class MapView {
  constructor(stage, worldEl, canvas, model, lay, onSelect) {
    this.stage = stage;
    this.world = worldEl;
    this.canvas = canvas;
    this.model = model;
    this.lay = lay;
    this.onSelect = onSelect;
    this.tx = 40; this.ty = 20; this.scale = 1;
    this.selected = null;
    this.visible = null;     // Set of ids or null = all
    this.cardEls = new Map();
    this._buildDom();
    this._bind();
    this.applyTransform();
  }

  _buildDom() {
    const frag = document.createDocumentFragment();

    for (const f of this.lay.furniture) {
      const el = document.createElement("div");
      if (f.kind === "band") {
        el.className = "section-band";
        if (f.area) el.dataset.area = f.area;
        if (f.cat) el.dataset.cat = f.cat;
        el.style.left = `${f.x}px`; el.style.top = `${f.y}px`;
        el.style.width = `${f.w}px`; el.style.height = `${f.h}px`;
      } else if (f.kind === "header") {
        el.className = "section-header";
        if (f.area) el.dataset.area = f.area;
        if (f.cat) el.dataset.cat = f.cat;
        el.textContent = f.text;
        const n = document.createElement("span");
        n.className = "count";
        n.textContent = String(f.count);
        el.appendChild(n);
        el.style.left = `${f.x}px`; el.style.top = `${f.y}px`;
      } else if (f.kind === "rule") {
        el.className = "section-rule";
        el.style.left = `${f.x}px`; el.style.top = `${f.y}px`;
        el.style.width = `${f.w}px`;
      } else if (f.kind === "tiercolumn") {
        el.className = "tier-column";
        el.dataset.parity = String(f.parity);
        el.style.left = `${f.x}px`; el.style.top = `${f.y}px`;
        el.style.width = `${f.w}px`; el.style.height = `${f.h}px`;
      } else if (f.kind === "tierdivider") {
        el.className = "tier-divider";
        el.style.left = `${f.x}px`; el.style.top = `${f.y}px`;
        el.style.height = `${f.h}px`;
      } else {
        el.className = "tier-label" + (f.small ? " tier-label-small" : "");
        el.textContent = f.text;
        el.style.left = `${f.x}px`; el.style.top = `${f.y}px`;
      }
      frag.appendChild(el);
    }

    for (const [id, p] of this.lay.pos) {
      const t = this.model.techs.get(id);
      const el = document.createElement("div");
      el.className = "tech-card";
      el.tabIndex = 0;
      el.dataset.id = id;
      if (t.area) el.dataset.area = t.area;
      el.dataset.src = t.stub || t.crossModGated ? "crossmod"
        : t.overridesVanilla ? "override" : t.source;
      if (t.isRare) el.classList.add("rare");
      if (t.stub) el.classList.add("stub");
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;

      if (!t.stub && t.icon) {
        const icon = document.createElement("img");
        icon.className = "tech-icon";
        icon.src = `assets/icons/${t.icon}.png`;
        icon.loading = "lazy";
        icon.alt = "";
        icon.onerror = () => icon.remove();
        el.appendChild(icon);
      }
      const text = document.createElement("div");
      text.className = "tech-text";
      el.appendChild(text);

      const name = document.createElement("div");
      name.className = "tech-name" + (t.nameMissing ? " loc-missing" : "");
      name.textContent = t.name;
      name.title = t.name;
      text.appendChild(name);

      const sub = document.createElement("div");
      sub.className = "tech-sub";
      const cost = document.createElement("span");
      cost.className = "tech-cost";
      cost.textContent = t.stub ? "external mod" :
        t.cost === null ? "" : String(t.cost);
      sub.appendChild(cost);
      if (t.tier !== null || t.isRepeatable) {
        const badge = document.createElement("span");
        badge.className = "tech-tier-badge";
        const rep = !t.isRepeatable ? ""
          : t.levels > 0 ? ` \u00d7${t.levels}`
          : t.levels === -1 ? " \u221e" : " \u21bb";
        badge.textContent = (t.tier !== null ? `T${t.tier}` : "") + rep;
        badge.title = !t.isRepeatable ? ""
          : t.levels > 0 ? `Repeatable, ${t.levels} levels`
          : t.levels === -1 ? "Repeatable, unlimited levels"
          : "Repeatable";
        sub.appendChild(badge);
      }
      text.appendChild(sub);

      if (t.isDangerous) {
        const d = document.createElement("div");
        d.className = "tech-danger-line";
        d.textContent = "Dangerous technology";
        text.appendChild(d);
      }

      this.cardEls.set(id, el);
      frag.appendChild(el);
    }
    this.world.appendChild(frag);
  }

  _bind() {
    const stage = this.stage;
    let panning = false, px = 0, py = 0, moved = false;
    let downCard = null;   // captured BEFORE setPointerCapture retargets
                           // pointerup to the stage (real-browser behaviour
                           // jsdom doesn't emulate — see tests/dom-smoke.mjs)

    stage.addEventListener("pointerdown", e => {
      panning = true; moved = false;
      downCard = e.target.closest?.(".tech-card") ?? null;
      px = e.clientX; py = e.clientY;
      stage.classList.add("panning");
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener("pointermove", e => {
      if (!panning) return;
      const dx = e.clientX - px, dy = e.clientY - py;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      this.tx += dx; this.ty += dy;
      px = e.clientX; py = e.clientY;
      this.applyTransform();
    });
    stage.addEventListener("pointerup", () => {
      panning = false;
      stage.classList.remove("panning");
      if (!moved) this.select(downCard ? downCard.dataset.id : null);
      downCard = null;
    });
    stage.addEventListener("wheel", e => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      this.zoomAt(e.clientX, e.clientY, factor);
    }, { passive: false });

    stage.addEventListener("keydown", e => {
      if (e.key === "Escape") this.select(null);
    });
    stage.addEventListener("pointerover", e => {
      if (this.selected) return;   // a selection owns the highlight until
                                   // blank-space click or another selection
      const card = e.target.closest(".tech-card");
      this.highlightLineage(card ? card.dataset.id : null);
    });
    stage.addEventListener("pointerleave", () => {
      if (!this.selected) this.highlightLineage(null);
    });

    new ResizeObserver(() => this.resizeCanvas()).observe(stage);
    this.resizeCanvas();
  }

  zoomAt(cx, cy, factor) {
    const rect = this.stage.getBoundingClientRect();
    const sx = cx - rect.left, sy = cy - rect.top;
    const ns = Math.min(2.5, Math.max(0.08, this.scale * factor));
    const real = ns / this.scale;
    this.tx = sx - (sx - this.tx) * real;
    this.ty = sy - (sy - this.ty) * real;
    this.scale = ns;
    this.applyTransform();
  }

  resetView() {
    this.tx = 40; this.ty = 20; this.scale = 1;
    this.applyTransform();
  }

  applyTransform() {
    if (this._raf) return;               // coalesce to one update per frame
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.world.style.transform =
        `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
      const readout = document.getElementById("zoom-readout");
      if (readout) readout.textContent = `${Math.round(this.scale * 100)}%`;
      this.drawEdges();
      // Culling touches every card's inline style, which is layout work; do
      // it once the view settles rather than on every frame of a wheel spin.
      clearTimeout(this._cullTimer);
      this._cullTimer = setTimeout(() => this.cull(), 90);
    });
  }

  /* Virtualisation: cards outside the viewport (plus margin) are
     display:none'd so the compositor only handles what's visible.
     Kicks in above 800 placed cards (spec §8 threshold). */
  cull() {
    if (this.lay.pos.size <= 800) return;
    const { clientWidth: w, clientHeight: h } = this.stage;
    const m = 300; // margin so cards appear before entering view
    const x0 = (-this.tx - m) / this.scale, x1 = (w - this.tx + m) / this.scale;
    const y0 = (-this.ty - m) / this.scale, y1 = (h - this.ty + m) / this.scale;
    for (const [id, p] of this.lay.pos) {
      const el = this.cardEls.get(id);
      if (!el) continue;
      // Culling and filtering are independent: filter = .hidden class,
      // culling = inline display. Never skip filtered cards here or their
      // culled state goes stale and they vanish when the filter clears.
      const off = p.x > x1 || p.x + 208 < x0 || p.y > y1 || p.y + 64 < y0;
      if (off !== el._culled) {
        el._culled = off;
        el.style.display = off ? "none" : "";
      }
    }
  }

  resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = this.stage;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.drawEdges();
  }

  /* Edge geometry lives in world coordinates, so it does not change when
     the view pans or zooms. Build the paths once per layout/filter and
     stroke them under a canvas transform; rebuilding ~1400 beziers on every
     frame of a zoom was the real cost, not the number of pixels. */
  _buildEdgePaths() {
    const near = new Path2D(), far = new Path2D();
    for (const [id, p] of this.lay.pos) {
      if (this.visible !== null && !this.visible.has(id)) continue;
      const t = this.model.techs.get(id);
      for (const pid of t.prerequisites) {
        const pp = this.lay.pos.get(pid);
        if (!pp) continue;
        if (this.visible !== null && !this.visible.has(pid)) continue;
        const path = Math.abs(pp.y - p.y) < 2200 ? near : far;
        addEdge(path, pp, p);
      }
    }
    this._edgePaths = { near, far };
  }

  _buildLineagePath() {
    const lin = new Path2D();
    if (this.lineage) {
      for (const [id, p] of this.lay.pos) {
        if (!this.lineage.has(id)) continue;
        const t = this.model.techs.get(id);
        for (const pid of t.prerequisites) {
          if (!this.lineage.has(pid)) continue;
          const pp = this.lay.pos.get(pid);
          if (!pp) continue;
          addEdge(lin, pp, p);
        }
      }
    }
    this._lineagePath = lin;
  }

  drawEdges() {
    const ctx = this.canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.translate(this.tx, this.ty);
    ctx.scale(this.scale, this.scale);

    if (!this._edgePaths) this._buildEdgePaths();
    if (this._lineagePath === undefined) this._buildLineagePath();

    const css = getComputedStyle(document.documentElement);
    const lineCol = css.getPropertyValue("--line").trim() || "#2a3348";
    const hiCol = css.getPropertyValue("--physics").trim() || "#53a8e2";
    const dim = this.lineage ? 0.05 : 1;

    ctx.setLineDash([]);
    ctx.lineWidth = 1.25 / this.scale;
    ctx.strokeStyle = lineCol;
    ctx.globalAlpha = 0.5 * dim;
    ctx.stroke(this._edgePaths.near);
    ctx.globalAlpha = 0.12 * dim;
    ctx.setLineDash([5, 5]);
    ctx.stroke(this._edgePaths.far);
    ctx.setLineDash([]);
    if (this.lineage && this._lineagePath) {
      ctx.strokeStyle = hiCol;
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 2 / this.scale;
      ctx.stroke(this._lineagePath);
    }
    ctx.globalAlpha = 1;
  }

  relayout(lay, visibleSet) {
    this.lay = lay;
    this.visible = visibleSet;
    this._edgePaths = null;
    this.cardEls.clear();
    this.world.replaceChildren();
    this._buildDom();
    if (this.selected && !this.lay.pos.has(this.selected)) {
      this.selected = null;
      this.lineage = null;
      this.onSelect(null);
    } else if (this.selected) {
      this.cardEls.get(this.selected)?.classList.add("selected");
      this.highlightLineage(this.selected);
    }
    this.cull();
    this.drawEdges();
  }

  highlightLineage(id) {
    if (!id) {
      this.lineage = null;
      this._lineagePath = undefined;
      for (const el of this.cardEls.values()) el.classList.remove("dimmed");
      this.drawEdges();
      return;
    }
    const keep = new Set([id]);
    const walk = (start, key) => {
      const stack = [start];
      while (stack.length) {
        const t = this.model.techs.get(stack.pop());
        for (const n of t[key]) {
          if (!keep.has(n)) { keep.add(n); stack.push(n); }
        }
      }
    };
    walk(id, "prerequisites");
    walk(id, "unlocks");
    for (const [cid, el] of this.cardEls)
      el.classList.toggle("dimmed", !keep.has(cid));
    this.lineage = keep;
    this._lineagePath = undefined;
    this.drawEdges();
  }

  select(id) {
    if (this.selected) {
      const prev = this.cardEls.get(this.selected);
      if (prev) prev.classList.remove("selected");
    }
    this.selected = id;
    if (id) {
      const el = this.cardEls.get(id);
      if (el) el.classList.add("selected");
    }
    this.highlightLineage(id);
    this.onSelect(id);
  }

  centreOn(id) {
    const p = this.lay.pos.get(id);
    if (!p) return;
    const { clientWidth: w, clientHeight: h } = this.stage;
    this.tx = w / 2 - (p.x + CARD_W / 2) * this.scale;
    this.ty = h / 2 - (p.y + CARD_H / 2) * this.scale;
    this.applyTransform();
  }
}
