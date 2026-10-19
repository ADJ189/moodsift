// Default font pairing is self-hosted and bundled (no third-party font
// request on first paint). Other presets load on demand — see lib/fonts.ts.
import '@fontsource-variable/sora/wght.css';
import '@fontsource-variable/inter/wght.css';
import './styles/global.css';
import './styles/palettes.css';
import './styles/primitives.css';
import './styles/header.css';
import './styles/landing.css';
import './styles/landing-carousel.css';
import './styles/quiz.css';
import './styles/rating.css';
import './styles/results.css';
import './styles/modal.css';
import './styles/search.css';
import './styles/credits.css';
import './styles/settings.css';
import './styles/effects.css';

import { renderLanding } from './screens/landing';
import { store } from './lib/store';
import { initTheme } from './lib/theme';
import { effectiveMotion } from './lib/appearance';
import { initShortcuts } from './lib/command-palette';
import { initPointerFx } from './lib/fx';
import { renderHeader } from './lib/header';
import { el, mount } from './lib/dom';
import { safeGet, safeSet } from './lib/storage';
import type { Screen } from './lib/types';

initTheme();
initShortcuts();
initPointerFx();

const appRoot = document.getElementById('app');
if (!appRoot) throw new Error('#app root element missing from index.html');

appRoot.appendChild(renderHeader());
const app = createScreenHost(appRoot);

function createScreenHost(root: HTMLElement): HTMLElement {
  const host = document.createElement('div');
  host.className = 'screen-host';
  root.appendChild(host);
  return host;
}

type Renderer = (root: HTMLElement) => () => void;

// Landing is the only screen every visit actually needs — it's rendered
// eagerly. Everything reachable *from* landing (quiz, rating, results,
// search) is a separate chunk, fetched only once the person actually
// navigates there. This matters more now than it used to: the search
// screen alone pulls in TMDB similarity/watch-provider logic that a
// landing-only bounce (a real, common case — someone previews the app
// and leaves) would otherwise pay for and never use.
const eagerRenderers: Partial<Record<Screen, Renderer>> = { landing: renderLanding };
const lazyLoaders: Partial<Record<Screen, () => Promise<Renderer>>> = {
  quiz: () => import('./screens/quiz').then((m) => m.renderQuiz),
  rating: () => import('./screens/rating').then((m) => m.renderRating),
  results: () => import('./screens/results').then((m) => m.renderResults),
  search: () => import('./screens/search').then((m) => m.renderSearch),
};

let currentCleanup: (() => void) | null = null;
let currentScreen: Screen | null = null;
// Guards against a rapid double-navigation resolving out of order — e.g.
// tapping quiz then immediately back to landing before quiz's chunk has
// finished loading; without this the quiz screen could still render
// itself onto the host after landing already took over.
let navToken = 0;

/** Runs a screen swap inside a View Transition where the browser supports
 * it (and motion isn't Off); otherwise just swaps. The callback must be
 * safe to run late — it re-checks the navigation token itself — and a
 * failed or skipped transition can never leave the old screen in place. */
function swap(update: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (typeof doc.startViewTransition === 'function' && effectiveMotion() !== 'off' && !document.hidden) {
    try {
      doc.startViewTransition(update);
      return;
    } catch {
      /* fall through to a plain swap */
    }
  }
  update();
}

/** Scroll and focus handoff for a *new* screen: start at the top, and put
 * keyboard / screen-reader focus on the screen's heading. */
function arrive(initial: boolean) {
  window.scrollTo(0, 0);
  if (initial) return;
  const heading = app.querySelector<HTMLElement>('h1, h2');
  if (heading) {
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }
}

let firstScreen = true;

store.subscribe((state) => {
  if (state.screen === currentScreen) return;
  const token = ++navToken;
  currentCleanup?.();
  currentCleanup = null;
  currentScreen = state.screen;
  // Any navigation supersedes an in-flight lazy load, so the loading dim
  // must be cleared here — not only when a lazy chunk resolves. (Going
  // back to the eager landing screen mid-load used to leave it stuck.)
  app.classList.remove('screen-loading');

  const initial = firstScreen;
  firstScreen = false;

  const eager = eagerRenderers[state.screen];
  if (eager) {
    const render = () => {
      if (token !== navToken) return;
      currentCleanup = eager(app);
      arrive(initial);
    };
    if (initial) render();
    else swap(render);
    return;
  }

  const loader = lazyLoaders[state.screen];
  if (!loader) return;
  app.classList.add('screen-loading');
  loadLazyScreen(loader, token);
});

const CHUNK_RELOAD_KEY = 'cinematch.chunk-reload';

function loadLazyScreen(loader: () => Promise<Renderer>, token: number) {
  loader()
    .then((renderer) => {
      // A chunk really loaded, so the one-shot reload guard can reset and a
      // *future* stale deploy may self-heal again. Persistent failures never
      // reach this line, so they can't loop.
      safeSet(CHUNK_RELOAD_KEY, '0');
      if (token !== navToken) return;
      app.classList.remove('screen-loading');
      swap(() => {
        if (token !== navToken) return;
        currentCleanup = renderer(app);
        arrive(false);
      });
    })
    .catch(() => {
      if (token !== navToken) return;
      // A stale chunk after a new deploy is the classic cause: the old
      // index references hashed files that no longer exist. One automatic
      // reload (guarded so it can never loop) picks up the new build.
      if (safeGet(CHUNK_RELOAD_KEY) !== '1' && safeSet(CHUNK_RELOAD_KEY, '1')) {
        window.location.reload();
        return;
      }
      app.classList.remove('screen-loading');
      mount(
        app,
        el('div', { class: 'screen' }, [
          el('div', { class: 'state-message', role: 'alert' }, [
            el('h2', {}, ['This screen didn\u2019t load']),
            el('p', {}, ['Your connection may have dropped, or a new version was just published. Your answers are safe.']),
            el('div', { class: 'state-message-actions' }, [
              el(
                'button',
                {
                  class: 'btn btn-primary',
                  onclick: () => {
                    app.classList.add('screen-loading');
                    loadLazyScreen(loader, token);
                  },
                },
                ['Try again']
              ),
              el('button', { class: 'btn btn-ghost', onclick: () => window.location.reload() }, ['Reload the app']),
            ]),
          ]),
        ])
      );
    });
}

dismissBootLoader();

function dismissBootLoader() {
  const loader = document.getElementById('boot-loader');
  if (!loader) return;
  // rAF so the first screen's own paint has actually happened before we
  // start fading the loader out — avoids a one-frame flash of bare page.
  requestAnimationFrame(() => {
    loader.classList.add('hidden');
    setTimeout(() => loader.remove(), 320);
  });
}
