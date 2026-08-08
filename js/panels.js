/* panels.js — left sidebar (area groups → category checkboxes with live
   counts), search, and URL state sync (?tech=&q=&cats=&src=). */

const $ = id => document.getElementById(id);

export class Panels {
  constructor(model, onFilter, onJump) {
    this.model = model;
    this.onFilter = onFilter;   // (visibleIdSet|null) => void
    this.onJump = onJump;       // (techId) => void
    this.activeCats = null;     // null = all
    this.query = "";
    this.sourceFilter = "all";  // all | gigas | vanilla | override | crossmod
    this._buildSidebar();
    this._bindSearch();
  }

  _catCounts() {
    const counts = new Map();
    for (const t of this.model.techs.values()) {
      const c = t.categories[0] ?? "~none";
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return counts;
  }

  _buildSidebar() {
    const host = $("sidebar-cats");
    host.replaceChildren();
    const counts = this._catCounts();

    // Group categories by dominant area, mirroring layout order.
    const areaOf = new Map();
    for (const t of this.model.techs.values()) {
      const c = t.categories[0] ?? "~none";
      if (!areaOf.has(c)) areaOf.set(c, new Map());
      const m = areaOf.get(c);
      m.set(t.area, (m.get(t.area) ?? 0) + 1);
    }
    const dominant = c => {
      let best = null, n = -1;
      for (const [a, k] of areaOf.get(c))
        if (k > n || (k === n && String(a) < String(best))) { best = a; n = k; }
      return best ?? "other";
    };
    const groups = new Map();
    for (const c of [...counts.keys()].sort()) {
      const a = dominant(c) ?? "other";
      if (!groups.has(a)) groups.set(a, []);
      groups.get(a).push(c);
    }

    const order = ["physics", "society", "engineering", "other"];
    for (const area of order) {
      const cats = groups.get(area);
      if (!cats) continue;
      const h = document.createElement("h3");
      h.className = `sidebar-area area-${area}`;
      h.textContent = area;
      host.appendChild(h);
      for (const c of cats) {
        const label = document.createElement("label");
        label.className = "sidebar-cat";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        cb.dataset.cat = c;
        cb.addEventListener("change", () => this._recompute());
        const span = document.createElement("span");
        span.textContent = c === "~none" ? "uncategorised" : c.replace(/_/g, " ");
        const count = document.createElement("span");
        count.className = "sidebar-count";
        count.textContent = counts.get(c);
        label.append(cb, span, count);
        host.appendChild(label);
      }
    }

    $("show-all").addEventListener("click", () => {
      host.querySelectorAll("input[type=checkbox]")
          .forEach(cb => { cb.checked = true; });
      $("source-filter").value = "all";
      this.sourceFilter = "all";
      this._recompute();
    });
    $("source-filter").addEventListener("change", e => {
      this.sourceFilter = e.target.value;
      this._recompute();
    });
  }

  _bindSearch() {
    const box = $("search-box");
    const results = $("search-results");
    box.addEventListener("input", () => {
      this.query = box.value.trim().toLowerCase();
      this._recompute();
      results.replaceChildren();
      if (this.query.length < 2) return;
      const hits = [];
      for (const t of this.model.techs.values()) {
        if (t.name.toLowerCase().includes(this.query) ||
            t.id.toLowerCase().includes(this.query)) {
          hits.push(t);
          if (hits.length >= 12) break;
        }
      }
      for (const t of hits) {
        const li = document.createElement("li");
        li.textContent = t.name;
        li.tabIndex = 0;
        const go = () => { this.onJump(t.id); results.replaceChildren(); };
        li.addEventListener("click", go);
        li.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
        results.appendChild(li);
      }
    });
  }

  _matchesSource(t) {
    switch (this.sourceFilter) {
      case "gigas": return t.source !== "vanilla";
      case "vanilla": return t.source === "vanilla";
      case "override": return t.overridesVanilla;
      case "crossmod": return t.crossModGated;
      default: return true;
    }
  }

  _recompute() {
    const checked = new Set(
      [...document.querySelectorAll("#sidebar-cats input:checked")]
        .map(cb => cb.dataset.cat));
    const allChecked =
      checked.size ===
      document.querySelectorAll("#sidebar-cats input").length;
    this.activeCats = allChecked ? null : checked;

    if (this.activeCats === null && !this.query &&
        this.sourceFilter === "all") {
      this.onFilter(null);
      this.syncUrl();
      return;
    }
    const visible = new Set();
    for (const t of this.model.techs.values()) {
      const cat = t.categories[0] ?? "~none";
      if (this.activeCats && !this.activeCats.has(cat)) continue;
      if (!this._matchesSource(t)) continue;
      if (this.query &&
          !t.name.toLowerCase().includes(this.query) &&
          !t.id.toLowerCase().includes(this.query)) continue;
      visible.add(t.id);
    }
    this.onFilter(visible);
    this.syncUrl();
  }

  // -- URL state ------------------------------------------------------

  syncUrl(techId = undefined) {
    const p = new URLSearchParams(location.search);
    if (techId !== undefined) {
      if (techId) p.set("tech", techId); else p.delete("tech");
    }
    if (this.query) p.set("q", this.query); else p.delete("q");
    if (this.activeCats)
      p.set("cats", [...this.activeCats].sort().join(","));
    else p.delete("cats");
    if (this.sourceFilter !== "all") p.set("src", this.sourceFilter);
    else p.delete("src");
    history.replaceState(null, "",
      p.size ? `?${p}` : location.pathname);
  }

  applyUrl() {
    const p = new URLSearchParams(location.search);
    const q = p.get("q");
    if (q) { $("search-box").value = q; this.query = q.toLowerCase(); }
    const cats = p.get("cats");
    if (cats) {
      const want = new Set(cats.split(","));
      document.querySelectorAll("#sidebar-cats input").forEach(cb => {
        cb.checked = want.has(cb.dataset.cat);
      });
    }
    const src = p.get("src");
    if (src) { this.sourceFilter = src; $("source-filter").value = src; }
    if (q || cats || src) this._recompute();
    return p.get("tech");
  }
}
