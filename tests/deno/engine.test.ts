/// <reference lib="deno.ns" />
// Native Deno test: the scoring engine stays deterministic, era is a hard
// filter, de-duplication uses media keys, and AI-style text never reorders.
import { assertEquals } from 'jsr:@std/assert@1';
import { calibratedMatch, RecommendationEngine } from '../../src/lib/engine.ts';
import type { CatalogItem, ScoredItem } from '../../src/lib/types.ts';

const item = (over: Partial<CatalogItem> & { id: number }): CatalogItem => ({
  title: `Title ${over.id}`,
  year: 2015,
  type: 'movie',
  tmdbType: 'movie',
  posterPath: null,
  backdropPath: null,
  genreIds: [],
  genres: ['thriller'],
  vibe: ['dark'],
  language: 'en',
  era: 'recent',
  voteAverage: 7.5,
  voteCount: 1200,
  popularity: 60,
  overview: 'A deterministic fixture.',
  ...over,
});

const ids = (list: ScoredItem[]) => list.map((i) => `${i.tmdbType}:${i.id}`);

Deno.test('calibratedMatch is monotonic, clamped and deterministic', () => {
  assertEquals(calibratedMatch(0), calibratedMatch(0));
  const samples = [-100, -5, 0, 5, 20, 60, 200].map(calibratedMatch);
  for (let i = 1; i < samples.length; i++) assertEquals(samples[i]! >= samples[i - 1]!, true, `sample ${i}`);
  for (const v of samples) assertEquals(v >= 1 && v <= 99, true, String(v));
});

Deno.test('era is a hard filter, not a scoring nudge', () => {
  const engine = new RecommendationEngine();
  engine.processQuiz({ mood: 'thriller', era: 'recent' });
  const out = engine.getResults(
    [item({ id: 1, era: 'recent' }), item({ id: 2, era: 'classic', genres: ['thriller'], voteAverage: 9.9 })],
    {}
  );
  assertEquals(ids(out), ['movie:1']);
});

Deno.test('colliding movie/TV ids are both kept; duplicate keys are dropped', () => {
  const engine = new RecommendationEngine();
  engine.processQuiz({ era: 'any' });
  const out = engine.getResults(
    [
      item({ id: 7, tmdbType: 'movie' }),
      item({ id: 7, tmdbType: 'tv', type: 'series' }),
      item({ id: 7, tmdbType: 'movie', title: 'Duplicate movie' }),
    ],
    {}
  );
  assertEquals(ids(out).sort(), ['movie:7', 'tv:7']);
});

Deno.test('identical input yields identical ranking (no randomness)', () => {
  const candidates = Array.from({ length: 12 }, (_, i) => item({ id: i + 1, voteAverage: 6 + (i % 4), popularity: 20 + i }));
  const run = () => {
    const engine = new RecommendationEngine();
    engine.processQuiz({ mood: 'thriller', vibe: 'dark', language: 'english' });
    return engine.getResults(candidates, {});
  };
  assertEquals(ids(run()), ids(run()));
});

Deno.test('language preference penalises the mismatch without hiding it', () => {
  const engine = new RecommendationEngine();
  engine.processQuiz({ era: 'any', language: 'english' });
  const results = engine.getResults(
    [item({ id: 1, language: 'en' }), item({ id: 2, language: 'fr' })],
    {}
  );
  const [en, foreign] = results;
  assertEquals(results[0]!.id, 1);
  assertEquals(en!.score > foreign!.score, true);
  assertEquals(engine.getResults([item({ id: 2, language: 'fr' })], {}).length, 1);
});

Deno.test('reasons explain the match and never exceed three', () => {
  const engine = new RecommendationEngine();
  engine.processQuiz({ mood: 'thriller', vibe: 'dark', contentType: 'live_action' });
  const out = engine.getResults([item({ id: 1, voteAverage: 8.7, genres: ['thriller'], vibe: ['dark'] })], {});
  assertEquals(out[0]!.reasons.length <= 3, true);
  assertEquals(out[0]!.reasons.length > 0, true);
  assertEquals(out[0]!.reasons.some((r) => r.includes('thriller')), true);
});

Deno.test('rated titles nudge affinity in the expected direction', () => {
  const engine = new RecommendationEngine();
  engine.processQuiz({ era: 'any' });
  engine.processResultRating(item({ id: 99, genres: ['comedy'], vibe: ['feelgood'] }), 5);
  const results = engine.getResults(
    [item({ id: 1, genres: ['comedy'], vibe: ['feelgood'] }), item({ id: 2, genres: ['horror'], vibe: ['dark'] })],
    {}
  );
  const [liked, other] = results;
  assertEquals(results[0]!.id, 1);
  assertEquals(liked!.score > other!.score, true);
  assertEquals(liked!.matchedTags.includes('comedy'), true);
});
