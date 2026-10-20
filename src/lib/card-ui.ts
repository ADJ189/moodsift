// src/lib/card-ui.ts
//
// Small, shared pieces of a title card. Every card type (Interactive, Poster
// gallery, Editorial, Compact) is the same markup; `data-card-type` on <html>
// plus styles/cards.css decide what is shown and how. Only real catalog data
// is rendered here: a field that is missing is simply omitted.

import { el } from './dom';
import { ICON } from './icons';
import type { CatalogItem } from './types';

const GENRE_LABEL: Record<string, string> = {
  thriller: 'Thriller',
  comedy: 'Comedy',
  drama: 'Drama',
  scifi: 'Sci-fi',
  horror: 'Horror',
  adventure: 'Adventure',
  anime: 'Anime',
  cartoon: 'Cartoon',
  sitcom: 'Sitcom',
};

/** "Movie · Thriller" / "TV series" — a concise type + first-genre label. */
export function kindLabel(item: CatalogItem): string {
  const type = item.type === 'series' ? 'TV series' : 'Movie';
  const genre = item.genres[0];
  return genre ? `${type} \u00b7 ${GENRE_LABEL[genre] ?? genre}` : type;
}

export function buildKindLine(item: CatalogItem): HTMLElement {
  return el('p', { class: 'result-kind' }, [kindLabel(item)]);
}

/** The TMDB average, only when TMDB actually has votes for the title. */
export function hasRating(item: CatalogItem): boolean {
  return item.voteCount > 0 && item.voteAverage > 0;
}

export function buildRatingLine(item: CatalogItem): HTMLElement | null {
  if (!hasRating(item)) return null;
  const line = el('p', { class: 'result-rating' });
  const visible = el('span', { 'aria-hidden': 'true' });
  visible.innerHTML = `<span class="icon-inline" style="width:12px;height:12px">${ICON.starFilled}</span> ${item.voteAverage.toFixed(1)}`;
  line.append(visible, el('span', { class: 'visually-hidden' }, [`TMDB rating ${item.voteAverage.toFixed(1)} out of 10`]));
  return line;
}

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(' ', max);
  return `${text.slice(0, cut > max * 0.6 ? cut : max)}\u2026`;
}

/** A bounded synopsis for cards that show one (Editorial). Omitted when empty. */
export function buildSynopsis(item: CatalogItem, max = 170): HTMLElement | null {
  const text = item.overview?.trim();
  if (!text) return null;
  return el('p', { class: 'result-synopsis' }, [truncateText(text, max)]);
}

/** The second quick action on a poster (the first is the watchlist toggle).
 * A real button, so it works with keyboard focus and touch, not just hover. */
export function buildQuickButton(label: string, onActivate: (trigger: HTMLElement) => void): HTMLElement {
  const btn = el('button', {
    class: 'result-quick-btn',
    type: 'button',
    'aria-label': label,
    title: label,
    onclick: (e: Event) => {
      e.stopPropagation();
      onActivate(e.currentTarget as HTMLElement);
    },
  });
  btn.innerHTML = ICON.info;
  return btn;
}

/** Wraps the poster's quick actions in one positioned group. */
export function buildActionGroup(buttons: HTMLElement[]): HTMLElement {
  return el('div', { class: 'result-actions' }, buttons);
}

/** A labelled text button for the one primary action. Only the Editorial card
 * shows it (CSS), so other card types keep a single, shorter tab sequence. */
export function buildDetailsButton(text: string, label: string, onActivate: (trigger: HTMLElement) => void): HTMLElement {
  return el('button', {
    class: 'btn btn-ghost result-details-btn',
    type: 'button',
    'aria-label': label,
    onclick: (e: Event) => onActivate(e.currentTarget as HTMLElement),
  }, [text]);
}
