/* health.js — the mod-QA panel. Renders the build's health arrays as
   clickable lists. Owns #health-panel; remove the file + the footer button
   + the panel div to drop the feature. */

export class HealthPanel {
  constructor(host, model, onJump) {
    this.host = host;
    this.model = model;
    this.onJump = onJump;
    this._build();
  }

  _section(title, entries, render) {
    if (!entries.length) return;
    const h = document.createElement("h3");
    h.textContent = `${title} (${entries.length})`;
    this.host.appendChild(h);
    const ul = document.createElement("ul");
    for (const e of entries.slice(0, 200)) {
      const li = document.createElement("li");
      render(li, e);
      ul.appendChild(li);
    }
    if (entries.length > 200) {
      const li = document.createElement("li");
      li.textContent = `… and ${entries.length - 200} more`;
      ul.appendChild(li);
    }
    this.host.appendChild(ul);
  }

  _jumpLink(li, techId, text) {
    const a = document.createElement("span");
    a.className = "tech-link";
    a.textContent = text;
    a.addEventListener("click", () => this.onJump(techId));
    li.appendChild(a);
  }

  _build() {
    const h = this.model.health;
    const meta = this.model.meta;

    const summary = document.createElement("p");
    summary.className = "health-summary";
    summary.textContent =
      `${meta.counts.technologies} techs · ` +
      `${meta.counts.overrides} vanilla overrides · ` +
      `${meta.counts.crossModGated} cross-mod`;
    this.host.appendChild(summary);

    // Build-time findings are computed mod-only; anything the composed
    // dataset resolves (vanilla techs, vanilla-provided names) is not a
    // finding for the viewer.
    const stillMissing = h.dangling.filter(e => {
      const hit = this.model.techs.get(e.missing);
      return !hit || hit.stub;
    });
    const stillNoLoc = h.missingLoc.filter(e => {
      const t = this.model.techs.get(e.techId);
      if (!t) return true;
      return e.key.endsWith("_desc") ? t.desc == null : t.nameMissing;
    });

    this._section("Dangling prerequisites", stillMissing, (li, e) => {
      this._jumpLink(li, e.techId, e.techId);
      li.append(` → missing `);
      const m = document.createElement("code");
      m.textContent = e.missing;
      li.appendChild(m);
      li.append(` (${e.file}:${e.line})`);
    });

    this._section("Tier inversions", h.tierInversions, (li, e) => {
      this._jumpLink(li, e.techId, e.techId);
      li.append(` (T${e.tier}) requires `);
      this._jumpLink(li, e.prereq, e.prereq);
      li.append(` (T${e.prereqTier})`);
    });

    this._section("Missing localisation", stillNoLoc, (li, e) => {
      this._jumpLink(li, e.techId, e.techId);
      li.append(` — key `);
      const c = document.createElement("code");
      c.textContent = e.key;
      li.appendChild(c);
    });

    this._section("Prerequisite cycles", h.cycles, (li, cyc) => {
      li.textContent = cyc.join(" → ");
    });

    this._section("Build warnings", h.warnings, (li, e) => {
      li.textContent = `${e.kind}: ${e.message ?? ""} ` +
        `(${e.techId ?? e.file ?? ""})`;
    });

    if (!this.host.children.length) {
      const p = document.createElement("p");
      p.textContent = "No findings. Clean build.";
      this.host.appendChild(p);
    }
  }
}
