import { assertEquals } from 'jsr:@std/assert';
import {
  sanitizeBreadcrumb,
  sanitizeErrorEvent,
  sanitizeReplayEvent,
  scrubThirdPartyQueryUrls,
} from '../../src/lib/sentry-privacy.ts';

Deno.test('sanitizeBreadcrumb drops DOM ui.* breadcrumbs (rating star aria-labels)', () => {
  assertEquals(
    sanitizeBreadcrumb({
      category: 'ui.click',
      message: 'button.star[aria-label="Rate 5 stars — Barbie"]',
    }),
    null
  );
  assertEquals(sanitizeBreadcrumb({ category: 'ui.input', message: 'input.search-input' }), null);
});

Deno.test('sanitizeBreadcrumb drops fetch and xhr breadcrumbs', () => {
  assertEquals(
    sanitizeBreadcrumb({
      category: 'fetch',
      data: { url: 'https://api.themoviedb.org/3/search/multi?query=Barbie' },
    }),
    null
  );
  assertEquals(
    sanitizeBreadcrumb({
      category: 'xhr',
      data: { url: 'https://www.omdbapi.com/?t=Barbie&y=2023' },
    }),
    null
  );
});

Deno.test('sanitizeBreadcrumb strips query strings on navigation breadcrumbs and keeps others', () => {
  assertEquals(
    sanitizeBreadcrumb({
      category: 'navigation',
      data: { from: '/?q=secret', to: '/results#hash' },
    }),
    {
      category: 'navigation',
      data: { from: '/', to: '/results' },
    }
  );
  assertEquals(sanitizeBreadcrumb({ category: 'console', data: { level: 'info' } }), {
    category: 'console',
    data: { level: 'info' },
  });
});

Deno.test('sanitizeReplayEvent drops ui.* replay breadcrumbs and scrubs fetch span queries', () => {
  assertEquals(
    sanitizeReplayEvent({
      data: {
        tag: 'breadcrumb',
        payload: { category: 'ui.click', data: { node: { textContent: 'Barbie' } } },
      },
    }),
    null
  );

  assertEquals(
    sanitizeReplayEvent({
      data: {
        tag: 'performanceSpan',
        payload: {
          op: 'resource.fetch',
          description: 'https://api.themoviedb.org/3/search/multi?query=Barbie&include_adult=false',
        },
      },
    }),
    {
      data: {
        tag: 'performanceSpan',
        payload: {
          op: 'resource.fetch',
          description: 'https://api.themoviedb.org/3/search/multi',
        },
      },
    }
  );
});

Deno.test('scrubThirdPartyQueryUrls and sanitizeErrorEvent strip TMDB/OMDb query strings', () => {
  assertEquals(
    scrubThirdPartyQueryUrls('TMDB 500: https://api.themoviedb.org/3/search/multi?query=Barbie&api_key=abc'),
    'TMDB 500: https://api.themoviedb.org/3/search/multi'
  );
  assertEquals(
    sanitizeErrorEvent({
      message: 'Failed https://www.omdbapi.com/?apikey=123&t=Barbie&y=2023',
      exception: {
        values: [{ value: 'TMDB request failed: https://api.themoviedb.org/3/find/tt1517268?external_source=imdb_id' }],
      },
    }),
    {
      message: 'Failed https://www.omdbapi.com/',
      exception: {
        values: [{ value: 'TMDB request failed: https://api.themoviedb.org/3/find/tt1517268' }],
      },
    }
  );
});
