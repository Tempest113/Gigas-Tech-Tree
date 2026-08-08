# Observed grammar & data-layout notes — Gigastructures @ `767cf17` (Master-Dev)

Findings from reading the real repo before writing the parser, per the working
agreement. Each item names the file that settled it.

## Spec corrections (things the build prompt got wrong)

1. **Technology path.** There is no `common/technologies/`. Technologies live in
   `common/technology/*.txt` (20 files, `giga_01_physics.txt` …
   `zz_giga_tech_overwrites.txt`), matching the vanilla convention. Category
   definitions are in `common/technology/category/giga_category.txt`. The mod
   ships **no** `common/technology/tier/` — it relies on vanilla tier defs.
2. **Localisation indentation is tabs, not spaces** (every
   `localisation/english/*.yml`). The loc parser must accept any leading
   whitespace.
3. **Encoding reality:** tech files are ASCII except
   `zz_giga_tech_overwrites.txt` (UTF-8, no BOM). Localisation `.yml` files are
   UTF-8 **with** BOM. `common/scripted_variables/*.txt` have no BOM. So: strip
   BOM when present, never require it.

## Grammar features confirmed in real files

- **Scripted variable refs** everywhere: `cost = @tier5cost2`
  (`giga_01_physics.txt:7`). Definitions are `@name = value`, one per line, in
  `common/scripted_variables/*.txt`. **No inline `@defs` at the top of any tech
  file in this mod** (checked all 20), but vanilla does this, so support it.
- **Comparison operators in triggers:** `years_passed > 50`, `count >= 3`
  (`giga_02_society.txt`). Operator must be preserved on the AST node.
- **Duplicate keys at one level are pervasive:** 58 `modifier = { … }` blocks
  in `giga_03_engineering.txt` alone; multiple `technology_swap` blocks per
  tech in `zz_giga_tech_overwrites.txt`. List-of-pairs AST is mandatory.
- **Implicit lists**, both quoted and bare, sometimes mixed conventions across
  files: `prerequisites = { "giga_tech_war_moon_2" }` vs
  `prerequisites = { giga_tech_quasi_stellar_3 }`.
- **Trailing comments after values on the same line:**
  `factor = @giga_aiweight_multiplier_strong	#Moons!`.
- **Whole techs commented out** with `#` line-by-line (a "banished" tech in
  `giga_01_physics.txt`) — a naive scanner that greps for `tech_… = {` would
  resurrect dead techs; the lexer must treat comments before any structure.
- **No inline maths `@[ … ]` anywhere in the mod.** Implemented anyway (spec
  §3; vanilla uses it), flagged as untested-against-mod-data.

## Features the spec's data model missed

- **`technology_swap = { … }`** — repeated blocks that conditionally rename /
  re-icon / extend a tech (`zz_giga_tech_overwrites.txt`, `tech_ring_world`).
  Must be captured (name, trigger, inherit_icon/effects, nested
  prereqfor_desc) or the override view lies about what the player sees.
- **`inline_script`** — 220+ uses in tech files, in **two forms**:
  - value form: `inline_script = technology/tech_weight_boni/…`
  - block form with parameters:
    `inline_script = { script = technologies/rare_technologies_weight_modifiers  TECHNOLOGY = giga_tech_x }`
  The referenced scripts live in `common/inline_scripts/` (vanilla + mod),
  which is outside our sparse checkout. **Decision: do not expand them at
  build time**; record them structurally so weight-modifier display can say
  "via inline script X" honestly. Expanding vanilla inline scripts would need
  vanilla files we can't redistribute anyway.
- **`ai_update_type`** appears on the ring-world override; harmless extra
  field, keep as passthrough.

## Scripted-variable resolution facts

- 104 distinct `@vars` referenced across tech files; **32 are not defined
  anywhere in the mod** — they are vanilla's tier cost/weight tables
  (`@tier2cost1` … `@tier5weight3`) plus a few vanilla AI weights. Resolution
  must therefore support a *fallback layer* (a vanilla-vars table when
  available) and otherwise leave the reference **symbolic with a warning**,
  not crash and not silently zero.
- **Cross-mod compat pattern:** `zz_giga_compat_overwrite_me.txt` defines
  placeholders like `@acot_tier6cost2 = 0` and `@has_ancient_caches = 0`,
  intended to be overwritten by other mods loading later. Consequence: techs
  gated on other mods resolve to cost 0 / weight 0 in a Gigas-only build.
  These should be tagged (source file of the winning definition is the
  signal) rather than displayed as genuinely-free techs.
- Redefinition: later definition (load order) wins — same rule as techs.

## Icons

327 `.dds` files in `gfx/interface/icons/technologies/`, named by tech id
(`giga_tech_alderson_disk.dds`). Path in spec was correct here.

## Load order

`zz_` prefixes on the override files confirm ASCII-alphabetical filename
ordering is the mechanism the mod itself relies on (overrides must load after
vanilla and after the mod's own base files).
