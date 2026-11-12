# Design audit — v1.14.0

**Scope:** targeted anti-slop pass. Keep the cinematic identity, every
appearance option and all accessibility behaviour; remove the visual defaults
that make a page read as model-generated.
**References:** [Nutlope/hallmark](https://github.com/Nutlope/hallmark)
(Hallmark floor) and [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill)
(taste-skill metric rules). The audit was done against their published
criteria; their CLI/audit scripts were not installed or run in this checkout,
so nothing here claims a tool-generated score.

## What was flagged

| # | Tell | Where it was | Why it reads as generated |
|---|---|---|---|
| 1 | Inter as the default body face | `tokens.css`, `lib/fonts.ts`, `main.ts` | Inter is the default of nearly every generated UI and of most starter templates |
| 2 | Violet→cyan gradient headline text | `.landing-title` in `landing.css` | The "AI hero" gradient, applied to type rather than data |
| 3 | Mono eyebrow above the H1 | `screens/landing.ts` | Eyebrow + H1 + subhead + two CTAs is the stock generated hero stack |
| 4 | Two radial accent blobs | `.landing::before` | Generic aurora glow, two symmetric colour blobs |
| 5 | Particle field on by default | `appearance.ts` `DEFAULT_PREFERENCES` | Decorative animation as the first impression, not a user choice |
| 6 | Uniform radius on every surface | `--radius-lg: 24px` | Everything pillowy and equally rounded flattens hierarchy |
| 7 | Floating hero card | `hero-float` −8 px | "Float everything" motion with no interaction reason |

## What changed

| # | Change | Evidence |
|---|---|---|
| 1 | Default pairing is **Sora + Manrope**; Manrope is imported statically. Inter remains available in the optional presets. | `tokens.css`, `lib/fonts.ts`, `main.ts`, `package.json` |
| 2 | Headline is solid `--text-primary` with `text-wrap: balance`. Gradient tokens remain for meters/data marks only. | `landing.css` `.landing-title` |
| 3 | Eyebrow removed. The privacy statement moved into the trust line under the CTA: "No account · your profile stays on this device · about a minute". | `screens/landing.ts` |
| 4 | Two blobs replaced with one 11 % top-light wash + the existing film grain. | `landing.css` `.landing::before` |
| 5 | Default particles `balanced` → **`subtle`**. Interactive remains an explicit preset/user choice. | `appearance.ts` `DEFAULT_PREFERENCES` |
| 6 | Large radius 24 → 20 px; sharp/rounded shape presets still remap all tokens. | `tokens.css` |
| 7 | Hero float reduced to −4 px; disabled under Motion Off. | `landing.css` `@keyframes hero-float` |

Nothing else was restyled: cards, results, search, settings, palettes and the
other design styles keep their shipped behaviour.

## What was deliberately preserved

- All **8 palettes**, **5 design styles**, **4 card types**, **4 search types**
  and **8 font presets**.
- Reduced Motion ("Off always wins"), Reduced transparency, High contrast,
  text scale, density, width, poster size and shape.
- Deterministic ranking: no design change touches `engine.ts`.
- Local-storage keys and the single profile write path.
- Privacy: no new network requests, no analytics, no third-party font calls.
- Keyboard operation, screen-reader labels, 24 × 24 px targets and axe scans.

## Proportionality check (taste-skill style)

| Metric | Before | After |
|---|---|---|
| Gradient-clipped text blocks | 1 (the H1) | 0 |
| Radial background blobs on landing | 2 | 1 |
| Default decorative particle level | `balanced` | `subtle` |
| Default body faces | Inter | Manrope |
| Distinct border radii | 3 + pill | 3 + pill (lg reduced) |
| Landing reveal stack | eyebrow + H1 + sub + actions + trust | H1 + sub + actions + trust |

## Verification

- `npm run typecheck`, `npm run lint`, `npm run build`: clean.
- `deno task check`, `deno task lint`, `deno task build`, `deno task test`:
  clean (39 native tests).
- Playwright coverage, including axe scans for every palette, card type,
  design style and search type, is recorded in `CHANGELOG.md` for this release.
- Controlled visual checks: build output is ~33 kB gzip initial JS and
  ~27 kB gzip CSS (CSS grew slightly because Manrope ships six unicode-range
  faces; the font binaries are separate files and still self-hosted).

## Deferred

- A full Hallmark-style redesign (new layout direction, new component
  language). It is higher risk and was explicitly out of scope.
- Re-shooting the README screenshots. The existing shots still show the same
  screens; regenerate them on a machine with a real build if you want them to
  match the new default type exactly.
