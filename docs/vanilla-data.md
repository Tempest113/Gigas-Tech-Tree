# Vanilla data sourcing — investigation & recommendation

Spec §10 stop point. Findings first, recommendation at the end, decision
yours.

## Findings

**Licences.** Neither `turanar/stellaris-tech-tree` nor
`bloodstainedcrow/stellaris-tech-tree` publishes a licence. Without one,
redistributing their parsed JSON grants us no rights at all — option B is
dead on legal grounds before staleness even enters into it. (Also relevant:
the **Gigastructures repo itself has no LICENSE file** — see
`docs/licensing.md` implications below.)

**What the mod-only build already tells us.** All 84 dangling prerequisites
in the current build are vanilla `tech_*` IDs. That means option D (stub
nodes) is not a degraded experience for the primary audience — a
Gigastructures developer sees every mod tech, every mod edge, and clearly
labelled vanilla attachment points. What D cannot show: vanilla tech names,
tiers of vanilla prereqs (so some tier-inversion checks stay silent), vanilla
tier cost/weight variables (191 warnings, cost/weight display symbolic as
`@tier5cost2`), and the vs-vanilla diff mode.

**What each option costs.**

- **A — user-supplied game files, parsed client-side.** Legally clean,
  version-exact, respects the user's DLC and icons. Costs a JS port of the
  parser (`pdxparse.js`) — a real but bounded job now the Python grammar is
  proven against the whole mod — plus first-run friction. Note Linux
  reality: the Steam install path is
  `~/.local/share/Steam/steamapps/common/Stellaris/`; on Bazzite with
  Flatpak Steam it's
  `~/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common/Stellaris/`.
  `webkitdirectory` folder pickers handle either fine; the docs should name
  both paths.
- **B — community dumps.** No licence → not usable. Revisit only if either
  repo adds one.
- **C — maintainer-run local CLI, committing derived structural facts
  only.** A script you run against your own install that emits: vanilla tech
  IDs, tiers, areas, categories, prerequisite edges, and the
  `@tierNcostM`/`@tierNweightM` scripted-variable table. **No names, no
  descriptions, no icons, no script bodies.** That is a table of ~600 IDs
  and numbers — game facts, about as minimal a copyright surface as exists,
  and the same class of information every wiki publishes. It is still your
  judgement call to commit it, which is why this is a question and not a
  default. What it buys: the *public site* gets real vanilla topology, exact
  tier data (better inversion checks), resolved costs, and the diff mode —
  with zero first-run friction, no vanilla names shown (stubs display the ID,
  styled as vanilla).

## Recommendation

**D ships first** (it's nearly free — the viewer needs stub nodes anyway),
**A is the canonical full-fidelity path** (build `pdxparse.js` in step 11 as
planned), and **C is worth doing** if you're comfortable committing derived
structural facts from your own install — it upgrades the default experience
from "mod tree with grey stubs" to "real combined tree" for every visitor at
the cost of one script run whenever a Stellaris patch lands. B is out.

This differs from the spec's expectation (A canonical + D fallback + B
badged) in exactly one way: B is removed for licence reasons, and C is
promoted to "recommended if acceptable to you."

## Interface

`VanillaSource` stays pluggable regardless of choice:

```
VanillaSource
  ├─ NullSource        (D: stubs only)          — always available
  ├─ StructuralSource  (C: committed facts)     — data/vanilla-structural.json
  └─ ClientSource      (A: user files, JS-side) — IndexedDB-cached
```

The dataset loader composes: mod data + best available vanilla source at
runtime; the build pipeline composes mod data + StructuralSource when the
file exists. Adding A later touches no build code.

## Licensing note for `docs/licensing.md` (to be written in step 10)

The Gigastructures repo has **no licence file**. Redistributing its icons
and localisation text in our public repo is therefore not formally licensed
— it's tolerated-by-convention at best. Since you contribute to that repo:
the cleanest fix is upstream (add a LICENSE, or an explicit note permitting
derived tooling). Until then the honest position is: we redistribute mod
icons + loc with the maintainers' informal blessing, and take them down on
request. Flagging now so it's a decision, not an accident.
