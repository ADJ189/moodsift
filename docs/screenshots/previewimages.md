# Screenshots

Product screenshots used by the README and release notes. All are captured from
the production build with the deterministic Playwright fixtures (no live TMDB
account, no real user data).

| File | Screen | Notes |
|---|---|---|
| `landing.webp` | Landing | Default appearance, Sora + Manrope, single top-light |
| `results.webp` | Results | Interactive cards, match badge and reasons visible |
| `search.webp` | Search | Grouped autocomplete with a fictional query |

## Regenerating

The `tests/visual.spec.ts` suite is opt-in and intentionally does **not** commit
baselines:

```bash
npx playwright install chromium
npm run test:visual -- --update-snapshots
```

Copy the shots you want to publish here as `.webp` (quality ~82) and keep the
same filenames. Do not include real account names, API keys or live TMDB
artwork that the project does not have rights to redistribute; the fixtures use
CSS-drawn placeholders on purpose.
