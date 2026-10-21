// src/lib/ai-diagnostics.ts
//
// The pure half of "Test on this device": failure records, error
// classification, the auto-recommendation, and the privacy-safe report.
// No DOM, no worker globals, no network — unit-tested in Node.

import { buildCandidates, MODELS, type Backend, type Candidate, type ModelFamily, type ResourceSnapshot } from './ai-policy';
import type { AiMode } from './ai-settings';
import type { IntegrityReport } from './ai-integrity';

export type FailureStage = 'runtime' | 'download' | 'integrity' | 'initialization' | 'smoke inference' | 'generation';

export type FailureKind =
  | 'offline'
  | 'timeout'
  | 'cors'
  | 'http'
  | 'network'
  | 'module'
  | 'wasm'
  | 'integrity'
  | 'memory'
  | 'empty-output'
  | 'unknown';

/** One attempt to start one candidate (or the runtime itself). */
export interface AttemptRecord {
  /** `family:backend`, or `runtime` for a failure before any model was tried. */
  key: string;
  label: string;
  backend?: Backend;
  dtype?: string;
  revision?: string;
  ok: boolean;
  stage?: FailureStage;
  kind?: FailureKind;
  /** origin + path only — never a query string or credentials. */
  url?: string;
  host?: string;
  status?: number;
  /** Short, single-line, sanitized detail. */
  message?: string;
  /** Milliseconds spent on this attempt. */
  ms?: number;
}

export type DiagnosticOutcome = 'passed' | 'passed-fallback' | 'failed' | 'disabled';

export interface Recommendation {
  mode: AiMode;
  /** Ready-to-show sentence, e.g. "SmolLM2-360M could not start. We recommend Fastest (SmolLM2-135M) on this device." */
  message: string;
}

export interface QualityResult {
  passed: number;
  total: number;
}

export interface DiagnosticResult {
  outcome: DiagnosticOutcome;
  mode: AiMode;
  /** The candidate that is now ready (passed outcomes only). */
  model?: { label: string; family: ModelFamily; backend: Backend; dtype: string; revision: string; approxMb: number };
  integrity?: IntegrityReport;
  resources?: ResourceSnapshot & { webgpuApi: boolean };
  eligible: string[];
  attempts: AttemptRecord[];
  startupMs?: number;
  smokeMs?: number;
  quality?: QualityResult;
  recommendation?: Recommendation | null;
  /** Short, readable explanation of what happened. */
  summary: string;
}

// ── error classification ────────────────────────────────────────────────

const NETWORKISH: readonly FailureKind[] = ['offline', 'timeout', 'cors', 'http', 'network', 'module', 'wasm'];

export function classifyFailure(input: { stage: FailureStage; message?: string; status?: number; offline?: boolean; timedOut?: boolean }): FailureKind {
  const m = (input.message ?? '').toLowerCase();
  if (input.stage === 'integrity') return 'integrity';
  if (input.timedOut || /timed? ?out|timeout|deadline/.test(m)) return 'timeout';
  if (input.offline) return 'offline';
  if (typeof input.status === 'number' && input.status >= 400) return 'http';
  if (/\bcors\b|cross-origin|access-control|blocked by/.test(m)) return 'cors';
  if (/out of memory|\boom\b|bad_alloc|allocation failed|array buffer allocation|memory access out of bounds/.test(m)) return 'memory';
  if (/wasm|webassembly|ort-wasm/.test(m)) return 'wasm';
  // A failed dynamic import is a module-load failure first (it may be the
  // network, CORS or a 404, but the actionable fact is "the runtime module").
  if (input.stage === 'runtime' && /import|module|syntax|loaded but had no/.test(m)) return 'module';
  if (/networkerror|failed to fetch|network request failed|load failed|err_(?:internet|name|connection|network)|net::/.test(m)) return 'network';
  if (input.stage === 'smoke inference' && /no usable text/.test(m)) return 'empty-output';
  return 'unknown';
}

export function isNetworkKind(kind: FailureKind | undefined): boolean {
  return kind !== undefined && NETWORKISH.includes(kind);
}

/** One line, bounded, no control characters, no URLs with query strings. */
export function cleanMessage(raw: unknown, max = 160): string {
  const text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : '';
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/(https?:\/\/[^\s?#"')]+)[?#][^\s"')]*/g, '$1').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

const KIND_TEXT: Record<FailureKind, string> = {
  offline: 'the browser is offline',
  timeout: 'it timed out',
  cors: 'a cross-origin (CORS) policy blocked it',
  http: 'the server returned an error',
  network: 'a network request failed',
  module: 'the AI runtime module could not be loaded',
  wasm: 'the ONNX WebAssembly runtime could not start',
  integrity: 'a downloaded file did not match its checksum',
  memory: 'the device ran out of memory',
  'empty-output': 'the model returned no usable text',
  unknown: 'it failed to start',
};

/** "SmolLM2-360M (WASM): download — a network request failed at cdn.example.com". */
export function describeAttempt(a: AttemptRecord): string {
  const where = a.backend ? ` (${a.backend === 'webgpu' ? 'WebGPU' : 'WASM'})` : '';
  const kind = a.kind ? KIND_TEXT[a.kind] : 'it failed to start';
  const at = a.host ? ` at ${a.host}${a.status ? ` (HTTP ${a.status})` : ''}` : a.status ? ` (HTTP ${a.status})` : '';
  return `${a.label}${where}: ${a.stage ?? 'start-up'} — ${kind}${at}`;
}

/** Concise message for the Settings card / loader: every failed attempt, not only the last. */
export function summarizeFailures(attempts: readonly AttemptRecord[]): string {
  const failed = attempts.filter((a) => !a.ok);
  if (failed.length === 0) return 'No on-device model could be started on this device.';
  const parts = failed.map(describeAttempt);
  const shown = parts.slice(0, 3).join('; ');
  return `No on-device model could be started. ${shown}${parts.length > 3 ? `; and ${parts.length - 3} more` : ''}.`;
}

// ── eligibility + recommendation ────────────────────────────────────────

const MODE_LABEL: Record<AiMode, string> = { best: 'Best quality', balanced: 'Balanced', fastest: 'Fastest', lightweight: 'Lightweight / data saver' };
const MODE_FOR_FAMILY: Record<ModelFamily, Exclude<AiMode, 'lightweight'>> = { 'qwen2.5-0.5b': 'best', 'smollm2-360m': 'balanced', 'smollm2-135m': 'fastest' };

export function modeLabel(mode: AiMode): string {
  return MODE_LABEL[mode];
}

/** Human-readable list of the candidates this mode may try on this device, in order. */
export function eligibleLabels(mode: AiMode, r: ResourceSnapshot): string[] {
  return buildCandidates(mode, r).map((c) => `${c.label} (${c.backend === 'webgpu' ? 'WebGPU' : 'WASM'}, about ${c.approxMb} MB)`);
}

/**
 * Suggests a different SAVED mode — never applies it. Only ever recommends a
 * local mode or data saver; never a cloud service. Returns null when nothing
 * would help (e.g. every failure was a network problem: a smaller model would
 * hit the same blocked host).
 */
export function recommendMode(mode: AiMode, attempts: readonly AttemptRecord[], passed: Candidate | null, r: ResourceSnapshot): Recommendation | null {
  if (mode === 'lightweight') return null;
  const failed = attempts.filter((a) => !a.ok && a.key !== 'runtime');

  if (passed) {
    if (failed.length === 0) return null;
    const target = MODE_FOR_FAMILY[passed.family];
    if (target === mode) return null;
    // Only suggest a mode whose FIRST pick is the model that actually worked.
    if (buildCandidates(target, r)[0]?.family !== passed.family) return null;
    const first = failed[0]!;
    return { mode: target, message: `${first.label} could not start. We recommend ${MODE_LABEL[target]} (${MODELS[passed.family].label}) on this device.` };
  }

  if (failed.length === 0 || failed.some((a) => isNetworkKind(a.kind))) return null;
  return { mode: 'lightweight', message: 'No local model could start on this device. We recommend Lightweight / data saver: it downloads nothing and keeps the rule-based reasons.' };
}

export function outcomeOf(attempts: readonly AttemptRecord[], passed: Candidate | null, firstEligibleKey: string | undefined): DiagnosticOutcome {
  if (!passed) return 'failed';
  return passed.key === firstEligibleKey && attempts.every((a) => a.ok || a.key === 'runtime') ? 'passed' : 'passed-fallback';
}

// ── report (privacy-safe) ───────────────────────────────────────────────

const OUTCOME_TEXT: Record<DiagnosticOutcome, string> = { passed: 'Passed', 'passed-fallback': 'Passed with fallback', failed: 'Failed', disabled: 'Not run (data saver)' };
export function outcomeLabel(o: DiagnosticOutcome): string {
  return OUTCOME_TEXT[o];
}

export interface ReportEnvironment {
  /** e.g. "Chrome 126" — a browser family/version only; never the full user-agent string. */
  browser: string;
  appVersion: string;
}

/** The text behind "Copy diagnostic report". Contains technical facts only:
 * no quiz answers, ratings, searches, tokens, cookies or storage contents. */
export function buildReport(r: DiagnosticResult, env: ReportEnvironment): string {
  const lines: string[] = [];
  lines.push(`Moodsift ${env.appVersion} — local AI diagnostic`);
  lines.push(`Result: ${outcomeLabel(r.outcome)}`);
  lines.push(`Mode: ${MODE_LABEL[r.mode]}`);
  lines.push(`Browser: ${env.browser}`);
  if (r.resources) {
    const x = r.resources;
    lines.push(
      `Device signals: memory ${x.deviceMemoryGb ?? 'unknown'} GB (estimate), ${x.cores} logical cores, ${x.mobile ? 'mobile/touch' : 'desktop'}, WebGPU adapter ${x.webgpuAdapter ? 'usable (shader-f16)' : x.webgpuApi ? 'unavailable' : 'API absent'}, cross-origin isolated ${x.crossOriginIsolated ? 'yes' : 'no'}`
    );
  }
  if (r.eligible.length) lines.push(`Eligible models: ${r.eligible.join(' → ')}`);
  if (r.model) lines.push(`Model: ${r.model.label} · ${r.model.backend === 'webgpu' ? 'WebGPU' : 'WASM/CPU'} · ${r.model.dtype} · about ${r.model.approxMb} MB · revision ${r.model.revision}`);
  if (r.integrity) lines.push(`Integrity: ${r.integrity.state}${r.integrity.reason ? ` (${r.integrity.reason})` : ''} — ${r.integrity.detail}`);
  if (typeof r.startupMs === 'number') lines.push(`Start-up: ${(r.startupMs / 1000).toFixed(1)} s`);
  if (typeof r.smokeMs === 'number') lines.push(`Smoke inference: ${(r.smokeMs / 1000).toFixed(1)} s`);
  if (r.quality) lines.push(`Quality check: ${r.quality.passed}/${r.quality.total} format checks passed (not a factuality test)`);
  if (r.attempts.length) {
    lines.push('Attempts:');
    for (const a of r.attempts) {
      const bits = [a.ok ? 'ok' : `failed at ${a.stage ?? 'start-up'}`];
      if (a.kind) bits.push(`kind=${a.kind}`);
      if (a.url) bits.push(`resource=${a.url}`);
      else if (a.host) bits.push(`host=${a.host}`);
      if (a.status) bits.push(`http=${a.status}`);
      if (typeof a.ms === 'number') bits.push(`${Math.round(a.ms)} ms`);
      if (a.message && !a.ok) bits.push(`detail=${a.message}`);
      lines.push(`  - ${a.label}${a.backend ? ` [${a.backend}${a.dtype ? `/${a.dtype}` : ''}${a.revision ? ` @${a.revision.slice(0, 7)}` : ''}]` : ''}: ${bits.join(', ')}`);
    }
  }
  if (r.recommendation) lines.push(`Recommendation: ${r.recommendation.message}`);
  return lines.join('\n');
}

/** "Chrome 126" from a user-agent string — family and major version only. */
export function browserFamily(ua: string): string {
  const pick = (re: RegExp, name: string) => {
    const m = re.exec(ua);
    return m ? `${name} ${m[1]}` : null;
  };
  return (
    pick(/Edg\/(\d+)/, 'Edge') ??
    pick(/OPR\/(\d+)/, 'Opera') ??
    pick(/Firefox\/(\d+)/, 'Firefox') ??
    pick(/(?:Chrome|CriOS)\/(\d+)/, 'Chrome') ??
    (ua.includes('Safari') ? pick(/Version\/(\d+)/, 'Safari') : null) ??
    'Unknown browser'
  );
}
