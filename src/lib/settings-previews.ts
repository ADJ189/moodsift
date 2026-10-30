// src/lib/settings-previews.ts
//
// Tiny, static, decorative previews for the Settings workspace. They use
// fictional sample text ("The Midnight Reel") and local markup only — they
// never request catalog data, never take focus, and are hidden from assistive
// technology by their containers (aria-hidden). Their look comes from
// settings.css (.pv-*), so they follow the live palette and light/dark mode.

import { el } from './dom';
import type { CardType, DesignStyle, SearchType } from './appearance';

const bar = (w: number) => el('i', { class: 'pv-line', style: `width:${w}%` });
const text = (cls: string, t: string) => el('span', { class: cls }, [t]);

function poster(opts: { badge?: boolean; actions?: boolean } = {}): HTMLElement {
  return el('span', { class: 'pv-poster' }, [
    ...(opts.badge ? [text('pv-badge', '94%')] : []),
    ...(opts.actions ? [el('span', { class: 'pv-actions' }, [el('i'), el('i')])] : []),
  ]);
}

export function cardPreview(type: CardType): HTMLElement {
  const body: Record<CardType, () => HTMLElement[]> = {
    interactive: () => [text('pv-title', 'The Midnight Reel'), text('pv-sub', 'Movie \u00b7 Thriller'), el('i', { class: 'pv-meter' }), bar(70)],
    poster: () => [text('pv-title', 'The Midnight Reel'), text('pv-sub', '2019 \u00b7 \u2605 7.8')],
    editorial: () => [text('pv-title', 'The Midnight Reel'), text('pv-sub', 'Movie \u00b7 2019 \u00b7 \u2605 7.8'), bar(95), bar(88), bar(60), text('pv-pill', 'Details')],
    compact: () => [text('pv-title', 'The Midnight Reel'), text('pv-sub', '\u2605 7.8')],
  };
  return el('span', { class: `pv pv-card pv-card-${type}`, 'aria-hidden': 'true' }, [
    poster({ badge: type === 'interactive', actions: type === 'interactive' || type === 'poster' }),
    el('span', { class: 'pv-body' }, body[type]()),
  ]);
}

export function stylePreview(style: DesignStyle): HTMLElement {
  return el('span', { class: 'pv pv-style', 'data-ds': style, 'aria-hidden': 'true' }, [
    el('span', { class: 'pv-poster' }, [text('pv-badge', '94%')]),
    el('span', { class: 'pv-body' }, [text('pv-title', 'The Midnight Reel'), text('pv-sub', 'Movie \u00b7 Thriller'), bar(65)]),
  ]);
}

const row = (title: string, sub: string, tag?: string, round = false): HTMLElement =>
  el('span', { class: 'pv-row' }, [
    el('i', { class: `pv-thumb${round ? ' pv-round' : ''}` }),
    el('span', { class: 'pv-meta' }, [text('pv-title', title), text('pv-sub', sub)]),
    ...(tag ? [text('pv-tag', tag)] : []),
  ]);

export function searchPreview(type: SearchType): HTMLElement {
  const field = el('span', { class: 'pv-field' }, [text('pv-sub', 'midnight')]);
  let panel: HTMLElement;
  if (type === 'grouped') {
    panel = el('span', { class: 'pv-panel pv-cols' }, [
      el('span', { class: 'pv-group' }, [text('pv-group-label', 'Movies & TV Shows'), row('The Midnight Reel', '2019 \u00b7 Movie \u00b7 \u2605 7.8'), row('Midnight Harbor', '2022 \u00b7 TV series')]),
      el('span', { class: 'pv-group' }, [text('pv-group-label', 'People'), row('Mira Calloway', 'Acting', undefined, true), row('Jonas Midland', 'Directing', undefined, true)]),
    ]);
  } else if (type === 'compact') {
    panel = el('span', { class: 'pv-panel pv-narrow' }, [row('The Midnight Reel', '2019', 'Movie'), row('Midnight Harbor', '2022', 'TV'), row('Mira Calloway', 'Acting', 'Person', true)]);
  } else if (type === 'expanded') {
    panel = el('span', { class: 'pv-panel pv-split' }, [
      el('span', { class: 'pv-group' }, [text('pv-group-label', 'Movies & TV Shows'), row('The Midnight Reel', '2019 \u00b7 Movie \u00b7 \u2605 7.8'), row('Midnight Harbor', '2022 \u00b7 TV series'), text('pv-group-label', 'People'), row('Mira Calloway', 'Acting', undefined, true)]),
      el('span', { class: 'pv-side' }, [el('i', { class: 'pv-side-poster' }), text('pv-title', 'The Midnight Reel'), bar(90), bar(70)]),
    ]);
  } else {
    panel = el('span', { class: 'pv-full' }, [
      el('span', { class: 'pv-chips' }, [text('pv-chip pv-on', 'All'), text('pv-chip', 'Movies'), text('pv-chip', 'TV Shows'), text('pv-chip', 'People')]),
      el('span', { class: 'pv-mini-grid' }, [0, 1, 2, 3].map(() => el('i', { class: 'pv-mini-card' }))),
    ]);
  }
  return el('span', { class: `pv pv-search pv-search-${type}`, 'aria-hidden': 'true' }, [field, panel]);
}

export function layoutPreview(layout: 'grid' | 'list' | 'spotlight'): HTMLElement {
  const cells =
    layout === 'grid'
      ? [0, 1, 2, 3, 4, 5].map(() => el('i', { class: 'pv-cell' }))
      : layout === 'list'
        ? [0, 1, 2].map(() => el('i', { class: 'pv-list-row' }))
        : [el('i', { class: 'pv-cell pv-big' }), el('i', { class: 'pv-cell' }), el('i', { class: 'pv-cell' })];
  return el('span', { class: `pv pv-layout pv-layout-${layout}`, 'aria-hidden': 'true' }, cells);
}

// ── Studio preview stages (v1.13.6) ────────────────────────────────────────
//
// Larger, local-only scenes for Cards & layout, Search and Theme. Each is built
// ONCE and then driven entirely by the <html> data-* attributes that
// appearance.ts already maintains (data-card-type, data-results-layout,
// data-design-style, data-search-type, data-shape, data-palette, data-theme…).
// That keeps the panel's build-once/sync rule — changing a setting never
// remounts or re-renders a stage, so keyboard focus cannot move — and means
// the stage also follows "Compare with before" for free. They contain only
// fictional sample titles, make no requests, and are aria-hidden.

const SAMPLE_TITLES: { title: string; meta: string; blurb: string; match: string }[] = [
  { title: 'The Midnight Reel', meta: '2019 \u00b7 Movie \u00b7 \u2605 7.8', blurb: 'A projectionist finds a reel nobody ordered.', match: '94%' },
  { title: 'Harbor Lights', meta: '2022 \u00b7 TV series', blurb: 'Night-shift pilots, one foggy winter.', match: '88%' },
  { title: 'Paper Moons', meta: '2016 \u00b7 Movie \u00b7 \u2605 7.1', blurb: 'Two forgers and a very small town.', match: '85%' },
  { title: 'Velvet Static', meta: '2021 \u00b7 Movie \u00b7 \u2605 6.9', blurb: 'A pirate radio host goes off-script.', match: '81%' },
  { title: 'Salt & Signal', meta: '2023 \u00b7 TV series', blurb: 'Lighthouse keepers, a coded diary.', match: '79%' },
];

/** One illustrative result card; every variant's parts are present and CSS
 * (keyed on data-card-type) decides which are shown. */
function stageCard(s: (typeof SAMPLE_TITLES)[number], featured = false): HTMLElement {
  return el('span', { class: `st-card${featured ? ' st-featured' : ''}` }, [
    el('span', { class: 'st-art' }, [text('st-match', s.match), el('span', { class: 'st-acts' }, [el('i'), el('i')])]),
    el('span', { class: 'st-info' }, [text('st-title', s.title), text('st-meta', s.meta), text('st-blurb', s.blurb), el('i', { class: 'st-meter' })]),
  ]);
}

function stageCaption(label: string): HTMLElement {
  return el('span', { class: 'st-caption' }, [label]);
}

/** Cards & layout stage: card type, results layout, card corners, density, poster size. */
export function cardsStage(): HTMLElement {
  return el('span', { class: 'st st-cards', 'aria-hidden': 'true' }, [
    stageCaption('Illustrative sample \u2014 not a recommendation'),
    el('span', { class: 'st-grid' }, SAMPLE_TITLES.slice(0, 5).map((s, i) => stageCard(s, i === 0))),
  ]);
}

/** Search stage: all four presentations are present; CSS shows the active one. */
export function searchStage(): HTMLElement {
  const variants: SearchType[] = ['grouped', 'compact', 'expanded', 'full-page'];
  return el('span', { class: 'st st-search', 'aria-hidden': 'true' }, [
    stageCaption('Sample query and results \u2014 nothing is searched here'),
    ...variants.map((v) => el('span', { class: 'st-variant', 'data-v': v }, [searchPreview(v)])),
  ]);
}

/** Theme stage: a miniature Moodsift screen painted with the live tokens. */
export function themeStage(): HTMLElement {
  return el('span', { class: 'st st-theme', 'aria-hidden': 'true' }, [
    stageCaption('Illustrative sample \u2014 follows your palette, accent and mode'),
    el('span', { class: 'st-screen' }, [
      el('span', { class: 'st-bar' }, [el('i', { class: 'st-logo' }), text('st-wordmark', 'Moodsift'), el('i', { class: 'st-bar-fill' }), el('i', { class: 'st-btn' })]),
      el('span', { class: 'st-hero' }, [
        stageCard(SAMPLE_TITLES[0]!, true),
        el('span', { class: 'st-side' }, [
          text('st-kicker', 'Tonight\u2019s pick'),
          text('st-heading', 'Find your next film'),
          text('st-copy', 'Seven questions, a few ratings, and a short list that fits the mood.'),
          el('span', { class: 'st-chips' }, [text('st-chip st-on', 'Thriller'), text('st-chip', 'Mystery'), text('st-chip', '2010s')]),
          el('span', { class: 'st-cta' }, ['See my matches']),
        ]),
      ]),
    ]),
  ]);
}

/** Overview preset thumbnail: the preset's own card type, design style and
 * search treatment in one small frame (reuses the .pv-style surface rules). */
export function presetPreview(p: { cardType?: CardType; designStyle?: DesignStyle; searchType?: SearchType }): HTMLElement {
  const ct = p.cardType ?? 'interactive';
  const posters = ct === 'editorial' ? 2 : ct === 'compact' ? 4 : 3;
  return el('span', { class: 'pv pv-style pv-reel', 'data-ds': p.designStyle ?? 'cinematic', 'data-ct': ct, 'data-st': p.searchType ?? 'grouped', 'aria-hidden': 'true' }, [
    el('span', { class: 'pv-reel-field' }, [el('i'), el('i')]),
    el('span', { class: 'pv-reel-row' }, Array.from({ length: posters }, () => el('span', { class: 'pv-reel-card' }, [el('i', { class: 'pv-reel-art' }), el('i', { class: 'pv-line' })]))),
  ]);
}
