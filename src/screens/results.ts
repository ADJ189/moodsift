import { RecommendationEngine } from '../lib/engine';
import { buildPosterImage, el, mount } from '../lib/dom';
import { store } from '../lib/store';
import { discoverCandidates, getCredits, isTmdbConfigured, posterUrl, backdropUrl, tmdbDetailsUrl, TmdbUnavailableError } from '../lib/tmdb';
import { buildCreditsBlock } from '../lib/credits-ui';
import { trapFocus } from '../lib/a11y';
import { buildMatchMeter, buildReasonChips } from '../lib/match-ui';
import { mountProviders } from '../lib/providers-ui';
import { fetchExternalRatings, isOmdbConfigured } from '../lib/omdb';
import { subscribeAiMode } from '../lib/ai-settings';
import { describeLlm, enableLocalAi, generateExplanation, getLlmStatus, subscribeLlm } from '../lib/llm';
import { openAppearancePanel } from '../lib/settings-panel';
import { historyAsCatalogItems, historyRatingFor, isInWatchlist, recordRating, toggleWatchlist } from '../lib/profile';
import { keyOf } from '../lib/media-key';
import { buildStarRow, buildWatchlistButton, paintStars } from '../lib/rating-ui';
import { buildActionGroup, buildDetailsButton, buildKindLine, buildQuickButton, buildRatingLine, buildSynopsis } from '../lib/card-ui';
import { showToast } from '../lib/toast';
import { buildCompareButton, buildCompareTray, clearCompare, openCompareDialog } from '../lib/compare';
import { extractArtworkPalette } from '../lib/artwork';
import { ICON } from '../lib/icons';
import type { CatalogItem, RatingValue, ResultsMode, ScoredItem } from '../lib/types';

const GROUPED_SIZE = 24;
const PRECISE_SIZE = 10;
const PRECISE_MIN_MATCH = 68; // precise mode only keeps titles at/above this match%
const AI_REASON_LIMIT = 8;
const HISTORY_FULL_WEIGHT_COUNT = 12;
const MAX_PAGE_OFFSET = 18; // ~6 refreshes of live TMDB pages before we start reusing the pool
// A rating changes the whole grid — give it a beat before recomputing so a
// quick run of taps doesn't re-render on every single click, and so the
// change doesn't feel jarringly instant. Long enough to read as deliberate,
// short enough not to feel like a delay.
const RATE_DEBOUNCE_MS = 1600;
// How many titles you've just rated stay visible (with their stars filled)
// while the rest of the grid re-curates around them.
const MAX_PINNED_RATED = 6;

function summarizeQuiz(state: ReturnType<typeof store.getState>): string {
  const { mood, vibe, era, company, contentType } = state.quizAnswers;
  return (
    [mood, vibe, era !== 'any' ? era : null, contentType !== 'live_action' ? contentType : null, company]
      .filter(Boolean)
      .join(', ') || 'no strong preference stated'
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

/** Icon + text label as an HTML string, for the buttons that need an SVG
 * inline with a text node — el()'s children array only takes real Nodes
 * or plain (auto-escaped) text, so these go through .innerHTML instead. */
function iconLabel(svg: string, label: string, size = 14): string {
  return `<span class="icon-inline" style="width:${size}px;height:${size}px">${svg}</span> ${label}`;
}

/** A row of rating badges (TMDB/RT/IMDb/Metacritic), each with its own
 * icon, joined by a middle-dot separator. */
function ratingsRow(parts: { svg: string; label: string }[], size = 12): string {
  return parts.map((p) => iconLabel(p.svg, p.label, size)).join(' <span class="rating-sep">·</span> ');
}

export function renderResults(root: HTMLElement): () => void {
  let cancelled = false;

  // Screen-local state. Ratings collected here (on top of the seed
  // calibration ratings already in the store) are the "rate more, get a
  // more curated response" loop — they never leave this screen's memory,
  // so restarting the flow starts clean.
  let quizAnswers = store.getState().quizAnswers;
  const seedRatings = store.getState().ratings;
  const ratingSeeds = store.getState().ratingSeeds;
  const ratingSignals = store.getState().ratingSignals;
  const resultRatings = new Map<string, RatingValue>();
  const itemsByKey = new Map<string, CatalogItem>();
  const shownKeys = new Set<string>();
  // Bumped by every re-curation; a slower, older one can't overwrite a newer
  // draw (e.g. a rating's debounced refresh landing after "Different picks").
  let drawToken = 0;
  let closeOpenModal: (() => void) | null = null;
  let closeCompare: (() => void) | null = null;
  let posterTransitionActive = false;
  const compareTray = buildCompareTray((opener) => {
    closeCompare?.();
    closeCompare = openCompareDialog(opener, () => {
      closeCompare = null;
    });
  });
  // Fixed-position, so it lives on <body> (screen content is replaced on every draw).
  document.body.appendChild(compareTray.node);
  const compareFull = () => showToast('You can compare up to 3 titles \u2014 remove one first.');
  let allCandidates: CatalogItem[] = [];
  let pageOffset = 0;
  let refreshing = false;
  let mode: ResultsMode = 'grouped';
  let rateTimer: number | null = null;

  // On-device AI wording. The button/status elements are rebuilt on every
  // draw, so the live status subscription tracks whichever pair is current.
  let aiBtn: HTMLButtonElement | null = null;
  let aiStatusEl: HTMLElement | null = null;
  let currentResults: ScoredItem[] = [];
  // Bumped to cancel an in-progress sentence-by-sentence refresh (a newer
  // draw, a mode change, leaving the screen).
  let aiRun = 0;
  let aiWasReady = getLlmStatus() === 'ready';
  const unsubscribeLlm = subscribeLlm(onLlmChange);
  const unsubscribeAiMode = subscribeAiMode(() => {
    aiRun++;
    restoreReasons();
  });

  const screen = el('div', { class: 'screen results' });
  mount(root, screen);
  void run();

  function targetCount(): number {
    return mode === 'precise' ? PRECISE_SIZE : GROUPED_SIZE;
  }

  async function run() {
    if (!isTmdbConfigured) {
      drawConfigError();
      return;
    }

    drawLoading();
    try {
      setPhase(0);
      const candidates = await discoverCandidates(filters());
      if (cancelled) return;
      pageOffset = 3;
      mergeCandidates(candidates);

      // External ratings are fetched for the strongest candidates *before*
      // the final scoring pass, so they can actually influence which
      // titles make the batch (they used to be attached afterwards, for
      // display only).
      setPhase(1);
      await enrichTopCandidates();
      if (cancelled) return;

      setPhase(2);
      const { batch } = await ensureBatch(targetCount());
      if (cancelled) return;

      if (batch.length === 0) {
        drawEmpty();
        return;
      }

      store.setResults(batch);
      draw(batch);
    } catch (err) {
      if (cancelled) return;
      if (err instanceof TmdbUnavailableError) {
        drawOutage();
        return;
      }
      const message = err instanceof Error ? err.message : 'Something went wrong fetching results.';
      store.setError(message);
      drawError(message);
    }
  }

  function filters() {
    return {
      mood: quizAnswers.mood,
      vibe: quizAnswers.vibe,
      era: quizAnswers.era,
      format: quizAnswers.format,
      language: quizAnswers.language,
      contentType: quizAnswers.contentType,
    };
  }

  function mergeCandidates(items: CatalogItem[]) {
    for (const item of items) {
      if (!itemsByKey.has(keyOf(item))) {
        itemsByKey.set(keyOf(item), item);
        allCandidates.push(item);
      }
    }
  }

  /** Rebuilds the engine from scratch each time — quiz + seed ratings +
   * every result rating collected so far — and returns the next unseen
   * batch. Titles the user has directly rated are excluded from the pool:
   * they've already gotten a verdict, repeating them adds nothing.
   * In precise mode, the pool is also held to a minimum match% so a
   * thinner, more confident list beats a padded-out one.
   *
   * `opts` lets ensureBatch() reuse this for its fallback steps instead of
   * duplicating the scoring pipeline: ignoreShown lifts the "already
   * shown this session" exclusion, ignorePreciseFloor lifts the 68%+ bar. */
  function buildEngine(): RecommendationEngine {
    const engine = new RecommendationEngine();
    engine.processQuiz(quizAnswers);
    engine.processRatings(seedRatings, ratingSeeds, ratingSignals);
    for (const [key, rating] of resultRatings) {
      const item = itemsByKey.get(key);
      if (item) engine.processResultRating(item, rating);
    }
    // Everything the local profile remembers from *previous* sessions —
    // this is what makes a returning user's first batch already informed
    // instead of a cold start every time (see src/lib/profile.ts).
    //
    // Ratings made this session are also written to the profile, so skip
    // any title already counted above (seed or result rating) — otherwise
    // one rating would count twice. An imported film that is also a visible
    // seed likewise counts once.
    //
    // Only seed ratings that processRatings() could actually use are skipped
    // here (those with a signal entry). After "Change answers" the rating
    // screen can build a different pool, whose signal map no longer covers
    // seeds rated earlier; those ratings contribute nothing above, so they
    // must fall through to the history pass instead of being dropped.
    const countedSeeds = Object.keys(seedRatings).filter((key) => ratingSignals[key] !== undefined);
    const counted = new Set<string>([...countedSeeds, ...resultRatings.keys()]);
    const history = historyAsCatalogItems().filter(({ item }) => !counted.has(keyOf(item)));
    // A big imported library must not outvote the quiz, so *imported*
    // entries are scaled down past ~12 films to keep the library's total
    // weight bounded. Ratings the person gave deliberately in this app
    // (calibration or result ratings from earlier sessions) always keep
    // full weight, however large the import is.
    const importedCount = history.filter((h) => h.imported).length;
    const importScale = Math.min(1, HISTORY_FULL_WEIGHT_COUNT / Math.max(1, importedCount));
    for (const { item, rating, imported } of history) {
      engine.processResultRating(item, rating, imported ? importScale : 1);
    }
    return engine;
  }

  function rescore(count: number, opts: { ignoreShown?: boolean; ignorePreciseFloor?: boolean } = {}): ScoredItem[] {
    const engine = buildEngine();
    const pool = allCandidates.filter((c) => !resultRatings.has(keyOf(c)) && historyRatingFor(c) === undefined);
    const scored = engine.getResults(pool, ratingSignals);
    let unseen = opts.ignoreShown ? scored : scored.filter((r) => !shownKeys.has(keyOf(r)));
    if (mode === 'precise' && !opts.ignorePreciseFloor) unseen = unseen.filter((r) => r.matchPct >= PRECISE_MIN_MATCH);

    const batch = unseen.slice(0, count);
    for (const item of batch) shownKeys.add(keyOf(item));
    return batch;
  }

  /**
   * Used to hand back a blank grid the moment `shownKeys` (accumulated
   * every time a batch is drawn) happened to cover the whole pool — which,
   * for a narrow filter combination, could be after rating just a
   * handful of results. Escalates through fallbacks instead, and always
   * returns *something* plus an honest note when it had to compromise,
   * rather than a dead end:
   *   1. Retry ignoring `shownKeys` — repeats may just be crowding it out.
   *   2. Pull a later page window from TMDB (same as "Different picks").
   *   3. Drop precise mode's 68%+ floor.
   *   4. Last resort: show the pool's best remaining titles regardless of
   *      what's already been shown, with a note explaining why.
   */
  async function ensureBatch(count: number): Promise<{ batch: ScoredItem[]; note: string | null }> {
    let batch = rescore(count);
    if (batch.length > 0) return { batch, note: null };

    batch = rescore(count, { ignoreShown: true });
    if (batch.length > 0) return { batch, note: null };

    if (pageOffset <= MAX_PAGE_OFFSET) {
      try {
        const more = await discoverCandidates(filters(), pageOffset);
        pageOffset += 3;
        mergeCandidates(more);
        await enrichTopCandidates();
        batch = rescore(count, { ignoreShown: true });
        if (batch.length > 0) return { batch, note: null };
      } catch {
        // A failed refresh isn't fatal here — still try the fallbacks below.
      }
    }

    if (mode === 'precise') {
      batch = rescore(count, { ignoreShown: true, ignorePreciseFloor: true });
      if (batch.length > 0) {
        return {
          batch,
          note: "You've rated through every tight match — here are the next-best picks, just outside the Precise cutoff.",
        };
      }
    }

    batch = rescore(count, { ignoreShown: true, ignorePreciseFloor: true });
    return {
      batch,
      note:
        batch.length > 0
          ? 'You\u2019ve rated your way through everything fresh for this combination \u2014 showing the best matches again. \u201cDifferent picks\u201d or loosening the era/language filter will surface more variety.'
          : null,
    };
  }

  const ENRICH_LIMIT = 24;
  const ENRICH_CONCURRENCY = 6;
  const ENRICH_BUDGET_MS = 6000;

  /** Pre-scores the pool, then fetches OMDb ratings for the best
   * ENRICH_LIMIT unrated candidates (bounded concurrency; omdb.ts caches,
   * so repeat passes are free). The ratings are written onto the shared
   * candidate objects, so the real scoring pass that follows sees them. */
  async function enrichTopCandidates() {
    if (!isOmdbConfigured) return;
    const pool = allCandidates.filter((c) => !c.externalRatings && !resultRatings.has(keyOf(c)));
    const top = buildEngine()
      .getResults(pool, ratingSignals)
      .slice(0, ENRICH_LIMIT);
    let next = 0;
    // Overall budget: ratings are a refinement, so stop starting new
    // lookups after this and rank with whatever has arrived.
    const deadline = Date.now() + ENRICH_BUDGET_MS;
    const worker = async () => {
      while (next < top.length && !cancelled && Date.now() < deadline) {
        const entry = top[next++]!;
        const ext = await fetchExternalRatings(entry.title, entry.year);
        const original = itemsByKey.get(keyOf(entry));
        if (ext && original) original.externalRatings = ext;
      }
    };
    await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, worker));
  }

  async function onDifferentPicks(btn: HTMLElement) {
    if (refreshing) return;
    refreshing = true;
    const token = ++drawToken;
    btn.setAttribute('disabled', '');
    btn.textContent = 'Finding more…';

    try {
      const { batch, note } = await ensureBatch(targetCount());
      if (cancelled || token !== drawToken) return;

      store.setResults(batch);
      draw(batch, note);
    } catch {
      btn.removeAttribute('disabled');
      btn.innerHTML = iconLabel(ICON.shuffle, 'Show me different picks');
    } finally {
      refreshing = false;
    }
  }

  async function setMode(next: ResultsMode) {
    if (mode === next || refreshing) return;
    refreshing = true;
    mode = next;
    // Switching bands is itself a fresh request — start the "seen" set
    // over so precise mode can freely pick from titles a wider grouped
    // batch already showed, and vice versa.
    shownKeys.clear();
    const token = ++drawToken;
    try {
      const { batch, note } = await ensureBatch(targetCount());
      if (cancelled || token !== drawToken) return;
      store.setResults(batch);
      draw(batch, note);
    } finally {
      refreshing = false;
    }
  }

  /** Updates the star buttons for one item wherever they currently appear
   * (grid card, and the modal if it's open) — instant feedback — then
   * debounces the actual re-curation so a burst of ratings doesn't
   * re-render the whole grid on every tap. Routes through ensureBatch
   * instead of a bare rescore(): for a narrow filter combination,
   * `shownKeys` can end up covering the whole live pool after just a
   * handful of ratings, and a bare rescore() would then hand back an
   * empty batch with nothing on screen to explain why. */
  function onRateResult(item: ScoredItem, value: RatingValue) {
    const key = keyOf(item);
    resultRatings.set(key, value);
    recordRating(item, value, 'result');
    paintStars(screen, key, value);
    setCurating(true);

    if (rateTimer !== null) window.clearTimeout(rateTimer);
    const token = ++drawToken;
    rateTimer = window.setTimeout(() => {
      rateTimer = null;
      void (async () => {
        const { batch, note } = await ensureBatch(targetCount());
        if (cancelled || token !== drawToken) return;
        // Rated titles are excluded from the scoring pool (they already got
        // a verdict), so a plain redraw made the title you had just rated
        // vanish and left a blank slot. Keep the most recent ones on screen,
        // with their stars filled, and let new picks fill in around them.
        const merged = withPinnedRated(batch);
        store.setResults(merged);
        draw(merged, note);
      })();
    }, RATE_DEBOUNCE_MS);
  }

  /** The titles rated this session that are on screen right now, newest
   * first, merged with a fresh batch and kept in match order. */
  function withPinnedRated(batch: ScoredItem[]): ScoredItem[] {
    const onScreen = new Map<string, ScoredItem>(currentResults.map((r) => [keyOf(r), r]));
    const pinned: ScoredItem[] = [];
    for (const key of Array.from(resultRatings.keys()).reverse()) {
      const item = onScreen.get(key);
      if (item) pinned.push(item);
      if (pinned.length >= MAX_PINNED_RATED) break;
    }
    if (pinned.length === 0) return batch;
    const pinnedKeys = new Set(pinned.map(keyOf));
    return [...batch.filter((r) => !pinnedKeys.has(keyOf(r))), ...pinned].sort((a, b) => b.matchPct - a.matchPct);
  }

  function setCurating(active: boolean) {
    screen.querySelector('.curating-indicator')?.classList.toggle('visible', active);
  }

  type Phase = 'fetch' | 'ratings' | 'rank';

  /** Real progress, not theatre: each step flips to done when that stage of
   * run() actually finishes. The OMDb step only exists if it will run. */
  function drawLoading() {
    const steps: { id: Phase; label: string }[] = [
      { id: 'fetch', label: 'Finding titles that fit your answers' },
      ...(isOmdbConfigured ? [{ id: 'ratings' as Phase, label: 'Checking critic ratings' }] : []),
      { id: 'rank', label: 'Ranking against your taste' },
    ];
    const list = el(
      'ol',
      { class: 'curate-steps', 'aria-label': 'Progress' },
      steps.map((st) => el('li', { class: 'curate-step', 'data-phase': st.id }, [el('span', { class: 'curate-dot', 'aria-hidden': 'true' }), st.label]))
    );
    const grid = el(
      'div',
      { class: 'results-grid' },
      Array.from({ length: 8 }, (_, i) =>
        el('div', { class: 'result-card skeleton-card stagger-in', style: `--stagger: ${i}`, 'aria-hidden': 'true' }, [
          el('div', { class: 'result-poster skeleton' }),
        ])
      )
    );
    mount(
      screen,
      el('div', { class: 'curating' }, [
        el('div', { class: 'curating-panel', role: 'status', 'aria-live': 'polite' }, [
          el('p', { class: 'eyebrow' }, ['building your picks']),
          el('h2', {}, ['Finding films that fit your answers\u2026']),
          list,
        ]),
        grid,
      ])
    );
  }

  function setPhase(phase: 'fetch' | 'ratings' | 'rank' | 0 | 1 | 2) {
    const order: Phase[] = ['fetch', 'ratings', 'rank'];
    const id: Phase = typeof phase === 'number' ? order[phase]! : phase;
    const steps = Array.from(screen.querySelectorAll<HTMLElement>('.curate-step'));
    const activeIdx = steps.findIndex((n) => n.dataset.phase === id);
    // With OMDb off there's no 'ratings' step; treat that phase as the
    // one that follows 'fetch'.
    const idx = activeIdx === -1 ? Math.min(steps.length - 1, order.indexOf(id) - (isOmdbConfigured ? 0 : 1)) : activeIdx;
    steps.forEach((n, i) => {
      n.classList.toggle('done', i < idx);
      n.classList.toggle('active', i === idx);
    });
  }

  function drawConfigError() {
    mount(
      screen,
      el('div', { class: 'state-message' }, [
        el('h2', {}, ['TMDB isn\u2019t configured yet']),
        el('p', {}, [
          'Add a free TMDB API read token as VITE_TMDB_TOKEN in a local .env file, then restart the dev server. See README for the two-minute setup.',
        ]),
        el('button', { class: 'btn btn-ghost', onclick: () => store.setScreen('landing') }, ['← Back']),
      ])
    );
  }

  /** Every TMDB request failed — an outage, auth or rate-limit problem,
   * never a valid "no matches" result, so it gets its own honest state. */
  function drawOutage() {
    mount(
      screen,
      el('div', { class: 'state-message', role: 'alert' }, [
        el('h2', {}, ['We couldn\u2019t reach the movie database']),
        el('p', {}, ['That\u2019s a connection or service problem, not your answers \u2014 they\u2019re safe. Give it another try.']),
        el('div', { class: 'state-message-actions' }, [
          el('button', { class: 'btn btn-primary', onclick: () => void run() }, ['Retry']),
          el('button', { class: 'btn btn-ghost', onclick: () => store.setScreen('landing') }, ['← Back']),
        ]),
      ])
    );
  }

  function drawError(message: string) {
    mount(
      screen,
      el('div', { class: 'state-message', role: 'alert' }, [
        el('h2', {}, ['Couldn\u2019t load results']),
        el('p', {}, [message]),
        el('button', { class: 'btn btn-primary', onclick: () => void run() }, ['Try again']),
      ])
    );
  }

  /** Genuinely nothing fits (the pool loaded fine). Offers a one-click way
   * to loosen the two hard filters instead of a dead end. */
  function drawEmpty() {
    mount(
      screen,
      el('div', { class: 'state-message' }, [
        el('h2', {}, ['Nothing quite fits this combination']),
        el('p', {}, ['Try loosening one preference \u2014 the era and language filters are the strictest.']),
        el('div', { class: 'state-message-actions' }, [
          el(
            'button',
            {
              class: 'btn btn-primary',
              onclick: () => {
                quizAnswers = { ...quizAnswers, era: 'any', language: 'any_lang' };
                allCandidates = [];
                itemsByKey.clear();
                shownKeys.clear();
                pageOffset = 0;
                void run();
              },
            },
            ['Broaden my matches']
          ),
          el('button', { class: 'btn btn-ghost', onclick: () => store.setScreen('quiz') }, ['← Change answers']),
        ]),
      ])
    );
  }

  /** Splits one scored batch into a featured #1 plus themed shelves, so
   * the list reads as curated choices instead of a sorted spreadsheet. */
  function groupResults(results: ScoredItem[]) {
    const [featured, ...rest] = results;
    const pops = rest.map((r) => r.popularity).sort((x, y) => x - y);
    const medianPop = pops.length ? pops[Math.floor(pops.length / 2)]! : 0;
    const gems = rest.filter((r) => r.popularity <= medianPop && r.voteAverage >= 7.2 && r.matchPct >= 55).slice(0, 4);
    const gemKeys = new Set(gems.map(keyOf));
    const others = rest.filter((r) => !gemKeys.has(keyOf(r)));
    return {
      featured,
      strongest: others.filter((r) => r.fit !== 'stretch'),
      gems,
      stretch: others.filter((r) => r.fit === 'stretch'),
    };
  }

  function buildShelf(title: string, blurb: string, items: ScoredItem[], startIndex: number): HTMLElement | null {
    if (items.length === 0) return null;
    return el('section', { class: 'shelf' }, [
      el('div', { class: 'shelf-head' }, [el('h3', {}, [title]), el('p', {}, [blurb])]),
      el('div', { class: 'results-grid' }, items.map((item, i) => buildCard(item, startIndex + i))),
    ]);
  }

  function draw(results: ScoredItem[], note: string | null = null) {
    currentResults = results;
    const aiButton = el('button', { class: 'btn btn-ghost toolbar-btn', type: 'button' });
    aiButton.addEventListener('click', () => void onAiClick());
    const aiStatus = el('p', { class: 'ai-status', role: 'status', 'aria-live': 'polite' });
    aiBtn = aiButton;
    aiStatusEl = aiStatus;
    syncAiUi();

    const differentBtn = el('button', { class: 'btn btn-ghost toolbar-btn' });
    differentBtn.innerHTML = iconLabel(ICON.shuffle, 'Give me another');
    differentBtn.addEventListener('click', () => onDifferentPicks(differentBtn));

    const modeToggle = el('div', { class: 'mode-toggle', role: 'tablist', 'aria-label': 'Results mode' }, [
      el(
        'button',
        {
          class: `mode-btn${mode === 'grouped' ? ' active' : ''}`,
          role: 'tab',
          'aria-selected': mode === 'grouped' ? 'true' : 'false',
          onclick: () => setMode('grouped'),
        },
        ['Grouped']
      ),
      el(
        'button',
        {
          class: `mode-btn${mode === 'precise' ? ' active' : ''}`,
          role: 'tab',
          'aria-selected': mode === 'precise' ? 'true' : 'false',
          onclick: () => setMode('precise'),
        },
        ['Precise']
      ),
    ]);

    const ratedCount = resultRatings.size;
    const header = el('div', { class: 'results-header' }, [
      el('p', { class: 'eyebrow' }, ['your picks']),
      el('h2', {}, ['Your matches']),
      el('p', { class: 'results-subline' }, [
        mode === 'precise'
          ? `${results.length} tightly-matched titles (${PRECISE_MIN_MATCH}%+ match).`
          : `${results.length} titles, scored against your answers.`,
        ratedCount > 0 ? ` You've rated ${ratedCount} result${ratedCount === 1 ? '' : 's'} \u2014 picks keep adjusting.` : '',
        ' ',
        el('span', { class: 'curating-indicator', role: 'status' }, ['Updating your picks…']),
      ]),
      el('div', { class: 'results-toolbar' }, [
        modeToggle,
        el('div', { class: 'toolbar-group' }, [
          differentBtn,
          aiButton,
          el('button', { class: 'btn btn-ghost toolbar-btn', onclick: restart }, ['Start over']),
        ]),
      ]),
      aiStatus,
      // A note from ensureBatch() — shown whenever it had to compromise
      // to avoid a dead end (loosened the Precise floor, allowed repeats,
      // etc.) instead of silently doing so.
      ...(note
        ? [(() => {
            const p = el('p', { class: 'results-note stagger-in' });
            p.innerHTML = iconLabel(ICON.info, note, 13);
            return p;
          })()]
        : []),
    ]);

    const body = el('div', { class: 'results-body' });
    if (results.length === 0) {
      body.appendChild(
        el('div', { class: 'state-message state-message-inline stagger-in' }, [
          el('h3', {}, ['Nothing new left for this exact combination']),
          el('p', {}, ['You\u2019ve been through everything the live pool had. Try another batch, or loosen the era, language or mode.']),
          el('div', { class: 'state-message-actions' }, [
            el('button', { class: 'btn btn-primary', onclick: () => onDifferentPicks(differentBtn) }, ['Give me another']),
            el('button', { class: 'btn btn-ghost', onclick: () => store.setScreen('quiz') }, ['← Change answers']),
          ]),
        ])
      );
    } else {
      const { featured, strongest, gems, stretch } = groupResults(results);
      if (featured) body.appendChild(buildFeatured(featured));
      let idx = 1;
      const shelves: [string, string, ScoredItem[]][] = [
        ['Strong matches', 'Closest to what you told us.', strongest],
        ['Hidden gems', 'Well-rated, less-obvious picks that still fit.', gems],
        ['Worth a stretch', 'A little outside your usual \u2014 close enough to be interesting.', stretch],
      ];
      for (const [title, blurb, items] of shelves) {
        const shelf = buildShelf(title, blurb, items, idx);
        idx += items.length;
        if (shelf) body.appendChild(shelf);
      }
    }

    mount(screen, el('div', {}, [header, body]));

    if (getLlmStatus() === 'ready') void refreshReasons(results);
  }

  /** Mirrors the engine state onto the current button + status line. */
  function syncAiUi() {
    if (!aiBtn) return;
    const view = describeLlm('✨ Explain with on-device AI');
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
    if (ready && !aiWasReady) void refreshReasons(currentResults);
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
    if (cancelled) return;
    for (const item of currentResults) {
      screen
        .querySelectorAll<HTMLElement>(`[data-reasons="${keyOf(item)}"]`)
        .forEach((listEl) => listEl.replaceChildren(...item.reasons.map((r) => el('li', {}, [r]))));
    }
  }

  /** Swaps in on-device AI sentences, matched to cards by item key (the
   * featured pick and themed shelves don't follow raw result order). Strictly
   * one card at a time: each card updates as soon as its own sentence is
   * ready, and a title with no usable sentence keeps its original reasons. */
  async function refreshReasons(results: ScoredItem[]) {
    const run = ++aiRun;
    const summary = summarizeQuiz(store.getState());
    for (const item of results.slice(0, AI_REASON_LIMIT)) {
      if (cancelled || run !== aiRun || getLlmStatus() !== 'ready') return;
      const sentence = await generateExplanation(item, summary);
      if (cancelled || run !== aiRun) return;
      if (!sentence) continue;
      screen
        .querySelectorAll<HTMLElement>(`[data-reasons="${keyOf(item)}"]`)
        .forEach((listEl) => listEl.replaceChildren(el('li', { class: 'ai-reason' }, [sentence])));
    }
  }

  /** A real <button> stretched over the poster: keyboard-focusable, with
   * a visible focus ring, instead of a click handler on a <div>. */
  function buildOpenButton(item: ScoredItem): HTMLElement {
    // The poster-wide target is a pointer convenience. Keyboard and assistive
    // tech use the title link and the Details quick action instead, so a card
    // never presents three identical tab stops for one destination.
    return el('button', {
      class: 'result-open',
      type: 'button',
      tabindex: '-1',
      'aria-hidden': 'true',
      onclick: (e: Event) => openDetailModal(item, e.currentTarget as HTMLElement),
    });
  }

  function previewRatings(item: ScoredItem): { svg: string; label: string }[] {
    const parts: { svg: string; label: string }[] = [{ svg: ICON.starFilled, label: item.voteAverage.toFixed(1) }];
    if (item.externalRatings?.rottenTomatoes !== undefined) parts.push({ svg: ICON.tomato, label: `${item.externalRatings.rottenTomatoes}%` });
    if (item.externalRatings?.imdbRating !== undefined) parts.push({ svg: ICON.starFilled, label: `IMDb ${item.externalRatings.imdbRating}` });
    return parts;
  }

  function buildCard(item: ScoredItem, index: number): HTMLElement {
    const poster = buildPosterImage({
      src: posterUrl(item.posterPath, 'md'),
      alt: `${item.title} poster`,
      fallbackText: item.title.slice(0, 1),
    });
    const chips = buildReasonChips(item);
    const synopsis = buildSynopsis(item);
    const rating = buildRatingLine(item);

    return el('article', { class: 'result-card stagger-in', style: `--stagger: ${Math.min(index, 10)}` }, [
      el('div', { class: 'result-poster' }, [
        poster,
        buildOpenButton(item),
        buildActionGroup([
          buildWatchlistButton(item),
          buildQuickButton(`Open details for ${item.title} (${item.year})`, (btn) => openDetailModal(item, btn)),
        ]),
        // Hover/focus quick-look: synopsis + ratings, no extra fetch. It is a
        // decorative extra — every action it hints at stays one tap away.
        el('div', { class: 'result-hover-preview', 'aria-hidden': 'true' }, [
          el('p', { class: 'hover-preview-overview' }, [item.overview ? truncate(item.overview, 130) : 'No synopsis available.']),
          (() => {
            const p = el('p', { class: 'hover-preview-ratings' });
            p.innerHTML = ratingsRow(previewRatings(item));
            return p;
          })(),
        ]),
        // A genuine quiz match, labelled in text — never colour alone.
        el('span', { class: 'poster-match-badge', 'data-fit': item.fit }, [`${item.matchPct}%`, el('span', { class: 'visually-hidden' }, [' match'])]),
      ]),
      el('div', { class: 'result-body' }, [
        el('h3', { class: 'result-title' }, [
          el('button', { class: 'result-title-btn', type: 'button', onclick: (e: Event) => openDetailModal(item, e.currentTarget as HTMLElement) }, [
            `${item.title} (${item.year})`,
          ]),
        ]),
        buildKindLine(item),
        ...(rating ? [rating] : []),
        buildMatchMeter(item),
        ...(chips ? [chips] : []),
        ...(synopsis ? [synopsis] : []),
        el('ul', { class: 'result-reasons', 'data-reasons': keyOf(item) }, item.reasons.map((r) => el('li', {}, [r]))),
        buildDetailsButton('Details', `Details for ${item.title} (${item.year})`, (btn) => openDetailModal(item, btn)),
        buildStarRow(item, resultRatings.get(keyOf(item)) ?? historyRatingFor(item), (v) => onRateResult(item, v)),
        buildCompareButton(item, compareFull),
      ]),
    ]);
  }

  /** The #1 pick gets a wide backdrop treatment so the list has a visual
   * hierarchy and an obvious "start here". */
  function buildFeatured(item: ScoredItem): HTMLElement {
    const backdrop = backdropUrl(item.backdropPath);
    const chips = buildReasonChips(item);
    const openBtn = el('button', { class: 'btn btn-primary', type: 'button' }, ['See why it fits']);
    openBtn.addEventListener('click', () => openDetailModal(item, openBtn));
    const featuredEl = el('article', { class: 'featured featured-reveal stagger-in', 'data-item': keyOf(item), style: backdrop ? `--feat-bg: url('${backdrop}')` : '' }, [
      el('div', { class: 'featured-poster' }, [buildPosterImage({ src: posterUrl(item.posterPath, 'md'), alt: `${item.title} poster`, fallbackText: item.title.slice(0, 1), eager: true })]),
      el('div', { class: 'featured-info' }, [
        el('p', { class: 'eyebrow' }, ['your top pick']),
        el('h3', { class: 'featured-title' }, [`${item.title} (${item.year})`]),
        buildMatchMeter(item, 'lg'),
        ...(chips ? [chips] : []),
        el('p', { class: 'featured-overview' }, [item.overview ? truncate(item.overview, 220) : 'No synopsis available.']),
        el('ul', { class: 'result-reasons', 'data-reasons': keyOf(item) }, item.reasons.map((r) => el('li', {}, [r]))),
        el('div', { class: 'featured-actions' }, [openBtn, buildWatchlistInline(item), buildCompareButton(item, compareFull)]),
      ]),
    ]);

    // Artwork ambience: a confined halo from the poster's own colours. Skipped
    // entirely when the setting is Off; on any failure the halo simply uses
    // the palette's own accents (see effects.css), so nothing can break here.
    if (document.documentElement.getAttribute('data-ambience') !== 'off') {
      void extractArtworkPalette(keyOf(item), posterUrl(item.posterPath, 'md')).then((pal) => {
        if (cancelled || !featuredEl.isConnected) return;
        if (pal) {
          featuredEl.style.setProperty('--art-1', pal[0]);
          featuredEl.style.setProperty('--art-2', pal[1]);
        }
        featuredEl.dataset.art = pal ? 'extracted' : 'fallback';
      });
    }
    return featuredEl;
  }

  function buildWatchlistInline(item: ScoredItem): HTMLElement {
    const label = () => (isInWatchlist(item) ? '\u2713 In watchlist' : '+ Watchlist');
    const btn = el('button', { class: 'btn btn-ghost', type: 'button', 'aria-pressed': isInWatchlist(item) ? 'true' : 'false' }, [label()]);
    btn.addEventListener('click', () => {
      const saved = toggleWatchlist(item);
      btn.textContent = label();
      btn.setAttribute('aria-pressed', saved ? 'true' : 'false');
      showToast(saved ? `Saved \u201c${item.title}\u201d to your watchlist` : `Removed \u201c${item.title}\u201d from your watchlist`);
    });
    return btn;
  }

  // ── Detail sheet — "check the info before watching" ─────────────────
  function openDetailModal(item: ScoredItem, trigger?: HTMLElement) {
    const backdropSrc = backdropUrl(item.backdropPath) ?? posterUrl(item.posterPath, 'xl');

    const ratingParts: { svg: string; label: string }[] = [{ svg: ICON.starFilled, label: `${item.voteAverage.toFixed(1)}/10 TMDB (${item.voteCount.toLocaleString()})` }];
    if (item.externalRatings?.rottenTomatoes !== undefined) ratingParts.push({ svg: ICON.tomato, label: `${item.externalRatings.rottenTomatoes}%` });
    if (item.externalRatings?.metacritic !== undefined) ratingParts.push({ svg: ICON.metacritic, label: `${item.externalRatings.metacritic}` });
    if (item.externalRatings?.imdbRating !== undefined) ratingParts.push({ svg: ICON.starFilled, label: `IMDb ${item.externalRatings.imdbRating}` });

    const titleId = `modal-title-${item.tmdbType}-${item.id}`;
    const overlay = el('div', { class: 'modal-overlay' });
    const closeBtn = el('button', { class: 'modal-close', type: 'button', 'aria-label': 'Close details' });
    closeBtn.innerHTML = ICON.close;

    const hero = el('div', { class: 'modal-hero' }, [
      buildPosterImage({ src: backdropSrc, alt: '', fallbackText: item.title.slice(0, 1), eager: true }),
    ]);

    const providersHost = el('div', { class: 'modal-providers' });
    mountProviders(providersHost, item.id, item.tmdbType);

    // Cast & crew — click a name to jump to that person on the search screen.
    const creditsHost = el('div', { class: 'modal-credits' });
    let modalClosed = false;
    void getCredits(item.id, item.tmdbType)
      .then((credits) => {
        if (modalClosed) return;
        const block = buildCreditsBlock(credits, (personId) => {
          close();
          store.openInSearch({ kind: 'person', id: personId });
        });
        if (block) creditsHost.replaceChildren(block);
      })
      .catch(() => {});

    const chips = buildReasonChips(item);
    const modal = el('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, [
      closeBtn,
      hero,
      el('div', { class: 'modal-body' }, [
        buildMatchMeter(item, 'lg'),
        el('h2', { id: titleId }, [`${item.title} (${item.year})`]),
        el('p', { class: 'modal-meta' }, [[item.type === 'movie' ? 'Movie' : 'Series', ...item.genres, ...item.vibe].join(' · ')]),
        ...(chips ? [chips] : []),
        (() => {
          const p = el('p', { class: 'modal-ratings' });
          p.innerHTML = ratingsRow(ratingParts, 13);
          return p;
        })(),
        el('p', { class: 'modal-overview' }, [item.overview || 'No synopsis available.']),
        el('div', { class: 'why-box' }, [
          el('h4', {}, ['Why this recommendation?']),
          el('ul', {}, item.reasons.map((r) => el('li', {}, [r]))),
        ]),
        creditsHost,
        providersHost,
        el('div', { class: 'modal-actions' }, [
          el('a', { class: 'btn btn-ghost', href: tmdbDetailsUrl(item.id, item.tmdbType), target: '_blank', rel: 'noopener' }, ['View trailer & full details ↗']),
          el(
            'button',
            {
              class: `btn btn-ghost modal-watchlist-btn${isInWatchlist(item) ? ' active' : ''}`,
              type: 'button',
              onclick: (e: Event) => {
                const btn = e.currentTarget as HTMLButtonElement;
                const nowSaved = toggleWatchlist(item);
                btn.classList.toggle('active', nowSaved);
                btn.textContent = nowSaved ? '✓ In watchlist' : '+ Watchlist';
                showToast(nowSaved ? `Saved \u201c${item.title}\u201d to your watchlist` : `Removed \u201c${item.title}\u201d from your watchlist`);
              },
            },
            [isInWatchlist(item) ? '✓ In watchlist' : '+ Watchlist']
          ),
        ]),
        el('p', { class: 'modal-rate-label' }, ['Rate it, or rate it after you watch — either sharpens your picks:']),
        buildStarRow(item, resultRatings.get(keyOf(item)) ?? historyRatingFor(item), (v) => {
          onRateResult(item, v);
          close();
        }),
      ]),
    ]);

    overlay.appendChild(modal);

    let release: () => void = () => {};
    const show = () => {
      if (modalClosed) return; // closed (or screen left) before a transition callback ran
      document.body.appendChild(overlay);
      document.body.style.overflow = 'hidden';
      release = trapFocus(modal, { initialFocus: closeBtn, onEscape: close });
    };
    // Shared-element transition: the clicked poster morphs into the sheet's
    // hero. Progressive enhancement only — unsupported browsers, Motion: Off,
    // or a transition already in flight all take the plain path above.
    const source = trigger?.closest<HTMLElement>('.result-card, .featured')?.querySelector<HTMLElement>('.result-poster, .featured-poster') ?? null;
    const doc = document as Document & { startViewTransition?: (cb: () => void) => { finished: Promise<unknown> } };
    if (source && !posterTransitionActive && typeof doc.startViewTransition === 'function' && document.documentElement.getAttribute('data-motion') !== 'off' && !document.hidden) {
      posterTransitionActive = true;
      source.style.viewTransitionName = 'poster-hero';
      try {
        const t = doc.startViewTransition(() => {
          source.style.viewTransitionName = '';
          hero.style.viewTransitionName = 'poster-hero';
          show();
        });
        void t.finished.catch(() => {}).finally(() => {
          posterTransitionActive = false;
          hero.style.viewTransitionName = '';
          source.style.viewTransitionName = '';
        });
      } catch {
        posterTransitionActive = false;
        source.style.viewTransitionName = '';
        show();
      }
    } else {
      show();
    }

    closeOpenModal = close;

    function close() {
      if (modalClosed) return;
      modalClosed = true;
      if (closeOpenModal === close) closeOpenModal = null;
      providersHost.dispatchEvent(new Event('providers-unmount'));
      overlay.remove();
      document.body.style.overflow = '';
      release();
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    closeBtn.addEventListener('click', close);
  }

  function restart() {
    store.reset();
    store.setScreen('landing');
  }

  return () => {
    cancelled = true;
    aiRun++;
    unsubscribeLlm();
    unsubscribeAiMode();
    if (rateTimer !== null) window.clearTimeout(rateTimer);
    // An open detail sheet lives on <body>, outside the screen: close it so
    // it can't outlive the screen and leave scrolling locked.
    closeOpenModal?.();
    closeCompare?.();
    compareTray.destroy();
    compareTray.node.remove();
    clearCompare(true);
  };
}
