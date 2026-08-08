/* explore.js — the Explore tab. Deliberately loosely coupled: this module
   owns everything inside #explore-tab. To remove the feature entirely,
   delete this file, the "Explore" tab button, and the #explore-tab div in
   index.html — nothing else references it. */

export class ExploreTable {
  constructor(host, model, onJump) {
    this.host = host;
    this.model = model;
    this.onJump = onJump;
    this.sortKey = "name";
    this.sortDir = 1;
    this.visible = null;   // Set from the sidebar filter, or null
    this._build();
  }

  setFilter(visibleSet) {
    this.visible = visibleSet;
    this._renderRows();
  }

  _build() {
    const cols = [
      ["name", "Name"], ["area", "Area"], ["cat", "Category"],
      ["tier", "Tier"], ["cost", "Cost"], ["weight", "Weight"],
      ["source", "Source"],
    ];
    const table = document.createElement("table");
    table.className = "explore-table";
    const thead = document.createElement("thead");
    const tr = document.createElement("tr");
    for (const [key, label] of cols) {
      const th = document.createElement("th");
      th.textContent = label;
      th.tabIndex = 0;
      th.setAttribute("role", "button");
      const sort = () => {
        this.sortDir = this.sortKey === key ? -this.sortDir : 1;
        this.sortKey = key;
        this._renderRows();
      };
      th.addEventListener("click", sort);
      th.addEventListener("keydown", e => { if (e.key === "Enter") sort(); });
      tr.appendChild(th);
    }
    thead.appendChild(tr);
    table.appendChild(thead);
    this.tbody = document.createElement("tbody");
    table.appendChild(this.tbody);
    this.host.appendChild(table);
    this._renderRows();
  }

  _key(t) {
    switch (this.sortKey) {
      case "area": return t.area ?? "";
      case "cat": return t.categories[0] ?? "";
      case "tier": return t.tier ?? -1;
      case "cost": return typeof t.cost === "number" ? t.cost : -1;
      case "weight": return typeof t.weight === "number" ? t.weight : -1;
      case "source": return `${t.source}${t.overridesVanilla ? "!" : ""}`;
      default: return t.name.toLowerCase();
    }
  }

  _renderRows() {
    const rows = [...this.model.techs.values()]
      .filter(t => !t.stub)
      .filter(t => this.visible === null || this.visible.has(t.id))
      .sort((a, b) => {
        const ka = this._key(a), kb = this._key(b);
        if (ka < kb) return -this.sortDir;
        if (ka > kb) return this.sortDir;
        return a.id < b.id ? -1 : 1;
      });
    const frag = document.createDocumentFragment();
    for (const t of rows) {
      const tr = document.createElement("tr");
      tr.tabIndex = 0;
      const cells = [
        t.name, t.area ?? "", (t.categories[0] ?? "").replace(/_/g, " "),
        t.isRepeatable
          ? (t.tier !== null ? `${t.tier} (repeatable)` : "Repeatable")
          : (t.tier ?? ""),
        t.cost ?? "", t.weight ?? "",
        t.overridesVanilla ? `${t.source} (override)` : t.source,
      ];
      for (const c of cells) {
        const td = document.createElement("td");
        td.textContent = String(c);
        tr.appendChild(td);
      }
      const go = () => this.onJump(t.id);
      tr.addEventListener("click", go);
      tr.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
      frag.appendChild(tr);
    }
    this.tbody.replaceChildren(frag);
  }
}
