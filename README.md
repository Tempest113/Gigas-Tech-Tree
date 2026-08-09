# Gigastructures Tech Tree

An interactive browser for the Stellaris technology tree with first-class
support for **Gigastructural Engineering & More** (Pouchkinn's fork),
composed with vanilla data. Static site for GitHub Pages: all parsing happens
at build time; the browser loads pre-baked JSON.

**Live:** enable GitHub Pages for this repo (Settings → Pages → Source:
GitHub Actions) and the *Deploy Pages* workflow publishes it.

Version history: [CHANGELOG.md](CHANGELOG.md).

Releasing: bump `APP_VERSION` in `js/version.js` (it versions the page header
and every data and asset request), bump the `?v=` query on the script and
stylesheet in `index.html`, and add a changelog entry.

## Quick start (local)

```bash
python -m http.server 8000     # from the repo root
# open http://localhost:8000
```

Everything needed to *view* the site is committed (data, icons). Rebuilding
the data requires a Gigastructures checkout:

```bash
pip install Pillow pytest --user
git clone --depth 1 --branch Master-Dev --filter=blob:none --sparse \
    https://github.com/Pouchkinn-s-Gigastructures/Gigastructures upstream
git -C upstream sparse-checkout set common/technology \
    common/scripted_variables common/inline_scripts \
    localisation/english gfx/interface/icons/technologies

python tools/build_data.py --mod-dir upstream \
    --out data --icons-out assets/icons \
    --commit "$(git -C upstream rev-parse HEAD)" \
    --vanilla data/vanilla-structural.json

python -m pytest tools/tests/ -q          # parser/build suite
npm i -D jsdom@24 && node tests/dom-smoke.mjs   # boots the page headlessly
```

## Vanilla data

Vanilla cannot be redistributed as game files, so the site composes the mod
dataset with **derived facts** extracted from a legitimate Stellaris install
by the maintainer:

```bash
python tools/extract_vanilla.py \
  --game-dir ~/.local/share/Steam/steamapps/common/Stellaris \
  --out data/vanilla-structural.json --game-version 4.5.0 --desc
# optionally after a game patch adds icons:  --icons vanilla-icons
```

Repo path (maintainer): `/home/Tempest1273/Github/Gigas-Tech-Tree/`.

Re-run after each Stellaris patch and commit the JSON (plus any new icon
PNGs into `assets/icons/`, using `cp -n` so existing files aren't clobbered).
Push the vanilla commit **before** the weekly mod refresh runs: the mod build
resolves `@tier5cost2`-style variables against whichever
`vanilla-structural.json` is committed.

The build writes `data/unresolved-loc-keys.json` listing substitution keys
the mod references but doesn't define (e.g. `$orbital_arc_furnace_4$`). The
extractor reads that file automatically and captures those keys' vanilla
values into `locExtra`, so re-running the extractor after a build fixes them. Techs referencing IDs from other mods (e.g.
ACOT) render as "external mod" stubs.

## Architecture

```
tools/            Python 3.11+ build pipeline (stdlib + Pillow)
  pdx/            Clausewitz lexer, parser, scripted-variable resolution
  inline_scripts  Paradox inline_script macro expansion ($param$, [[opt]])
  loc.py          Stellaris .yml localisation (not YAML)
  icons.py        DDS → PNG + sprite atlas, deterministic output
  merge.py        load order, whole-file replacement, same-ID overrides
  graph.py        field extraction, validation, JSON model
  build_data.py   entry point
  extract_vanilla.py  vanilla structural-facts extractor (maintainer-run)
js/               Plain ES modules, no build step, no runtime dependencies
data/             manifest + dataset JSON + vanilla-structural.json
assets/icons/     converted PNGs + atlas
tests/            headless DOM smoke test (dev-only jsdom)
```

Determinism: identical inputs produce byte-identical JSON, icons, and node
positions (sorted inputs, sorted keys, no timestamps, alphabetical layout
tie-breaks).

## Viewer notes

- `?dev` in the URL reveals developer tools:
  - **Health** panel — dangling prerequisites, tier inversions, missing
    localisation; the build doubles as a mod-QA lint of every upstream commit.
  - **Load mod…** — pick one or more mod folders (the directory containing
    `common/`); they are parsed in your browser by `js/pdxparse.js` (a port
    of the Python pipeline, kept honest by `tests/pdxparse-test.mjs`) and
    merged in load order against the baked vanilla data. The **Mods** panel
    lists them with enable/disable, reorder, and remove; names come from
    each mod's `descriptor.mod`. Nothing is uploaded. Useful for previewing
    uncommitted local changes, and for seeing how a mod list assembles —
    e.g. loading ACOT alongside Gigastructures resolves the `@acot_*`
    placeholder techs. Limitation: browsers cannot decode `.dds`, so techs
    from mods other than Gigastructures render without icons.
- `?theme=palette-a|ink` switches colour themes (also in the header).
- Deep links: `?tech=<id>&q=<search>&cats=<list>&src=<filter>`.
- Performance: the whole map is canvas-drawn. Only cards intersecting the
  viewport are painted (21 of 981 at 100% zoom on a 1080p viewport), icons
  come from a single sprite atlas, and draws are coalesced to one per frame.
  Culling and picking live in `js/viewmodel.js` and are unit-tested.

## Troubleshooting

**The map is sluggish.** Add `?dev` to the URL for a draw-time meter
(median/worst of the last sixty frames, split into background, edges and
cards, with the canvas size). Single-digit milliseconds is a
GPU-accelerated canvas; over a hundred means the browser is rasterising on
the CPU.

In Firefox, check `about:support` for `ACCELERATED_CANVAS2D`. If it reports
`Disabled by Software WebRender`, the browser has fallen back to software
compositing — usually a driver or Wayland issue — and canvas acceleration
is blocklisted as a consequence. Setting
`gfx.canvas.accelerated.force-enabled` to `true` in `about:config` restores
it; fixing the underlying GPU fallback is the better cure and speeds up
everything else too. Chromium equivalents live in `chrome://gpu`.

The renderer also measures itself and reduces resolution and skips textures
while the view is moving on machines that need it; `?render=<n>` forces a
specific device pixel ratio for testing.

## Adding another mod

The pipeline is source-list based (`tools/merge.py`): add a second
`Source`, its sparse paths in the refresh workflow, and a dataset entry in
the manifest. No parser or viewer changes required; the viewer's dataset
manifest already supports multiple entries.

## Automation

- **Refresh data** (`.github/workflows/refresh-data.yml`): weekly cron +
  manual dispatch; sparse-checks-out Gigastructures `Master-Dev`, rebuilds,
  validates (tech-count floor, test suite), commits only on change, and
  writes a summary with the upstream SHA.
- **Deploy Pages** (`deploy-pages.yml`): on push; publishes only if the
  parser suite *and* the DOM smoke test pass.
- GitHub **disables scheduled workflows after 60 days of repository
  inactivity** in public repos, and the workflow's own commits don't count
  as activity. If updates stop: Actions → *Refresh data* → *Run workflow*,
  or push any commit. (Alternative: author the data commit with a personal
  access token instead of `GITHUB_TOKEN`.)

## Licensing

- **Code** in this repository (build pipeline, viewer): MIT — see `LICENSE`.
- **Gigastructures content** (technology data, localisation text, icons
  under `assets/icons/giga_*`): © the Gigastructural Engineering & More
  team. The upstream repo publishes no licence; this material is
  redistributed as non-commercial fan tooling with the maintainers'
  awareness, and will be removed on request.
- **Vanilla-derived content** (`data/vanilla-structural.json`, icons under
  `assets/icons/tech_*`): derived from Stellaris, © Paradox Interactive,
  used non-commercially under Paradox's tolerance of fan works. Game files
  themselves are never committed. Removed on request.
- This is an unofficial fan project, not affiliated with Paradox
  Interactive.
