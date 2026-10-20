import { expect, test as base, type Page, type Route } from '@playwright/test';

/** Deterministic TMDB: movie and TV results deliberately share the same ids,
 * so every flow that touches identity exercises the collision case. */
const raw = (id: number, tv: boolean) => ({
  id,
  overview: 'A deterministic fixture overview.',
  genre_ids: [[53, 18], [35], [18], [878], [27], [12]][id % 6],
  original_language: 'en',
  vote_average: 7.6,
  vote_count: 1800,
  popularity: 60 + id,
  poster_path: null,
  backdrop_path: null,
  ...(tv
    ? { name: `Show ${id}`, first_air_date: `${1975 + ((id * 7) % 50)}-05-01` }
    : { title: `Film ${id}`, release_date: `${1975 + ((id * 7) % 50)}-05-01` }),
});

export const IMPORT_FILMS: Record<string, [number, number]> = { Alpha: [9001, 2001], Beta: [9002, 2002], Gamma: [9003, 2003], Delta: [9004, 2004] };

export interface Mock {
  failTitles: Set<string>;
}

export async function mockTmdb(page: Page): Promise<Mock> {
  const mock: Mock = { failTitles: new Set() };
  await page.route('**/api.themoviedb.org/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path.includes('/search/movie')) {
      const name = url.searchParams.get('query') ?? '';
      if (mock.failTitles.has(name)) return route.fulfill({ status: 500, body: 'fixture failure' });
      const hit = IMPORT_FILMS[name];
      return json({ results: hit ? [{ ...raw(hit[0], false), title: name, release_date: `${hit[1]}-01-01` }] : [] });
    }
    if (path.includes('/search/')) return json({ results: [] });
    const tv = path.includes('/tv');
    if (path.includes('/discover/') || path.includes('/trending') || path.includes('/recommendations') || path.includes('/similar')) {
      return json({ page: 1, total_pages: 3, results: Array.from({ length: 20 }, (_, i) => raw(100 + i, tv)) });
    }
    return json({ page: 1, results: [], genres: [], credits: { cast: [], crew: [] } });
  });
  await page.route('**/image.tmdb.org/**', (r) => r.fulfill({ status: 404 }));
  return mock;
}

/** Answers the seven quiz questions with the first option each time. */
export async function completeQuiz(page: Page): Promise<void> {
  await page.getByRole('button', { name: /find my next watch|get fresh picks/i }).click();
  for (let i = 0; i < 7; i++) {
    const option = page.locator('.quiz-option').first();
    await option.waitFor();
    await option.click();
    await page.waitForTimeout(450);
  }
  await page.locator('.rating-grid').waitFor({ timeout: 10_000 });
}

export async function rateCards(page: Page, n: number): Promise<void> {
  const cards = page.locator('.rating-card');
  for (let i = 0; i < n; i++) await cards.nth(i).locator('.star').nth(4).click();
}

export async function toResults(page: Page): Promise<void> {
  await rateCards(page, 4);
  await page.locator('.rating-footer .btn-primary').click();
  await page.locator('.result-card').first().waitFor({ timeout: 15_000 });
}

export const test = base.extend<{ mock: Mock }>({
  mock: async ({ page }, use) => {
    const mock = await mockTmdb(page);
    await use(mock);
  },
});

export { expect };

/** Fictional, deterministic search results. Registered after mockTmdb, so it
 * takes precedence for the two search endpoints only. */
export async function mockSearchResults(page: Page, opts: { delayMs?: number; fail?: boolean; empty?: boolean } = {}): Promise<{ calls: string[] }> {
  const calls: string[] = [];
  await page.route(/api\.themoviedb\.org\/3\/search\/(multi|person)/, async (route: Route) => {
    const url = new URL(route.request().url());
    calls.push(`${url.pathname}?${url.searchParams.get('query') ?? ''}`);
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.fail) return route.fulfill({ status: 500, body: 'fixture failure' });
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (opts.empty) return json({ results: [] });
    if (url.pathname.endsWith('/person')) {
      return json({
        results: [
          { id: 501, name: 'Mira Calloway', profile_path: null, known_for_department: 'Acting', known_for: [{ title: 'The Midnight Reel' }, { name: 'Midnight Harbor' }] },
          { id: 502, name: 'Jonas Midland', profile_path: null, known_for_department: 'Directing' },
        ],
      });
    }
    const movie = (id: number, title: string, year: number, votes: number) => ({
      id, media_type: 'movie', title, release_date: `${year}-03-01`, overview: `${title} is a fictional fixture overview used to test synopsis clamping. It runs long enough to need trimming when a card shows only a few lines of text, so the layout is exercised honestly.`,
      genre_ids: [53], original_language: 'en', vote_average: votes ? 7.8 : 0, vote_count: votes, popularity: 50, poster_path: null, backdrop_path: null,
    });
    const show = (id: number, name: string, year: number) => ({
      id, media_type: 'tv', name, first_air_date: `${year}-09-01`, overview: `${name} is a fictional series fixture.`, genre_ids: [18], original_language: 'en', vote_average: 8.1, vote_count: 900, popularity: 40, poster_path: null, backdrop_path: null,
    });
    return json({ results: [movie(301, 'The Midnight Reel', 2019, 1200), movie(302, 'Midnight Express Lane', 2011, 0), movie(303, 'Midnight in the Garden of Glass', 1998, 400), show(304, 'Midnight Harbor', 2022), show(305, 'Midnight Radio', 2015), movie(306, 'After Midnight', 2005, 90)] });
  });
  return { calls };
}

/** Opens the Settings workspace, optionally on a section tab. */
export async function openSettings(page: Page, section?: string): Promise<void> {
  await page.getByRole('button', { name: 'Appearance settings', exact: true }).click();
  if (section) await page.getByRole('tab', { name: section }).click();
}

/** "Saved looks" and other secondary controls live in closed disclosures. */
export async function openDisclosure(page: Page, summary: string): Promise<void> {
  await page.locator('summary', { hasText: summary }).click();
}
