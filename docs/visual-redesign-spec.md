# Moodsift Visual Redesign & Settings Architecture

**Status:** Approved visual direction; implementation specification  
**Applies to:** Moodsift v1.11.x  
**Primary reference:** `docs/assets/moodsift-visual-redesign-reference.png`  
**Implementation style:** Preserve the existing framework-free TypeScript + Vite architecture.

## 1. Goal

Redesign Moodsift's title cards, search experience, and Settings UI so the product feels like a premium cinematic discovery tool rather than a generic content grid. The approved direction is:

- **Card type:** Interactive hover/focus card.
- **Design style:** Cinematic dark, with restrained artwork-aware glow.
- **Search type:** Grouped autocomplete, separating Movies & TV Shows from People.
- **Motion:** Dynamic but lightweight; subtle perspective, a short lift, and quick action reveals.

Users must be able to change **Card type**, **Design style**, and **Search type** independently in Settings. Their choices apply immediately, persist locally, and remain usable with a keyboard, touch, reduced motion, high contrast, and lower-powered devices.

This is a UI and presentation change only. It must not change recommendation scoring, ranking, quiz behavior, ratings, watchlist data, AI mode, TMDB request semantics, or the source of movie/show metadata.

## 2. Current implementation to build on

The application already has the relevant foundations:

- `src/lib/appearance.ts` owns `AppearancePreferences`, validated preference values, local persistence, undo/redo, presets/looks, import/export, and root `data-*` attributes.
- `src/lib/settings-panel.ts` builds the Appearance drawer and settings controls using the project's `el()` DOM helper. It already supports live preview, tabs, keyboard navigation, focus trapping, Undo/Redo, reset, appearance export/import, and a separately stored AI mode.
- `src/styles/settings.css` styles the current 440px right drawer and mobile bottom sheet.
- `src/styles/results.css` owns `.result-card`, poster art, the quick-look overlay, watchlist/open actions, and featured recommendation presentation.
- `src/styles/effects.css` already supports grid/list/spotlight result layouts, labels, shadows, hover glow, poster tilt, and artwork ambience through document attributes.
- `src/lib/fx.ts` uses one delegated, animation-frame-throttled pointer listener for card effects.
- `src/screens/search.ts` currently renders a search field, up to eight title rows and three people rows, then a selected title/person view and similar-title results.
- `src/styles/search.css` styles search rows, title hero, and similar-title grid.

Keep these responsibilities. Do not migrate to React or add a UI framework just for this work. Prefer extending the existing preference and CSS systems to introducing a parallel settings store.

## 3. Visual design principles

1. **Artwork is the hero.** The poster or backdrop should be the strongest visual element. UI chrome should stay quiet.
2. **Information hierarchy first.** Title, year/type, rating, and one useful reason should scan faster than secondary actions.
3. **Different places have different density.** A recommendation card, autocomplete row, result grid card, and selected-title hero should not all look identical.
4. **Motion should explain state.** Use animation to indicate focus, selection, card elevation, or revealed actions—not continuous decoration.
5. **Consistent design, variable presentation.** Card type and search type can change structure; design style changes surface treatment; existing result layout controls arrangement.
6. **Real data only.** Do not invent ratings, match percentages, watch providers, trailers, seasons, or synopsis text. If a field is unavailable, omit it or show a neutral fallback.
7. **Accessible without hover.** Any essential action or information hidden during mouse hover must remain reachable by keyboard and touch.
8. **Fast by default.** Animate `transform` and `opacity` where possible. Avoid repeated layout reads, heavy filters, and extra network calls per card.

### Visual reference

The concept image is direction-setting, not a pixel-exact asset or a source of real catalog data. Recreate the layout and interaction language with real Moodsift data and the existing theme tokens.

![Moodsift approved visual direction](assets/moodsift-visual-redesign-reference.png)

## 4. Terminology and preference model

Keep these controls distinct so the Settings UI is understandable:

| Control | What it changes | It does **not** change |
|---|---|---|
| **Card type** (`cardType`) | The structure and information treatment inside each movie/show card | Overall colour palette or grid/list arrangement |
| **Design style** (`designStyle`) | The shared visual surface treatment, border, glow and decorative language | Movie ranking, search semantics, or chosen light/dark mode |
| **Search type** (`searchType`) | How live search suggestions/results are presented | The underlying title/person search API or relevance ranking |
| **Results layout** (`resultLayout`, already exists) | The overall arrangement: grid, list, or spotlight | The card's visual style |
| **Theme and palette** (already exist) | Light/dark/system mode and colour palette | Card/search structure |
| **Motion profile/effects** (already exist) | Animation amount and pointer effects | Ability to use core controls |

### 4.1 New preference values

Extend `AppearancePreferences` in `src/lib/appearance.ts` with these fields:

```ts
cardType: 'interactive' | 'poster' | 'editorial' | 'compact';
designStyle: 'cinematic' | 'minimal' | 'film-journal' | 'glass' | 'neon-noir';
searchType: 'grouped' | 'compact' | 'expanded' | 'full-page';
```

Add each field to `DEFAULT_PREFERENCES` and `FIELD_OPTIONS`. Apply these root attributes from `applyPreferences()`:

```html
<html data-card-type="interactive"
      data-design-style="cinematic"
      data-search-type="grouped">
```

**Defaults must match the approved mockup:**

```ts
cardType: 'interactive',
designStyle: 'cinematic',
searchType: 'grouped',
resultLayout: 'grid',
```

Do not overload existing `resultLayout`, `cardShape`, `surfaceStyle`, `hoverGlow`, or `posterTilt`. They remain separate, lower-level preferences. In the Settings UI, use descriptive copy to explain the difference.

### 4.2 Persistence compatibility

- Preserve the existing appearance storage key, `cinematch-appearance:v1`, and preference envelope version unless a breaking storage-format change becomes unavoidable.
- Old preference objects that lack the three new keys must sanitize to the new defaults. The current field-by-field sanitizer should remain authoritative.
- Extend strict import/export validation to recognize the new keys. Older version-1 exports without them must still import with defaults; invalid enum values must be rejected or safely defaulted according to the existing strict-vs-forgiving code path.
- New visual settings belong in appearance export/import and named looks because they are presentation choices.
- Do not store or export profile, ratings, watchlist, quiz answers, AI engine selection, tokens, API secrets, or other private/user data as part of appearance settings.
- A full appearance reset resets the new visual fields too. It must not reset AI mode, ratings, watchlist, or profile.
- Preserve the current safe storage-failure behavior: show “Applied for this session only” when persistence is blocked instead of claiming changes were saved.

## 5. Card type designs

All four choices should have thumbnail previews in Settings. Use the same sample title/artwork/metadata across the choices so the difference is easy to compare. The preview is decorative and must not issue TMDB requests.

### 5.1 Interactive (default)

**Purpose:** Main recommendation cards with dynamic hover/focus behavior.

- Portrait poster is dominant, with a subtle bottom gradient when text overlays art.
- Match indicator sits in a consistent poster corner only when a genuine match percentage is available.
- Heart/watchlist action is visible on hover, keyboard focus, and touch. A second quick action opens details.
- On hover/focus, the poster lifts very slightly, actions reveal, and a concise synopsis/rating preview may appear without changing the card's dimensions.
- Title and year remain under the poster; show a concise type/genre label when useful.
- Show one short recommendation reason in card body when the current context provides one; move long reasons to details.
- Rating, match, and watchlist states are independently labeled and must not be communicated by colour alone.

### 5.2 Poster gallery

**Purpose:** Artwork-led dense browsing, watchlist, and similar-title shelves.

- Preserve poster aspect ratio and emphasize the image.
- Title and year sit directly below the poster; keep metadata to one or two lines.
- Rating may appear as a small labelled line; do not force a match percentage where no match exists.
- Actions reveal on hover/focus but remain reachable on touch.
- No persistent synopsis overlay. Opening details gives the longer description.

### 5.3 Editorial

**Purpose:** Larger cards for discovery shelves where context is valuable.

- Use a more spacious poster/text split or landscape treatment depending on available width.
- Include title, year/type, rating if available, a short synopsis, and primary action.
- Support `resultLayout=grid` without turning every card into a full-bleed hero.
- When the existing result layout is `spotlight`, let layout control the larger arrangement while card type controls the internal visual details; document that these settings are complementary, not duplicates.
- Keep the card's content bounded; never use full biographies or long synopses inside a grid card.

### 5.4 Compact

**Purpose:** Fast scanning, smaller windows, lower-power hardware, or users who prefer less decoration.

- Use a smaller poster with title, year/type, and rating when available.
- Omit decorative synopsis, extra chips, and nonessential animation.
- Keep detail, watchlist, rating, and compare functionality available through visible actions or a clearly labeled overflow control.
- Respect the chosen results layout. On small screens, use a stable two-column grid or compact list instead of tiny unreadable cards.

### 5.5 Card anatomy and action rules

Use a consistent action order and icon meaning across all card types:

1. **Open details** — existing detail modal/sheet behavior.
2. **Watchlist** — current state is exposed through `aria-pressed` and a text/state change.
3. **Rating** — keep existing rating functionality and do not disguise it as a match score.
4. **Compare** — keep the existing compare action where available; move it to an overflow menu only if the new layout preserves discoverability and test coverage.

Implementation notes:

- Avoid making an `<article>` with multiple controls behave as one giant button. Use real buttons/links for their specific actions.
- Prevent click propagation between the card surface and its nested actions.
- On keyboard focus, use `:focus-within` to reveal the same controls as hover and provide a visible `:focus-visible` ring.
- On touch devices, do not require long-press or hover to reach core actions.
- Use real poster/backdrop URLs from the existing catalog provider and current image helper. Keep a graceful fallback for missing art, fixed aspect ratios, lazy loading below the fold, and `decoding="async"` where supported.
- Do not implement the mockup's “Play trailer” control unless the current project has a real supported trailer data/action path. The existing detail/watchlist/rating/compare actions are the baseline.

## 6. Design style choices

Design style changes a bounded set of CSS tokens and component modifiers. It must remain compatible with all existing palettes, light/dark mode, custom accent colour, contrast settings, and card/search types.

### 6.1 Cinematic (default)

- Dark surfaces remain the recommended default, but do not force dark mode; users may still choose system/light mode.
- Atmospheric surfaces, gentle image-led gradients, refined borders, restrained shadow depth, and artwork-aware glow.
- Highlight actions use the existing accent tokens rather than hard-coded violet/cyan.
- Motion is expressive but brief; avoid “gaming UI” intensity by default.

### 6.2 Minimal

- Mostly solid surfaces, simpler borders, very low shadow, no decorative grain, no pointer tilt, and little or no artwork glow.
- Strong typography and spacing remain; “minimal” must not mean small text or low contrast.
- Useful for performance-focused browsing and reduced visual stimulation.

### 6.3 Film journal

- Editorial typography hierarchy, thin separators, more whitespace, poster-gallery sensibility, restrained serif display accents if the current font preset supports them.
- Metadata should look curated, not like a dense admin table.
- Use poster shelves and detail sections to echo a film journal without changing data sources.

### 6.4 Glass

- Soft translucent panels and layered surfaces for search suggestions and menus, with subtle blur only where supported.
- Text contrast must be computed against the effective rendered surface, not assumed from the background image.
- When the user chooses reduced transparency or the device indicates limited effects, automatically fall back to an opaque surface without losing borders or selection indicators.

### 6.5 Neon noir

- Stronger accent-edge illumination and controlled colored highlights around focused/hovered cards.
- No continuously pulsing glow and no permanently glowing border on every card.
- Preserve the selected palette and allow accent colours to remain customizable.

### 6.6 Interaction with existing preferences

- `palette`, `mode`, and `customAccent` stay independent of `designStyle`.
- `cardShape`, `surfaceStyle`, `shadows`, `grain`, `hoverGlow`, `posterTilt`, `transitionIntensity`, and `artworkAmbience` remain valid low-level settings. A selected design style may set sensible defaults in a **preset action**, but changing `designStyle` alone should not silently destroy the user's separate, manually tuned preferences.
- If a style suggests a default effect, use a style-specific CSS rule only as a base visual treatment. A user's explicit Motion/Accessibility setting must win.
- Avoid hard-coded text/background colours in card rules. Use the existing design tokens and `color-mix()` only with supported fallbacks.

## 7. Search type designs

All search types use the same data and search functions. Only presentation and navigation change. Continue to search titles and people, abort obsolete requests, ignore stale responses, and preserve the existing error/retry behavior.

### 7.1 Grouped autocomplete (default)

This is the search treatment shown in the approved mockup.

- Anchor a floating panel below the search field with a clear border, subtle background separation, and a small opening transition.
- Split results into **Movies & TV Shows** and **People** sections with visible group labels.
- Title rows include a small poster, title, release year, media type, and rating only if the source provides one.
- People rows include a profile image/fallback, name, department/role, and optionally a concise “known for” strip if available without extra unnecessary requests.
- Use section headers that are semantic and readable; don't rely on colour or spacing alone.
- On desktop, allow a two-column grouped panel if sufficient width is available. At narrow widths, stack the groups in one column.
- Keep the dropdown within the viewport, apply a max height with internal scrolling, and ensure it is not clipped by a parent with `overflow: hidden`.
- Show loading skeletons, empty results, and request failures as distinct states.

### 7.2 Compact suggestions

- A narrow, low-distraction dropdown with small posters and one-line title/year/type.
- Group labels may be replaced with compact type tags, but titles and people must remain distinguishable.
- Optimized for short viewports and rapid selection.
- Must still include people results if the query returns them; do not silently change the search backend.

### 7.3 Expanded discovery panel

- A wider panel with grouped results, larger rows, better metadata visibility, and a focused-item preview on wide desktop screens.
- The selected item preview is optional on touch/narrow widths; use a stacked flow rather than squeezing content.
- Actions must be obvious and keyboard-accessible. Preview state must not trigger a second request for the same data if the current results already contain it.

### 7.4 Full-page results

- Keep a search field at the top, then visible filter chips/tabs such as All, Movies, TV Shows, and People only when the underlying data actually supports that category.
- Results appear in the chosen `resultLayout` and use the chosen `cardType`/`designStyle`.
- Provide a clear sort/filter region that does not dominate the poster grid. Do not display fake sorting options or unsupported provider filters.
- “See all results” from autocomplete opens this view while preserving the query.
- A selected movie/show/person continues to use the existing detail/person flow. Similar titles remain based on the existing TMDB recommendation data and must not be re-ranked by appearance preferences.

### 7.5 Search behavior and keyboard support

- Preserve the current safe minimum query length unless product testing justifies a different threshold; current behavior requires at least two characters before running the search.
- Debounce typing modestly (roughly 150–250 ms) if not already done, cancel in-flight requests when the query changes, and ignore stale response tokens. Do not stack duplicate requests on every keypress.
- `ArrowDown`/`ArrowUp` moves through selectable suggestions; `Enter` selects the active suggestion; `Escape` closes the suggestion panel and returns focus to the input; `Tab` moves through visible controls naturally.
- Keep the input's text when a user dismisses suggestions; clear only via an explicit clear button or when existing product navigation requires it.
- Set appropriate combobox/listbox semantics and active-descendant behavior if the UI is implemented as an ARIA combobox. Do not apply `role=listbox` incorrectly to a container that includes unrelated buttons/links.
- Use `aria-live="polite"` for result counts/loading status sparingly; avoid announcing every keystroke/result row.
- On mobile, don't automatically pop open the system keyboard on navigation unless the user initiated search. Respect the existing behavior that avoids autofocus on touch devices.

## 8. Settings redesign

### 8.1 Problems to solve

The current drawer packs many controls into horizontal tabs. It mixes foundational theme settings, layout, motion micro-controls, advanced effects, and AI engine selection within one narrow panel. The preview is generic and is not enough to compare the new card/search options.

Redesign the panel as a compact **Settings workspace** with clearer categories, larger visual previews, fewer always-visible controls, and progressive disclosure for advanced options.

### 8.2 Shell and navigation

**Desktop (recommended):**

- Expand the current 440px drawer to a comfortable workspace around 800–880px wide, capped to the viewport. Keep the right-side drawer interaction unless usability testing shows a centered dialog is clearly better.
- Use a fixed header and a two-column body: a 190–210px navigation rail on the left and a scrollable content pane on the right.
- Keep the close button, section heading, and save status visible; the content pane alone scrolls.
- Use clear active navigation styling, not a row of seven crowded tiny tabs.

**Tablet:**

- If there is not enough width for the full rail, collapse the rail to compact icon/label navigation or a horizontally scrollable category row with a visible active indicator.
- Never compress controls until labels or choices become unreadable.

**Mobile (<=640px):**

- Use a near-full-screen settings sheet/page (`height: 100dvh`) rather than a cramped partial sheet. Preserve safe-area insets and a sticky top bar.
- Replace the desktop rail with a simple category chooser or compact horizontal section navigation. Keep the chosen section label obvious.
- Controls stack to one column; preview cards can scroll horizontally if appropriate.
- Touch target size should generally be at least 44×44 CSS pixels.

### 8.3 Proposed Settings navigation

Keep the visible categories short and task-based:

1. **Overview** — current choices, starter presets, and a compact preview.
2. **Cards & layout** — Card type, Results layout, poster size, density, label detail, card shape.
3. **Search** — Search type with illustrative grouped/compact/expanded/full-page previews.
4. **Theme** — System/Light/Dark, palette, accent, vibe shortcuts, saved looks.
5. **Readability** — font pairing, text size, line spacing, contrast, transparency, comfort preset.
6. **Motion & performance** — motion profile, interaction intensity, hover glow, tilt, ambience, hero particles; advanced effects collapsed.
7. **AI engine** — existing AI-mode priorities and model/resource details, kept separate from visual preference storage.
8. **Advanced** — appearance import/export, full reset, and additional low-frequency options.

If navigation width is very constrained, “Overview” can be the initial landing content rather than a permanent nav item. Keep this category structure stable once the UI is wired to test IDs and deep links.

### 8.4 Overview

The overview should be useful without being a second copy of every setting:

- Heading: **Make Moodsift yours**.
- Three compact current-choice summaries: Card type, Design style, Search type.
- Four optional starter presets with short descriptions and tiny preview art:
  - **Cinematic** (recommended): Interactive card + Cinematic design + Grouped search + grid layout.
  - **Minimal**: Compact card + Minimal design + Compact search + essential labels, restrained effects.
  - **Film journal**: Editorial card + Film journal design + Expanded search + spacious layout.
  - **Performance**: Compact card + Minimal design + Compact search + low decorative effects.
- Presets are convenience actions, not permanent modes. Users can tweak any field after applying one.
- The preset action must not alter ratings, watchlist, profile, quiz state, AI mode, or private data.
- Do not silently lower text size or contrast. Accessibility preferences remain explicit and take precedence.
- Do not override the OS `prefers-reduced-motion` signal. A preset may request less motion; it must never force motion when the OS requests reduction.

### 8.5 Cards & layout screen

Use visual option tiles with a preview, name, one-line description, and selected state. Do not make all options plain text segmented buttons.

Controls, in this order:

1. **Card type** — Interactive, Poster gallery, Editorial, Compact.
2. **Results layout** — Grid, List, Spotlight (existing `resultLayout`).
3. **Poster size** — Small, Medium, Large.
4. **Density** — Compact, Comfortable.
5. **Poster labels** — Essential, Detailed.
6. **Card corners** and **surface** — place below a collapsed “More layout details” area if needed.
7. Shadows and decorative grain go into the same collapsed group or Motion/Design details; don't duplicate them.

Keep the current `resultLayout` semantics: Grid is the default, List is one row per result, Spotlight gives the leading recommendation more space. Test every `cardType` with every `resultLayout` to avoid selector conflicts.

### 8.6 Search screen

- Use four large option tiles with a miniature UI diagram and a sentence describing the presentation.
- Include a small “Try preview” area with fictional sample data; the preview should not issue network requests.
- Explain that all options search the same titles and people; this setting changes only the presentation.
- Place any future search-specific toggles (if implemented) beneath the main choice, not mixed into the global Theme section.
- Do not add a complicated control for the number of suggestions unless there is a clear user need and product test to justify it.

### 8.7 Theme screen

- First row: System / Dark / Light.
- Then palette tiles with names and mood descriptions, each showing real swatches and selected state.
- Accent colour: show curated swatches first; keep custom picker/hex input collapsed under “Custom accent” by default.
- Keep vibe shortcuts but use concise labels and explain that they apply ordinary settings, not hidden effects.
- Move saved looks into a collapsed section; retain the existing cap and delete/apply behavior.
- Theme palette selection and design style selection must stay separate.

### 8.8 Readability screen

Group controls into three small blocks:

- **Text:** Font pairing, text size, line spacing.
- **Contrast and surfaces:** Standard/High contrast; Standard/Reduced transparency.
- **Quick comfort:** Existing comfort preset, with a short list of what it changes before applying.

Do not bury text size or high contrast behind an Advanced disclosure. Always preserve a visible focus ring.

### 8.9 Motion & performance screen

Show three high-level motion presets at the top (Dynamic, Subtle, Off/System) with direct links/details for the existing lower-level values. Keep the actual stored `motion` preference values compatible (`system`, `full`, `subtle`, `off`).

Recommended grouping:

- **Motion profile:** System / Full / Subtle / Off.
- **Card interactions:** hover glow, poster tilt.
- **Atmosphere:** artwork ambience, hero particles.
- **Transitions:** Minimal / Standard / Cinematic.
- **Advanced effects** collapsed: particle density, connection lines, pointer response, click pulse.

The dynamic card design is the desired default, but effects must be automatically constrained when:

- `prefers-reduced-motion: reduce` is active and the profile is System;
- Motion is Off;
- pointer is coarse/touch-only;
- page is hidden or window loses focus;
- effect code is unavailable or fails.

Turning off motion must remove tilt/glow classes and inline CSS variables immediately. It must not disable visible button-state/focus feedback or delay actions.

### 8.10 AI engine screen

- Keep the four existing AI engine modes and their policy explanations intact.
- Use compact selectable rows/cards with concise descriptions; expose resource details inside a “Model details” disclosure.
- Do not mix AI mode into appearance undo/redo, named looks, appearance import/export, or appearance reset.
- Visual presets must never change AI mode.

### 8.11 Advanced screen

- Appearance JSON export/import with clear error/status states.
- A destructive-looking but low-frequency **Reset appearance** action at the bottom; it resets only appearance preferences and offers Undo.
- Any reset action should state exactly what is reset. No reset may touch ratings, watchlist, profile, quiz history, or AI engine mode.
- Hide technical raw JSON until the user chooses Export or Import; don't display large textareas constantly.

### 8.12 Footer, save state and preview

- Use a compact sticky footer with a clear saved/session-only status and Undo/Redo. Keep actions available but visually secondary.
- Save instantly or using the existing debounced persistence. Always display whether local storage persistence succeeded.
- Replace the generic one-card preview with section-specific previews:
  - Overview: card + search mini-previews.
  - Cards & layout: all card type mini-previews.
  - Search: the four search presentations.
  - Theme: swatch/typography preview.
- Previews are `aria-hidden="true"` when merely illustrative, and must not create keyboard traps or fake interactive controls.
- Avoid re-rendering the entire panel on each selection. Keep existing in-place sync patterns so focus does not jump.

## 9. Implementation detail and code changes

### 9.1 Preference layer

Update `src/lib/appearance.ts`:

1. Extend the `AppearancePreferences` type with `cardType`, `designStyle`, and `searchType`.
2. Add strict enum allow-lists to `FIELD_OPTIONS`.
3. Add defaults to `DEFAULT_PREFERENCES`.
4. Add root attributes to `applyPreferences()`.
5. Place `cardType` and `resultLayout` in the layout reset group, `designStyle` in the theme/design group, and `searchType` in a new search reset group or the Advanced/UX group. Prefer a dedicated `ResetSection='search'` if a per-section reset is shown for Search.
6. Make sure reset, undo/redo, named looks, import/export, and compare-before behavior include the new fields automatically.
7. Preserve field validation. Never insert arbitrary strings into CSS selectors or style declarations; only apply the validated enumerated attributes.

For user-facing organization, a design style may be edited from Overview/Theme even if its stored field is part of the same appearance object. Avoid redundant controls that update different aliases for the same setting.

### 9.2 Settings panel

Refactor `src/lib/settings-panel.ts` by extracting section builders rather than growing a single giant builder:

- Create the shell/navigation with stable section IDs.
- Create reusable `choiceTile`/preview tile helpers that use semantic buttons and selected state.
- Reuse the current labelled radio-group pattern and arrow-key behavior when appropriate.
- Add the card/search previews without calling catalog APIs.
- Keep live `onChange` synchronization in place; don't replace focused controls after each update.
- Keep the AI panel's `subscribeAiMode` cleanup and focus trap behavior.
- Keep Escape-to-close, return focus to opener, scrim close where intended, and proper mobile scroll locking.
- Maintain an accessible dialog label (rename it to “Settings” if the panel is now the full settings workspace) and update Playwright accessible-role tests consistently.

### 9.3 Card rendering and styles

Likely touchpoints:

- `src/screens/results.ts`: retain existing card data and actions; add small, explicit modifier attributes/classes if the CSS cannot express the card type cleanly.
- `src/styles/results.css`: styles for the card composition variants and action/hover/focus states.
- `src/styles/effects.css`: design-style modifiers and ensure reduced-motion/low-transparency rules win.
- `src/lib/fx.ts`: keep delegated pointer handling; extend the selector only if needed and clean up active state on `pointerleave`, blur, motion-off, and screen teardown.
- `src/styles/tokens.css` / `src/styles/palettes.css`: introduce design-style variables/modifiers without overriding user palette/custom accent or light mode unexpectedly.

Prefer a root modifier and a small number of component classes over repeating long, highly-specific selectors. CSS should have clear cascade precedence: accessibility/motion overrides first in authority, then user-level shape/labels/layout, then design-style decoration.

### 9.4 Search rendering

Likely touchpoints:

- `src/screens/search.ts`: create a search presentation renderer selected using `getPreferences().searchType`; keep the core title/person fetch, cancellation token, abort behavior, detail selection, and similar-title flow shared.
- `src/styles/search.css`: style grouped autocomplete, compact suggestions, expanded panel, full-page results, focus/active states, and mobile stacking.
- Consider extracting small helpers for title row, person row, group heading, loading/empty/error state to avoid four separate, drifting implementations.

A search type change should redraw only the presentation, not issue a new query unnecessarily. If the active query is still current, reuse its result set. A settings change must not send extra TMDB requests simply because the user previewed an option.

### 9.5 Header/entry points

- Keep the existing Search navigation entry point and header search action.
- Use the same active `searchType` for autocomplete wherever the shared search field appears.
- Preserve pending search target behavior for title/person clicks from elsewhere in the app.
- When full-page results is selected, a “See all results” action must carry the query rather than starting over.

## 10. Animation specification

### 10.1 Interactive card timing

Suggested targets—not mandatory pixel values if existing design tokens provide equivalent values:

| Interaction | Target |
|---|---|
| Card hover/focus reveal | 160–220 ms |
| Poster lift/scale | 180–240 ms |
| Action control fade/slide | 140–180 ms |
| Search panel enter/exit | 140–200 ms |
| Grid entrance stagger | 20–30 ms per card, capped after the first 8–12 cards |

Use the existing easing/duration custom properties when possible. Avoid spring loops, permanent animation, and transitions that delay interaction.

### 10.2 Hover/focus choreography

On pointer hover for the Interactive card:

1. Lift card by approximately 3–6px and scale very slightly (about 1.01–1.025).
2. Apply a restrained local glow tied to pointer position if enabled.
3. Reveal open-details and watchlist actions with a short opacity/translate transition.
4. Reveal a short synopsis/rating preview if there is room and data exists.
5. Keep card dimensions fixed to prevent grid jumps.

On keyboard focus:

- Use `:focus-within` to expose the same actions and detail preview.
- Show a visible high-contrast outline independent of the accent colour.
- Do not require pointer movement to reveal focus-only controls.

On pointer exit, reset the card's pointer CSS variables/classes and return to the resting state without a delayed “snap”.

### 10.3 Responsive/input adaptation

- Mouse/trackpad + motion enabled: allow tilt/glow within configured limits.
- Touch/coarse pointer: no tilt, no hover-only information, actions visible or tap-accessible.
- Keyboard: focus-driven action reveal, no pointer tilt requirement.
- Reduced motion: disable perspective tilt, stagger, scale/slide transitions, animated glow; keep immediate state changes and focus rings.
- Small screens: never render a desktop hover-preview panel over the only controls. Use clear tap targets and avoid nested click targets.

## 11. Responsive design requirements

### Wide desktop (>=1200px)

- Recommendation grid supports 5–7 cards depending on content width and user-selected poster size.
- Grouped autocomplete can use two sections/columns; expanded panel can show a selected preview if enough space.
- Settings uses the wide two-column rail/content layout.

### Tablet and small laptop (641–1199px)

- Result grid adapts to 3–5 cards based on actual usable width, not fixed viewport assumptions.
- Search sections stack when a two-column panel would make rows cramped.
- Settings navigation collapses before control labels start wrapping excessively.

### Mobile (<=640px)

- Result grid defaults to two columns with readable title and type labels; compact list remains available.
- Search suggestions occupy available width and do not overflow the viewport.
- Grouped results stack Movies & TV Shows before People (unless a different stable ordering is chosen after testing).
- Search panel height is bounded, with its own scrolling region if needed. The page behind must not scroll while a modal panel is open.
- Settings becomes nearly full-screen with one-column controls and safe-area padding.
- Don't autofocus the search field on touch navigation if that would unexpectedly open the keyboard; preserve explicit user intent.

At all widths: no horizontal document overflow, no poster aspect ratio distortion, no text clipped beneath gradient overlays, no unreachable content behind sticky headers/footers.

## 12. Accessibility and robustness

- Maintain WCAG AA contrast for text and control labels under every design style and palette; test glass surfaces against actual composited backgrounds.
- Don't use the match ring or colour alone to communicate a numeric match; include the percentage and accessible label where that data exists.
- Buttons need explicit names; watchlist button exposes saved/unsaved state through `aria-pressed` and meaningful accessible text.
- Maintain logical heading hierarchy and labelled groups for radio/card-choice tiles.
- Preserve dialog focus trap, Escape behavior, focus restoration, and background scroll lock.
- Search suggestions must support keyboard navigation and expose loading/empty/error states accessibly.
- Respect `prefers-reduced-motion` and current user motion settings. User design preferences must not bypass platform accessibility settings.
- Keep fallback art, missing-title metadata, no-network states, and image load failures graceful.
- Test zoom to 200% and large text settings; don't force fixed card heights that truncate meaningful controls.

## 13. Performance and privacy

- Keep pointer movement delegated and RAF-throttled; do not attach a pointer listener to every card.
- Animate transform/opacity. Avoid animating `filter`, `backdrop-filter`, large blur, or layout-affecting dimensions per frame.
- Limit effect work to the active card. Do not perform continuous palette extraction over all posters.
- Use lazy loading for poster images outside the initial viewport and reserve dimensions to avoid cumulative layout shift.
- The three new preferences are local display preferences. They must not be sent to TMDB, AI engines, analytics, or server endpoints.
- Settings previews use local sample markup, not networked media/search calls.
- A preference change never changes scoring or recommendation ranking, and the AI explanation engine continues to follow its own policy and selection.

## 14. Automated validation and regression plan

Add or extend Playwright tests using the project's existing fixtures and mocked TMDB responses. Keep tests deterministic; visual states should not depend on live catalog APIs.

### 14.1 Preference and persistence tests

- Each `cardType`, `designStyle`, and `searchType` choice can be selected and sets the correct root attribute.
- Choices persist across reloads.
- Missing fields in an older stored version fall back to defaults.
- Unknown/hostile field values never create arbitrary attributes/styles and safely fall back.
- Undo/redo includes new visual preferences.
- Named looks and appearance JSON export/import include the new preferences.
- Invalid imports reject invalid new enum values; older exports without new fields remain importable.
- Resetting a section or all appearance restores its defaults and never changes profile, ratings, watchlist, quiz state, or AI mode.
- Visual presets alter only their documented preferences and can be customized afterward.

### 14.2 Card tests

- Every card type renders valid title/year/type metadata and available actions.
- Every combination of four card types × three existing result layouts can be smoke-tested without overflowing or hiding actions (12 combinations minimum).
- Hover and keyboard focus reveal the appropriate dynamic controls for Interactive cards.
- Touch/coarse-pointer emulation exposes all essential actions without hover.
- Watchlist, rating, compare and details behavior remains unchanged.
- Missing posters/synopses/ratings do not create broken layout or fake values.
- Reduced motion and Motion Off disable tilt/stagger/large transition effects and remove stale inline variables.

### 14.3 Search tests

- All four search types render from the same mocked result payload.
- Grouped mode separates titles and people and exposes titles' year/type/rating only where available.
- Arrow keys, Enter, Escape, focus restoration, and clear input work.
- Empty, loading, failure, abort, and stale-response states are tested.
- Switching Search type while results are visible does not issue unnecessary duplicate API calls.
- “See all results” preserves the query; selecting a result still opens the existing title/person flow.
- Mobile grouped/expanded/full-page modes do not overflow horizontally.

### 14.4 Settings and visual tests

- Settings navigation is keyboard-operable, uses selected/current semantics, and does not lose focus after live updates.
- Desktop rail, tablet navigation, and mobile full-screen layout work.
- Dialog opens/closes, Escape returns focus to the opener, backdrop behavior is correct, and background scroll is restored.
- Capture visual snapshots for the default (Interactive/Cinematic/Grouped), each individual selector alternative, settings Overview, Cards & layout, and Search sections on desktop and mobile.
- Run existing a11y/visual/appearance/search/AI policy regression tests and update only the assertions legitimately affected by the Settings UI restructure.

### 14.5 Cross-product smoke matrix

The key selectors form a 4 × 5 × 4 = **80-combination** preference space. Avoid taking 80 full screenshots by default. Instead:

- Test all 80 combinations in a fast DOM/computed-style smoke test for invalid combinations, missing selectors, and overflow.
- Take selected visual snapshots for each option independently and several pairwise combinations, including glass + reduced transparency, neon-noir + high contrast, interactive + reduced motion, editorial + spotlight layout, and grouped search on mobile.

### 14.6 Project checks

Before merging:

```bash
npm run typecheck
npm run lint
npm run build
npm test
npm run test:visual   # where browser binaries are installed
```

If a command cannot run due to unavailable dependencies/network, report it as blocked; do not label it passed.

## 15. Acceptance criteria

This update is complete only when all of the following are true:

- The first-load default matches the selected concept: Interactive cards, Cinematic design, Grouped search, grid layout.
- Card type, design style, and search type can be independently selected in Settings and survive reload.
- Settings presents a clear hierarchy, responsive navigation, a live selected state, and useful previews without showing every advanced control at once.
- The desktop Settings workspace is spacious enough to compare visuals; mobile Settings is usable without cramped tabs or horizontal page overflow.
- Interactive card hover/focus effects feel smooth, but card sizes do not jump and essential actions work without hover.
- Grouped autocomplete visibly separates Movies & TV Shows from People and has complete keyboard, loading, empty, and failure behavior.
- Search presentation changes do not alter the search provider, ranking, recommendation score, or AI policy.
- All existing result actions, user ratings, watchlist, compare flow, similar-title flow, pending search targets, theme options, saved looks, import/export, undo/redo, and reset semantics continue working.
- Reduced motion, high contrast, reduced transparency, touch input, and low-power behavior are respected under every style.
- No external UI framework is introduced, and no live API calls are used by previews.
- Automated test/build results are recorded honestly with environment blockers distinguished from actual failures.

## 16. Suggested implementation order

1. **Preference contract:** add the three validated fields, defaults, document attributes, section reset semantics, and compatibility tests.
2. **Settings shell:** redesign navigation/layout and build the Overview/Cards/Search pages with local sample previews.
3. **Card variants:** implement Interactive first, then Poster, Editorial, and Compact; keep existing actions and rating state intact.
4. **Design styles:** implement Cinematic, Minimal, Film journal, Glass, and Neon noir using tokens and small modifier layers.
5. **Search presentations:** implement Grouped first, then Compact, Expanded, and Full-page with a shared query/result layer.
6. **Motion/input adaptation:** finish keyboard-focus and touch behavior, reduced-motion precedence, and cleanup of pointer effects.
7. **Regression pass:** run full tests, screenshots, a11y checks, layout matrix and performance checks; fix regressions before tuning decoration.

## 17. Explicit non-goals

- Do not rewrite Moodsift in React or another framework.
- Do not change how quiz recommendations are scored or ordered.
- Do not have a local AI model alter ranks; current AI policy stays independent.
- Do not add unsupported trailer playback, streaming availability, or invented metadata to match the mockup.
- Do not upload user preferences or personal watch data to a server.
- Do not remove existing theme options, saved looks, accessibility controls, import/export, undo/redo, or reset safeguards merely to simplify the UI.
- Do not ship mock data in production result cards. Fictional data is only for local Settings previews/tests.

---

**Implementation north star:** let users personalize how Moodsift *looks and feels* without changing what it recommends or how their personal library behaves.
