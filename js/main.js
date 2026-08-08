/* main.js — bootstrap: manifest → dataset → layout → render. */

import { loadManifest, loadDataset, loadVanilla, compose } from "./data.js";
import { layout } from "./layout.js";
import { MapView } from "./render.js";
import { Panels } from "./panels.js";
import { ExploreTable } from "./explore.js";
import { HealthPanel } from "./health.js";

const $ = id => document.getElementById(id);

let view = null;
let model = null;
let panels = null;
let explore = null;

const DEV = new URLSearchParams(location.search).has("dev");

async function boot() {
  const status = $("status");
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

function showModel(newModel) {
  model = newModel;
  $("world").replaceChildren();
  $("sidebar-cats").replaceChildren();
  $("explore-tab").replaceChildren();
  $("health-body").replaceChildren();
  {
    const lay = layout(model.techs);
    view = new MapView($("stage"), $("world"), $("edge-canvas"),
                       model, lay, showDetail);

    const jump = id => {
      setTab("map");
      closeModals();
      view.select(id);
      view.centreOn(id);
    };
    panels = new Panels(model,
      visible => { view.setFilter(visible); explore?.setFilter(visible); },
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

  // Health is a mod-developer instrument; end users don't need a lint
  // report. Visible only with ?dev in the URL.
  if (DEV) {
    $("health-btn").hidden = false;
    $("localmod-btn").hidden = false;
    $("localmod-btn").onclick = () => $("localmod-input").click();
    $("localmod-input").onchange = async e => {
      const files = [...e.target.files];
      if (!files.length) return;
      const status = $("status");
      status.textContent = "Parsing mod locally…";
      status.hidden = false;
      try {
        const { loadLocalMod } = await import("./localmod.js");
        const folder = files[0].webkitRelativePath?.split("/")[0] || "Local mod";
        const localModel = await loadLocalMod(files, folder);
        showModel(compose(localModel, await loadVanilla()));
        $("localmod-reset").hidden = false;
        $("build-info").textContent =
          `${folder} · ${localModel.technologies.length} techs (local)`;
        status.hidden = true;
      } catch (err) {
        status.textContent = `Local mod failed — ${err.message}`;
      }
      e.target.value = "";
    };
    $("localmod-reset").onclick = () => {
      $("localmod-reset").hidden = true;
      boot();
    };
  }
  $("health-btn").onclick = e => {
    e.stopPropagation();
    $("health-panel").hidden = !$("health-panel").hidden;
  };

  // Click outside any open modal panel closes it.
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
  addBadge(t.stub ? "external mod (not in Gigas or vanilla)" : t.source,
           t.stub ? "crossmod" : "");
  if (t.overridesVanilla) addBadge("overrides vanilla", "override");
  if (t.crossModGated) addBadge("requires another mod", "crossmod");
  if (t.isRare) addBadge("rare");
  if (t.isDangerous) addBadge("dangerous");
  if (t.isRepeatable) addBadge("repeatable");
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
