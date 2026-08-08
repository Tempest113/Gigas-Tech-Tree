# Changelog

Notable changes to the Gigastructures Tech Tree. Versions refer to the tool
(`APP_VERSION` in `js/main.js`, shown in the page header), not to the mod or
game data, which refresh independently.

## 1.2.0

### Changed

- **The map is drawn on a canvas.** Technology cards were DOM elements
  inside a CSS-transformed container, so every zoom step made the browser
  re-rasterise a layer roughly 12000×10000 CSS pixels holding a thousand
  elements and their images. Tier washes, category bands, labels, edges and
  cards are now painted on a single canvas, and only what is on screen is
  drawn — 21 cards at 100% zoom on a 1080p viewport, against 981 placed.
  Icons come from the sprite atlas the build already produced, so the whole
  map costs one image rather than a thousand.
- The build now generates the sprite atlas over every icon present, not just
  the mod's own, since the renderer draws all icons from it.
- Picking, culling and lineage logic moved into `js/viewmodel.js` as pure
  functions with their own unit tests, and the deploy workflow runs them.
  Previously this logic could only be exercised through the DOM.

## 1.1.2

### Changed

- Categories whose technologies span research areas (Blokkats, and any
  future crisis or event line such as Aeternite) are listed after a plain
  divider at the foot of the sidebar rather than filed under whichever area
  happens to hold the most of them. No heading — the rule alone reads as
  "everything else".

## 1.1.1

### Fixed

- **Zoom-out performance.** Edge geometry is in world coordinates and does
  not change when the view moves, but it was being rebuilt from scratch on
  every animation frame of a pan or zoom — roughly 880 bezier curves per
  frame. Paths are now built once per layout and stroked under a canvas
  transform. Culling, which touches every card's inline style, moved off the
  hot path to 90 ms after the view settles.
- Reverted the level-of-detail rendering added in 1.1.0: it degraded cards to
  coloured blocks when zoomed out without addressing the actual bottleneck.
- Repeatable technologies from the base game claimed unlimited levels. The
  vanilla extractor reported that a technology was repeatable but never how
  many levels it had, so the viewer defaulted to unlimited; it now exports
  the count. Badges show `×5` when the count is known, `∞` only for a genuine
  unlimited repeatable, and `↻` when the count is unknown, rather than
  asserting a cap that was never read.

## 1.1.0

### Added

- **Guide panel.** A "Guide" button in the header opens a reference covering
  how the layout works, the tier-unlock rule (six technologies of the
  previous tier in the same research area), a colour legend, badge meanings,
  and every interaction and keyboard shortcut.
- **Tier column shading.** Each tier column carries a full-height wash
  alternating in brightness, so tier boundaries stay readable at any zoom
  without relying on labels.
- **Tier labels above every category**, not only at the top of the map.
- **Repeatable level counts.** Cards show `×40` for capped repeatables and
  `∞` for unlimited ones alongside the tier badge, with the same detail in
  the technology panel and in tooltips.
- **Colour-coded Explore rows.** Table rows carry their research area's
  accent (and the Blokkats green), with the area column tinted to match.
- **Version badge** in the header, so the running tool version is visible
  without inspecting the source.
- **Vanilla localisation round trip.** The build records substitution keys
  the mod references but cannot resolve on its own into
  `data/unresolved-loc-keys.json`; `tools/extract_vanilla.py` reads that file
  and captures those keys' vanilla values, so names such as
  "Orbital Arc Furnace Management Protocols" resolve instead of showing raw
  `$tokens$`. These resolve correctly in-game already — the gap was only in
  the build, which had no vanilla localisation to resolve against.

### Changed

- **Zoom-out performance.** Edges are now batched into three `Path2D` objects
  (near, far, highlighted lineage) and stroked once each, rather than one
  style change and stroke per edge; below 45% zoom curves degrade to straight
  lines. Two levels of detail drop card contents as the view shrinks: icons
  and warning lines below 45%, all text below 22%, where cards render as
  solid accent-coloured blocks.
- Category filters now **re-lay-out the map**: unchecking a category removes
  its row entirely instead of leaving an empty band. The current pan, zoom,
  and selection survive the change.
- README documents the maintainer repo path, the requirement to commit
  vanilla updates before the weekly mod refresh runs, and the `cp -n` idiom
  for adding new icons without clobbering existing ones.

### Fixed

- Unchecking a sidebar category had no effect on the map. Two edits in the
  previous release silently failed to apply, so the filter never reached the
  renderer. Now covered by a regression test that drives the real checkbox
  and asserts the band and its cards leave the DOM.
- Stale assertions in the DOM smoke test that assumed the pre-relayout
  filtering behaviour.

## 1.0.0

First complete release.

### Build pipeline (Python)

- Clausewitz lexer, recursive-descent parser, and scripted-variable
  resolution with a safe arithmetic evaluator, covering the grammar as it
  actually appears in Gigastructures: duplicate keys, implicit lists, mixed
  blocks, comparison operators, trailing comments, escaped strings, inline
  maths, BOM/Windows-1252 encodings, and mixed line endings.
- `inline_script` macro expansion with `$parameter$` substitution and
  `[[optional]]` blocks — without it, roughly fifty repeatable technologies
  carry no area, category, cost, or prerequisites at all.
- Stellaris localisation parser (the `.yml` files are not YAML), including
  recursive `$key$` substitution, colour and icon markup stripping, and
  load-order overrides.
- DDS to PNG icon conversion with a sprite atlas, per-file failure tolerance,
  and deterministic output.
- Load-order and override semantics: whole-file replacement (warned about
  loudly) and same-ID redefinition.
- Graph construction with reverse edges, cycle detection, dangling
  prerequisites, tier inversions, missing localisation, and cross-mod gating
  detection.
- `tools/extract_vanilla.py`: maintainer-run extraction of vanilla
  technologies, tier requirements, scripted variables, names, descriptions,
  and icons from a local game install. No game files are ever committed.
- 63 tests, including fixtures copied from the mod repository.

### Viewer

- Tier-column layout with within-tier dependency ordering, category bands,
  and a dedicated repeatables column; deterministic and free of overlaps.
- Pan, zoom, selection with persistent ancestor/descendant highlighting,
  detail panel with prerequisites, unlocks, research path with cumulative
  cost, and source links into GitHub at the pinned commit.
- Sidebar filters by category and source with live counts, search, keyboard
  shortcuts, and deep-linkable URL state.
- Explore tab: sortable, filterable table of every technology.
- Health panel (`?dev`): the build's QA findings as a browsable, clickable
  list — a lint of the mod on every refresh.
- Local mod loading (`?dev`): `js/pdxparse.js` ports the parser to the
  browser, so one or more mod folders can be loaded from disk, named from
  their `descriptor.mod`, reordered, enabled or disabled, and merged in load
  order against the baked vanilla data. Nothing is uploaded. Known
  limitation: browsers cannot decode `.dds`, so technologies from mods other
  than Gigastructures render without icons.

### Automation

- Weekly data refresh workflow with sparse checkout, validation, and
  commit-only-on-change.
- Pages deploy gated on the Python suite, the parser parity suite, and a
  headless DOM smoke test that boots the real page.
