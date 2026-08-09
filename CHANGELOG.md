# Changelog

Notable changes to the Gigastructures Tech Tree. Versions refer to the tool
(`APP_VERSION` in `js/main.js`, shown in the page header), not to the mod or
game data, which refresh independently.

## 1.7.2

### Added

- **`data/manual-perk-grants.json`** for requirements that cannot be derived
  from script. The Colossus is granted by a special project which the
  Colossus Project perk enables — a chain the build does not follow — so it
  is declared there, and the weapon technologies inherit it through their
  prerequisites as usual. Manual entries are labelled "manual" in the perk
  audit, so they are never mistaken for something read from the files.

## 1.7.1

### Fixed

- Ascension gate mode interleaved its bands — "No gate" and "Gigastructural
  Constructs" each appeared twice, and Dyson Sphere sat under
  Mega-Engineering — because the offset computed for each gate was being
  overwritten before it was used. Each gate now owns a disjoint range of
  columns, verified at zero columns holding more than one gate.
- Repeatables were seeded on a different scale from the tiers, so they
  appeared between Tier 1 and Tier 2 instead of after every tier.
- Band labels are asserted unique in the smoke test, in both modes.

## 1.7.0

### Changed

- **Columns are assigned by dependency, not by tier number.** Every
  technology starts at a seed column and is pushed right until it sits
  strictly right of all its prerequisites, so a technology can no longer
  appear ahead of something it needs — Exodus Jump Coordinator sat left of
  Jump Drives because their tiers disagreed with their prerequisites.
  Verified at zero violations across the whole tree in both modes, and
  asserted in the smoke test.
- **Gated technologies sit beyond ungated ones.** Within a tier, a
  technology behind Mega-Engineering sits right of one behind nothing,
  Galactic Wonders right of that, and Gigastructural Constructs right again,
  so perk progression reads left to right.

### Added

- **Ascension gate column mode**, chosen in the header (`?cols=gate`):
  columns become the perk progression itself — no gate, Mega-Engineering,
  Galactic Wonders, Gigastructural Constructs — instead of research tiers.

### Fixed

- **Either/or requirements.** The Vat needs Galactic Wonders and *either*
  genetic ascension, a genetics tradition, *or* Mechromancy; it was listed
  as requiring Mechromancy outright. Alternatives inside an `OR` are now
  modelled as a group, and only a group with a single perk and no other
  route counts as a requirement — so alternatives no longer propagate to
  dependent technologies either. The detail panel lists the alternatives,
  including "another qualifying condition" where a route is not a perk.

## 1.6.4

### Fixed

- Dyson Sphere and Matter Decompressor lost their Galactic Wonders
  requirement in 1.6.3. They had never carried perk data of their own — they
  were inheriting it from Mega-Engineering, which 1.6.2 had marked wrongly,
  so removing that false marking took a correct-looking result with it.
  The mod's perk grants now apply to base-game technologies as well, which
  is where the requirement genuinely comes from, and the weight test
  introduced in 1.6.2 is gone: it only existed to work around the AI-only
  grant that 1.6.3 fixed at source.
- The five markings that have each broken at some point — Ring World, Dyson
  Sphere, Matter Decompressor, Mega-Engineering and Gateway Construction —
  are now asserted together in the smoke test, so a change cannot fix one by
  breaking another.

## 1.6.3

### Fixed

- **AI-only perk grants counted as player requirements.** Galactic Wonders
  hands Mega-Engineering to AI empires only, inside
  `if = { limit = { is_ai = yes } … }`; the grant collector ignored the
  surrounding `limit` blocks entirely. Grants now respect their conditions,
  which removes Mega-Engineering — and everything downstream of it — from
  the Galactic Wonders requirement.

### Added

- **`data/perk-audit.json` and an "Ascension perk markings" section in the
  health panel** (`?dev`): every perk attached to every technology, with its
  provenance — the technology's own `potential`, a perk granting it, or the
  prerequisite it was inherited from. Markings can now be checked against
  the script rather than taken on trust.

## 1.6.2

### Fixed

- **False ascension perk requirements.** A perk that hands over a technology
  was treated as gating it, so Mega-Engineering — granted by Galactic
  Wonders but with a normal research weight, and reachable without the perk
  — was marked as requiring it, and the requirement then propagated to
  everything downstream, including Gateway Construction. A grant now only
  implies a requirement when the technology cannot come up in research at
  all, which is what Ring World does and Mega-Engineering does not.
- The parser missed a bare `factor` directly inside a `weight_modifier`
  block (as opposed to a conditional `modifier = { … }`), which is exactly
  how Ring World zeroes its weight.

## 1.6.1

### Fixed

- The isolate bar never disappeared, because `.isolate-bar` sets
  `display: flex` and a class selector outranks the browser's built-in
  `[hidden] { display: none }` rule — so the element was correctly marked
  hidden and painted anyway. `[hidden]` is now enforced globally, which
  also protects every other panel from the same trap.
- The isolate bar used the rare-technology purple, which is not part of the
  interface palette; it now uses the standard panel border with the
  interactive accent as a marker.

## 1.6.0

### Added

- **Requirement filter**: show only technologies that need Mega-Engineering
  somewhere in their prerequisite chain, or that need Galactic Wonders or
  Gigastructural Constructs (directly or through a prerequisite).
- **Middle-click a technology to isolate it** — the map shows only that
  technology, everything it needs and everything it leads to, which is the
  quickest way to see a route to something. A bar names what is isolated;
  Clear or `Esc` restores. Category and source filters step aside while a
  chain is isolated, since a chain crosses categories by definition. The
  state is in the URL (`?only=<id>`), so a route can be linked.

### Changed

- "Show all" is now "Hide all" / "Show all", so a narrow view can be built
  up from nothing rather than by unchecking a dozen categories.
- Dropped the "Overrides vanilla" source filter: it selected two
  technologies, both of which the detail panel already badges.
- "Requires another mod" now also matches external-mod stubs.

## 1.5.2

### Changed

- Ascension perk requirements read "Needs <perk>" on every card. Previously
  a technology gated behind a perk said "Needs", one granted by it said
  "From" and one inheriting the requirement said "Via" — three phrasings for
  what amounts to the same thing to a player. The distinctions remain in the
  detail panel, where there is room to explain them.

## 1.5.0

### Added

- **Technologies granted by an ascension perk.** Ring World, Dyson Sphere,
  Matter Decompressor and Mega-Engineering carry no `potential` gate and zero
  research weight: the perk hands them over directly, through
  `add_research_option` in its own definition. Both the build and the
  extractor read perk definitions for those grants, so these show "From
  Galactic Wonders" rather than nothing at all — no hardcoding, and it picks
  up every other granted technology too (twelve on the mod side).

- **Ascension perk gating for base-game technologies.** The extractor now
  reads vanilla `potential` blocks and resolves vanilla scripted triggers, so
  Dyson Sphere and Matter Decompressor show Galactic Wonders and the
  colossus weapons show the Colossus Project. Previously only mod
  technologies carried perk requirements, because the extractor took
  structural facts alone.
- Perk requirements propagate across the **composed** graph rather than the
  mod half only, so a mod technology sitting behind a perk-gated base-game
  one inherits the requirement.

## 1.4.4

### Fixed

- **Ascension perk icons and names for the mod's own perks.** Five of the
  seven perks the tree references — A Celestial Armada, Gigastructural
  Constructs, A Weapon to Pierce the Heavens, Unshackled Transportation and
  Vast Expanses — are defined by Gigastructures, not the base game, so the
  vanilla extractor could never supply them. The build now converts perk
  icons from the mod and takes their names from the mod's own localisation,
  merging with the vanilla set client-side. This also corrects the names:
  the mod renames Celestial Printing to "A Celestial Armada".

## 1.4.2

### Changed

- The extractor converts only the icons the site actually references. The
  build writes `data/needed-icons.json` — every technology's resolved icon
  plus every ascension perk named by a gated technology — and the extractor
  filters against it, instead of copying the game's icon folders wholesale.
- Added `tools/prune_icons.py`, which deletes committed icons that are not
  referenced. Running it removed 223 files (1.3 MB) and took the sprite
  atlas from 5.8 MB to 4.7 MB.

### Added

- `tools/build_atlas.py`, which rebuilds the sprite atlas from the icons
  already in the repository. Previously the atlas could only be regenerated
  as part of a full build, which requires a Gigastructures checkout.

## 1.4.1

### Added

- **Ascension perk names and icons come from the game.** The extractor
  captures perk display names, so a gated technology reads "Needs Master
  Builders" rather than a name mangled out of its id ("Qso"), and converts
  the perk icons alongside the technology icons, so the badge on a gated
  technology shows the perk's own icon. Both degrade gracefully: without a
  fresh extraction the badge falls back to `✦` and a derived name.

### Fixed

- Badges are sentence-cased, so "gigas", "rare" and "needs qso via a
  prerequisite" read properly without every word being capitalised.
- Source badges name the mod ("Gigastructures") rather than its internal id.

## 1.4.0

### Added

- **Ascension perk requirements now cover the scripted-trigger forms.**
  Gigastructures gates most of its content on `has_galactic_wonders` and
  `has_gigastructural_constructs` rather than naming a perk directly; the
  build resolves scripted triggers to the perk behind them. Marked
  technologies went from 8 to 30.
- **Requirements propagate through prerequisites.** A technology behind a
  Galactic Wonders technology is equally unreachable without the perk, so it
  carries the requirement too, shown with a dashed badge ring and "Via
  <perk>" rather than "Needs <perk>", and spelled out in the detail panel.
  A further 39 technologies are marked this way.

### Fixed

- **Multi-line quoted strings.** Gigastructures passes blocks of script to
  `inline_script` as a quoted `code` parameter spanning many lines — a legal
  construct the lexer rejected, silently skipping the whole of
  `common/scripted_triggers/zzz_overwrites.txt` and with it the Galactic
  Wonders trigger. Fixed in both the Python parser and its browser port,
  with tests either side.
- The ascension perk line no longer overflows the card; long perk names are
  truncated to fit.

## 1.3.6

### Changed

- Ascension-perk locked technologies are marked with a badge over the
  technology's icon, not only by a line of small text at the foot of the
  card, and the card line now reads "Requires <perk>". The marker was
  drawing correctly before but was too quiet to notice among a thousand
  cards. Covered by a regression test that inspects what the renderer
  actually draws.

## 1.3.5

### Changed

- Quality degradation is now self-tuning. The renderer measures its own draw
  times and only trades resolution and textures for speed while the view is
  moving on machines that need it; a GPU-accelerated canvas keeps full
  fidelity throughout. Hysteresis prevents oscillation.
- The `?dev` meter reports canvas size, device pixel ratio and whether
  quality is currently reduced.
- README gained a troubleshooting section covering the meter and Firefox's
  `ACCELERATED_CANVAS2D` blocklisting under Software WebRender, which
  rasterises the whole map on the CPU and was worth roughly a twentyfold
  difference in draw time between two machines.

## 1.3.4

### Changed

- Canvas pixels are capped by a budget (~4.5 megapixels) as well as by
  device pixel ratio, so a 4K or ultrawide window cannot ask for several
  times the fill rate of a smaller one. `?render=<n>` overrides it.

## 1.3.3

### Fixed

- **Draw time when zoomed out.** Two costs had crept back in with the canvas
  renderer: edge paths were rebuilt every frame (roughly 880 bezier curves)
  rather than cached as they had been before, and letter-spaced labels were
  drawn a glyph at a time with a `measureText` call for each — about 1,260
  measure-and-fill pairs per frame once every section's tier labels were on
  screen. Edge paths are cached per layout again, labels use the engine's
  native letter spacing where available with memoised glyph widths
  otherwise, text measurements and truncations are cached, and the small
  per-section tier labels are skipped below 30% zoom where they cannot be
  read anyway.
- The `?dev` meter now breaks the frame down into background, edges and
  cards, with the number of cards drawn, so a slow machine can be diagnosed
  rather than guessed at.

## 1.3.2

### Fixed

- Data and icon requests are now versioned along with the scripts and
  stylesheet, from a single constant in `js/version.js`. Data files keep
  stable names across releases, so a browser could serve a cached dataset
  after an update — showing the previous release's categories while running
  the new code.

## 1.3.1

### Added

- **Draw-time meter** under `?dev`, showing the median and worst frame draw
  time of the last sixty frames. It measures the renderer's own work only,
  so it separates this code from compositing and GPU cost — the number to
  compare when one machine feels slower than another.

### Changed

- The Sirens category is now **Sirenalia**, and it sits with Blokkats below
  the divider rather than under Society, since both are content lines rather
  than research areas. Its texture is layered wave art rather than
  concentric arcs: four filled sine bands per visible category band, so the
  cost does not scale with the map.

## 1.3.0

### Added

- **Sirens category.** EAWAF technologies are grouped into their own
  category, instead of being scattered through particles, psionics and
  voidcraft. The build applies this via a synthetic category rule, so
  further content lines can be split off the same way.
- **Ascension perk requirements.** Technologies gated behind an ascension
  perk are marked on the card with `✦` and the perk's name, and carry a full
  badge in the detail panel. Perks named inside `NOT` blocks are ignored,
  since those gate a technology out rather than in.

### Fixed

- The Blokkats hexagon texture, lost when the map moved to canvas in 1.2.0,
  is drawn again — as a tiled canvas pattern, so it costs the same whatever
  the band's size.
- The canvas backing store is capped at 1.5× device pixel ratio. Canvas cost
  is fill-rate bound, so a high-resolution display was asking for several
  times the pixels of a smaller one at the same window size; past 1.5× the
  extra resolution is invisible on small text.

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
