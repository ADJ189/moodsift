// src/lib/sentry.ts
//
// Browser-side Sentry initialization for Moodsift.
// Stays completely inactive when VITE_SENTRY_DSN is unset (e.g. Playwright
// test builds or forks without Sentry). Never sends stored ratings, watchlist,
// search queries, or user identity (DOM/fetch/XHR breadcrumbs, URL query params,
// and dataCollection.userInfo are disabled).

import * as Sentry from '@sentry/browser';
import { APP_VERSION } from './app-version';
import { sanitizeBreadcrumb, sanitizeErrorEvent, sanitizeReplayEvent } from './sentry-privacy';

let initialized = false;

/** Initializes Sentry for the browser app when VITE_SENTRY_DSN is configured. */
export function initSentry(): void {
  if (initialized) return;
  const dsn = import.meta.env.VITE_SENTRY_DSN?.trim();
  if (!dsn) return;

  initialized = true;
  const environment = import.meta.env.VITE_SENTRY_ENVIRONMENT?.trim() || import.meta.env.MODE;
  const release = import.meta.env.VITE_SENTRY_RELEASE?.trim() || `moodsift@${APP_VERSION}`;
  const isDev = import.meta.env.DEV || environment === 'development';

  Sentry.init({
    dsn,
    release,
    environment,
    integrations: [
      // Never capture DOM click/input breadcrumbs (rating stars carry title
      // aria-labels) or outgoing fetch/XHR URLs (TMDB/OMDb search queries).
      Sentry.breadcrumbsIntegration({ dom: false, fetch: false, xhr: false }),
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({
        beforeAddRecordingEvent: (event) => sanitizeReplayEvent(event),
      }),
    ],
    // Sample every trace locally so verification traces always appear; keep production low.
    tracesSampleRate: isDev ? 1.0 : 0.1,
    // Restrict trace headers to same-origin requests so third-party APIs (TMDB,
    // OMDb, CDNs) never receive unexpected CORS preflight headers.
    tracePropagationTargets: [/^\//, /^https?:\/\/localhost(?::\d+)?\//],
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    dataCollection: {
      userInfo: false,
      urlQueryParams: false,
    },
    beforeBreadcrumb: (breadcrumb) => sanitizeBreadcrumb(breadcrumb),
    beforeSend: (event) => sanitizeErrorEvent(event),
  });
}
