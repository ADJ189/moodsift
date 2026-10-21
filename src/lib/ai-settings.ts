// src/lib/ai-settings.ts
//
// The user's "AI engine" priority. Stored under its own versioned key
// (`cinematch-local-ai:v1`), deliberately NOT inside the appearance
// preferences: "Reset all appearance", appearance undo/redo, saved looks and
// appearance export/import never read or write it, and it never travels with
// ratings, watchlist or profile data.
//
// Values are validated on every read — an unknown mode, a wrong version or
// corrupt JSON falls back to the default instead of throwing.
//
// This module only decides *which policy applies*. What each policy means for
// model order, resource guardrails and loading is in ai-policy.ts (pure) and
// ai-worker.ts (execution); see Moodsift-Local-AI-Engine-Policy.md.

import { safeGet, safeSet } from './storage';

export type AiMode = 'best' | 'balanced' | 'fastest' | 'lightweight';

export const AI_MODE_KEY = 'cinematch-local-ai:v1';
export const DEFAULT_AI_MODE: AiMode = 'balanced';

export interface AiModeOption {
  id: AiMode;
  label: string;
  /** One line shown next to the option. */
  summary: string;
  /** Longer explanation shown under the group for the selected option. */
  detail: string;
}

export const AI_MODE_OPTIONS: readonly AiModeOption[] = [
  {
    id: 'best',
    label: 'Best quality',
    summary: 'Strongest model your device can safely run.',
    detail:
      'Tries the strongest model allowed by device checks (Qwen2.5-0.5B where the device qualifies), then falls back to smaller ones. Larger download and higher memory/startup cost.',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    summary: 'Good writing without a big download. (Default)',
    detail:
      'Uses a mid-sized model (SmolLM2-360M) when eligible; falls back to the small SmolLM2-135M on constrained devices or if the first model cannot start.',
  },
  {
    id: 'fastest',
    label: 'Fastest',
    summary: 'Smallest tested model first.',
    detail:
      'Starts with the smallest model (SmolLM2-135M) for a lower download and start-up cost; explanations may be simpler. A larger model is only tried if it cannot start.',
  },
  {
    id: 'lightweight',
    label: 'Lightweight / data saver',
    summary: 'No AI download at all.',
    detail:
      'Does not download or run a model. Keeps rule-based explanations and does not use cloud AI.',
  },
];

const MODES: readonly AiMode[] = AI_MODE_OPTIONS.map((o) => o.id);

export function isAiMode(value: unknown): value is AiMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

let current: AiMode | null = null;
let persisted = true;
const listeners = new Set<(mode: AiMode) => void>();

function readStored(): AiMode {
  const raw = safeGet(AI_MODE_KEY);
  if (raw === null) return DEFAULT_AI_MODE;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as { version?: unknown; mode?: unknown };
      if (obj.version === 1 && isAiMode(obj.mode)) return obj.mode;
    }
  } catch {
    // Corrupt value — fall through to the default.
  }
  return DEFAULT_AI_MODE;
}

function notify(mode: AiMode): void {
  for (const fn of listeners) {
    try {
      fn(mode);
    } catch {
      // One misbehaving subscriber must not break the others.
    }
  }
}

export function getAiMode(): AiMode {
  if (current === null) current = readStored();
  return current;
}

/** False when the choice could not be written (private mode / blocked storage). */
export function isAiModePersisted(): boolean {
  return persisted;
}

export function setAiMode(next: AiMode): void {
  if (!isAiMode(next)) return;
  if (getAiMode() === next) return;
  current = next;
  persisted = safeSet(AI_MODE_KEY, JSON.stringify({ version: 1, mode: next }));
  notify(next);
}

/** Returns an unsubscribe function. */
export function subscribeAiMode(fn: (mode: AiMode) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// Another tab changed the mode: adopt it so every tab follows the stored
// choice, and let the engine reset itself.
window.addEventListener('storage', (e) => {
  if (e.key !== AI_MODE_KEY) return;
  const next = readStored();
  if (next === getAiMode()) return;
  current = next;
  notify(next);
});
