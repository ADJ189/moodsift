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
