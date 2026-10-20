import type { Page, Route } from '@playwright/test';
import { expect, test } from './fixtures';

// The landing gallery, against mocked TMDB (deterministic titles) and mocked
// poster art. Movie popularity is 500-10·id and TV 495-10·id, so the deck
// order is always: Movie 1, Show 1, Movie 2, Show 2, … (8 items).

const raw = (id: number, tv: boolean) => ({
  id,
  overview: 'Fixture overview.',
  genre_ids: [53, 18],
  original_language: 'en',
  vote_average: 7.5,
  vote_count: 2000,
  popularity: (tv ? 495 : 500) - id * 10,
  poster_path: `/p${tv ? 't' : 'm'}${id}.jpg`,
  backdrop_path: `/b${tv ? 't' : 'm'}${id}.jpg`,
  ...(tv ? { name: `Show ${id}`, first_air_date: `${2000 + id}-05-01` } : { title: `Movie ${id}`, release_date: `${2000 + id}-05-01` }),
});

const poster = (label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="342" height="513"><rect width="342" height="513" fill="#5b3fd0"/><text x="20" y="460" font-size="32" fill="#fff">${label}</text></svg>`;

interface ShowcaseOptions {
  movies?: number;
  shows?: number;
  status?: number;
  failImages?: boolean;
  /** Hold the discover responses until released (to observe the loading state / cancellation). */
  gate?: Promise<void>;
}

async function mockShowcase(page: Page, opts: ShowcaseOptions = {}): Promise<{ discover: string[] }> {
  const seen = { discover: [] as string[] };
  await page.route('**/api.themoviedb.org/3/discover/**', async (route: Route) => {
    seen.discover.push(new URL(route.request().url()).pathname);
    if (opts.gate) await opts.gate;
    const tv = route.request().url().includes('/discover/tv');
    const count = tv ? (opts.shows ?? 10) : (opts.movies ?? 10);
    try {
      if (opts.status && opts.status !== 200) return await route.fulfill({ status: opts.status, body: 'fixture failure' });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ page: 1, results: Array.from({ length: count }, (_, i) => raw(i + 1, tv)) }),
      });
    } catch {
      /* the page navigated away and aborted the request — expected in the cancellation test */
    }
  });
  await page.route('**/image.tmdb.org/**', (route) => {
    if (opts.failImages) return route.fulfill({ status: 404 });
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: poster('poster') });
  });
  return seen;
}

const title = (page: Page) => page.locator('.lc-title');

/** A fake clock that starts *paused*: only `runFor` moves time, so autoplay
 * timing is exact however slow the machine is (a free-running fake clock
 * drifts ahead between steps). Rendering and network are unaffected. */
async function pausedClock(page: Page) {
  // The hero's particle canvas is a rAF loop; replaying thousands of fake
  // frames per `runFor` is just wasted work here, so switch it off.
  await page.addInitScript(() => localStorage.setItem('cinematch-appearance:v1', JSON.stringify({ version: 1, particles: 'off' })));
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
}
/** Title assertion for the paused-clock tests: reads the text directly (an
 * action, not the injected auto-retry), so it never depends on the fake clock. */
const expectTitle = (page: Page, text: string) => expect.poll(() => title(page).textContent()).toBe(text);
/** Waits for the gallery, then pauses auto-advance so tests that run on the
 * real clock can't race the 7 s timer on a slow machine. (Autoplay itself is
 * covered by the paused-clock tests, which don't use this helper.) */
const ready = async (page: Page) => {
  await page.locator('.lc.is-ready .lc-slide').first().waitFor();
  const pause = page.locator('.lc-pause');
  if (await pause.isVisible()) await pause.click();
};

/** Synthetic pointer gesture on the stage. `gapMs` spaces the moves so the
 * release velocity is controlled (slow ≈ 0.1 px/ms, flick ≈ 1 px/ms). */
async function gesture(page: Page, o: { dx?: number; dxFraction?: number; dy?: number; steps?: number; gapMs: number; end?: 'up' | 'cancel' }) {
  await page.evaluate(async ({ dx, dxFraction, dy, steps, gapMs, end }) => {
    const stage = document.querySelector('.lc-stage') as HTMLElement;
    const r = stage.getBoundingClientRect();
    const x0 = r.x + r.width / 2;
    const y0 = r.y + r.height / 2;
    const totalX = dx ?? (dxFraction ?? 0) * r.width;
    const mk = (type: string, x: number, y: number) =>
      new PointerEvent(type, { pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, bubbles: true, cancelable: true });
    stage.dispatchEvent(mk('pointerdown', x0, y0));
    for (let i = 1; i <= steps; i++) {
      await new Promise((res) => setTimeout(res, gapMs));
      stage.dispatchEvent(mk('pointermove', x0 + (totalX * i) / steps, y0 + (dy * i) / steps));
    }
    stage.dispatchEvent(mk(end === 'cancel' ? 'pointercancel' : 'pointerup', x0 + totalX, y0 + dy));
  }, { dx: o.dx, dxFraction: o.dxFraction, dy: o.dy ?? 0, steps: o.steps ?? 6, gapMs: o.gapMs, end: o.end ?? 'up' });
}

test.describe('landing gallery — data and loading', () => {
  test('shows real titles, makes exactly two discover requests, and never blocks the hero', async ({ page, mock }) => {
    void mock;
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const seen = await mockShowcase(page, { gate });
    await page.goto('/');

    // While TMDB is still pending: skeleton visible, headline + CTA already usable.
    await expect(page.locator('.lc-skel')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: /find my next watch/i })).toBeEnabled();
    const skeletonBox = await page.locator('.lc').boundingBox();

    release();
    await ready(page);
    await expect(page.locator('.lc-slide')).toHaveCount(8);
    await expect(title(page)).toHaveText('Movie 1');
    await expect(page.locator('.lc-line')).toContainText('Movie');
    await expect(page.locator('.lc-line')).toContainText('2001');
    await expect(page.locator('.lc')).toHaveAttribute('aria-busy', 'false');
    // The reserved footprint is the real footprint: no layout shift on load.
    const loadedBox = await page.locator('.lc').boundingBox();
    expect(Math.abs((loadedBox?.height ?? 0) - (skeletonBox?.height ?? 0))).toBeLessThanOrEqual(1);
    // One movie request + one TV request — not the multi-page recommendation pipeline.
    expect(seen.discover.sort()).toEqual(['/3/discover/movie', '/3/discover/tv']);
    // Honest labelling: popular, not personalised, and no invented match score.
    await expect(page.locator('.lc')).toContainText('Popular picks');
    await expect(page.locator('.lc')).toContainText('Not personalised');
    await expect(page.locator('.lc')).not.toContainText('% match');
  });

  test('alternates movies and series and uses the poster art', async ({ page, mock }) => {
    void mock;
    await mockShowcase(page);
    await page.goto('/');
    await ready(page);
    const labels = await page.locator('.lc-slide').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    expect(labels[0]).toBe('1 of 8: Movie 1, 2001, movie');
    expect(labels[1]).toBe('2 of 8: Show 1, 2001, series');
    expect(labels.filter((l) => l?.endsWith('movie'))).toHaveLength(4);
    await expect(page.locator('.lc-slide.is-active img.poster-img')).toHaveAttribute('src', /image\.tmdb\.org\/t\/p\/w342\/pm1\.jpg/);
  });

  for (const [label, opts] of [
    ['an API failure', { status: 500 }],
    ['an empty response', { movies: 0, shows: 0 }],
  ] as const) {
    test(`falls back to the sample visual on ${label}`, async ({ page, mock }) => {
      void mock;
      await mockShowcase(page, opts);
      await page.goto('/');
      await expect(page.locator('.hero-visual')).toBeAttached();
      await expect(page.locator('.lc')).toHaveCount(0);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.getByRole('button', { name: /find my next watch/i }).click();
      await expect(page.locator('.quiz-option').first()).toBeVisible();
    });
  }

  test('falling back to the sample card does not move the headline or CTA', async ({ page, mock, viewport }) => {
    test.skip((viewport?.width ?? 0) <= 860, 'the copy is only centred against the visual in the two-column layout');
    void mock;
    // A returning visitor: no "Choose your vibe" card, so the copy column is
    // shorter than the gallery and is centred against it (that's when a swap would shift it).
    await page.addInitScript(() => localStorage.setItem('cinematch-vibe:v1', 'skipped'));
    await page.setViewportSize({ width: 1280, height: 720 }); // the shift is viewport-dependent; 720 tall reproduces it
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    await mockShowcase(page, { status: 500, gate });
    await page.goto('/');
    await expect(page.locator('.lc-skel')).toBeVisible();
    const cta = page.getByRole('button', { name: /find my next watch/i });
    await page.waitForTimeout(1500); // let the hero's entrance animation finish; we want layout movement only
    const before = (await cta.boundingBox())!;
    release();
    await expect(page.locator('.lc')).toHaveCount(0);
    await page.waitForTimeout(400);
    const after = (await cta.boundingBox())!;
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1);
  });

  test('a single title renders a static card with no dead controls', async ({ page, mock }) => {
    void mock;
    await mockShowcase(page, { movies: 1, shows: 0 });
    await page.goto('/');
    await ready(page);
    await expect(page.locator('.lc-slide')).toHaveCount(1);
    await expect(page.locator('.lc-nav')).toHaveCount(0);
    await expect(page.locator('.lc-dot')).toHaveCount(0);
    await expect(page.locator('.lc-pause')).toBeHidden();
    await expect(title(page)).toHaveText('Movie 1');
    await page.locator('.lc-slide.is-active').click();
    await expect(page.locator('.search-screen')).toBeVisible();
  });

  test('a missing poster image falls back per slide, with no broken image', async ({ page, mock }) => {
    void mock;
    await mockShowcase(page, { failImages: true });
    await page.goto('/');
    await ready(page);
    await expect(page.locator('.lc-slide.is-active .poster-fallback')).toHaveText('M');
    await expect(page.locator('.lc-slide.is-active img.poster-img')).toHaveCount(0);
    await expect(title(page)).toHaveText('Movie 1'); // the title is DOM text, never only artwork
  });
});

test.describe('landing gallery — no TMDB credential', () => {
  test.use({ baseURL: 'http://localhost:4322' });

  test('shows the static sample, makes no TMDB request, keeps the warning', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (r) => {
      // Compare the parsed hostname, not a substring of the URL, so a host like
      // evil-themoviedb.org.example.com can neither match nor hide a request.
      const host = new URL(r.url()).hostname;
      if (host === 'themoviedb.org' || host.endsWith('.themoviedb.org')) requests.push(r.url());
    });
    await page.goto('/');
    await expect(page.locator('.hero-visual')).toBeAttached();
    await expect(page.locator('.lc')).toHaveCount(0);
    await expect(page.locator('.config-warning')).toBeVisible();
    await page.waitForTimeout(800);
    expect(requests).toEqual([]);
  });
});

test.describe('landing gallery — navigation', () => {
  test.beforeEach(async ({ page, mock }) => {
    void mock;
    await mockShowcase(page);
    await page.goto('/');
    await ready(page);
  });

  test('buttons, dots, side cards, wraparound all drive one activeIndex', async ({ page }) => {
    const activeDot = page.locator('.lc-dot[aria-current="true"]');
    await page.getByRole('button', { name: 'Next title' }).click();
    await expect(title(page)).toHaveText('Show 1');
    await expect(page.locator('.lc-line')).toContainText('Series');
    await expect(page.locator('.lc-slide.is-active')).toHaveAttribute('data-index', '1');
    await expect(activeDot).toHaveAttribute('aria-label', /^Show 2 of 8: Show 1$/);
    await expect(page.locator('.lc-bd.is-on')).toHaveCount(1);

    await page.locator('.lc-dot').nth(4).click();
    await expect(title(page)).toHaveText('Movie 3');
    await expect(page.locator('.lc [role="status"]')).toHaveText('5 of 8: Movie 3, 2003, movie');

    // wrap: previous from the first → last, next from the last → first
    await page.locator('.lc-dot').first().click();
    await page.getByRole('button', { name: 'Previous title' }).click();
    await expect(title(page)).toHaveText('Show 4');
    await page.getByRole('button', { name: 'Next title' }).click();
    await expect(title(page)).toHaveText('Movie 1');

    // clicking a visible side card selects it; far/decorative cards are inert
    // (the active card covers the inner part of a neighbour, so aim at its visible outer edge)
    const side = page.locator('.lc-slide.is-near[data-index="1"]');
    await page.waitForTimeout(600); // let the previous change finish animating before measuring
    const sb = (await side.boundingBox())!;
    await page.mouse.click(sb.x + sb.width * 0.85, sb.y + sb.height / 2);
    await expect(page.locator('.lc-slide.is-active')).toHaveAttribute('data-index', '1');
    await expect(page.locator('.lc-slide.is-far').first()).toHaveCSS('pointer-events', 'none');
  });

  test('inactive slides are hidden from assistive tech and never focusable', async ({ page }) => {
    await expect(page.locator('.lc-slide[aria-hidden="true"]')).toHaveCount(7);
    await expect(page.locator('.lc-slide:not([aria-hidden])')).toHaveCount(1);
    expect(await page.locator('.lc-slide button, .lc-slide a, .lc-slide [tabindex]').count()).toBe(0);
    await expect(page.locator('.lc')).toHaveAttribute('role', 'region');
    await expect(page.locator('.lc')).toHaveAttribute('aria-roledescription', 'carousel');
  });

  test('keyboard: arrows, Home/End, predictable tab order, polite announcement', async ({ page }) => {
    await page.locator('.lc-explore').focus();
    await page.keyboard.press('ArrowRight');
    await expect(title(page)).toHaveText('Show 1');
    await expect(page.locator('.lc [role="status"]')).toHaveText('2 of 8: Show 1, 2001, series');
    await page.keyboard.press('End');
    await expect(title(page)).toHaveText('Show 4');
    await page.keyboard.press('ArrowRight');
    await expect(title(page)).toHaveText('Movie 1');
    await page.keyboard.press('ArrowLeft');
    await expect(title(page)).toHaveText('Show 4');
    await page.keyboard.press('Home');
    await expect(title(page)).toHaveText('Movie 1');

    // Explore → previous → pager dots → next → pause; nothing hidden in between
    await page.locator('.lc-explore').focus();
    const order: string[] = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      order.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? ''));
    }
    expect(order[0]).toBe('Previous title');
    expect(order.slice(1, 9).every((l) => l.startsWith('Show '))).toBe(true);
    expect(order[9]).toBe('Next title');
    expect(order[10]).toMatch(/automatic rotation/);
  });

  test('Explore title opens the existing title flow', async ({ page }) => {
    await page.getByRole('button', { name: /^Explore title: Movie 1/ }).click();
    await expect(page.locator('.search-screen')).toBeVisible();
    await expect(page.locator('.lc')).toHaveCount(0);
  });
});

test.describe('landing gallery — gestures', () => {
  test.beforeEach(async ({ page, mock }) => {
    void mock;
    await mockShowcase(page);
    await page.goto('/');
    await ready(page);
  });

  test('a swipe past the threshold moves exactly one title, either way', async ({ page }) => {
    await gesture(page, { dxFraction: -0.45, gapMs: 30 }); // a huge drag still commits just one
    await expect(title(page)).toHaveText('Show 1');
    await gesture(page, { dxFraction: 0.35, gapMs: 30 });
    await expect(title(page)).toHaveText('Movie 1');
  });

  test('a fast flick commits even when short; a short slow drag snaps back', async ({ page }) => {
    await gesture(page, { dx: -44, steps: 2, gapMs: 20 });
    await expect(title(page)).toHaveText('Show 1');
    await gesture(page, { dxFraction: -0.08, steps: 4, gapMs: 60 });
    await expect(title(page)).toHaveText('Show 1');
    await expect(page.locator('.lc-slide.is-active')).toHaveAttribute('data-index', '1');
  });

  test('pointercancel and vertical gestures never change the slide', async ({ page }) => {
    await gesture(page, { dxFraction: -0.4, gapMs: 30, end: 'cancel' });
    await expect(title(page)).toHaveText('Movie 1');
    await gesture(page, { dx: 3, dy: 140, gapMs: 30 });
    await expect(title(page)).toHaveText('Movie 1');
    await expect(page.locator('.lc')).not.toHaveClass(/is-dragging/);
  });

  test('cards follow the pointer while dragging, with no transition lag', async ({ page }) => {
    const mid = await page.evaluate(async () => {
      const stage = document.querySelector('.lc-stage') as HTMLElement;
      const r = stage.getBoundingClientRect();
      const mk = (type: string, x: number) => new PointerEvent(type, { pointerId: 9, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: r.y + r.height / 2, bubbles: true });
      const x0 = r.x + r.width / 2;
      stage.dispatchEvent(mk('pointerdown', x0));
      stage.dispatchEvent(mk('pointermove', x0 - 20));
      stage.dispatchEvent(mk('pointermove', x0 - 60));
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      const root = document.querySelector('.lc') as HTMLElement;
      const active = document.querySelector('.lc-slide.is-active') as HTMLElement;
      const out = { dragging: root.classList.contains('is-dragging'), transition: getComputedStyle(active).transitionDuration, transform: active.style.transform };
      stage.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 9, bubbles: true }));
      return out;
    });
    expect(mid.dragging).toBe(true);
    expect(mid.transition).toBe('0s');
    expect(mid.transform).toMatch(/translate3d\(-/); // moved left with the pointer
  });

  test('a real mouse drag never also clicks through (any direction); a plain click still explores', async ({ page }) => {
    await page.locator('.lc-stage').scrollIntoViewIfNeeded(); // on phones the gallery starts below the fold
    const box = (await page.locator('.lc-stage').boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    // vertical drag released over the same card
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) {
      await page.mouse.move(cx + 1, cy + i * 20);
      await page.waitForTimeout(20);
    }
    await page.mouse.up();
    await expect(page.locator('.lc')).toBeVisible();
    // horizontal drag
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(cx - i * 18, cy);
      await page.waitForTimeout(25);
    }
    await page.mouse.up();
    await expect(title(page)).toHaveText('Show 1');
    await expect(page.locator('.lc')).toBeVisible(); // still on the landing page
    // a tap without travel works normally
    await page.locator('.lc-slide.is-active').click();
    await expect(page.locator('.search-screen')).toBeVisible();
  });
});

test.describe('landing gallery — touch', () => {
  test.skip(({ isMobile }) => !isMobile, 'touch gestures run in the mobile project');

  test.beforeEach(async ({ page, mock }) => {
    void mock;
    await mockShowcase(page);
    await page.goto('/');
    await ready(page);
    await page.locator('.lc').scrollIntoViewIfNeeded();
  });

  const swipe = async (page: Page, dx: number, dy: number) => {
    await page.locator('.lc-stage').scrollIntoViewIfNeeded();
    await page.waitForTimeout(400); // let the scroll settle, or the browser cancels the touch
    const box = (await page.locator('.lc-stage').boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / 8, y: y + (dy * i) / 8 }] });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  };

  test('horizontal swipe changes the title; a vertical swipe scrolls and does not', async ({ page }) => {
    await swipe(page, -130, 0);
    await expect(title(page)).toHaveText('Show 1');
    await page.waitForTimeout(500);
    await swipe(page, 4, -160);
    await expect(title(page)).toHaveText('Show 1');
  });

  test('tapping a side poster selects it; tapping Explore opens the title', async ({ page }) => {
    const sb = (await page.locator('.lc-slide.is-near[data-index="1"]').boundingBox())!;
    await page.touchscreen.tap(sb.x + sb.width - 14, sb.y + sb.height / 2);
    await expect(page.locator('.lc-slide.is-active')).toHaveAttribute('data-index', '1');
    await page.getByRole('button', { name: /^Explore title:/ }).tap();
    await expect(page.locator('.search-screen')).toBeVisible();
  });
});

test.describe('landing gallery — motion preferences', () => {
  test('reduced motion: no autoplay control, no tilt or parallax, instant changes', async ({ page, mock }) => {
    void mock;
    await pausedClock(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await mockShowcase(page);
    await page.goto('/');
    await page.locator('.lc-slide').first().waitFor();
    await page.clock.runFor(200);
    await expect(page.locator('.lc')).toHaveAttribute('data-lc-motion', 'off');
    await expect(page.locator('.lc-pause')).toBeHidden();
    const transforms = await page.locator('.lc-slide').evaluateAll((els) => els.map((e) => (e as HTMLElement).style.transform));
    expect(transforms.every((t) => /rotateY\(-?0(\.0+)?deg\)/.test(t))).toBe(true);
    expect(await page.locator('.lc-slide').evaluateAll((els) => els.every((e) => /^-?0(\.00)?px$/.test((e as HTMLElement).style.getPropertyValue('--par'))))).toBe(true);
    await page.clock.runFor(30_000);
    await expectTitle(page, 'Movie 1'); // never auto-advances
    await page.getByRole('button', { name: 'Next title' }).click();
    await expectTitle(page, 'Show 1');
  });

  test('the site Motion setting is honoured live, both ways', async ({ page, mock }) => {
    void mock;
    await mockShowcase(page);
    await page.goto('/');
    await ready(page);
    await expect(page.locator('.lc')).not.toHaveAttribute('data-lc-motion', 'off');
    await expect(page.locator('.lc-pause')).toBeVisible();
    await page.evaluate(() => document.documentElement.setAttribute('data-motion', 'off'));
    await expect(page.locator('.lc')).toHaveAttribute('data-lc-motion', 'off');
    await expect(page.locator('.lc-pause')).toBeHidden();
    await page.evaluate(() => document.documentElement.setAttribute('data-motion', 'full'));
    await expect(page.locator('.lc')).toHaveAttribute('data-lc-motion', 'full');
    await expect(page.locator('.lc-pause')).toBeVisible();
  });
});

test.describe('landing gallery — autoplay and cleanup', () => {
  test.beforeEach(async ({ page, mock }) => {
    void mock;
    await pausedClock(page);
    await mockShowcase(page);
    await page.goto('/');
    await page.locator('.lc-slide').first().waitFor();
    // On phones the gallery starts below the fold, where autoplay (rightly) doesn't run.
    await page.locator('.lc').scrollIntoViewIfNeeded();
    await page.clock.runFor(100); // flush the first-frame rAF
    await expect(page.locator('.lc.is-ready')).toBeVisible();
  });

  test('advances after ~7s when idle, and not before', async ({ page }) => {
    await page.clock.runFor(6000);
    await expectTitle(page, 'Movie 1');
    await page.clock.runFor(1500);
    await expectTitle(page, 'Show 1');
  });

  test('waits at least 8s after a manual interaction', async ({ page }) => {
    await page.clock.runFor(5000);
    await page.getByRole('button', { name: 'Next title' }).click(); // → Show 1, focus now inside
    await page.evaluate(() => (document.activeElement as HTMLElement).blur()); // focus leaves
    await page.mouse.move(2, 2); // hover leaves
    await page.clock.runFor(7500);
    await expectTitle(page, 'Show 1');
    await page.clock.runFor(1500);
    await expectTitle(page, 'Movie 2');
  });

  test('pauses for hover, focus, an explicit Pause, a hidden tab and an off-screen gallery', async ({ page }) => {
    // hover
    const box = (await page.locator('.lc-stage').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 40);
    await page.clock.runFor(20_000);
    await expectTitle(page, 'Movie 1');
    await page.mouse.move(2, 2);
    // focus inside
    await page.locator('.lc-explore').focus();
    await page.clock.runFor(20_000);
    await expectTitle(page, 'Movie 1');
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    // explicit pause (kept for the life of the component)
    await page.locator('.lc-pause').click();
    await expect(page.locator('.lc-pause')).toHaveAccessibleName('Resume automatic rotation');
    await page.mouse.move(2, 2);
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await page.clock.runFor(30_000);
    await expectTitle(page, 'Movie 1');
    await page.locator('.lc-pause').click(); // resume
    await expect(page.locator('.lc-pause')).toHaveAccessibleName('Pause automatic rotation');
    await page.mouse.move(2, 2);
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    // hidden document
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(30_000);
    await expectTitle(page, 'Movie 1');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // scrolled out of view
    await page.evaluate(() => {
      (document.querySelector('.lc') as HTMLElement).style.marginTop = '3000px';
      window.scrollTo(0, 0);
    });
    await page.clock.runFor(30_000);
    await expectTitle(page, 'Movie 1');
  });

  test('leaving the landing screen stops everything; returning gives exactly one working gallery', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.getByRole('button', { name: /find my next watch/i }).click();
    await expect(page.locator('.quiz-option').first()).toBeVisible();
    await expect(page.locator('.lc')).toHaveCount(0);
    await page.clock.runFor(60_000); // several autoplay periods with the gallery gone
    await page.locator('a.app-brand').click();
    await page.locator('.lc-slide').first().waitFor();
    await expect(page.locator('.lc')).toHaveCount(1);
    await page.clock.runFor(100);
    await expectTitle(page, 'Movie 1');
    await page.getByRole('button', { name: 'Next title' }).click();
    await expectTitle(page, 'Show 1');
    expect(errors).toEqual([]);
  });
});

test('leaving before TMDB answers cancels the request and changes nothing', async ({ page, mock }) => {
  void mock;
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const errors: string[] = [];
  const failed: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('requestfailed', (r) => {
    if (r.url().includes('/discover/')) failed.push(r.url());
  });
  await mockShowcase(page, { gate });
  await page.goto('/');
  await expect(page.locator('.lc-skel')).toBeVisible();
  await page.getByRole('button', { name: /find my next watch/i }).click();
  await expect(page.locator('.quiz-option').first()).toBeVisible();
  release();
  await page.waitForTimeout(500);
  await expect(page.locator('.lc')).toHaveCount(0);
  await expect(page.locator('.hero-visual')).toHaveCount(0); // the fallback never lands on the quiz screen either
  expect(errors).toEqual([]);
  expect(failed.length).toBeGreaterThan(0); // the in-flight requests were aborted
});

test.describe('landing gallery — layout', () => {
  for (const [w, h] of [
    [1440, 900],
    [1024, 768],
    [768, 1024],
    [390, 844],
    [360, 800],
    [320, 740],
  ] as const) {
    test(`${w}×${h}: CTA and gallery are arranged correctly and nothing in the gallery overflows`, async ({ page, mock }) => {
      void mock;
      await page.setViewportSize({ width: w, height: h });
      await mockShowcase(page);
      await page.goto('/');
      await ready(page);
      const cta = (await page.getByRole('button', { name: /find my next watch/i }).boundingBox())!;
      const lc = (await page.locator('.lc').boundingBox())!;
      const stage = (await page.locator('.lc-stage').boundingBox())!;
      if (w > 860) expect(lc.x).toBeGreaterThan(cta.x + cta.width / 2); // gallery on the right
      else expect(lc.y).toBeGreaterThan(cta.y + cta.height); // CTA first, gallery below
      expect(lc.x).toBeGreaterThanOrEqual(0);
      expect(lc.x + lc.width).toBeLessThanOrEqual(w + 0.5);
      expect(stage.height).toBeGreaterThan(w <= 520 ? 215 : 290);
      expect(stage.height).toBeLessThan(w <= 520 ? 305 : 465);
      // every pager control stays inside the gallery, on one row
      const controls = await page.locator('.lc-nav, .lc-dot').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
      expect(controls.every((r) => r.left >= lc.x - 0.5 && r.right <= lc.x + lc.width + 0.5)).toBe(true);
      expect(new Set(controls.map((r) => Math.round(r.top))).size).toBe(1);
      await expect(page.getByRole('button', { name: 'Next title' })).toBeVisible();
      if (w >= 360) expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });
  }
});
