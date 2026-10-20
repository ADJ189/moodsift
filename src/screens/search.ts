// src/screens/search.ts
//
// Search a specific movie/show and see what's actually similar to it —
// deliberately a different data source than the quiz-driven results
// screen. results.ts scores candidates against *this user's* stated
// quiz preferences; that's the wrong model for "what's similar to this
// one title", since people's taste isn't static from session to session
// and a single title's similarity is better answered by TMDB's own
// recommendation data (collaborative filtering — what people who
// engaged with this title also engaged with) than by re-running our
// genre/vibe heuristic on it. See tmdb.ts's getSimilarTitles() for the
// detail.

import { buildPosterImage, el, mount } from '../lib/dom';
import { getPreferences, subscribeAppearance } from '../lib/appearance';
import { buildActionGroup, buildDetailsButton, buildKindLine, buildQuickButton, buildRatingLine, hasRating } from '../lib/card-ui';
import { ICON } from '../lib/icons';
import { subscribeAiMode } from '../lib/ai-settings';
import { describeLlm, enableLocalAi, generateExplanation, getLlmStatus, subscribeLlm } from '../lib/llm';
import { openAppearancePanel } from '../lib/settings-panel';
import { recordRating } from '../lib/profile';
import { keyOf } from '../lib/media-key';
import { buildStarRow, buildWatchlistButton, paintStars } from '../lib/rating-ui';
import { mountProviders } from '../lib/providers-ui';
import { store } from '../lib/store';
import { backdropUrl, getCredits, getPersonBestWork, getPersonDetails, getSimilarTitles, getTitleDetails, personImageUrl, posterUrl, searchMulti, searchPeople, tmdbDetailsUrl, TmdbUnavailableError } from '../lib/tmdb';
import { buildCreditsBlock } from '../lib/credits-ui';
import type { CatalogItem, PersonSummary, RatingValue, ScoredItem } from '../lib/types';

const SEARCH_DEBOUNCE_MS = 200;
const MIN_QUERY = 2;
const LISTBOX_ID = 'search-suggestions';
const AI_LIMIT = 8;

/** Turns a plain CatalogItem into the ScoredItem shape the shared card
 * styling expects, without pretending TMDB's similarity data is a quiz
 * match score. `matchPct` here is repurposed as a rough "how many genres
 * this shares with the title you searched" indicator — shown in smaller,
 * quieter type than the results screen's quiz match% (see search.css) so
 * it doesn't read as the same kind of number. */
function toSimilarItem(item: CatalogItem, source: CatalogItem): ScoredItem {
  const shared = item.genres.filter((g) => source.genres.includes(g));
  const reasons: string[] = [];
  if (shared.length > 0) reasons.push(`Shares ${shared.join(', ')} with ${source.title}`);
  if (item.voteAverage >= 7) reasons.push(`Well-rated: ${item.voteAverage.toFixed(1)}/10 on TMDB`);
  if (reasons.length === 0) reasons.push(`From TMDB's own recommendations for ${source.title}`);
  const overlapPct = source.genres.length > 0 ? Math.round((shared.length / source.genres.length) * 100) : 0;
  return { ...item, matchPct: overlapPct, rankPct: overlapPct, score: overlapPct, fit: 'good', reasons, matchedTags: shared.slice(0, 4) };
}

/** A title found by name, shaped for the shared card. There is no quiz match
 * and no similarity here, so both stay zero and the card shows neither. */
function toSearchItem(item: CatalogItem): ScoredItem {
  return { ...item, matchPct: 0, rankPct: 0, score: 0, fit: 'good', reasons: [], matchedTags: [] };
}

export function renderSearch(root: HTMLElement): () => void {
  let cancelled = false;
  let unsubscribePending: (() => void) | null = null;
  let debounceTimer: number | null = null;
  let searchToken = 0;
  let searchAbort: AbortController | null = null;
  let removeOutsideListener: (() => void) | null = null;
  // Bumped by every title/person selection; an async load only paints if
  // it is still the latest one, so a slow older response can't overwrite
  // the page for a newer choice.
  let detailToken = 0;
  let similarItems: ScoredItem[] = [];
  const resultRatings = new Map<string, RatingValue>();

  // On-device AI wording for the similar-titles grid. Elements are rebuilt on
  // every drawDetail, so the live status subscription tracks the current ones.
  let aiBtn: HTMLButtonElement | null = null;
  let aiStatusEl: HTMLElement | null = null;
  let aiGrid: HTMLElement | null = null;
  let aiResults: ScoredItem[] = [];
  let aiSource: CatalogItem | null = null;
  // Bumped to cancel an in-progress sentence-by-sentence refresh.
  let aiRun = 0;
  let aiWasReady = getLlmStatus() === 'ready';
  const unsubscribeLlm = subscribeLlm(onLlmChange);
  const unsubscribeAiMode = subscribeAiMode(() => {
    aiRun++;
    restoreReasons();
  });

  const screen = el('div', { class: 'screen search-screen' });
  mount(root, screen);

  // ── Search presentation state ───────────────────────────────────────
  // One shared query/result layer; the four search types only change how the
  // same results are presented. A type change redraws from this cache and
  // never issues a request.
  type Phase = 'idle' | 'loading' | 'ready' | 'error';
  type Category = 'all' | 'movie' | 'tv' | 'people';
  interface Option {
    kind: 'title' | 'person';
    title?: CatalogItem;
    person?: PersonSummary;
    node: HTMLElement;
  }
  let phase: Phase = 'idle';
  let currentQuery = '';
  let titles: CatalogItem[] = [];
  let people: PersonSummary[] = [];
  let panelOpen = false;
  let fullOpen = false;
  let category: Category = 'all';
  let activeIdx = -1;
  let options: Option[] = [];
  let lastType = getPreferences().searchType;
  // Set by draw(); lets a Settings change redraw the presentation only.
  let redrawSearch: (() => void) | null = null;
  const unsubscribeAppearance = subscribeAppearance((p) => {
    if (p.searchType === lastType) return;
    lastType = p.searchType;
    redrawSearch?.();
  });

  draw();

  function draw() {
    const input = el('input', {
      class: 'search-input',
      type: 'search',
      role: 'combobox',
      placeholder: 'Search a movie, show or person…',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': 'Search for a title',
      'aria-autocomplete': 'list',
      'aria-haspopup': 'listbox',
      'aria-expanded': 'false',
      'aria-controls': LISTBOX_ID,
    }) as HTMLInputElement;

    const searchIconWrap = el('span', { class: 'icon-inline', style: 'width:18px;height:18px' });
    searchIconWrap.innerHTML = `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8.6" cy="8.6" r="5.6" stroke="currentColor" stroke-width="1.6"/><path d="M17 17l-4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

    const panelHost = el('div', { class: 'search-panel-host' });
    const fullHost = el('div', { class: 'search-full-host' });
    const statusEl = el('div', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
    const detailHost = el('div', { class: 'search-detail-host' });
    const field = el('div', { class: 'search-field' }, [el('div', { class: 'search-bar' }, [searchIconWrap, input]), panelHost, statusEl]);

    const header = el('div', { class: 'search-header' }, [
      (() => {
        const backBtn = el('button', { class: 'btn btn-ghost toolbar-btn', onclick: () => store.setScreen('landing') });
        backBtn.innerHTML = `<span class="icon-inline" style="width:14px;height:14px">${ICON.chevronLeft}</span> Back`;
        return backBtn;
      })(),
      el('h2', {}, ['Search for a title']),
      el('p', { class: 'search-sub' }, [
        'Find a movie or show you already like, and see what\u2019s actually similar — pulled straight from TMDB\u2019s own recommendation data, not re-run through your quiz answers, since taste shifts session to session.',
      ]),
      field,
      fullHost,
    ]);

    mount(screen, el('div', {}, [header, detailHost]));
    // Don't pop the on-screen keyboard over the page on touch devices.
    if (!window.matchMedia('(hover: none)').matches) input.focus();

    // ── picking ──────────────────────────────────────────────────────
    function resetSearch(clearInput: boolean) {
      searchToken++;
      searchAbort?.abort();
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      debounceTimer = null;
      phase = 'idle';
      titles = [];
      people = [];
      currentQuery = '';
      panelOpen = false;
      fullOpen = false;
      category = 'all';
      activeIdx = -1;
      if (clearInput) input.value = '';
      renderSearchUi();
    }
    function pickTitle(m: CatalogItem) {
      resetSearch(true);
      void selectTitle(m, detailHost);
    }
    function pickPerson(p: PersonSummary) {
      resetSearch(true);
      void selectPerson(p.id, detailHost);
    }
    function pickOption(i: number) {
      const o = options[i];
      if (!o) return;
      if (o.kind === 'title' && o.title) pickTitle(o.title);
      else if (o.person) pickPerson(o.person);
    }

    // ── rendering ────────────────────────────────────────────────────
    function shownTitles(variant: string): CatalogItem[] {
      return titles.slice(0, variant === 'compact' ? 6 : 8);
    }
    function shownPeople(variant: string): PersonSummary[] {
      return people.slice(0, variant === 'compact' ? 3 : 4);
    }

    function setExpanded(open: boolean) {
      input.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!open) input.removeAttribute('aria-activedescendant');
    }

    function renderSearchUi() {
      const hadFocus = (panelHost.contains(document.activeElement) || fullHost.contains(document.activeElement)) && document.activeElement !== input;
      renderSearchUiInner();
      // The focused Retry / filter / See-all control may have been replaced;
      // hand focus back to the field rather than dropping it on the page.
      if (hadFocus && !field.contains(document.activeElement) && !fullHost.contains(document.activeElement)) input.focus({ preventScroll: true });
    }

    function renderSearchUiInner() {
      const type = getPreferences().searchType;
      const valid = phase !== 'idle';
      const showFull = valid && (type === 'full-page' || fullOpen);
      options = [];
      if (showFull) {
        panelHost.replaceChildren();
        setExpanded(false);
        renderFull();
      } else {
        fullHost.replaceChildren();
        if (panelOpen && valid) renderPanel(type);
        else {
          panelHost.replaceChildren();
          setExpanded(false);
        }
      }
      field.dataset.searchType = type;
    }

    redrawSearch = () => renderSearchUi();

    function announce() {
      if (phase === 'loading') statusEl.textContent = 'Searching\u2026';
      else if (phase === 'ready') {
        statusEl.textContent = titles.length + people.length === 0 ? 'Nothing found for that search.' : `${titles.length} title${titles.length === 1 ? '' : 's'} and ${people.length} ${people.length === 1 ? 'person' : 'people'} found.`;
      } else if (phase === 'idle') statusEl.textContent = '';
    }

    function skeletonRows(n: number): HTMLElement[] {
      return Array.from({ length: n }, () =>
        el('div', { class: 'search-skel-row', 'aria-hidden': 'true' }, [el('span', { class: 'skeleton search-skel-poster' }), el('span', { class: 'search-skel-lines' }, [el('span', { class: 'skeleton' }), el('span', { class: 'skeleton' })])])
      );
    }

    function titleMeta(m: CatalogItem): HTMLElement {
      const parts: (Node | string)[] = [];
      const type = m.type === 'series' ? 'TV series' : 'Movie';
      parts.push(m.year ? `${m.year} \u00b7 ${type}` : type);
      const line = el('span', { class: 'search-result-type' }, parts);
      if (hasRating(m)) {
        const r = el('span', { class: 'search-result-rating' });
        r.innerHTML = `<span aria-hidden="true"><span class="icon-inline" style="width:11px;height:11px">${ICON.starFilled}</span> ${m.voteAverage.toFixed(1)}</span><span class="visually-hidden"> TMDB rating ${m.voteAverage.toFixed(1)} out of 10</span>`;
        line.append(' ', r);
      }
      return line;
    }

    function buildOption(kind: 'title' | 'person', data: CatalogItem | PersonSummary, variant: string): Option {
      const idx = options.length;
      const isTitle = kind === 'title';
      const m = data as CatalogItem;
      const p = data as PersonSummary;
      const label = isTitle ? `${m.title}${m.year ? ` (${m.year})` : ''}, ${m.type === 'series' ? 'TV series' : 'movie'}` : `${p.name}, ${p.knownForDepartment}`;
      const meta = el('span', { class: 'search-result-meta' }, [
        el('span', { class: 'search-result-title' }, [isTitle ? m.title : p.name]),
        isTitle ? titleMeta(m) : el('span', { class: 'search-result-type' }, [p.knownForDepartment]),
        ...(!isTitle && p.knownFor && variant !== 'compact' ? [el('span', { class: 'search-result-known' }, [`Known for ${p.knownFor.join(', ')}`])] : []),
      ]);
      const children: (Node | string)[] = [
        buildPosterImage(isTitle ? { src: posterUrl(m.posterPath, 'xs'), alt: '', fallbackText: m.title.slice(0, 1) } : { src: personImageUrl(p.profilePath), alt: '', fallbackText: p.name.slice(0, 1) }),
        meta,
      ];
      if (variant === 'compact') children.push(el('span', { class: 'search-tag', 'aria-hidden': 'true' }, [isTitle ? (m.type === 'series' ? 'TV' : 'Movie') : 'Person']));
      const node = el('div', {
        class: `search-option search-option-${kind}`,
        role: 'option',
        id: `${LISTBOX_ID}-o${idx}`,
        'aria-selected': 'false',
        'aria-label': label,
        'data-index': idx,
      }, children);
      // Keep keyboard focus in the field; pick on click/tap.
      node.addEventListener('mousedown', (e) => e.preventDefault());
      node.addEventListener('click', () => pickOption(idx));
      node.addEventListener('mouseenter', () => setActive(idx, false));
      const opt: Option = isTitle ? { kind, title: m, node } : { kind, person: p, node };
      options.push(opt);
      return opt;
    }

    function group(labelText: string, id: string, rows: HTMLElement[]): HTMLElement {
      return el('div', { class: 'search-group', role: 'group', 'aria-labelledby': id }, [el('div', { class: 'search-group-label', id }, [labelText]), ...rows]);
    }

    let previewEl: HTMLElement | null = null;

    function renderPanel(type: 'grouped' | 'compact' | 'expanded' | 'full-page') {
      const variant = type === 'full-page' ? 'grouped' : type;
      const scroll = el('div', { class: 'search-panel-scroll' });
      let seeAll: HTMLElement | null = null;
      previewEl = null;

      if (phase === 'loading') {
        scroll.setAttribute('aria-busy', 'true');
        scroll.append(...skeletonRows(variant === 'compact' ? 4 : 5));
        setExpanded(false);
      } else if (phase === 'error') {
        scroll.append(
          el('div', { class: 'search-state', role: 'alert' }, [
            el('p', {}, ['Search failed — check your connection and try again.']),
            el('button', { class: 'btn btn-ghost toolbar-btn', type: 'button', onclick: () => void runSearch(currentQuery, true) }, ['Retry']),
          ])
        );
        setExpanded(false);
      } else if (titles.length + people.length === 0) {
        scroll.append(el('p', { class: 'search-state' }, ['No matches — try a different spelling.']));
        setExpanded(false);
      } else {
        const t = shownTitles(variant);
        const pp = shownPeople(variant);
        const titleRows = t.map((m) => buildOption('title', m, variant).node);
        const personRows = pp.map((m) => buildOption('person', m, variant).node);
        const groups: HTMLElement[] = [];
        if (titleRows.length) groups.push(group('Movies & TV Shows', 'search-g-titles', titleRows));
        if (personRows.length) groups.push(group('People', 'search-g-people', personRows));
        scroll.append(el('div', { class: 'search-listbox', role: 'listbox', id: LISTBOX_ID, 'aria-label': 'Search suggestions' }, groups));
        setExpanded(true);
        seeAll = el('button', { class: 'search-see-all', type: 'button', onclick: () => openFull() }, [`See all results for \u201c${currentQuery}\u201d`]);
        if (variant === 'expanded') previewEl = el('aside', { class: 'search-preview', 'aria-hidden': 'true' });
      }

      const panel = el('div', { class: 'search-panel', 'data-variant': variant }, [
        el('div', { class: 'search-panel-body' }, [scroll, ...(previewEl ? [previewEl] : [])]),
        ...(seeAll ? [el('div', { class: 'search-panel-foot' }, [seeAll])] : []),
      ]);
      panelHost.replaceChildren(panel);
      // A region that scrolls must be reachable without a pointer. Arrow keys
      // already scroll the active option into view; this adds a Tab stop only
      // when the content really overflows, so there is no extra stop otherwise.
      requestAnimationFrame(() => {
        if (scroll.isConnected && scroll.scrollHeight > scroll.clientHeight + 1) scroll.tabIndex = 0;
      });
      if (activeIdx >= options.length) activeIdx = -1;
      syncActive(false);
    }

    function renderPreview() {
      if (!previewEl) return;
      const o = options[activeIdx] ?? options[0];
      if (!o) return previewEl.replaceChildren();
      if (o.kind === 'title' && o.title) {
        const m = o.title;
        previewEl.replaceChildren(
          buildPosterImage({ src: posterUrl(m.posterPath, 'md'), alt: '', fallbackText: m.title.slice(0, 1) }),
          el('h4', {}, [`${m.title}${m.year ? ` (${m.year})` : ''}`]),
          el('p', { class: 'search-result-type' }, [m.type === 'series' ? 'TV series' : 'Movie']),
          ...(hasRating(m) ? [el('p', { class: 'search-result-type' }, [`TMDB ${m.voteAverage.toFixed(1)} / 10`])] : []),
          el('p', { class: 'search-preview-overview' }, [m.overview ? (m.overview.length > 240 ? `${m.overview.slice(0, m.overview.lastIndexOf(' ', 240))}\u2026` : m.overview) : 'No synopsis available.'])
        );
      } else if (o.person) {
        const p = o.person;
        previewEl.replaceChildren(
          buildPosterImage({ src: personImageUrl(p.profilePath), alt: '', fallbackText: p.name.slice(0, 1) }),
          el('h4', {}, [p.name]),
          el('p', { class: 'search-result-type' }, [p.knownForDepartment]),
          ...(p.knownFor ? [el('p', { class: 'search-preview-overview' }, [`Known for ${p.knownFor.join(', ')}`])] : [])
        );
      }
    }

    function setActive(i: number, scrollIntoView: boolean) {
      activeIdx = i;
      syncActive(scrollIntoView);
    }
    function syncActive(scrollIntoView: boolean) {
      options.forEach((o, i) => o.node.setAttribute('aria-selected', i === activeIdx ? 'true' : 'false'));
      const cur = options[activeIdx];
      if (cur) {
        input.setAttribute('aria-activedescendant', cur.node.id);
        if (scrollIntoView) cur.node.scrollIntoView({ block: 'nearest' });
      } else input.removeAttribute('aria-activedescendant');
      renderPreview();
    }

    function openFull() {
      fullOpen = true;
      panelOpen = false;
      category = 'all';
      renderSearchUi();
      input.focus({ preventScroll: true });
    }

    function personCard(p: PersonSummary): HTMLElement {
      return el('button', { class: 'search-person-card', type: 'button', onclick: () => pickPerson(p) }, [
        buildPosterImage({ src: personImageUrl(p.profilePath), alt: '', fallbackText: p.name.slice(0, 1) }),
        el('span', { class: 'search-result-meta' }, [
          el('span', { class: 'search-result-title' }, [p.name]),
          el('span', { class: 'search-result-type' }, [p.knownForDepartment]),
          ...(p.knownFor ? [el('span', { class: 'search-result-known' }, [`Known for ${p.knownFor.join(', ')}`])] : []),
        ]),
      ]);
    }

    function renderFull() {
      if (phase === 'loading') {
        fullHost.replaceChildren(
          el('section', { class: 'search-full', 'aria-label': 'Search results', 'aria-busy': 'true' }, [
            el('div', { class: 'results-grid' }, Array.from({ length: 6 }, () => el('div', { class: 'result-card skeleton-card', 'aria-hidden': 'true' }, [el('div', { class: 'result-poster skeleton' })]))),
          ])
        );
        return;
      }
      if (phase === 'error') {
        fullHost.replaceChildren(
          el('div', { class: 'state-message state-message-inline', role: 'alert' }, [
            el('h3', {}, ['Search failed']),
            el('p', {}, ['Check your connection and try again.']),
            el('button', { class: 'btn btn-primary', type: 'button', onclick: () => void runSearch(currentQuery, true) }, ['Retry']),
          ])
        );
        return;
      }
      const movies = titles.filter((m) => m.type === 'movie');
      const shows = titles.filter((m) => m.type === 'series');
      const counts: [Category, string, number][] = [
        ['all', 'All', titles.length + people.length],
        ['movie', 'Movies', movies.length],
        ['tv', 'TV Shows', shows.length],
        ['people', 'People', people.length],
      ];
      // Only categories the results actually contain.
      const available = counts.filter(([id, , n]) => id === 'all' || n > 0);
      if (!available.some(([id]) => id === category)) category = 'all';
      if (titles.length + people.length === 0) {
        fullHost.replaceChildren(el('div', { class: 'state-message state-message-inline' }, [el('h3', {}, ['No matches']), el('p', {}, ['Try a different spelling.'])]));
        return;
      }
      const chips = el('div', { class: 'search-filters', role: 'group', 'aria-label': 'Filter results' }, available.map(([id, label, n]) =>
        el('button', {
          class: `search-filter${category === id ? ' active' : ''}`,
          type: 'button',
          'aria-pressed': category === id ? 'true' : 'false',
          onclick: () => {
            category = id;
            renderFull();
            fullHost.querySelector<HTMLElement>(`[data-filter="${id}"]`)?.focus({ preventScroll: true });
          },
          'data-filter': id,
        }, [`${label} `, el('span', { class: 'search-filter-count' }, [String(n)])])
      ));
      const wantTitles = category === 'all' || category === 'movie' || category === 'tv';
      const visibleTitles = category === 'movie' ? movies : category === 'tv' ? shows : titles;
      const wantPeople = category === 'all' || category === 'people';
      const body: HTMLElement[] = [];
      if (wantTitles && visibleTitles.length) {
        body.push(
          el('div', { class: 'search-full-group' }, [
            ...(category === 'all' ? [el('h3', { class: 'search-full-heading' }, ['Movies & TV Shows'])] : []),
            el('div', { class: 'results-grid' }, visibleTitles.map((m, i) => buildCard(toSearchItem(m), i, () => pickTitle(m)))),
          ])
        );
      }
      if (wantPeople && people.length) {
        body.push(
          el('div', { class: 'search-full-group' }, [
            ...(category === 'all' ? [el('h3', { class: 'search-full-heading' }, ['People'])] : []),
            el('div', { class: 'search-people-grid' }, people.map(personCard)),
          ])
        );
      }
      fullHost.replaceChildren(el('section', { class: 'search-full', 'aria-label': 'Search results' }, [el('div', { class: 'search-full-head' }, [el('h3', {}, [`Results for \u201c${currentQuery}\u201d`]), chips]), ...body]));
    }

    // ── querying ─────────────────────────────────────────────────────
    async function runSearch(query: string, force = false) {
      const trimmed = query.trim();
      if (trimmed.length < MIN_QUERY) {
        resetSearch(false);
        return;
      }
      // Same query already answered: redraw from the cache, no new request.
      if (!force && trimmed === currentQuery && (phase === 'ready' || phase === 'loading')) {
        renderSearchUi();
        return;
      }
      const token = ++searchToken;
      searchAbort?.abort();
      const ctrl = new AbortController();
      searchAbort = ctrl;
      currentQuery = trimmed;
      phase = 'loading';
      panelOpen = !fullOpen;
      activeIdx = -1;
      announce();
      renderSearchUi();
      try {
        const [t, pe] = await Promise.all([
          searchMulti(trimmed, ctrl.signal),
          searchPeople(trimmed, ctrl.signal).catch((err) => {
            if (ctrl.signal.aborted) throw err;
            return [] as PersonSummary[];
          }),
        ]);
        if (cancelled || token !== searchToken) return;
        titles = t;
        people = pe;
        phase = 'ready';
      } catch (err) {
        if ((err instanceof DOMException && err.name === 'AbortError') || cancelled || token !== searchToken) return;
        titles = [];
        people = [];
        phase = 'error';
      }
      announce();
      renderSearchUi();
    }

    // ── input wiring ─────────────────────────────────────────────────
    input.addEventListener('input', () => {
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      if (input.value.trim().length < MIN_QUERY) {
        debounceTimer = null;
        resetSearch(false);
        return;
      }
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        void runSearch(input.value);
      }, SEARCH_DEBOUNCE_MS);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        // Decide from the cached results, not the rendered rows: the panel
        // may have been dismissed, which clears its rows.
        if (phase !== 'ready' || titles.length + people.length === 0 || getPreferences().searchType === 'full-page' || fullOpen) return;
        e.preventDefault();
        if (!panelOpen) {
          panelOpen = true;
          renderSearchUi();
        }
        if (options.length === 0) return;
        const next = e.key === 'ArrowDown' ? (activeIdx + 1) % options.length : (activeIdx - 1 + options.length) % options.length;
        setActive(next, true);
      } else if (e.key === 'Enter') {
        if (activeIdx >= 0 && options[activeIdx] && panelOpen) {
          e.preventDefault();
          pickOption(activeIdx);
        } else if (input.value.trim().length >= MIN_QUERY) {
          e.preventDefault();
          if (debounceTimer !== null) {
            window.clearTimeout(debounceTimer);
            debounceTimer = null;
          }
          fullOpen = true;
          panelOpen = false;
          category = 'all';
          void runSearch(input.value);
          renderSearchUi();
        }
      } else if (e.key === 'Escape' && panelOpen) {
        // Close the suggestions but keep what was typed (type=search would
        // otherwise clear itself on Escape).
        e.preventDefault();
        e.stopPropagation();
        panelOpen = false;
        activeIdx = -1;
        renderSearchUi();
        input.focus({ preventScroll: true });
      }
    });

    input.addEventListener('focus', () => {
      if (phase !== 'idle' && !fullOpen && getPreferences().searchType !== 'full-page' && !panelOpen) {
        panelOpen = true;
        renderSearchUi();
      }
    });
    field.addEventListener('focusout', (e) => {
      const next = e.relatedTarget as Node | null;
      // A null target is a re-render dropping the focused control (or the
      // window losing focus) — not the user leaving. Real outside clicks are
      // handled by the pointerdown listener below.
      if (!next || field.contains(next)) return;
      if (!panelOpen) return;
      panelOpen = false;
      activeIdx = -1;
      renderSearchUi();
    });
    const onOutsidePointer = (e: PointerEvent) => {
      if (!panelOpen || field.contains(e.target as Node)) return;
      panelOpen = false;
      activeIdx = -1;
      renderSearchUi();
    };
    document.addEventListener('pointerdown', onOutsidePointer);
    removeOutsideListener = () => document.removeEventListener('pointerdown', onOutsidePointer);

    // A cast-member click elsewhere in the app lands here already pointed
    // at that person/title instead of an empty search box.
    //
    // Targets also arrive while this screen is already open (the command menu
    // can search from here). main.ts ignores same-screen updates, so the
    // screen listens for them itself — otherwise the target would sit unused
    // and replay the next time search is opened.
    function consumePending() {
      const pending = store.getState().pendingSearchTarget;
      if (!pending) return;
      store.clearPendingSearchTarget();
      if (pending.kind === 'person') void selectPerson(pending.id, detailHost);
      else if (pending.kind === 'title') void selectTitleById(pending.id, pending.tmdbType, detailHost);
      else {
        input.value = pending.query.slice(0, 120);
        input.focus({ preventScroll: true });
        void runSearch(input.value);
      }
    }
    consumePending();
    unsubscribePending = store.subscribe((state) => {
      if (state.pendingSearchTarget && !cancelled) consumePending();
    });
  }

  async function selectPerson(id: number, host: HTMLElement) {
    const token = ++detailToken;
    host.replaceChildren(el('p', { class: 'search-loading', role: 'status' }, ['Loading…']));
    try {
      const [person, work] = await Promise.all([getPersonDetails(id), getPersonBestWork(id)]);
      if (cancelled || token !== detailToken) return;
      const items = work.slice(0, 12).map((w) => toSimilarItem(w, { ...w, genres: [] }));
      const photo = personImageUrl(person.profilePath);
      const hero = el('div', { class: 'search-hero' }, [
        el('div', { class: 'search-hero-inner' }, [
          buildPosterImage({ src: photo, alt: person.name, fallbackText: person.name.slice(0, 1) }),
          el('div', { class: 'search-hero-info' }, [
            el('h3', {}, [person.name]),
            el('p', { class: 'search-result-type' }, [[person.knownForDepartment, person.birthday ? `born ${person.birthday}` : '', person.placeOfBirth ?? ''].filter(Boolean).join(' · ')]),
            el('p', { class: 'search-hero-overview' }, [person.biography ? truncatePerson(person.biography) : 'No biography available.']),
          ]),
        ]),
      ]);
      const grid = el('div', { class: 'results-grid' }, items.map((item, i) => buildCard({ ...item, reasons: ['Best-known work'], matchedTags: [] }, i)));
      host.replaceChildren(
        hero,
        el('div', { class: 'search-similar-section' }, [
          el('div', { class: 'search-similar-header' }, [el('h3', {}, [`Best known for`])]),
          items.length > 0 ? grid : el('p', { class: 'search-loading' }, ['No credits found.']),
        ])
      );
    } catch {
      if (cancelled || token !== detailToken) return;
      host.replaceChildren(
        el('div', { class: 'state-message', role: 'alert' }, [
          el('h3', {}, ['Couldn\u2019t load this person']),
          el('button', { class: 'btn btn-primary', type: 'button', onclick: () => void selectPerson(id, host) }, ['Retry']),
        ])
      );
    }
  }

  /** A title picked elsewhere in the app (pendingSearchTarget) arrives as a
   * bare id; resolve it to a full item before showing similar titles. */
  async function selectTitleById(id: number, tmdbType: 'movie' | 'tv', host: HTMLElement) {
    const token = ++detailToken;
    host.replaceChildren(el('p', { class: 'search-loading', role: 'status' }, ['Loading\u2026']));
    try {
      const item = await getTitleDetails(id, tmdbType);
      if (cancelled || token !== detailToken) return;
      if (item) void selectTitle(item, host);
      else host.replaceChildren(el('p', { class: 'search-loading' }, ['We couldn\u2019t find that title.']));
    } catch {
      if (cancelled || token !== detailToken) return;
      host.replaceChildren(
        el('div', { class: 'state-message', role: 'alert' }, [
          el('h3', {}, ['Couldn\u2019t load this title']),
          el('button', { class: 'btn btn-primary', type: 'button', onclick: () => void selectTitleById(id, tmdbType, host) }, ['Retry']),
        ])
      );
    }
  }

  function truncatePerson(text: string): string {
    return text.length <= 600 ? text : `${text.slice(0, text.lastIndexOf(' ', 600))}\u2026`;
  }

  async function selectTitle(item: CatalogItem, host: HTMLElement) {
    const token = ++detailToken;
    resultRatings.clear();
    host.replaceChildren(el('p', { class: 'search-loading' }, [`Finding titles similar to ${item.title}…`]));

    let similar: CatalogItem[] = [];
    let failed = false;
    try {
      similar = await getSimilarTitles(item.id, item.tmdbType);
    } catch (err) {
      failed = err instanceof TmdbUnavailableError;
    }
    if (cancelled || token !== detailToken) return;

    similarItems = similar.slice(0, 24).map((s) => toSimilarItem(s, item));
    drawDetail(item, similarItems, host, failed);
  }

  function drawDetail(source: CatalogItem, results: ScoredItem[], host: HTMLElement, failed = false) {
    const backdrop = backdropUrl(source.backdropPath);

    const hero = el(
      'div',
      { class: 'search-hero', style: backdrop ? `--hero-bg: url('${backdrop}')` : '' },
      [
        el('div', { class: 'search-hero-inner' }, [
          buildPosterImage({ src: posterUrl(source.posterPath, 'md'), alt: `${source.title} poster`, fallbackText: source.title.slice(0, 1) }),
          el('div', { class: 'search-hero-info' }, [
            el('h3', {}, [`${source.title} (${source.year})`]),
            el('p', { class: 'search-hero-overview' }, [source.overview || 'No synopsis available.']),
            el(
              'a',
              { class: 'btn btn-ghost', href: tmdbDetailsUrl(source.id, source.tmdbType), target: '_blank', rel: 'noopener' },
              ['View on TMDB ↗']
            ),
            (() => {
              const creditsHost = el('div', { class: 'search-hero-credits' });
              void getCredits(source.id, source.tmdbType)
                .then((credits) => {
                  if (cancelled) return;
                  const block = buildCreditsBlock(credits, (personId) => void selectPerson(personId, host));
                  if (block) creditsHost.replaceChildren(block);
                })
                .catch(() => {});
              return creditsHost;
            })(),
            (() => {
              const providersHost = el('div', { class: 'search-hero-providers' });
              mountProviders(providersHost, source.id, source.tmdbType);
              return providersHost;
            })(),
          ]),
        ]),
      ]
    );

    const aiButton = el('button', { class: 'btn btn-ghost toolbar-btn', type: 'button' });
    aiButton.addEventListener('click', () => void onAiClick());
    const aiStatus = el('p', { class: 'ai-status', role: 'status', 'aria-live': 'polite' });

    const grid = el(
      'div',
      { class: 'results-grid' },
      results.map((item, i) => buildCard(item, i))
    );

    const section = el('div', { class: 'search-similar-section' }, [
      el('div', { class: 'search-similar-header' }, [
        el('h3', {}, [`Similar to ${source.title}`]),
        aiButton,
      ]),
      aiStatus,
      results.length > 0
        ? grid
        : failed
          ? el('div', { class: 'state-message state-message-inline', role: 'alert' }, [
              el('h3', {}, ['We couldn\u2019t reach the movie database']),
              el('button', { class: 'btn btn-primary', type: 'button', onclick: () => void selectTitle(source, host) }, ['Retry']),
            ])
          : el('p', { class: 'search-loading' }, ['TMDB doesn\u2019t have similar-title data for this one yet.']),
    ]);

    host.replaceChildren(hero, section);

    aiBtn = aiButton;
    aiStatusEl = aiStatus;
    aiGrid = grid;
    aiResults = results;
    aiSource = source;
    syncAiUi();
    if (getLlmStatus() === 'ready') void refreshReasons();
  }

  /** Mirrors the engine state onto the current button + status line. */
  function syncAiUi() {
    if (!aiBtn) return;
    const view = describeLlm('✨ Summarize with on-device AI');
    aiBtn.textContent = view.label;
    aiBtn.toggleAttribute('disabled', view.busy);
    aiBtn.setAttribute('aria-busy', view.busy ? 'true' : 'false');
    aiBtn.title = view.status;
    if (aiStatusEl) {
      // Percent updates while downloading would be read out one by one;
      // announce only once loading has settled.
      aiStatusEl.setAttribute('aria-live', view.busy ? 'off' : 'polite');
      aiStatusEl.textContent = view.status;
    }
  }

  function onLlmChange() {
    if (cancelled) return;
    syncAiUi();
    const ready = getLlmStatus() === 'ready';
    if (ready && !aiWasReady) void refreshReasons();
    aiWasReady = ready;
  }

  async function onAiClick() {
    const status = getLlmStatus();
    if (status === 'disabled') {
      // Data saver is on: take the person to the setting instead of a dead button.
      openAppearancePanel('ai');
      return;
    }
    if (status === 'ready' || status === 'loading') return;
    try {
      await enableLocalAi();
    } catch {
      // The failure reason is already shown through the status subscription.
    }
  }

  /** Puts the original rule-based reasons back on every card. */
  function restoreReasons() {
    if (cancelled || !aiGrid) return;
    const lists = aiGrid.querySelectorAll<HTMLElement>('.result-reasons');
    aiResults.forEach((item, i) => lists[i]?.replaceChildren(...item.reasons.map((r) => el('li', {}, [r]))));
  }

  /** Strictly one card at a time; a title with no usable sentence keeps its
   * original reasons. */
  async function refreshReasons() {
    const grid = aiGrid;
    const source = aiSource;
    if (!grid || !source) return;
    const run = ++aiRun;
    const results = aiResults;
    const summary = `titles similar to "${source.title}" (${source.genres.join(', ') || 'no genre data'})`;
    const lists = grid.querySelectorAll<HTMLElement>('.result-reasons');
    for (let i = 0; i < Math.min(results.length, AI_LIMIT); i++) {
      if (cancelled || run !== aiRun || !grid.isConnected || getLlmStatus() !== 'ready') return;
      const sentence = await generateExplanation(results[i]!, summary);
      if (cancelled || run !== aiRun) return;
      if (!sentence) continue;
      lists[i]?.replaceChildren(el('li', { class: 'ai-reason' }, [sentence]));
    }
  }

  function buildCard(item: ScoredItem, index: number, pick?: () => void): HTMLElement {
    const poster = buildPosterImage({
      src: posterUrl(item.posterPath, 'md'),
      alt: `${item.title} poster`,
      fallbackText: item.title.slice(0, 1),
    });

    const previewParts = [{ svg: ICON.starFilled, label: item.voteAverage.toFixed(1) }];
    const open = () => {
      if (pick) return pick();
      const host = screen.querySelector<HTMLElement>('.search-detail-host');
      if (host) void selectTitle(item, host);
    };
    const rating = buildRatingLine(item);
    const hasPreviewRating = hasRating(item);

    const card = el('article', { class: 'result-card stagger-in', style: `--stagger: ${Math.min(index, 10)}` }, [
      el(
        'div',
        { class: 'result-poster' },
        [
          poster,
          el('button', { class: 'result-open', type: 'button', tabindex: '-1', 'aria-hidden': 'true', onclick: open }),
          buildActionGroup([buildWatchlistButton(item), buildQuickButton(`See what\u2019s similar to ${item.title}`, () => open())]),
          el('div', { class: 'result-hover-preview', 'aria-hidden': 'true' }, [
            el('p', { class: 'hover-preview-overview' }, [item.overview || 'No synopsis available.']),
            ...(hasPreviewRating
              ? [
                  (() => {
                    const p = el('p', { class: 'hover-preview-ratings' });
                    p.innerHTML = previewParts.map((pt) => `<span class="icon-inline" style="width:12px;height:12px">${pt.svg}</span> ${pt.label}`).join(' ');
                    return p;
                  })(),
                ]
              : []),
            (() => {
              const span = el('span', { class: 'hover-preview-cta' });
              span.innerHTML = `<span class="icon-inline" style="width:12px;height:12px">${ICON.arrowUpRight}</span> See what's similar to this`;
              return span;
            })(),
          ]),
        ]
      ),
      el('div', { class: 'result-body' }, [
        ...(item.matchPct > 0 ? [el('div', { class: 'result-match search-overlap' }, [`${item.matchPct}% genre overlap`])] : []),
        el('h3', { class: 'result-title' }, [el('button', { class: 'result-title-btn', type: 'button', onclick: open }, [`${item.title} (${item.year})`])]),
        buildKindLine(item),
        ...(rating ? [rating] : []),
        ...(item.overview ? [el('p', { class: 'result-synopsis' }, [item.overview.length > 170 ? `${item.overview.slice(0, item.overview.lastIndexOf(' ', 170))}\u2026` : item.overview])] : []),
        ...(item.reasons.length ? [el('ul', { class: 'result-reasons' }, item.reasons.map((r) => el('li', {}, [r])))] : []),
        buildDetailsButton('See similar', `See what\u2019s similar to ${item.title}`, () => open()),
        buildStarRow(item, resultRatings.get(keyOf(item)), (v) => {
          resultRatings.set(keyOf(item), v);
          recordRating(item, v, 'result');
          paintStars(screen, keyOf(item), v);
        }),
      ]),
    ]);
    return card;
  }

  return () => {
    cancelled = true;
    aiRun++;
    unsubscribeLlm();
    unsubscribeAiMode();
    unsubscribePending?.();
    unsubscribePending = null;
    unsubscribeAppearance();
    removeOutsideListener?.();
    if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    searchAbort?.abort();
  };
}
