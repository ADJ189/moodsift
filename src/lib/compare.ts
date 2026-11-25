// src/lib/compare.ts
//
// Shortlist & side-by-side comparison of two or three recommendations.
//
// Identity is the shared composite media key (`movie:123` / `tv:123`), so a
// film and a show with the same TMDB number can never be confused, merged
// or removed by each other. Only fields that actually exist on the item are
// shown; everything else is marked "Not available" rather than guessed. A
// match percentage is presented as a *fit estimate for your answers*, never
// as a rating or a guarantee.

import { trapFocus } from './a11y';
import { buildPosterImage, el } from './dom';
import { ICON } from './icons';
import { buildMatchMeter } from './match-ui';
import { keyOf } from './media-key';
import { posterUrl } from './tmdb';
import type { ScoredItem } from './types';

export const MAX_COMPARE = 3;

type Listener = (items: ScoredItem[]) => void;

const selected = new Map<string, ScoredItem>();
const listeners = new Set<Listener>();
let liveRegion: HTMLElement | null = null;

function announce(message: string) {
  if (!liveRegion || !document.body.contains(liveRegion)) {
    liveRegion = el('div', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', 'data-compare-live': '' });
    document.body.appendChild(liveRegion);
  }
  liveRegion.textContent = message;
}

function emit() {
  const items = [...selected.values()];
  for (const l of listeners) l(items);
}

export function subscribeCompare(l: Listener): () => void {
  listeners.add(l);
  l([...selected.values()]);
  return () => listeners.delete(l);
}

export function isCompared(item: { id: number; tmdbType: 'movie' | 'tv' }): boolean {
  return selected.has(keyOf(item));
}

export function compareCount(): number {
  return selected.size;
}

/** Toggles an item. Returns `'full'` (and changes nothing) when a fourth is
 * attempted, otherwise the new state. */
export function toggleCompare(item: ScoredItem): 'added' | 'removed' | 'full' {
  const key = keyOf(item);
  if (selected.has(key)) {
    selected.delete(key);
    announce(`Removed ${item.title} from comparison. ${selected.size} of ${MAX_COMPARE} selected.`);
    emit();
    return 'removed';
  }
  if (selected.size >= MAX_COMPARE) {
    announce(`You can compare up to ${MAX_COMPARE} titles. Remove one first.`);
    return 'full';
  }
  selected.set(key, item);
  announce(`Added ${item.title} to comparison. ${selected.size} of ${MAX_COMPARE} selected.`);
  emit();
  return 'added';
}

export function removeCompared(key: string): void {
  if (selected.delete(key)) emit();
}

export function clearCompare(silent = false): void {
  if (selected.size === 0) return;
  selected.clear();
  if (!silent) announce('Comparison cleared.');
  emit();
}

/** The Compare button placed on result cards. Its pressed state is kept in
 * sync with the selection no matter where else the item is toggled. */
export function buildCompareButton(item: ScoredItem, onFull?: () => void): HTMLElement {
  const btn = el('button', { class: 'compare-btn', type: 'button' });
  const paint = () => {
    const on = isCompared(item);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.setAttribute('aria-label', `${on ? 'Remove' : 'Add'} ${item.title} ${on ? 'from' : 'to'} comparison`);
    btn.classList.toggle('active', on);
    btn.innerHTML = `<span class="icon-inline" style="width:14px;height:14px">${on ? ICON.check : ICON.compare}</span><span>${on ? 'Comparing' : 'Compare'}</span>`;
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (toggleCompare(item) === 'full') onFull?.();
    paint();
  });
  paint();
  registerButton(btn, paint);
  return btn;
}

// One shared subscription repaints every live Compare button. Detached
// buttons (cards removed by "Different picks", a re-sort, a screen re-draw)
// are pruned both when a new button is registered and on every change, so a
// card that is dropped *before* any comparison activity can't linger — the
// registry never holds more than the buttons currently on the page plus the
// ones just built.
interface LiveButton {
  paint: () => void;
  /** Has it ever been attached to the page? */
  seen: boolean;
  born: number;
}

const liveButtons = new Map<HTMLElement, LiveButton>();
const UNATTACHED_GRACE_MS = 10_000;
let registrySubscribed = false;

function pruneButtons() {
  const now = Date.now();
  for (const [btn, entry] of liveButtons) {
    if (btn.isConnected) entry.seen = true;
    // Attached once and gone now → its card was removed: drop it.
    else if (entry.seen) liveButtons.delete(btn);
    // Never attached (built mid-draw, or discarded before mounting): give a
    // draw time to attach it, then drop it so it can't leak.
    else if (now - entry.born > UNATTACHED_GRACE_MS) liveButtons.delete(btn);
  }
}

function registerButton(btn: HTMLElement, paint: () => void) {
  pruneButtons();
  liveButtons.set(btn, { paint, seen: false, born: Date.now() });
  // A draw builds and mounts its cards in one synchronous pass, so by the
  // next microtask an attached button is on the page; marking it then means a
  // card removed straight afterwards (e.g. "Different picks") is dropped at
  // the very next prune instead of waiting out the grace period.
  queueMicrotask(() => {
    const entry = liveButtons.get(btn);
    if (entry && btn.isConnected) entry.seen = true;
  });
  if (!registrySubscribed) {
    registrySubscribed = true;
    subscribeCompare(() => {
      pruneButtons();
      for (const entry of liveButtons.values()) entry.paint();
    });
  }
}

/** Test/diagnostic hook: how many Compare buttons are still tracked. */
export function trackedCompareButtons(): number {
  pruneButtons();
  return liveButtons.size;
}

/** Sticky tray summarising the selection with the entry points. */
export function buildCompareTray(onOpen: (opener: HTMLElement) => void): { node: HTMLElement; destroy: () => void } {
  const count = el('span', { class: 'compare-tray-count' });
  const chips = el('div', { class: 'compare-tray-chips' });
  const openBtn = el('button', { class: 'btn btn-primary toolbar-btn', type: 'button' }, ['Compare']);
  const clearBtn = el('button', { class: 'btn-text', type: 'button', onclick: () => clearCompare() }, ['Clear']);
  openBtn.addEventListener('click', () => onOpen(openBtn));
  const node = el('div', { class: 'compare-tray', role: 'region', 'aria-label': 'Comparison shortlist', hidden: true }, [
    el('div', { class: 'compare-tray-info' }, [count, chips]),
    el('div', { class: 'compare-tray-actions' }, [clearBtn, openBtn]),
  ]);
  const unsub = subscribeCompare((items) => {
    node.hidden = items.length === 0;
    count.textContent = `${items.length} of ${MAX_COMPARE} selected`;
    chips.replaceChildren(
      ...items.map((it) =>
        el('button', { class: 'compare-chip', type: 'button', 'aria-label': `Remove ${it.title} from comparison`, onclick: () => removeCompared(keyOf(it)) }, [it.title, ' \u00d7'])
      )
    );
    openBtn.toggleAttribute('disabled', items.length < 2);
    openBtn.textContent = items.length < 2 ? 'Pick 2\u20133 to compare' : `Compare ${items.length}`;
  });
  return { node, destroy: unsub };
}

/** Opens the side-by-side dialog. Resolves focus back to `opener` on close. */
export function openCompareDialog(opener: HTMLElement | null, onClose?: () => void): () => void {
  if (selected.size === 0) {
    onClose?.();
    return () => {};
  }

  const overlay = el('div', { class: 'modal-overlay compare-overlay' });
  const titleId = 'compare-title';
  const grid = el('div', { class: 'compare-grid', role: 'list' });
  const closeBtn = el('button', { class: 'modal-close', type: 'button', 'aria-label': 'Close comparison' });
  closeBtn.innerHTML = ICON.close;
  const status = el('p', { class: 'compare-note', role: 'status' });

  const dialog = el('div', { class: 'compare-dialog modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, [
    closeBtn,
    el('div', { class: 'compare-head' }, [
      el('h2', { id: titleId }, ['Compare your shortlist']),
      el('p', { class: 'compare-sub' }, [
        'Match % is how closely a title fits the answers and ratings you gave \u2014 an estimate, not a rating or a promise.',
      ]),
    ]),
    grid,
    status,
    el('div', { class: 'compare-foot' }, [
      el('button', { class: 'btn btn-ghost toolbar-btn', type: 'button', onclick: () => clearCompare() }, ['Clear comparison']),
      el('button', { class: 'btn btn-primary toolbar-btn', type: 'button', onclick: () => close() }, ['Back to results']),
    ]),
  ]);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  const column = (item: ScoredItem): HTMLElement => {
    const rows: [string, string | HTMLElement][] = [
      ['Type', item.type === 'series' ? 'Series' : 'Movie'],
      ['Year', item.year ? String(item.year) : 'Not available'],
      ['Genres', item.genres.length ? item.genres.join(', ') : 'Not available'],
      ['Runtime', 'Not available'], // not part of the discovery payload; never guessed
      ['TMDB rating', item.voteCount > 0 ? `${item.voteAverage.toFixed(1)}/10 (${item.voteCount.toLocaleString()} votes)` : 'Not available'],
    ];
    const reasons = item.reasons.length
      ? el('ul', { class: 'result-reasons' }, item.reasons.map((r) => el('li', {}, [r])))
      : el('p', { class: 'compare-na' }, ['No specific reasons recorded.']);
    return el('article', { class: 'compare-col', role: 'listitem', 'data-item': keyOf(item) }, [
      el('div', { class: 'compare-poster' }, [buildPosterImage({ src: posterUrl(item.posterPath, 'md'), alt: `${item.title} poster`, fallbackText: item.title.slice(0, 1) })]),
      el('h3', { class: 'compare-title' }, [item.title]),
      buildMatchMeter(item),
      el('dl', { class: 'compare-facts' }, rows.flatMap(([k, v]) => [el('dt', {}, [k]), el('dd', { class: v === 'Not available' ? 'compare-na' : '' }, [v])])),
      el('div', { class: 'compare-reasons' }, [el('h4', {}, ['Why it matched']), reasons]),
      el('button', { class: 'btn-text-danger', type: 'button', 'aria-label': `Remove ${item.title} from comparison`, onclick: () => removeCompared(keyOf(item)) }, ['Remove']),
    ]);
  };

  let closed = false;
  let unsub: () => void = () => {};
  let release: () => void = () => {};

  function close() {
    if (closed) return;
    closed = true;
    unsub();
    overlay.remove();
    document.body.style.overflow = '';
    release();
    onClose?.();
  }

  const render = (items: ScoredItem[]) => {
    grid.replaceChildren(...items.map(column));
    grid.style.setProperty('--cols', String(Math.max(1, items.length)));
    status.textContent = items.length < 2 ? 'Add at least one more title to compare side by side.' : '';
    if (items.length === 0) close();
  };
  unsub = subscribeCompare(render);
  if (closed) {
    unsub();
    return () => {};
  }

  release = trapFocus(dialog, { initialFocus: closeBtn, restoreFocus: opener, onEscape: () => close() });
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  closeBtn.addEventListener('click', () => close());

  return close;
}
