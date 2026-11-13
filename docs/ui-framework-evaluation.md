# UI framework evaluation: Svelte vs the current vanilla TypeScript

**Status:** evaluation only. No migration was performed in v1.14.0.
**Recommendation:** keep the framework-free TypeScript UI. Revisit only if a
future roadmap item needs SSR, accounts/sync, or a much larger component
surface.

## What the app is today

Measured in this checkout (v1.14.0):

| Area | Approximate size |
|---|---|
| `src/` TypeScript | ~12,400 lines across 54 files |
| `worker/` TypeScript | ~720 lines |
| Stylesheets | ~6,700 lines across 16 files |
| Playwright tests + fixtures | ~3,500 lines across 18 specs |
| Initial client JS | ~33 kB gzip (results/search/LLM are lazy chunks) |
| Initial CSS | ~27 kB gzip |
| Runtime UI dependencies | none (no React/Svelte/Vue/Lit, no state library) |

The "framework" is a ~70-line pub-sub store (`src/lib/store.ts`) plus a small
`el()` DOM helper (`src/lib/dom.ts`). Screens are plain functions that build and
update DOM nodes. Shared markup is already extracted into `src/lib/*-ui.ts`.

Rough split of the source:

- **UI / DOM building:** landing, quiz, rating, results, search, settings panel,
  card/credits/providers UI, carousel — roughly 3,500–4,000 lines.
- **Logic / state / data:** scoring engine, TMDB, profile and storage codecs,
  AI policy/engine/integrity, importers, appearance model — roughly 8,000 lines.
- **CSS:** 6,700 lines, token-driven, already componentised per screen.

Most of the complexity is deliberately outside the view layer. A framework
would replace the smaller half of the codebase.

## What Svelte 5 would buy

### Pros

1. **Less manual DOM reconciliation.** Results cards, settings previews and the
   search panel currently re-render by replacing children. Svelte's reactivity
   would remove that bookkeeping.
2. **Scoped styles by default.** Component `<style>` blocks would reduce the
   chance of global CSS collisions, though the existing CSS is already split
   per screen and token-driven.
3. **Built-in transitions and a11y warnings.** `transition:` and compiler
   warnings are convenient, but the app already has a tested motion system and
   axe coverage.
4. **Easier componentisation.** A future contributor pool may be more familiar
   with `.svelte` files than `el()` calls.
5. **Optional SSR/prerender path.** Useful only if SEO landing pages or a
   server-rendered shell become a requirement. The app is a client-side tool
   behind a Cloudflare Worker; today it does not need SSR.

### Cons

1. **Large rewrite.** About 3,500–4,000 lines of view code plus a significant
   share of the 3,500-line test suite (selectors, timing, focus behaviour)
   would be rewritten. The logic modules could stay, but every screen boundary
   changes.
2. **Risk to hard-won behaviour.** The current UI encodes many deliberate
   behaviours: presentation-only preferences, "Motion: Off always wins",
   reduced transparency, high contrast, focus restoration, touch quick actions,
   the never-a-dead-end results fallback, the rating debounce, and the exact
   localStorage keys. A rewrite would need to re-prove all of it.
3. **Build and deployment complexity.** A compiler enters the build and the
   bundle gains a runtime. Today the initial bundle is ~33 kB gzip with no UI
   runtime.
4. **Constraint change.** The README, AGENTS.md and CONTRIBUTING.md all state
   "no framework, no new UI dependency" as a product decision, not an accident.
   Migrating would require changing that contract and the review expectations
   around it.
5. **No current problem it solves.** There is no complex shared state, no
   deep prop drilling, no SSR requirement, and no rendering hot path that has
   been measured as a bottleneck. The framework would be added on speculation.
6. **Svelte 5 runes change the mental model again.** A migration now would
   target runes and the newer compiler; the ecosystem's answers for testing,
   a11y and CSS tokens are good but still moving.
7. **Two sources of truth during migration.** A partial migration (Svelte
   islands inside a vanilla app) would leave both models in the repo, the worst
   of both worlds for review and testing.

## Migration cost (rough)

| Work | Estimate |
|---|---|
| Spike: one screen (landing + carousel) in Svelte 5 | 1–2 days |
| Full screen migration (quiz, rating, results, search) | 2–3 weeks |
| Settings workspace + appearance model | 1–2 weeks |
| Test rewrite and stabilisation | 2–3 weeks |
| Accessibility, cross-engine and visual regression re-baselining | 1 week |
| Total, one experienced developer | **6–9 weeks** |

That estimate excludes the risk of subtle regressions in ranking, storage or
preference behaviour, which are not view-layer concerns but are exercised
through the UI.

## Alternatives that get most of the benefit

1. **Keep extracting shared UI modules.** `card-ui.ts`, `providers-ui.ts`,
   `credits-ui.ts`, `rating-ui.ts` already exist. Continue that pattern rather
   than introducing a compiler.
2. **Tighten the store API.** A typed `select()` helper and explicit actions
   remove most of the "manual reactivity" pain without a framework.
3. **Template literals for static markup only.** Where a block is large and
   static, a tagged template helper can improve readability without a runtime.
4. **Revisit if:** accounts/sync arrive, SSR or prerendered marketing pages
   become a requirement, or the UI grows past roughly 10k view-layer lines.

## Verdict

**Do not migrate now.** The current architecture is small, fast, well tested,
and aligned with the product's privacy and no-framework constraints. Svelte is
a reasonable choice for a future rewrite if the requirements change, but it
would be a net cost today. Any future decision should be based on a measured
problem (bundle size, render cost, contributor velocity), not on framework
fashion.
