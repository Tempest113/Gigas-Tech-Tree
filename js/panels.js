/* panels.js — left sidebar (area groups → category checkboxes with live
   counts), search, and URL state sync (?tech=&q=&cats=&src=). */

const $ = id => document.getElementById(id);

import { descendantsOf, lineageOf, MISC_CATEGORIES,
         profileAllows } from "./viewmodel.js";

export class Panels {
  constructor(model, onFilter, onJump) {
    this.model = model;
    this.onFilter = onFilter;   // (visibleIdSet|null) => void
    this.onJump = onJump;       // (techId) => void
    this.activeCats = null;     // null = all
    this.query = "";
    this.sourceFilter = "all";  // all | gigas | vanilla | crossmod
    this.reqFilter = "all";     // all | tech:<id> | perk:<id>
    // Empire profile (prototype, ?dev only). "all" shows every technology
    // regardless of empire shape; a named profile hides what that empire can
    // never research. Distinct from the other filters: those narrow what you
    // are looking at, this one narrows what exists for you.
    this.profile = "all";
    this.isolated = null;       // technology id, from a middle-click
    this._reqCache = new Map();
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
    // A category whose techs span research areas (Blokkats: physics,
    // society and engineering) doesn't belong under any one area heading.
    const dominant = c => {
      if (MISC_CATEGORIES.includes(c)) return "misc";
      const m = areaOf.get(c);
      let best = null, n = -1, total = 0;
      for (const [a, k] of m) {
        total += k;
        if (k > n || (k === n && String(a) < String(best))) { best = a; n = k; }
      }
      // Categories spread across research areas (Blokkats, and any future
      // crisis/event line like Aeternite) are grouped as misc rather than
      // filed under whichever area happens to hold the most.
      if (m.size > 1 && n / total < 0.8) return "misc";
      return best ?? "misc";
    };
    const miscRank = c => {
      const i = MISC_CATEGORIES.indexOf(c);
      return i === -1 ? MISC_CATEGORIES.length : i;
    };
    const groups = new Map();
    const ordered = [...counts.keys()].sort((a, b) =>
      (miscRank(a) - miscRank(b)) || (a < b ? -1 : a > b ? 1 : 0));
    for (const c of ordered) {
      const a = dominant(c) ?? "other";
      if (!groups.has(a)) groups.set(a, []);
      groups.get(a).push(c);
    }

    const order = ["physics", "society", "engineering", "misc"];
    for (const area of order) {
      const cats = groups.get(area);
      if (!cats) continue;
      if (area === "misc") {
        // No heading: a plain rule, so misc categories read as "everything
        // else" rather than as a named group.
        const hr = document.createElement("div");
        hr.className = "sidebar-divider";
        host.appendChild(hr);
      } else {
        const h = document.createElement("h3");
        h.className = `sidebar-area area-${area}`;
        h.textContent = area;
        host.appendChild(h);
      }
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

    // Show all / Hide all: hiding everything is the fast way to build up a
    // narrow view, showing everything the fast way to reset.
    const showAll = $("show-all");
    showAll.addEventListener("click", () => {
      const boxes = [...host.querySelectorAll("input[type=checkbox]")];
      const anyChecked = boxes.some(cb => cb.checked);
      boxes.forEach(cb => { cb.checked = !anyChecked; });
      if (anyChecked) {
        showAll.textContent = "Show all";
      } else {
        showAll.textContent = "Hide all";
        $("source-filter").value = "all";
        this.sourceFilter = "all";
        $("req-filter").value = "all";
        this.reqFilter = "all";
        this.isolated = null;
      }
      this._recompute();
    });
    $("source-filter").addEventListener("change", e => {
      this.sourceFilter = e.target.value;
      this._recompute();
    });
    $("req-filter").addEventListener("change", e => {
      this.reqFilter = e.target.value;
      this._recompute();
    });
  }

  _bindSearch() {
    const box = $("search-box");
    const results = $("search-results");
    box.addEventListener("input", () => {
      this.query = box.value.trim().toLowerCase();
      if (this.query && this.isolated) {
        this.isolated = null;
        $("isolate-bar").hidden = true;
      }
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
      case "gigas": return t.source !== "vanilla" && !t.external;
      case "vanilla": return t.source === "vanilla";
      default: return true;
    }
  }

  /* Set of ids satisfying the requirement filter, cached per selection.
     `tech:` is everything downstream of a technology (so "Requires
     Mega-Engineering" means it is somewhere in the prerequisite chain);
     `perk:` is everything needing an ascension perk, directly or through a
     prerequisite. */
  _requirementSet() {
    if (this.reqFilter === "all") return null;
    if (this._reqCache.has(this.reqFilter))
      return this._reqCache.get(this.reqFilter);

    const [kind, id] = this.reqFilter.split(":");
    let set;
    if (kind === "tech") {
      set = this.model.techs.has(id)
        ? descendantsOf(this.model.techs, id) : new Set();
    } else {
      set = new Set();
      for (const t of this.model.techs.values()) {
        // Soft perks count, matching gateRank() in layout.js: a technology
        // reachable only through this perk or a questline flag is filed
        // under the gate on the map, so the filter must agree or the gate
        // band and the filter disagree about the same technology.
        if ((t.ascensionPerks ?? []).includes(id) ||
            (t.inheritedPerks ?? []).includes(id) ||
            (t.softPerks ?? []).includes(id)) set.add(t.id);
      }
    }
    this._reqCache.set(this.reqFilter, set);
    return set;
  }

  isolate(id) {
    // Isolating a chain and filtering by text are two ways of narrowing to
    // different things; leaving both on hides most of the chain you asked
    // for. Each clears the other.
    if (id && this.query) {
      this.query = "";
      $("search-box").value = "";
      $("search-results").replaceChildren();
    }
    this.isolated = id;
    const bar = $("isolate-bar");
    if (id) {
      $("isolate-label").textContent =
        `Showing ${this.model.techs.get(id)?.name ?? id} and its chain`;
      bar.hidden = false;
    } else {
      bar.hidden = true;
    }
    this._recompute();
  }

  _recompute() {
    const checked = new Set(
      [...document.querySelectorAll("#sidebar-cats input:checked")]
        .map(cb => cb.dataset.cat));
    const allChecked =
      checked.size ===
      document.querySelectorAll("#sidebar-cats input").length;
    this.activeCats = allChecked ? null : checked;

    const reqSet = this._requirementSet();
    const isoSet = this.isolated
      ? lineageOf(this.model.techs, this.isolated) : null;

    if (this.activeCats === null && !this.query &&
        this.sourceFilter === "all" && !reqSet && !isoSet &&
        this.profile === "all") {
      this.onFilter(null);
      this.syncUrl();
      return;
    }
    const visible = new Set();
    for (const t of this.model.techs.values()) {
      if (isoSet && !isoSet.has(t.id)) continue;
      if (reqSet && !reqSet.has(t.id)) continue;
      const cat = t.categories[0] ?? "~none";
      // An isolated chain crosses categories by definition, so category and
      // source filters step aside while it is active.
      if (!isoSet) {
        if (this.activeCats && !this.activeCats.has(cat)) continue;
        if (!this._matchesSource(t)) continue;
      }
      if (!profileAllows(t, this.profile)) continue;
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
    if (this.reqFilter !== "all") p.set("req", this.reqFilter);
    else p.delete("req");
    if (this.isolated) p.set("only", this.isolated);
    else p.delete("only");
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
    const req = p.get("req");
    if (req) { this.reqFilter = req; $("req-filter").value = req; }
    const only = p.get("only");
    if (only && this.model.techs.has(only)) { this.isolate(only); return p.get("tech"); }
    // Always compute once: defaults are a filter too — other mods' content
    // is hidden unless asked for.
    this._recompute();
    return p.get("tech");
  }
}
