import { createLandingCarousel, type LandingCarouselHandle } from '../components/landing-carousel';
import { applyVibe, markVibeHandled, vibeAlreadyHandled, VIBES } from '../lib/appearance';
import { el, mount } from '../lib/dom';
import { openAppearancePanel } from '../lib/settings-panel';
import { getProfile, getStats } from '../lib/profile';
import { store } from '../lib/store';
import { isTmdbConfigured } from '../lib/tmdb';

/** The hero's "product as the artwork" panel: a sample recommendation card
 * drawn with CSS only (no studio posters, no network), labelled as a sample
 * so it never reads as a real recommendation. */
function buildSampleCard(): HTMLElement {
  return el('div', { class: 'hero-visual', 'aria-hidden': 'true' }, [
    el('div', { class: 'hero-poster hero-poster-back' }),
    el('div', { class: 'hero-poster hero-poster-mid' }),
    el('div', { class: 'hero-sample' }, [
      el('div', { class: 'hero-sample-art' }, [el('span', { class: 'hero-sample-badge' }, ['94% match'])]),
      el('div', { class: 'hero-sample-body' }, [
        el('p', { class: 'hero-sample-label' }, ['Sample match']),
        el('div', { class: 'hero-sample-meter' }, [el('i')]),
        el('ul', { class: 'chip-row' }, [el('li', { class: 'chip' }, ['thriller']), el('li', { class: 'chip' }, ['dark']), el('li', { class: 'chip' }, ['2016+'])]),
        el('p', { class: 'hero-sample-reason' }, ['Matches your thriller pick \u00b7 Has that dark vibe']),
      ]),
    ]),
  ]);
}

export function renderLanding(root: HTMLElement): () => void {
  let destroyed = false;
  let ambient: { destroy(): void } | null = null;
  let carousel: LandingCarouselHandle | null = null;

  const canvas = el('canvas', { class: 'landing-canvas', 'aria-hidden': 'true' });

  const warning = isTmdbConfigured
    ? null
    : el('p', { class: 'config-warning', role: 'status' }, [
        'Live recommendations are switched off: this build has no TMDB API key. ',
        'Add one (see the README) to get results.',
      ]);

  const stats = getStats();
  const returning = stats.ratedCount > 0;
  const welcomeBack = returning
    ? (() => {
        const p = getProfile();
        return el('p', { class: 'welcome-back reveal', style: '--reveal: 3' }, [
          el('span', { class: 'avatar-circle', style: `background:${p.avatarColor}` }, [p.avatarEmoji ?? p.displayName.charAt(0).toUpperCase()]),
          el('span', {}, [
            el('strong', {}, [`Welcome back, ${p.displayName}`]),
            ` \u00b7 ${stats.ratedCount} title${stats.ratedCount === 1 ? '' : 's'} rated here so far. New picks build on all of it.`,
          ]),
        ]);
      })()
    : null;

  // One-time, skippable "Choose your vibe". It only sets ordinary
  // appearance options and never sits in front of the primary action.
  let vibeCard: HTMLElement | null = null;
  if (!vibeAlreadyHandled()) {
    const dismiss = (permanent: boolean) => {
      if (permanent) markVibeHandled('skipped');
      vibeCard?.remove();
    };
    vibeCard = el('section', { class: 'vibe-card reveal', style: '--reveal: 5', 'aria-label': 'Choose your look' }, [
      el('div', { class: 'vibe-card-head' }, [
        el('strong', {}, ['Choose your vibe']),
        el('span', {}, ['Optional \u2014 change it any time from Appearance.']),
      ]),
      el(
        'div',
        { class: 'vibe-row' },
        VIBES.map((v) =>
          el(
            'button',
            {
              class: 'chip chip-btn',
              type: 'button',
              title: v.blurb,
              onclick: () => {
                applyVibe(v.id);
                vibeCard?.remove();
              },
            },
            [v.label]
          )
        )
      ),
      el('div', { class: 'vibe-card-actions' }, [
        el('button', { class: 'btn-text', type: 'button', onclick: () => dismiss(true) }, ['Skip']),
        el('button', { class: 'btn-text', type: 'button', onclick: () => dismiss(false) }, ['Not now']),
        el('button', { class: 'btn-text', type: 'button', onclick: () => openAppearancePanel('theme') }, ['More options\u2026']),
      ]),
    ]);
  }

  // The hero's visual slot. With a TMDB key it is the live popular-titles
  // gallery (a skeleton at once; the headline and CTA never wait on it). With
  // no key — or if the optional request fails or returns nothing usable — it
  // is the static sample card, exactly as before.
  let visual: HTMLElement;
  if (isTmdbConfigured) {
    carousel = createLandingCarousel({
      onUnavailable: () => {
        if (destroyed || !carousel) return;
        const failed = carousel;
        carousel = null;
        // The skeleton is taller than the sample card. In the two-column
        // layout the copy is vertically centred against it, so swapping would
        // make the headline and CTA jump; hold the height so they don't. (In
        // the stacked layout nothing above the gallery moves.)
        const grid = failed.element.parentElement;
        if (grid && window.matchMedia('(min-width: 861px)').matches) grid.style.minHeight = `${grid.offsetHeight}px`;
        failed.element.replaceWith(buildSampleCard());
        failed.destroy();
      },
    });
    visual = carousel.element;
  } else {
    visual = buildSampleCard();
  }

  const screen = el('div', { class: 'screen landing' }, [
    canvas,
    el('div', { class: 'landing-grid' }, [
      el('div', { class: 'landing-content' }, [
        el('span', { class: 'eyebrow reveal', style: '--reveal: 0' }, ['No account \u00b7 your profile stays on this device']),
        el('h1', { class: 'landing-title reveal', style: '--reveal: 1', tabindex: '-1' }, ['Find something you\u2019ll actually like']),
        el('p', { class: 'landing-sub reveal', style: '--reveal: 2' }, [
          'Seven quick questions, a few titles you already know, and a live pull from thousands of movies and shows \u2014 matched to you, not to what everyone else is watching.',
        ]),
        ...(welcomeBack ? [welcomeBack] : []),
        el('div', { class: 'landing-actions reveal', style: '--reveal: 4' }, [
          el('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: () => store.setScreen('quiz') }, [
            returning ? 'Get fresh picks' : 'Find my next watch',
            ' \u2192',
          ]),
          el('button', { class: 'btn btn-quiet', type: 'button', onclick: () => store.setScreen('search') }, ['Search a title you love']),
        ]),
        el('p', { class: 'landing-trust reveal', style: '--reveal: 4' }, ['7 questions \u00b7 about a minute \u00b7 no account required']),
        ...(vibeCard ? [vibeCard] : []),
        ...(warning ? [warning] : []),
      ]),
      visual,
    ]),
  ]);

  mount(root, screen);

  // The particle field is a progressive enhancement: the hero is fully
  // readable without it, and the module is only fetched on this screen.
  // `destroyed` closes the race where the person leaves before the import
  // resolves — without it the loop would start after cleanup and run forever.
  requestAnimationFrame(() => {
    if (destroyed) return;
    void import('../lib/ambient')
      .then(({ AmbientField }) => {
        if (destroyed) return;
        ambient = new AmbientField(canvas);
      })
      .catch(() => {
        /* decorative only */
      });
  });

  return () => {
    destroyed = true;
    carousel?.destroy();
    carousel = null;
    ambient?.destroy();
    ambient = null;
  };
}
