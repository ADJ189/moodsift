// src/lib/llm.ts
//
// Optional local LLM used to rephrase a result's rule-based reasons into one
// natural "why this pick" sentence. It NEVER chooses or reranks titles —
// ranking stays deterministic (engine.ts / tmdb.ts) — and it is never a
// dependency: if local AI is off, not ready, slow, or returns output that
// fails the format checks, the original rule-based reasons simply stay.
//
// This file is the main-thread wrapper around ai-worker.ts. It owns:
//   - the worker and request/response correlation,
//   - staged loading status (detect → runtime → download → start → verify),
//   - timeouts: a load that goes quiet or runs unreasonably long, and a
//     generation that wedges, both terminate the worker so nothing queues
//     behind a dead one,
//   - a small bounded cache so re-rendering a result doesn't re-run inference,
//   - resetting everything when the user changes the AI engine mode.
//
// Cloud AI is intentionally NOT used here. The existing /api/recommend
// endpoint is not called by the frontend; see Moodsift-Local-AI-Engine-Policy.md.
//
// Deliberately NOT an npm dependency: @huggingface/transformers pulls in
// onnxruntime-node and sharp as hard dependencies for its Node backend,
// which means a native-binary postinstall step that has nothing to do with
// this being a 100%-browser feature. Instead, the worker loads the browser
// build straight from a CDN, only when a user explicitly opts in — so
// `npm install` stays small and clean. In Lightweight / data saver mode
// nothing is imported or downloaded at all.

import { cleanField, MAX_REASON_CHARS, MAX_REASONS, MAX_SUMMARY_CHARS, MAX_TITLE_CHARS } from './ai-policy';
import { getAiMode, subscribeAiMode } from './ai-settings';
import { keyOf } from './media-key';
import type { ScoredItem } from './types';

/** `disabled` = Lightweight / data saver: no model is ever downloaded. */
export type LlmStatus = 'disabled' | 'unavailable' | 'loading' | 'ready' | 'error';

// A load is abandoned if the worker goes completely quiet for this long
// (progress and stage messages all count as activity)…
const LOAD_IDLE_TIMEOUT_MS = 120_000;
// …or if it simply takes this long overall. Both are far longer than the old
// 60 s limit, which cut off legitimate downloads of a few hundred MB.
const LOAD_HARD_TIMEOUT_MS = 20 * 60_000;
// Per generation, measured from when the worker starts decoding it (not from
// when it was queued behind earlier ones).
const GENERATE_TIMEOUT_MS = 30_000;
const CACHE_MAX_ENTRIES = 150;

type WorkerOutMsg =
  | { type: 'stage'; stage: 'detecting' | 'runtime' | 'downloading' | 'initializing' | 'verifying'; model?: string; approxMb?: number }
  | { type: 'progress'; pct: number; model?: string }
  | { type: 'activity' }
  | { type: 'ready'; model: string; backend: 'webgpu' | 'wasm'; dtype: string; approxMb: number }
  | { type: 'error'; message: string }
  | { type: 'started'; id: number }
  | { type: 'result'; id: number; text: string | null };

let worker: Worker | null = null;
let status: Exclude<LlmStatus, 'disabled'> = 'unavailable';
let statusDetail = '';
let stageText = '';
let activeModelKey = '';
let nextRequestId = 1;

let loadingPromise: Promise<void> | null = null;
let loadSettle: { resolve: () => void; reject: (e: Error) => void } | null = null;
let idleTimer: number | null = null;
let hardTimer: number | null = null;
let genTimer: number | null = null;
let genTimerId = 0;

const pending = new Map<number, (text: string | null) => void>();
const inflight = new Map<string, Promise<string | null>>();
const cache = new Map<string, string>();
const listeners = new Set<() => void>();

// ── status API ──────────────────────────────────────────────────────────

export function getLlmStatus(): LlmStatus {
  return getAiMode() === 'lightweight' ? 'disabled' : status;
}

/** A short human-readable detail for the current status: the chosen model,
 * backend, dtype and approximate weight size when ready; the reason when not. */
export function getLlmStatusDetail(): string {
  if (getAiMode() === 'lightweight') {
    return 'Data saver is on, so no AI model is downloaded. You can change this in Settings → AI engine.';
  }
  return statusDetail;
}

/** What the engine is doing right now while loading ("Downloading … 42%"). */
export function getLlmStageText(): string {
  return stageText;
}

/** Called whenever status, stage text or detail changes. Returns an unsubscribe. */
export function subscribeLlm(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // A broken subscriber must not break the engine or the others.
    }
  }
}

export interface LlmView {
  label: string;
  /** True while loading — the button should not accept clicks. */
  busy: boolean;
  /** Text for the polite live status line next to the button. */
  status: string;
}

/** One place that maps engine state to button/status text, so the results and
 * search screens always agree. `idleLabel` is the screen's own call to action. */
export function describeLlm(idleLabel: string): LlmView {
  const s = getLlmStatus();
  switch (s) {
    case 'disabled':
      return { label: '✨ On-device AI: off (data saver)', busy: false, status: getLlmStatusDetail() };
    case 'loading':
      return { label: 'Loading on-device AI…', busy: true, status: stageText };
    case 'ready':
      return { label: '✨ On-device AI: on', busy: false, status: statusDetail };
    case 'error':
      return { label: '⚠️ AI unavailable — retry', busy: false, status: statusDetail };
    default:
      return { label: idleLabel, busy: false, status: statusDetail };
  }
}

// ── worker lifecycle ────────────────────────────────────────────────────

function clearLoadTimers(): void {
  if (idleTimer !== null) window.clearTimeout(idleTimer);
  if (hardTimer !== null) window.clearTimeout(hardTimer);
  idleTimer = null;
  hardTimer = null;
}

function clearGenTimer(): void {
  if (genTimer !== null) window.clearTimeout(genTimer);
  genTimer = null;
  genTimerId = 0;
}

/** Terminates the worker (stopping any download or decode) and answers every
 * waiting request with `null` so callers fall back to the rule-based reasons. */
function dropWorker(): void {
  clearGenTimer();
  worker?.terminate();
  worker = null;
  const waiting = [...pending.values()];
  pending.clear();
  for (const resolve of waiting) resolve(null);
}

function armIdleTimer(): void {
  if (idleTimer !== null) window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(
    () => failLoad('The on-device model stopped responding while loading. Check your connection and try again.'),
    LOAD_IDLE_TIMEOUT_MS
  );
}

function failLoad(message: string): void {
  clearLoadTimers();
  dropWorker();
  status = 'error';
  statusDetail = message;
  stageText = '';
  activeModelKey = '';
  const settle = loadSettle;
  loadSettle = null;
  notify();
  settle?.reject(new Error(message));
}

/** Back to a clean "not loaded" state — used when the AI engine mode changes. */
function resetEngine(): void {
  clearLoadTimers();
  dropWorker();
  const settle = loadSettle;
  loadSettle = null;
  status = 'unavailable';
  statusDetail = '';
  stageText = '';
  activeModelKey = '';
  cache.clear();
  inflight.clear();
  notify();
  // Resolve (not reject): a cancelled load isn't an error. Callers re-read
  // the status instead of assuming the model is ready.
  settle?.resolve();
}

function onGenerateTimeout(): void {
  genTimer = null;
  genTimerId = 0;
  // A wedged decode would block every request behind it, so end the worker.
  dropWorker();
  status = 'unavailable';
  statusDetail = 'On-device AI stopped responding and was reset. Turn it on again to retry.';
  stageText = '';
  activeModelKey = '';
  notify();
}

function stageLabel(msg: Extract<WorkerOutMsg, { type: 'stage' }>): string {
  const model = msg.model ?? 'the model';
  switch (msg.stage) {
    case 'detecting':
      return 'Checking your device…';
    case 'runtime':
      return 'Loading the AI runtime…';
    case 'downloading':
      return typeof msg.approxMb === 'number' ? `Downloading ${model} (about ${msg.approxMb} MB)…` : `Downloading ${model}…`;
    case 'initializing':
      return `Starting ${model}…`;
    case 'verifying':
      return `Running a quick check on ${model}…`;
  }
}

function onWorkerMessage(w: Worker, msg: WorkerOutMsg): void {
  if (w !== worker) return; // a message from a worker we already discarded

  switch (msg.type) {
    case 'stage':
      if (status !== 'loading') return;
      stageText = stageLabel(msg);
      armIdleTimer();
      notify();
      return;
    case 'progress':
      if (status !== 'loading') return;
      stageText = `Downloading ${msg.model ?? 'model'}… ${Math.max(0, Math.min(99, Math.round(msg.pct)))}%`;
      armIdleTimer();
      notify();
      return;
    case 'activity':
      // Download bytes are still flowing: not stalled. No UI change.
      if (status === 'loading') armIdleTimer();
      return;
    case 'ready': {
      if (status !== 'loading') return;
      clearLoadTimers();
      status = 'ready';
      stageText = '';
      activeModelKey = `${msg.model}:${msg.backend}:${msg.dtype}`;
      const backend = msg.backend === 'webgpu' ? 'WebGPU' : 'WASM (CPU)';
      statusDetail = `On-device model: ${msg.model} · ${backend} · ${msg.dtype} · about ${msg.approxMb} MB of model weights`;
      const settle = loadSettle;
      loadSettle = null;
      notify();
      settle?.resolve();
      return;
    }
    case 'error':
      if (status !== 'loading') return;
      failLoad(msg.message || "This browser can't run the on-device model.");
      return;
    case 'started':
      clearGenTimer();
      genTimerId = msg.id;
      genTimer = window.setTimeout(onGenerateTimeout, GENERATE_TIMEOUT_MS);
      return;
    case 'result': {
      if (genTimerId === msg.id) clearGenTimer();
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve?.(msg.text);
      return;
    }
  }
}

function getWorker(): Worker {
  if (worker) return worker;

  const w = new Worker(new URL('./ai-worker.ts', import.meta.url), { type: 'module' });
  worker = w;

  w.addEventListener('message', (e: MessageEvent<WorkerOutMsg>) => onWorkerMessage(w, e.data));
  w.addEventListener('error', () => {
    if (w !== worker) return;
    const message = 'The on-device model crashed unexpectedly.';
    if (status === 'loading') {
      failLoad(message);
      return;
    }
    // The worker may be left in a broken state after an uncaught error — drop
    // it so the next attempt starts a clean one.
    dropWorker();
    status = 'error';
    statusDetail = message;
    stageText = '';
    activeModelKey = '';
    notify();
  });

  return w;
}

/**
 * Downloads and starts the local model chosen by the current AI engine mode.
 * Idempotent. Resolves once the model is fully initialised AND has passed its
 * start-up check; rejects with a user-readable message if no eligible model
 * could be started.
 *
 * In Lightweight / data saver mode it returns immediately without importing
 * Transformers.js or downloading anything. It also resolves (without being
 * ready) if the mode changes mid-load — read getLlmStatus() afterwards.
 */
export async function enableLocalAi(): Promise<void> {
  if (getAiMode() === 'lightweight') return;
  if (status === 'ready') return;
  if (loadingPromise) return loadingPromise;

  status = 'loading';
  statusDetail = '';
  stageText = 'Preparing on-device AI…';
  notify();

  let w: Worker;
  try {
    w = getWorker();
  } catch {
    status = 'error';
    statusDetail = "This browser can't run the on-device model.";
    stageText = '';
    notify();
    throw new Error(statusDetail);
  }

  const coarsePointer = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;

  const promise = new Promise<void>((resolve, reject) => {
    loadSettle = { resolve, reject };
    armIdleTimer();
    hardTimer = window.setTimeout(
      () => failLoad('Loading the on-device model took too long. Try again on a faster connection.'),
      LOAD_HARD_TIMEOUT_MS
    );
    w.postMessage({ type: 'load', mode: getAiMode(), coarsePointer });
  }).finally(() => {
    loadingPromise = null;
  });
  loadingPromise = promise;
  return promise;
}

// ── generation ──────────────────────────────────────────────────────────

function remember(key: string, text: string): void {
  cache.delete(key);
  cache.set(key, text);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Asks the local model for one sentence rephrasing the item's rule-based
 * reasons. Returns `null` — meaning "keep the original reasons" — when local
 * AI is off, not ready, times out, fails, or its output fails the format
 * checks. Requests are serialised inside the worker, so it is safe (if not
 * useful) to call this concurrently.
 */
export async function generateExplanation(item: ScoredItem, quizSummary: string): Promise<string | null> {
  if (getAiMode() === 'lightweight' || status !== 'ready' || !worker) return null;

  const summary = cleanField(quizSummary, MAX_SUMMARY_CHARS);
  const key = `${activeModelKey}|${keyOf(item)}|${summary}`;

  const hit = cache.get(key);
  if (hit !== undefined) {
    remember(key, hit); // refresh recency
    return hit;
  }
  const running = inflight.get(key);
  if (running) return running;

  const w = worker;
  const id = nextRequestId++;
  const promise = new Promise<string | null>((resolve) => {
    pending.set(id, resolve);
    w.postMessage({
      type: 'generate',
      id,
      item: {
        title: cleanField(item.title, MAX_TITLE_CHARS),
        year: item.year,
        reasons: item.reasons
          .slice(0, MAX_REASONS)
          .map((r) => cleanField(r, MAX_REASON_CHARS))
          .filter(Boolean),
      },
      quizSummary: summary,
    });
  })
    .then((text) => {
      if (text) remember(key, text);
      return text;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

/**
 * Rewrites a result's rule-based reasons into one natural sentence, or
 * returns the original reasons joined together when no usable AI sentence is
 * available. Always an enhancement, never a dependency for using the app.
 */
export async function explainPick(item: ScoredItem, quizSummary: string): Promise<string> {
  return (await generateExplanation(item, quizSummary)) ?? item.reasons.join(' · ');
}

// Changing the AI engine mode discards whatever is loaded or loading and
// starts clean, so the new priority policy always applies to the next load.
subscribeAiMode(() => resetEngine());
