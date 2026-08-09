/* main.js — bootstrap: manifest → dataset → layout → render. */

import { loadManifest, loadDataset, loadVanilla, compose } from "./data.js";
import { layout } from "./layout.js";
import { MapView, apName } from "./render.js";
import { Panels } from "./panels.js";
import { APP_VERSION } from "./version.js";
import { ExploreTable } from "./explore.js";
import { HealthPanel } from "./health.js";

const $ = id => document.getElementById(id);

let view = null;
let model = null;
let panels = null;
let explore = null;
let colMode = new URLSearchParams(location.search).get("cols") === "gate"
  ? "gate" : "tier";
let modSources = [];   // dev: ordered list of locally-loaded mod folders

const DEV = new URLSearchParams(location.search).has("dev");

export { APP_VERSION } from "./version.js";

async function boot() {
  const status = $("status");
  $("app-version").textContent = `v${APP_VERSION}`;
  try {
    const manifest = await loadManifest();
    const m0 = await loadDataset(manifest.datasets[0]);
    const commit = manifest.datasets[0].commit ?? "";
    $("build-info").textContent =
      commit && commit !== "unknown" ? commit.slice(0, 10) : "";
    showModel(m0);
    status.hidden = true;
  } catch (err) {
    status.textContent =
      `Could not load data — ${err.message}. Run tools/build_data.py first.`;
  }
}

/* Rebuild the view from the current local mod list (dev feature). With no
   mods loaded, falls back to the shipped Gigastructures dataset. */
async function refreshMods() {
  const status = $("status");
  const hasMods = modSources.length > 0;
  $("localmod-reset").hidden = !hasMods;
  $("modlist-btn").hidden = !DEV;
  renderModList();
  if (!hasMods) { await boot(); return; }
  status.textContent = "Merging mods\u2026";
  status.hidden = false;
  try {
    const { buildFromSources } = await import("./localmod.js");
    const merged = await buildFromSources(modSources);
    showModel(compose(merged, await loadVanilla()));
    const enabled = modSources.filter(s => s.enabled).length;
    $("build-info").textContent =
      `${enabled}/${modSources.length} mods \u00b7 ` +
      `${merged.technologies.length} techs (local)`;
    renderModList(merged);
    status.hidden = true;
  } catch (err) {
    status.textContent = `Merge failed \u2014 ${err.message}`;
  }
}

function renderModList(merged) {
  const host = $("modlist");
  if (!host) return;
  host.replaceChildren();
  const counts = new Map();
  for (const t of merged?.technologies ?? [])
    counts.set(t.source, (counts.get(t.source) ?? 0) + 1);

  modSources.forEach((s, i) => {
    const li = document.createElement("li");
    li.classList.toggle("disabled", !s.enabled);

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = s.enabled;
    cb.title = "Include this mod in the merge";
    cb.onchange = () => { s.enabled = cb.checked; refreshMods(); };

    const name = document.createElement("span");
    name.className = "mod-name";
    name.textContent = s.label;
    name.title = s.id;

    const count = document.createElement("span");
    count.className = "mod-count";
    count.textContent = counts.has(s.id) ? `${counts.get(s.id)} techs` : "";

    const up = document.createElement("button");
    up.textContent = "\u2191";
    up.title = "Load earlier (lower priority)";
    up.disabled = i === 0;
    up.onclick = () => {
      [modSources[i - 1], modSources[i]] = [modSources[i], modSources[i - 1]];
      refreshMods();
    };

    const down = document.createElement("button");
    down.textContent = "\u2193";
    down.title = "Load later (higher priority)";
    down.disabled = i === modSources.length - 1;
    down.onclick = () => {
      [modSources[i + 1], modSources[i]] = [modSources[i], modSources[i + 1]];
      refreshMods();
    };

    const rm = document.createElement("button");
    rm.textContent = "\u2715";
    rm.title = "Remove";
    rm.onclick = () => { modSources.splice(i, 1); refreshMods(); };

    li.append(cb, name, count, up, down, rm);
    host.appendChild(li);
  });

  if (!modSources.length) {
    const li = document.createElement("li");
    li.textContent = "No mods loaded \u2014 showing the shipped dataset.";
    host.appendChild(li);
  }
}

function showModel(newModel) {
  model = newModel;
  $("sidebar-cats").replaceChildren();
  $("explore-tab").replaceChildren();
  $("health-body").replaceChildren();
  {
    const lay = layout(model.techs, null, colMode);
    view = new MapView($("stage"), $("world"), $("edge-canvas"),
                       model, lay, showDetail,
                       id => {
                         panels?.isolate(id);
                         // Frame the chain, or the user has to hunt for it.
                         requestAnimationFrame(() =>
                           view.fitTo(view.index.items.map(i => i.id)));
                       });
    window.__view = view;   // test hook (tests/dom-smoke.mjs)

    if (DEV) {
      // Draw-time meter: median and worst of the last 60 frames. Only the
      // renderer's own work, so it isolates this code from compositing and
      // GPU cost — useful for comparing machines.
      const meter = $("perf-meter");
      meter.hidden = false;
      let last = 0;
      view.onFrame = (dt, frames) => {
        const now = performance.now();
        if (now - last < 250) return;
        last = now;
        const s = [...frames].sort((a, b) => a - b);
        const med = s[s.length >> 1] ?? 0;
        const worst = s[s.length - 1] ?? 0;
        const p = view._phase;
        meter.textContent =
          `draw ${med.toFixed(1)}/${worst.toFixed(1)}ms · ` +
          `bg ${p.furniture.toFixed(1)} edges ${p.edges.toFixed(1)} ` +
          `cards ${p.cards.toFixed(1)} (${p.n}) · ` +
          `${p.px}Mpx @${p.dpr?.toFixed(2)}x${p.degraded ? " (reduced)" : ""}`;
      };
    }

    const jump = id => {
      setTab("map");
      closeModals();
      view.select(id);
      view.centreOn(id);
    };
    panels = new Panels(model,
      visible => {
        view.relayout(layout(model.techs, visible, colMode), visible);
        explore?.setFilter(visible);
      },
      jump);

    explore = new ExploreTable($("explore-tab"), model, jump);
    new HealthPanel($("health-body"), model, jump);

    bindChrome(jump);
    const deepTech = panels.applyUrl();
    if (deepTech && model.techs.has(deepTech)) jump(deepTech);
    bindKeys();
  }
}

function setTab(name) {
  for (const b of document.querySelectorAll(".tab")) {
    const on = b.dataset.tab === name;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  }
  $("explore-tab").hidden = name !== "explore";
}

function closeModals() {
  for (const p of document.querySelectorAll(".modal-panel"))
    p.hidden = true;
}

function bindChrome(jump) {

  for (const b of document.querySelectorAll(".tab"))
    b.onclick = () => setTab(b.dataset.tab);
  for (const x of document.querySelectorAll("[data-close]"))
    x.onclick = () => { $(x.dataset.close).hidden = true; };

  const modeSel = $("mode-select");
  modeSel.value = colMode;
  modeSel.onchange = () => {
    colMode = modeSel.value;
    const p = new URLSearchParams(location.search);
    if (colMode === "gate") p.set("cols", "gate"); else p.delete("cols");
    history.replaceState(null, "", p.size ? `?${p}` : location.pathname);
    view.relayout(layout(model.techs, view.visible, colMode), view.visible);
  };

  $("guide-btn").onclick = e => {
    e.stopPropagation();
    $("guide-panel").hidden = !$("guide-panel").hidden;
  };

  // Health is a mod-developer instrument; end users don't need a lint
  // report. Visible only with ?dev in the URL.
  if (DEV) {
    $("health-btn").hidden = false;
    $("health-btn").onclick = e => {
      e.stopPropagation();
      $("health-panel").hidden = !$("health-panel").hidden;
    };
    $("localmod-btn").hidden = false;
    $("localmod-btn").onclick = () => $("localmod-input").click();
    $("modlist-btn").onclick = e => {
      e.stopPropagation();
      $("modlist-panel").hidden = !$("modlist-panel").hidden;
    };
    $("modlist-add").onclick = () => $("localmod-input").click();
    $("modlist-clear").onclick = () => { modSources = []; refreshMods(); };
    $("localmod-input").onchange = async e => {
      const files = [...e.target.files];
      e.target.value = "";
      if (!files.length) return;
      const status = $("status");
      status.textContent = "Reading mod\u2026";
      status.hidden = false;
      try {
        const { readModSource } = await import("./localmod.js");
        const src = await readModSource(files);
        const dup = modSources.findIndex(s => s.id === src.id);
        if (dup !== -1) modSources[dup] = src; else modSources.push(src);
        await refreshMods();
      } catch (err) {
        status.textContent = `Could not read mod \u2014 ${err.message}`;
      }
    };
    $("localmod-reset").onclick = () => { modSources = []; refreshMods(); };
  }

  document.addEventListener("pointerdown", e => {
    for (const p of document.querySelectorAll(".modal-panel:not([hidden])")) {
      if (!p.contains(e.target)) p.hidden = true;
    }
  });

  $("zoom-in").onclick = () => view.zoomAt(
    innerWidth / 2, innerHeight / 2, 1.25);
  $("zoom-out").onclick = () => view.zoomAt(
    innerWidth / 2, innerHeight / 2, 1 / 1.25);
  $("zoom-reset").onclick = () => view.resetView();
  $("detail-close").onclick = () => view.select(null);
  $("isolate-clear").onclick = () => panels.isolate(null);
}

function bindKeys() {
  document.onkeydown = e => {
    if (e.target.matches("input, select, textarea")) {
      if (e.key === "Escape") e.target.blur();
      return;
    }
    if (e.key === "f" || e.key === "F") {
      e.preventDefault(); $("search-box").focus();
    } else if (e.key === "Escape") {
      closeModals();
      if (panels?.isolated) panels.isolate(null);
      view.select(null);
    } else if (e.key === "Backspace") {
      e.preventDefault(); history.back();
    }
  };
}

/* Full prerequisite closure of a tech, topologically ordered, with
   cumulative cost — "what does it take to reach this". */
function pathTo(targetId) {
  const need = [];
  const seen = new Set();
  const visit = id => {
    if (seen.has(id)) return;
    seen.add(id);
    const t = model.techs.get(id);
    if (!t || t.stub) return;
    for (const p of [...t.prerequisites].sort()) visit(p);
    need.push(t);
  };
  visit(targetId);
  let cum = 0;
  return need.map(t => {
    const cost = typeof t.cost === "number" ? t.cost : 0;
    cum += cost;
    return { tech: t, cost, cumulative: cum };
  });
}

function showDetail(id) {
  const panel = $("detail");
  panels?.syncUrl(id ?? null);
  if (!id) { panel.hidden = true; return; }
  const t = model.techs.get(id);
  const body = $("detail-body");
  body.replaceChildren();

  const h2 = document.createElement("h2");
  h2.textContent = t.name;
  body.appendChild(h2);

  const meta = document.createElement("div");
  meta.className = "detail-meta";
  meta.textContent = [
    t.area ?? "unknown area",
    t.tier !== null ? `tier ${t.tier}` : null,
    t.cost !== null ? `cost ${t.cost}` : null,
    t.weight !== null ? `weight ${t.weight}` : null,
  ].filter(Boolean).join(" · ");
  body.appendChild(meta);

  const badges = document.createElement("div");
  const addBadge = (text, cls = "") => {
    const b = document.createElement("span");
    b.className = `badge ${cls}`;
    b.textContent = text;
    badges.appendChild(b);
  };
  const SOURCE_LABEL = { gigas: "Gigastructures", vanilla: "Vanilla",
                         local: "Local mod" };
  addBadge(t.stub ? "external mod (not in Gigastructures or vanilla)"
                  : (t.sourceLabel ?? SOURCE_LABEL[t.source] ?? t.source),
           t.stub ? "crossmod" : "");
  if (t.overridesVanilla) addBadge("overrides vanilla", "override");
  if (t.crossModGated) addBadge("requires another mod", "crossmod");
  for (const ap of t.ascensionPerks ?? [])
    addBadge(t.grantedByPerks?.includes(ap)
      ? `granted by ascension perk: ${apName(ap, model.perkNames)}`
      : `requires ascension perk: ${apName(ap, model.perkNames)}`, "ap");
  const condName = key => model.meta?.conditionLabels?.[key]
    ?? key.replace(/^(has|is)_/, "").replace(/_/g, " ");
  for (const grp of t.perkGroups ?? []) {
    const alts = [...grp.perks.map(p => apName(p, model.perkNames)),
                  ...(grp.conditions ?? []).map(condName)];
    if (alts.length > 1) addBadge(`requires ${alts.join(" or ")}`, "ap");
  }
  for (const ap of t.inheritedPerks ?? [])
    if (!(t.ascensionPerks ?? []).includes(ap))
      addBadge(`needs ${apName(ap, model.perkNames)}, via a prerequisite`,
               "ap");
  if (t.isRare) addBadge("rare");
  if (t.isDangerous) addBadge("dangerous");
  if (t.isRepeatable) {
    addBadge(t.levels > 0 ? `repeatable · ${t.levels} levels`
      : t.levels === -1 ? "repeatable · unlimited" : "repeatable");
  }
  body.appendChild(badges);

  if (t.desc) {
    const d = document.createElement("p");
    d.className = "detail-desc";
    d.textContent = t.desc;
    body.appendChild(d);
  }

  const linkList = (title, ids) => {
    if (!ids.length) return;
    const h = document.createElement("h3");
    h.textContent = title;
    body.appendChild(h);
    const ul = document.createElement("ul");
    for (const pid of ids) {
      const li = document.createElement("li");
      const a = document.createElement("span");
      a.className = "tech-link";
      a.textContent = model.techs.get(pid)?.name ?? pid;
      a.onclick = () => { view.select(pid); view.centreOn(pid); };
      li.appendChild(a);
      ul.appendChild(li);
    }
    body.appendChild(ul);
  };
  linkList("Prerequisites", t.prerequisites);
  linkList("Unlocks", t.unlocks);

  if (t.unlockText.length) {
    const h = document.createElement("h3");
    h.textContent = "Grants";
    body.appendChild(h);
    const ul = document.createElement("ul");
    for (const u of t.unlockText) {
      const li = document.createElement("li");
      li.textContent = u;
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }

  if (!t.stub) {
    const path = pathTo(id);
    if (path.length > 1) {
      const h = document.createElement("h3");
      h.textContent = `Research path (${path.length} techs)`;
      body.appendChild(h);
      const ol = document.createElement("ol");
      ol.className = "research-path";
      for (const step of path) {
        const li = document.createElement("li");
        const a = document.createElement("span");
        a.className = "tech-link";
        a.textContent = step.tech.name;
        a.onclick = () => { view.select(step.tech.id); view.centreOn(step.tech.id); };
        li.appendChild(a);
        const c = typeof step.tech.cost === "number"
          ? String(step.cost) : "\u2014";
        li.append(` — ${c} (\u03a3 ${step.cumulative})`);
        ol.appendChild(li);
      }
      body.appendChild(ol);
    }
  }

  if (t.sourceFile) {
    const h = document.createElement("h3");
    h.textContent = "Source";
    body.appendChild(h);
    const p = document.createElement("p");
    const a = document.createElement("a");
    const commit = model.meta.sources[0]?.commit ?? "Master-Dev";
    const [path, lineFrag] = t.sourceFile.split("#");
    a.href = `https://github.com/Pouchkinn-s-Gigastructures/Gigastructures/blob/${commit}/${path}#${lineFrag}`;
    a.target = "_blank"; a.rel = "noopener";
    a.textContent = t.sourceFile;
    p.appendChild(a);
    body.appendChild(p);
  }

  panel.hidden = false;
}

boot();
