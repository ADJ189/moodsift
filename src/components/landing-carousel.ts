// src/components/landing-carousel.ts
//
// The landing page's popular-titles gallery: a centre-focused poster deck
// that tracks the pointer directly while dragging, then settles with a small
// spring. Web-native (Pointer Events + CSS transforms) — no animation
// library, no always-running loop.
//
// These are *popular* titles, not recommendations: nothing here is scored
// against anyone's taste, and the UI says so.
//
// Lifecycle: `createLandingCarousel()` returns the element immediately (a
// skeleton, so the hero never waits on TMDB and nothing shifts later) and
// starts one cancellable request. `destroy()` is idempotent and releases
// everything: the request, the autoplay timeout, the drag frame, every
// listener and observer, and any held pointer capture.

import { buildPosterImage, el } from '../lib/dom';
import { ICON } from '../lib/icons';
import { store } from '../lib/store';
import { backdropUrl, getLandingShowcase, posterUrl } from '../lib/tmdb';
import type { CatalogItem } from '../lib/types';

export interface LandingCarouselOptions {
  /** Called once if the gallery can't be shown (request failed, or nothing
   * usable came back) so the caller can fall back to its static visual. Never
   * called after `destroy()`. */
  onUnavailable?: () => void;
  /** Idle auto-advance (default on). Always off for reduced motion, a single
   * item, a hidden tab, an off-screen gallery, or while the person is
   * hovering, focused, dragging or has pressed Pause. */
  autoplay?: boolean;
}

export interface LandingCarouselHandle {
  element: HTMLElement;
  destroy(): void;
}

type MotionLevel = 'full' | 'subtle' | 'off';

// ── Tunables ──────────────────────────────────────────────────────────────
const AUTOPLAY_MS = 7000;
const MANUAL_COOLDOWN_MS = 8000; // quiet period after any manual interaction
const INTENT_PX = 6; // horizontal travel before a press counts as a drag
const COMMIT_RATIO = 0.22; // of stage width
const COMMIT_VELOCITY = 0.45; // px/ms
const VELOCITY_WINDOW_MS = 100;
const SIDE_STEP = 0.58; // card-widths between adjacent card centres
const PARALLAX_RATIO = 0.85; // neighbours travel at this fraction of the dragged card
const BACKDROP_SHIFT_PX = 14; // desktop; scaled down on phones / subtle motion

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Signed shortest circular distance of slide `i` from `active` in a deck of `n`. */
function circularOffset(i: number, active: number, n: number): number {
  let d = (((i - active) % n) + n) % n;
  if (d > n / 2) d -= n;
  return d;
}

function describe(item: CatalogItem): string {
  return `${item.title}, ${item.year}, ${item.type === 'movie' ? 'movie' : 'series'}`;
}

function icon(svg: string): HTMLElement {
  const span = el('span', { class: 'lc-ico', 'aria-hidden': 'true' });
  span.innerHTML = svg; // static, trusted markup from lib/icons.ts
  return span;
}

interface DragState {
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  intent: boolean;
  /** A mostly-vertical gesture: the page scrolls, the deck ignores it. */
  abandoned: boolean;
  captured: boolean;
  samples: { x: number; t: number }[];
}

export function createLandingCarousel(options: LandingCarouselOptions = {}): LandingCarouselHandle {
  const autoplayEnabled = options.autoplay !== false;

  // ── State: one source of truth ─────────────────────────────────────────
  let items: CatalogItem[] = [];
  let slides: HTMLElement[] = [];
  let offsets: number[] = [];
  let activeIndex = 0;
  let isDragging = false;
  let isPausedByUser = false;
  let isPointerInside = false;
  let isFocusedWithin = false;
  let isVisible = typeof IntersectionObserver === 'undefined'; // else set by the observer
  let destroyed = false;
  let motion: MotionLevel = 'subtle';
  let narrow = false;
  let stageWidth = 0;
  let cardWidth = 0;
  let drag: DragState | null = null;
  let suppressClick = false;
  let suppressTimer: number | null = null;
  let rafId: number | null = null;
  let readyRaf: number | null = null;
  let autoplayTimer: number | null = null;
  let lastInteraction = -Infinity;
  let backdropToken = 0;
  let backdropFront = 0;

  const requestController = new AbortController();
  const life = new AbortController(); // aborts every listener registered with { signal }
  const signal = life.signal;
  const warmed = new Set<string>();

  // ── DOM ────────────────────────────────────────────────────────────────
  const hint = el('span', { class: 'lc-hint' }, ['Drag, swipe or use \u2190 \u2192']);
  const stage = el('div', { class: 'lc-stage' });
  const bdLayers = [0, 1].map(() => el('img', { class: 'lc-bd', alt: '', decoding: 'async' }));
  const atmos = el('div', { class: 'lc-atmos', 'aria-hidden': 'true' }, bdLayers);
  const meta = el('div', { class: 'lc-meta' });
  const controls = el('div', { class: 'lc-controls' });
  const status = el('div', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const pauseBtn = el('button', { class: 'lc-pause', type: 'button', hidden: true });

  const root = el(
    'div',
    {
      class: 'lc reveal',
      style: '--reveal: 3',
      role: 'region',
      'aria-roledescription': 'carousel',
      'aria-label': 'Popular film and series gallery',
      'aria-busy': 'true',
    },
    [
      el('div', { class: 'lc-head' }, [
        el('p', { class: 'lc-eyebrow' }, ['Popular picks']),
        el('p', { class: 'lc-note' }, ['Not personalised']),
        hint,
      ]),
      el('div', { class: 'lc-stage-wrap' }, [atmos, stage]),
      meta,
      controls,
      pauseBtn,
      status,
    ]
  );

  // Skeleton: same footprint as the loaded gallery, so nothing moves later.
  stage.appendChild(
    el('div', { class: 'lc-skel', 'aria-hidden': 'true' }, [
      el('div', { class: 'lc-skel-card lc-skel-l skeleton' }),
      el('div', { class: 'lc-skel-card lc-skel-r skeleton' }),
      el('div', { class: 'lc-skel-card lc-skel-c skeleton' }),
    ])
  );
  meta.appendChild(
    el('div', { class: 'lc-meta-skel', 'aria-hidden': 'true' }, [
      el('span', { class: 'skeleton lc-skel-bar lc-skel-bar-a' }),
      el('span', { class: 'skeleton lc-skel-bar lc-skel-bar-b' }),
    ])
  );

  // ── Motion preference ─────────────────────────────────────────────────
  let reduceMq: MediaQueryList | null = null;
  let narrowMq: MediaQueryList | null = null;
  try {
    reduceMq = window.matchMedia('(prefers-reduced-motion: reduce)');
    narrowMq = window.matchMedia('(max-width: 520px)');
  } catch {
    /* matchMedia unavailable — defaults stand */
  }

  /** The site's effective profile (written to <html data-motion> by
   * appearance.ts) *and* the OS preference: either asking for less wins. */
  function readMotion(): MotionLevel {
    const site = document.documentElement.getAttribute('data-motion');
    if (site === 'off' || reduceMq?.matches) return 'off';
    return site === 'full' ? 'full' : 'subtle';
  }

  function applyMotion() {
    motion = readMotion();
    narrow = narrowMq?.matches ?? false;
    root.dataset.lcMotion = motion;
    pauseBtn.hidden = !(autoplayEnabled && items.length > 1 && motion !== 'off');
    if (slides.length) layout(0);
    refreshAutoplay();
  }

  // ── Layout: rest + drag positions from one function ───────────────────
  /** Places every slide. `dragSteps` is the live drag distance in card steps
   * (negative = dragging toward the next title). Only transform / opacity /
   * z-index and two custom properties are written; nothing is measured. */
  function layout(dragSteps: number) {
    const amp = motion === 'off' ? 0 : motion === 'subtle' ? 0.6 : 1;
    const tiltAmp = amp * (narrow ? 0.6 : 1);
    const parAmp = amp * (narrow ? 0.6 : 1);
    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i]!;
      const d = offsets[i]!;
      // The dragged card follows the pointer 1:1; the rest lag a little,
      // which is what reads as depth.
      const p = d + (d === 0 ? dragSteps : dragSteps * PARALLAX_RATIO);
      const a = Math.abs(p);
      const sign = Math.sign(p);
      const near = Math.min(a, 1);
      const mid = clamp(a - 1, 0, 1);
      const far = clamp(a - 2, 0, 1);
      const x = sign * (58 * near + 30 * mid + 12 * far); // % of card width
      const y = 8 * near + 6 * mid;
      const scale = 1 - 0.12 * near - 0.05 * mid - 0.02 * far;
      let tilt = -sign * near * 5 * tiltAmp;
      if (d === 0) tilt = clamp(tilt, -3, 3); // the card in hand barely tilts
      const opacity = a <= 1 ? 1 - 0.22 * a : a <= 2 ? 0.78 - 0.34 * (a - 1) : Math.max(0, 0.44 - 0.44 * (a - 2));
      slide.style.transform = `translate3d(${x.toFixed(3)}%, ${y.toFixed(2)}px, 0) scale(${scale.toFixed(4)}) rotateY(${tilt.toFixed(2)}deg)`;
      slide.style.opacity = opacity.toFixed(3);
      slide.style.zIndex = String(100 - Math.round(a * 10));
      slide.style.setProperty('--par', `${(-clamp(p, -1.5, 1.5) * 2 * parAmp).toFixed(2)}px`);
    }
    const shift = BACKDROP_SHIFT_PX * (narrow ? 0.57 : 1) * (motion === 'subtle' ? 0.6 : 1) * (motion === 'off' ? 0 : 1);
    atmos.style.setProperty('--bdx', `${(-clamp(dragSteps, -1, 1) * shift).toFixed(2)}px`);
  }

  function updateRoles() {
    const n = slides.length;
    slides.forEach((slide, i) => {
      const d = circularOffset(i, activeIndex, n);
      offsets[i] = d;
      const a = Math.abs(d);
      slide.classList.toggle('is-active', d === 0);
      slide.classList.toggle('is-near', a === 1);
      slide.classList.toggle('is-far', a >= 2); // decorative: no pointer events
      if (d === 0) slide.removeAttribute('aria-hidden');
      else slide.setAttribute('aria-hidden', 'true'); // never a duplicate in the a11y tree
    });
  }

  // ── Active-item presentation (runs on index change, never per frame) ──
  let titleEl: HTMLElement;
  let lineEl: HTMLElement;
  let exploreBtn: HTMLButtonElement;
  let dots: HTMLButtonElement[] = [];

  function fadeIn(node: HTMLElement) {
    if (motion === 'off' || typeof node.animate !== 'function') return;
    node.animate(
      [
        { opacity: 0, transform: 'translateY(4px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      { duration: motion === 'subtle' ? 160 : 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
    );
  }

  function renderLine(item: CatalogItem) {
    const parts: (Node | string)[] = [
      el('span', { class: 'lc-type' }, [item.type === 'movie' ? 'Movie' : 'Series']),
      el('span', {}, [String(item.year)]),
    ];
    if (item.voteAverage > 0 && item.voteCount > 0) {
      const rating = el('span', { class: 'lc-rating' }, [icon(ICON.starFilled), item.voteAverage.toFixed(1)]);
      rating.appendChild(el('span', { class: 'visually-hidden' }, [' TMDB rating']));
      parts.push(rating);
    }
    lineEl.replaceChildren(...parts);
  }

  function updateMeta(animate: boolean) {
    const item = items[activeIndex]!;
    titleEl.textContent = item.title;
    titleEl.title = item.title;
    renderLine(item);
    exploreBtn.setAttribute('aria-label', `Explore title: ${item.title}`);
    if (animate) {
      fadeIn(titleEl);
      fadeIn(lineEl);
    }
  }

  function updatePager() {
    dots.forEach((dot, i) => {
      if (i === activeIndex) dot.setAttribute('aria-current', 'true');
      else dot.removeAttribute('aria-current');
    });
  }

  function warm(url: string | null) {
    if (!url || warmed.has(url)) return;
    warmed.add(url);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
  }

  function warmAround(index: number) {
    const n = items.length;
    for (const k of [0, 1, -1]) {
      const item = items[(((index + k) % n) + n) % n];
      if (!item) continue;
      warm(posterUrl(item.posterPath, 'md'));
      warm(backdropUrl(item.backdropPath));
    }
  }

  /** Cross-fades the ambient backdrop. The poster never waits for it: the old
   * backdrop stays up until the new one has loaded, then they swap. */
  function showBackdrop(item: CatalogItem) {
    const token = ++backdropToken;
    const url = backdropUrl(item.backdropPath) ?? posterUrl(item.posterPath, 'md');
    const front = bdLayers[backdropFront]!;
    const back = bdLayers[1 - backdropFront]!;
    if (!url) {
      front.classList.remove('is-on'); // gradient-only ambience
      delete front.dataset.src;
      return;
    }
    if (front.dataset.src === url && front.classList.contains('is-on')) return;
    back.dataset.src = url;
    back.src = url;
    const swap = () => {
      if (destroyed || token !== backdropToken) return;
      back.classList.add('is-on');
      front.classList.remove('is-on');
      backdropFront = 1 - backdropFront;
    };
    const fail = () => {
      if (destroyed || token !== backdropToken) return;
      delete back.dataset.src;
      front.classList.remove('is-on');
    };
    if (back.complete && back.naturalWidth > 0) swap();
    else {
      back.addEventListener('load', swap, { once: true, signal });
      back.addEventListener('error', fail, { once: true, signal });
    }
  }

  function announce() {
    status.textContent = `${activeIndex + 1} of ${items.length}: ${describe(items[activeIndex]!)}`;
  }

  // ── Navigation ────────────────────────────────────────────────────────
  function markInteraction() {
    lastInteraction = performance.now();
    clearAutoplay();
  }

  function setActive(next: number, source: 'manual' | 'auto' | 'drag') {
    const n = items.length;
    const target = ((next % n) + n) % n;
    if (target === activeIndex) return;
    activeIndex = target;
    // Swipe commits use the site's springy curve (little distance left to
    // cover, so the rebound is a few px); button/key/auto moves cover a full
    // step and get a gentler curve.
    root.classList.toggle('lc--swipe', source === 'drag');
    updateRoles();
    layout(0);
    updateMeta(true);
    updatePager();
    showBackdrop(items[activeIndex]!);
    warmAround(activeIndex);
    if (source !== 'auto') {
      announce();
      markInteraction();
    }
    refreshAutoplay();
  }

  const goTo = (index: number) => setActive(index, 'manual');
  const step = (dir: number) => setActive(activeIndex + dir, 'manual');

  function explore() {
    const item = items[activeIndex];
    if (!item || destroyed) return;
    store.openInSearch({ kind: 'title', id: item.id, tmdbType: item.tmdbType });
  }

  // ── Autoplay: one timeout, never an interval ──────────────────────────
  function clearAutoplay() {
    if (autoplayTimer !== null) {
      clearTimeout(autoplayTimer);
      autoplayTimer = null;
    }
  }

  function canAutoplay(): boolean {
    return (
      !destroyed &&
      autoplayEnabled &&
      items.length > 1 &&
      motion !== 'off' &&
      !isPausedByUser &&
      !isDragging &&
      !isPointerInside &&
      !isFocusedWithin &&
      !document.hidden &&
      isVisible
    );
  }

  function refreshAutoplay() {
    if (!canAutoplay()) {
      clearAutoplay();
      return;
    }
    if (autoplayTimer !== null) return;
    const wait = Math.max(AUTOPLAY_MS, lastInteraction + MANUAL_COOLDOWN_MS - performance.now());
    autoplayTimer = window.setTimeout(() => {
      autoplayTimer = null;
      if (!canAutoplay()) return;
      setActive(activeIndex + 1, 'auto');
    }, wait);
  }

  function syncPauseButton() {
    pauseBtn.replaceChildren(icon(isPausedByUser ? ICON.play : ICON.pause));
    pauseBtn.setAttribute('aria-label', isPausedByUser ? 'Resume automatic rotation' : 'Pause automatic rotation');
  }

  pauseBtn.addEventListener('click', () => {
    isPausedByUser = !isPausedByUser;
    syncPauseButton();
    markInteraction();
    refreshAutoplay();
  });
  syncPauseButton();

  // ── Gestures (Pointer Events; vertical scroll stays native) ───────────
  function dragSteps(): number {
    if (!drag || cardWidth <= 0) return 0;
    const raw = (drag.lastX - drag.startX) / (cardWidth * SIDE_STEP);
    // One slide per gesture: past a full step, resist instead of following.
    return Math.abs(raw) <= 1 ? raw : Math.sign(raw) * (1 + (Math.abs(raw) - 1) * 0.1);
  }

  function flushDrag() {
    rafId = null;
    if (drag?.intent) layout(dragSteps());
  }

  function onPointerDown(e: PointerEvent) {
    if (destroyed || items.length < 2) return;
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    // Single reads, only if the ResizeObserver hasn't reported yet.
    if (stageWidth <= 0) stageWidth = stage.clientWidth;
    if (cardWidth <= 0) cardWidth = slides[0]?.offsetWidth ?? 0;
    drag = { id: e.pointerId, startX: e.clientX, startY: e.clientY, lastX: e.clientX, intent: false, abandoned: false, captured: false, samples: [{ x: e.clientX, t: e.timeStamp }] };
  }

  function onPointerMove(e: PointerEvent) {
    const d = drag;
    if (!d || e.pointerId !== d.id || d.abandoned) return;
    d.lastX = e.clientX;
    if (!d.intent) {
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) {
        d.abandoned = true; // a vertical gesture: the page scrolls, the deck stays put
        return;
      }
      if (Math.abs(dx) < INTENT_PX || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      d.intent = true;
      isDragging = true;
      root.classList.add('is-dragging');
      clearAutoplay();
      try {
        stage.setPointerCapture(d.id);
        d.captured = true;
      } catch {
        /* capture is best-effort */
      }
    }
    d.samples.push({ x: e.clientX, t: e.timeStamp });
    while (d.samples.length > 2 && e.timeStamp - d.samples[0]!.t > VELOCITY_WINDOW_MS) d.samples.shift();
    if (rafId === null) rafId = requestAnimationFrame(flushDrag); // coalesce to one write per frame
  }

  function endDrag(commit: boolean, finalX?: number) {
    const d = drag;
    if (!d) return;
    drag = null;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    try {
      if (d.captured && stage.hasPointerCapture(d.id)) stage.releasePointerCapture(d.id);
    } catch {
      /* already released */
    }
    // A drag in any direction must not also "click" whatever is under the
    // pointer on release (a plain tap, with no travel, still does).
    if (d.intent || d.abandoned) {
      suppressClick = true;
      if (suppressTimer !== null) clearTimeout(suppressTimer);
      suppressTimer = window.setTimeout(() => {
        suppressClick = false;
        suppressTimer = null;
      }, 0);
    }
    if (!d.intent) return;

    isDragging = false;
    root.classList.remove('is-dragging');

    const dx = (finalX ?? d.lastX) - d.startX;
    const first = d.samples[0]!;
    const last = d.samples[d.samples.length - 1]!;
    const dt = last.t - first.t;
    const velocity = dt > 0 ? (last.x - first.x) / dt : 0;
    const far = Math.abs(dx) > stageWidth * COMMIT_RATIO;
    const flick = Math.abs(velocity) >= COMMIT_VELOCITY && Math.abs(dx) >= 10 && Math.sign(velocity) === Math.sign(dx);
    if (commit && (far || flick)) {
      setActive(activeIndex + (dx < 0 ? 1 : -1), 'drag');
    } else {
      root.classList.add('lc--swipe');
      layout(0); // snap back with the same spring
      markInteraction();
      refreshAutoplay();
    }
  }

  stage.addEventListener('pointerdown', onPointerDown, { signal });
  stage.addEventListener('pointermove', onPointerMove, { signal });
  // Only the pointer that started the gesture may end it (a second finger must not).
  stage.addEventListener('pointerup', (e) => e.pointerId === drag?.id && endDrag(true, e.clientX), { signal });
  stage.addEventListener('pointercancel', (e) => e.pointerId === drag?.id && endDrag(false), { signal });
  // Taking capture on the stage makes touch browsers release the finger's
  // implicit capture on the poster underneath, and that event bubbles here:
  // only the stage losing *its own* capture (revoked mid-gesture) ends a drag.
  stage.addEventListener('lostpointercapture', (e) => e.target === stage && e.pointerId === drag?.id && endDrag(false), { signal });
  stage.addEventListener('dragstart', (e) => e.preventDefault(), { signal });

  stage.addEventListener(
    'click',
    (e) => {
      if (suppressClick) {
        e.preventDefault();
        e.stopPropagation();
        suppressClick = false;
        return;
      }
      const slide = (e.target as Element | null)?.closest<HTMLElement>('.lc-slide');
      if (!slide || slide.classList.contains('is-far')) return;
      const index = Number(slide.dataset.index);
      if (index === activeIndex) explore();
      else goTo(index);
    },
    { signal }
  );

  // ── Keyboard: only while focus is inside the carousel ─────────────────
  root.addEventListener(
    'keydown',
    (e) => {
      if (items.length < 2 || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'Home') goTo(0);
      else if (e.key === 'End') goTo(items.length - 1);
      else return;
      e.preventDefault();
    },
    { signal }
  );

  // ── Pause conditions ──────────────────────────────────────────────────
  root.addEventListener(
    'pointerenter',
    (e) => {
      if (e.pointerType === 'touch') return; // touch has no hover
      isPointerInside = true;
      refreshAutoplay();
    },
    { signal }
  );
  root.addEventListener(
    'pointerleave',
    (e) => {
      if (e.pointerType === 'touch') return;
      isPointerInside = false;
      refreshAutoplay();
    },
    { signal }
  );
  root.addEventListener(
    'focusin',
    () => {
      isFocusedWithin = true;
      refreshAutoplay();
    },
    { signal }
  );
  root.addEventListener(
    'focusout',
    (e) => {
      if (e.relatedTarget instanceof Node && root.contains(e.relatedTarget)) return;
      isFocusedWithin = false;
      refreshAutoplay();
    },
    { signal }
  );
  document.addEventListener('visibilitychange', refreshAutoplay, { signal });

  let intersection: IntersectionObserver | null = null;
  if (typeof IntersectionObserver !== 'undefined') {
    intersection = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        isVisible = entry.isIntersecting && entry.intersectionRatio >= 0.35;
        refreshAutoplay();
      },
      { threshold: [0, 0.35, 0.6] }
    );
    intersection.observe(root);
  }

  let resize: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    resize = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === stage) stageWidth = entry.contentRect.width;
        else cardWidth = entry.contentRect.width;
      }
    });
    resize.observe(stage);
  }

  // Live changes: the site's Appearance → Motion setting (an attribute on
  // <html>), the OS reduced-motion toggle, and crossing the phone breakpoint.
  const motionWatch = new MutationObserver(applyMotion);
  motionWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  reduceMq?.addEventListener('change', applyMotion, { signal });
  narrowMq?.addEventListener('change', applyMotion, { signal });

  // ── Populate once the data arrives ────────────────────────────────────
  function unavailable() {
    if (destroyed) return;
    options.onUnavailable?.();
  }

  function build(list: CatalogItem[]) {
    if (destroyed) return;
    items = list.slice(0, 8);
    const n = items.length;
    if (n === 0) {
      unavailable();
      return;
    }

    slides = items.map((item, i) => {
      const art = buildPosterImage({
        src: posterUrl(item.posterPath, 'md'),
        alt: '',
        fallbackText: item.title.trim().charAt(0).toUpperCase() || '\u2022',
        eager: i === 0, // the first poster is the LCP-ish image; neighbours are warmed below
      });
      return el(
        'div',
        {
          class: 'lc-slide',
          role: 'group',
          'aria-roledescription': 'slide',
          'aria-label': `${i + 1} of ${n}: ${describe(item)}`,
          'data-index': i,
        },
        [el('div', { class: 'lc-card' }, [art, el('span', { class: 'lc-gloss', 'aria-hidden': 'true' })])]
      );
    });
    offsets = Array.from({ length: n }, () => 0);

    titleEl = el('p', { class: 'lc-title' });
    lineEl = el('p', { class: 'lc-line' });
    exploreBtn = el('button', { class: 'btn btn-ghost lc-explore', type: 'button', onclick: explore }, ['Explore title', icon(ICON.arrowUpRight)]);
    meta.replaceChildren(el('div', { class: 'lc-meta-text' }, [titleEl, lineEl]), exploreBtn);

    if (n > 1) {
      const prevBtn = el('button', { class: 'lc-nav', type: 'button', 'aria-label': 'Previous title', onclick: () => step(-1) }, [icon(ICON.chevronLeft)]);
      const nextBtn = el('button', { class: 'lc-nav', type: 'button', 'aria-label': 'Next title', onclick: () => step(1) }, [icon(ICON.chevronRight)]);
      dots = items.map((item, i) =>
        el(
          'button',
          { class: 'lc-dot', type: 'button', 'aria-label': `Show ${i + 1} of ${n}: ${item.title}`, onclick: () => goTo(i) },
          [el('span', { class: 'lc-dot-mark', 'aria-hidden': 'true' })]
        )
      );
      controls.replaceChildren(prevBtn, el('div', { class: 'lc-dots' }, dots), nextBtn);
    } else {
      controls.replaceChildren();
      hint.hidden = true;
    }

    stage.replaceChildren(...slides);
    resize?.observe(slides[0]!);
    root.classList.toggle('lc--single', n === 1);
    root.setAttribute('aria-busy', 'false');

    updateRoles();
    applyMotion(); // also lays out
    updateMeta(false);
    updatePager();
    showBackdrop(items[0]!);
    warmAround(0);

    // Transitions stay off for the very first placement, so cards don't
    // glide in from the origin.
    readyRaf = requestAnimationFrame(() => {
      readyRaf = null;
      if (!destroyed) root.classList.add('is-ready');
    });
    refreshAutoplay();
  }

  applyMotion();
  getLandingShowcase(requestController.signal).then(build, (err: unknown) => {
    if (destroyed || (err instanceof DOMException && err.name === 'AbortError')) return;
    unavailable();
  });

  return {
    element: root,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      requestController.abort();
      life.abort(); // every { signal } listener
      clearAutoplay();
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (readyRaf !== null) cancelAnimationFrame(readyRaf);
      if (suppressTimer !== null) clearTimeout(suppressTimer);
      rafId = readyRaf = suppressTimer = null;
      try {
        if (drag?.captured && stage.hasPointerCapture(drag.id)) stage.releasePointerCapture(drag.id);
      } catch {
        /* already released */
      }
      drag = null;
      intersection?.disconnect();
      resize?.disconnect();
      motionWatch.disconnect();
    },
  };
}
