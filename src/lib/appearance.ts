// src/lib/appearance.ts
//
// The single source of truth for how Moodsift looks. Mode (system / dark /
// light) and palette are separate preferences; fonts, text size, density,
// motion and effects are curated presets — there is no raw CSS, no remote
// font URL and no arbitrary script surface. Preferences are validated on
// every read, persisted under one versioned key, applied through whitelisted
// data-* attributes + CSS variables, and never stored with (or sent
// alongside) ratings, watchlists or any other personal movie data.
//
// src/lib/theme.ts is a thin facade over this module, so there is exactly
// one place that touches `data-theme`.

import { ensureFontLoaded, FONT_PRESETS, getFontPreset, type FontPresetId } from './fonts';
import { safeGet, safeSet } from './storage';

// ── Types & option lists ──────────────────────────────────────────────

export type Mode = 'system' | 'dark' | 'light';
export type PaletteId =
  | 'aurora'
  | 'noir-gold'
  | 'oceanic'
  | 'ember'
  | 'forest'
  | 'velvet-rose'
  | 'indie-paper'
  | 'monochrome';
export type MotionProfile = 'system' | 'full' | 'subtle' | 'off';
export type ParticleLevel = 'off' | 'subtle' | 'balanced' | 'interactive';
/** Structure of each title card (see styles/cards.css). */
export type CardType = 'interactive' | 'poster' | 'editorial' | 'compact';
/** Shared surface treatment — border, glow and decorative language. */
export type DesignStyle = 'cinematic' | 'minimal' | 'film-journal' | 'glass' | 'neon-noir';
/** How live search suggestions are presented. Never changes what is searched. */
export type SearchType = 'grouped' | 'compact' | 'expanded' | 'full-page';

export interface AppearancePreferences {
  version: 1;
  mode: Mode;
  palette: PaletteId;
  fontPreset: FontPresetId;
  textScale: 90 | 100 | 110 | 125;
  lineSpacing: 'compact' | 'comfortable' | 'relaxed';
  contentWidth: 'compact' | 'comfortable' | 'wide';
  density: 'compact' | 'comfortable';
  posterSize: 'small' | 'medium' | 'large';
  cardShape: 'sharp' | 'standard' | 'rounded';
  surfaceStyle: 'solid' | 'glass';
  contrast: 'standard' | 'high';
  transparency: 'standard' | 'reduced';
  motion: MotionProfile;
  particles: ParticleLevel;
  // Visual direction — three independent presentation choices.
  cardType: CardType;
  designStyle: DesignStyle;
  searchType: SearchType;
  // Layout extras
  resultLayout: 'grid' | 'list' | 'spotlight';
  shadows: 'minimal' | 'standard' | 'expressive';
  grain: 'off' | 'subtle';
  posterLabels: 'essential' | 'detailed';
  // Advanced effects (all bounded; Off always wins; see effective*())
  particleDensity: 'low' | 'medium' | 'high';
  connections: 'off' | 'faint' | 'normal';
  pointerResponse: 'off' | 'gentle' | 'noticeable';
  clickPulse: 'off' | 'on';
  posterTilt: 'off' | 'gentle';
  hoverGlow: 'off' | 'subtle' | 'strong';
  transitionIntensity: 'minimal' | 'standard' | 'cinematic';
  artworkAmbience: 'off' | 'subtle' | 'balanced';
  /** Validated #rrggbb only. */
  customAccent?: string;
}

export interface PaletteInfo {
  id: PaletteId;
  label: string;
  mood: string;
  /** [dark bg, dark accent, dark accent 2, light bg, light accent, light accent 2] — preview swatches only. */
  swatch: [string, string, string, string, string, string];
}

export const PALETTES: PaletteInfo[] = [
  { id: 'aurora', label: 'Cinema Aurora', mood: 'Cinematic, atmospheric', swatch: ['#07050f', '#a78bfa', '#22d3ee', '#f7f3ee', '#7c5cf0', '#0b7d8f'] },
  { id: 'noir-gold', label: 'Noir & Gold', mood: 'Classic cinema, prestige', swatch: ['#0b0a08', '#d9b44a', '#efe3c0', '#f6f2e9', '#8a6414', '#5c4a1c'] },
  { id: 'oceanic', label: 'Oceanic', mood: 'Calm, modern, precise', swatch: ['#050d14', '#38bdf8', '#2dd4bf', '#edf5f8', '#0369a1', '#0f766e'] },
  { id: 'ember', label: 'Ember / Sunset', mood: 'Warm and expressive', swatch: ['#0f0709', '#fb7185', '#fbbf24', '#fbf2ec', '#c2410c', '#a16207'] },
  { id: 'forest', label: 'Forest / Jade', mood: 'Calm and natural', swatch: ['#050d09', '#34d399', '#a7f3d0', '#edf4ee', '#047857', '#15803d'] },
  { id: 'velvet-rose', label: 'Velvet Rose', mood: 'Stylish, dramatic', swatch: ['#0e0612', '#f472b6', '#c4b5fd', '#faf0f5', '#be185d', '#6d28d9'] },
  { id: 'indie-paper', label: 'Indie Paper', mood: 'Editorial film journal', swatch: ['#14100b', '#e08a5c', '#b5c273', '#f5efe0', '#a8481f', '#56601f'] },
  { id: 'monochrome', label: 'Monochrome / AMOLED', mood: 'Minimal, low distraction', swatch: ['#000000', '#ffffff', '#a3a3a3', '#ffffff', '#171717', '#404040'] },
];

export const DEFAULT_PREFERENCES: AppearancePreferences = {
  version: 1,
  mode: 'system',
  palette: 'aurora',
  fontPreset: 'default',
  textScale: 100,
  lineSpacing: 'comfortable',
  contentWidth: 'comfortable',
  density: 'comfortable',
  posterSize: 'medium',
  cardShape: 'rounded',
  surfaceStyle: 'solid',
  contrast: 'standard',
  transparency: 'standard',
  motion: 'system',
  particles: 'balanced',
  cardType: 'interactive',
  designStyle: 'cinematic',
  searchType: 'grouped',
  resultLayout: 'grid',
  shadows: 'standard',
  grain: 'subtle',
  posterLabels: 'detailed',
  particleDensity: 'medium',
  connections: 'normal',
  pointerResponse: 'gentle',
  clickPulse: 'off',
  posterTilt: 'gentle',
  hoverGlow: 'subtle',
  transitionIntensity: 'standard',
  artworkAmbience: 'subtle',
};

const STORAGE_KEY = 'cinematch-appearance:v1';
const LEGACY_THEME_KEY = 'cinematch-theme';
const HISTORY_CAP = 20;

// ── Validation ────────────────────────────────────────────────────────

const oneOf = <T extends string | number>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

const HEX = /^#[0-9a-fA-F]{6}$/;

export function isValidHex(v: unknown): v is string {
  return typeof v === 'string' && HEX.test(v);
}

/** The single allow-list of option values per field. sanitizePreferences()
 * (forgiving: bad values fall back) and validatePreferencesStrict() (used by
 * import: bad values reject the whole file) both read from this table, so
 * the two can never disagree about what is valid. */
const FIELD_OPTIONS = {
  mode: ['system', 'dark', 'light'],
  palette: PALETTES.map((p) => p.id),
  fontPreset: FONT_PRESETS.map((p) => p.id),
  textScale: [90, 100, 110, 125],
  lineSpacing: ['compact', 'comfortable', 'relaxed'],
  contentWidth: ['compact', 'comfortable', 'wide'],
  density: ['compact', 'comfortable'],
  posterSize: ['small', 'medium', 'large'],
  cardShape: ['sharp', 'standard', 'rounded'],
  surfaceStyle: ['solid', 'glass'],
  contrast: ['standard', 'high'],
  transparency: ['standard', 'reduced'],
  motion: ['system', 'full', 'subtle', 'off'],
  particles: ['off', 'subtle', 'balanced', 'interactive'],
  cardType: ['interactive', 'poster', 'editorial', 'compact'],
  designStyle: ['cinematic', 'minimal', 'film-journal', 'glass', 'neon-noir'],
  searchType: ['grouped', 'compact', 'expanded', 'full-page'],
  resultLayout: ['grid', 'list', 'spotlight'],
  shadows: ['minimal', 'standard', 'expressive'],
  grain: ['off', 'subtle'],
  posterLabels: ['essential', 'detailed'],
  particleDensity: ['low', 'medium', 'high'],
  connections: ['off', 'faint', 'normal'],
  pointerResponse: ['off', 'gentle', 'noticeable'],
  clickPulse: ['off', 'on'],
  posterTilt: ['off', 'gentle'],
  hoverGlow: ['off', 'subtle', 'strong'],
  transitionIntensity: ['minimal', 'standard', 'cinematic'],
  artworkAmbience: ['off', 'subtle', 'balanced'],
} as const satisfies Record<string, readonly (string | number)[]>;

type OptionKey = keyof typeof FIELD_OPTIONS;
const OPTION_KEYS = Object.keys(FIELD_OPTIONS) as OptionKey[];

/** Rebuilds a preferences object field by field from untrusted input.
 * Unknown values fall back to defaults; an unknown future version is
 * rejected outright (returns defaults) rather than half-applied. */
export function sanitizePreferences(raw: unknown): AppearancePreferences {
  const d = DEFAULT_PREFERENCES;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...d };
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return { ...d };
  const out: Record<string, unknown> = { version: 1 };
  for (const key of OPTION_KEYS) {
    out[key] = oneOf(r[key], FIELD_OPTIONS[key] as readonly (string | number)[], d[key] as string | number);
  }
  const prefs = out as unknown as AppearancePreferences;
  if (isValidHex(r.customAccent)) prefs.customAccent = r.customAccent.toLowerCase();
  return prefs;
}

/** Import-grade validation: the file must be exactly the expected shape.
 * Unknown keys, wrong types and out-of-list values all reject the file —
 * nothing is "best-effort" applied. */
export function validatePreferencesStrict(raw: unknown): { ok: true; prefs: AppearancePreferences } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'The file is not an appearance export.' };
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return { ok: false, error: 'Unsupported appearance file version.' };
  const allowed = new Set<string>(['version', 'customAccent', ...OPTION_KEYS]);
  for (const k of Object.keys(r)) if (!allowed.has(k)) return { ok: false, error: `Unknown setting “${k.slice(0, 40)}”.` };
  for (const key of OPTION_KEYS) {
    if (r[key] === undefined) continue; // older exports may lack newer settings; defaults fill in
    if (!(FIELD_OPTIONS[key] as readonly (string | number)[]).includes(r[key] as string | number)) return { ok: false, error: `Invalid value for “${key}”.` };
  }
  if (r.customAccent !== undefined && !isValidHex(r.customAccent)) return { ok: false, error: 'Invalid accent colour.' };
  return { ok: true, prefs: sanitizePreferences(r) };
}

// ── Colour helpers (accent safety) ────────────────────────────────────

function luminance(hex: string): number {
  const h = hex.slice(1);
  const ch = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const DARK_INK = '#0a0714';

/** The text colour that reads best on a given accent, plus whether even the
 * best choice clears WCAG AA (4.5:1) — the settings UI warns when it doesn't. */
export function accentForeground(accent: string): { color: string; ratio: number; ok: boolean } {
  const onDark = contrastRatio(DARK_INK, accent);
  const onWhite = contrastRatio('#ffffff', accent);
  const color = onDark >= onWhite ? DARK_INK : '#ffffff';
  const ratio = Math.max(onDark, onWhite);
  return { color, ratio, ok: ratio >= 4.5 };
}

// ── State ─────────────────────────────────────────────────────────────

type Listener = (prefs: AppearancePreferences) => void;

let prefs: AppearancePreferences = { ...DEFAULT_PREFERENCES };
let persisted = true; // false once a save fails (blocked storage)
let undoStack: AppearancePreferences[] = [];
let redoStack: AppearancePreferences[] = [];
let started = false;
let saveTimer: number | null = null;
const listeners = new Set<Listener>();
const mqDark = safeMatchMedia('(prefers-color-scheme: dark)');
const mqLight = safeMatchMedia('(prefers-color-scheme: light)');
const mqReduce = safeMatchMedia('(prefers-reduced-motion: reduce)');
const mqCoarse = safeMatchMedia('(pointer: coarse)');

function safeMatchMedia(q: string): MediaQueryList | null {
  try {
    return window.matchMedia(q);
  } catch {
    return null;
  }
}

function load(): AppearancePreferences {
  const raw = safeGet(STORAGE_KEY);
  if (raw) {
    try {
      return sanitizePreferences(JSON.parse(raw));
    } catch {
      return { ...DEFAULT_PREFERENCES };
    }
  }
  // First run of the new system: carry the old explicit light/dark choice
  // over once. The legacy key is never read again once new prefs exist.
  const legacy = safeGet(LEGACY_THEME_KEY);
  if (legacy === 'dark' || legacy === 'light') return { ...DEFAULT_PREFERENCES, mode: legacy };
  return { ...DEFAULT_PREFERENCES };
}

function save(immediate = false): void {
  const write = () => {
    saveTimer = null;
    persisted = safeSet(STORAGE_KEY, JSON.stringify(prefs));
    notify();
  };
  if (immediate) {
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    write();
    return;
  }
  // Sliders and pickers fire continuously — preview instantly, persist once.
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(write, 350);
}

function notify(): void {
  for (const l of listeners) l(prefs);
}

/** Writes any debounced change immediately. Called when the page is being
 * hidden/closed so a choice made a moment before a reload or tab close is
 * never lost to the debounce. */
export function flushAppearanceSave(): void {
  if (saveTimer === null) return;
  window.clearTimeout(saveTimer);
  saveTimer = null;
  persisted = safeSet(STORAGE_KEY, JSON.stringify(prefs));
}

// ── Effective (resolved) values ───────────────────────────────────────

export function effectiveMode(p: AppearancePreferences = displayedPreferences()): 'dark' | 'light' {
  if (p.mode !== 'system') return p.mode;
  if (mqLight?.matches) return 'light';
  if (mqDark?.matches) return 'dark';
  return 'dark';
}

export function systemRequestsReducedMotion(): boolean {
  return mqReduce?.matches ?? false;
}

/** System behaves like Subtle, except non-essential continuous/large
 * movement is off when the OS asks for reduced motion. */
export function effectiveMotion(p: AppearancePreferences = displayedPreferences()): 'full' | 'subtle' | 'off' {
  if (p.motion === 'system') return systemRequestsReducedMotion() ? 'off' : 'subtle';
  return p.motion;
}

const LEVELS: ParticleLevel[] = ['off', 'subtle', 'balanced', 'interactive'];

function isLowPower(): boolean {
  const cores = navigator.hardwareConcurrency || 4;
  const mobile = /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent);
  return mobile || cores <= 2;
}

/** The hero particle level actually used. A user-selected Off always wins;
 * otherwise the level adapts *downward* on touch and low-power devices. */
/** Density multiplier; "high" is desktop-only and strictly bounded. */
export function effectiveDensity(p: AppearancePreferences = displayedPreferences()): 'low' | 'medium' | 'high' {
  if ((isCoarsePointer() || isLowPower()) && p.particleDensity === 'high') return 'medium';
  return p.particleDensity;
}

export function effectiveParticles(p: AppearancePreferences = displayedPreferences()): ParticleLevel {
  if (p.particles === 'off' || effectiveMotion(p) === 'off') return 'off';
  let level = LEVELS.indexOf(p.particles);
  if (mqCoarse?.matches) level = Math.min(level, LEVELS.indexOf('balanced')); // no pointer response without a hover pointer
  if (isLowPower()) level = Math.min(level, LEVELS.indexOf('subtle'));
  return LEVELS[level]!;
}

export function isCoarsePointer(): boolean {
  return mqCoarse?.matches ?? false;
}

export type Tilt = 'off' | 'gentle';
/** Tilt needs a hover-capable pointer and real motion; otherwise Off. */
export function effectiveTilt(p: AppearancePreferences = displayedPreferences()): Tilt {
  if (p.posterTilt === 'off' || effectiveMotion(p) === 'off' || isCoarsePointer()) return 'off';
  return 'gentle';
}

/** Artwork ambience adapts down on touch / low-power devices, never up,
 * and a user-selected Off always wins. The static (non-animated) halo is
 * still allowed under reduced motion. */
export function effectiveAmbience(p: AppearancePreferences = displayedPreferences()): 'off' | 'subtle' | 'balanced' {
  if (p.artworkAmbience === 'off') return 'off';
  if ((isCoarsePointer() || isLowPower()) && p.artworkAmbience === 'balanced') return 'subtle';
  return p.artworkAmbience;
}

/** What the page is *showing*: the live preferences, or — while "Compare
 * with before" is on — the baseline being previewed. Everything that
 * resolves effective values (mode, motion, particles, tilt, …) reads this,
 * so the hero canvas and other JS-driven effects follow the preview exactly
 * like the CSS does, without any of it being saved. */
export function displayedPreferences(): AppearancePreferences {
  return peeking && baseline ? baseline : prefs;
}

export function getPreferences(): AppearancePreferences {
  return prefs;
}

/** False when storage is blocked: the UI must not claim a save happened. */
export function isAppearancePersisted(): boolean {
  return persisted;
}

// ── Applying to the document ──────────────────────────────────────────

const LINE_HEIGHT = { compact: 1.45, comfortable: 1.6, relaxed: 1.8 } as const;

export function applyPreferences(p: AppearancePreferences = prefs): void {
  const root = document.documentElement;
  const mode = effectiveMode(p);
  root.setAttribute('data-theme', mode);
  root.setAttribute('data-palette', p.palette);
  root.setAttribute('data-font', p.fontPreset);
  root.setAttribute('data-density', p.density);
  root.setAttribute('data-width', p.contentWidth);
  root.setAttribute('data-shape', p.cardShape);
  root.setAttribute('data-poster', p.posterSize);
  root.setAttribute('data-surface', p.surfaceStyle);
  root.setAttribute('data-contrast', p.contrast);
  root.setAttribute('data-transparency', p.transparency);
  root.setAttribute('data-motion', effectiveMotion(p));
  root.setAttribute('data-results-layout', p.resultLayout);
  root.setAttribute('data-card-type', p.cardType);
  root.setAttribute('data-design-style', p.designStyle);
  root.setAttribute('data-search-type', p.searchType);
  root.setAttribute('data-shadows', p.shadows);
  root.setAttribute('data-grain', p.grain);
  root.setAttribute('data-labels', p.posterLabels);
  root.setAttribute('data-glow', p.hoverGlow);
  root.setAttribute('data-tilt', effectiveTilt(p));
  root.setAttribute('data-transition', p.transitionIntensity);
  root.setAttribute('data-ambience', effectiveAmbience(p));
  root.style.colorScheme = mode;

  const preset = getFontPreset(p.fontPreset);
  root.style.setProperty('--font-display', preset.display);
  root.style.setProperty('--font-body', preset.body);
  root.style.setProperty('--font-mono', preset.mono);
  root.style.setProperty('--heading-weight', String(preset.headingWeight));
  root.style.setProperty('--text-scale', String(p.textScale / 100));
  root.style.setProperty('--line-body', String(LINE_HEIGHT[p.lineSpacing]));
  void ensureFontLoaded(p.fontPreset);

  if (p.customAccent && isValidHex(p.customAccent)) {
    root.setAttribute('data-accent', 'custom');
    root.style.setProperty('--user-accent', p.customAccent);
    root.style.setProperty('--user-on-accent', accentForeground(p.customAccent).color);
  } else {
    root.removeAttribute('data-accent');
    root.style.removeProperty('--user-accent');
    root.style.removeProperty('--user-on-accent');
  }

  syncBrowserChrome(root);
}

/** Keeps the browser UI colour, form controls and the pre-paint boot
 * background in step with the palette that is actually showing. */
function syncBrowserChrome(root: HTMLElement): void {
  const bg = getComputedStyle(root).getPropertyValue('--bg-0').trim();
  if (!bg) return;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m, i) => {
    if (i > 0) m.remove(); // the media-split pair from index.html is replaced by one live tag
  });
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.removeAttribute('media');
    meta.setAttribute('content', bg);
  }
  root.style.setProperty('--boot-bg', bg);
}

// ── Public mutations ──────────────────────────────────────────────────

function commit(next: AppearancePreferences, opts: { history?: boolean; immediate?: boolean } = {}): void {
  if (JSON.stringify(next) === JSON.stringify(prefs)) return;
  peeking = false;
  if (opts.history !== false) {
    undoStack.push(prefs);
    if (undoStack.length > HISTORY_CAP) undoStack.shift();
    redoStack = [];
  }
  prefs = next;
  applyPreferences(prefs);
  save(opts.immediate ?? false);
  notify();
}

/** Merges a validated patch; preview is instant, persistence is debounced. */
export function updatePreferences(patch: Partial<Omit<AppearancePreferences, 'version'>>, opts: { history?: boolean; immediate?: boolean } = {}): void {
  const merged = sanitizePreferences({ ...prefs, ...patch, version: 1 });
  // sanitize drops an invalid customAccent, but an explicit `undefined`
  // in the patch must also clear a previously valid one.
  if ('customAccent' in patch && patch.customAccent === undefined) delete merged.customAccent;
  commit(merged, opts);
}

export type ResetSection = 'themes' | 'typography' | 'layout' | 'search' | 'motion' | 'accessibility';

const SECTION_KEYS: Record<ResetSection, (keyof AppearancePreferences)[]> = {
  themes: ['mode', 'palette', 'customAccent', 'designStyle'],
  typography: ['fontPreset', 'textScale', 'lineSpacing'],
  layout: ['contentWidth', 'density', 'posterSize', 'cardShape', 'surfaceStyle', 'cardType', 'resultLayout', 'shadows', 'grain', 'posterLabels'],
  search: ['searchType'],
  motion: ['motion', 'particles', 'particleDensity', 'connections', 'pointerResponse', 'clickPulse', 'posterTilt', 'hoverGlow', 'transitionIntensity', 'artworkAmbience'],
  accessibility: ['contrast', 'transparency'],
};

export function resetSection(section: ResetSection): void {
  const next: AppearancePreferences = { ...prefs };
  for (const key of SECTION_KEYS[section]) {
    if (key === 'customAccent') delete next.customAccent;
    else (next as unknown as Record<string, unknown>)[key] = DEFAULT_PREFERENCES[key];
  }
  commit(sanitizePreferences(next), { immediate: true });
}

/** Appearance only — never touches ratings, watchlist, profile or quiz state. */
export function resetAllAppearance(): void {
  commit({ ...DEFAULT_PREFERENCES }, { immediate: true });
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}
export function canRedo(): boolean {
  return redoStack.length > 0;
}

export function undo(): void {
  const prev = undoStack.pop();
  if (!prev) return;
  peeking = false;
  redoStack.push(prefs);
  prefs = prev;
  applyPreferences(prefs);
  save(true);
  notify();
}

export function redo(): void {
  const next = redoStack.pop();
  if (!next) return;
  peeking = false;
  undoStack.push(prefs);
  prefs = next;
  applyPreferences(prefs);
  save(true);
  notify();
}

/** Curated random look: palette + (sometimes) a font preset. Never touches
 * semantic colours, accessibility or motion settings. */
export function randomizePalette(): void {
  const others = PALETTES.filter((p) => p.id !== prefs.palette);
  const palette = others[Math.floor(Math.random() * others.length)]!.id;
  const fonts = FONT_PRESETS.filter((f) => f.id !== 'system');
  const fontPreset = fonts[Math.floor(Math.random() * fonts.length)]!.id;
  commit(sanitizePreferences({ ...prefs, palette, fontPreset, customAccent: undefined }), { immediate: true });
}

/** Quick header toggle: flips what is *currently showing* to an explicit
 * Light/Dark, so the choice stops following the OS afterwards. */
export function toggleQuickMode(): 'dark' | 'light' {
  const next = effectiveMode() === 'dark' ? 'light' : 'dark';
  updatePreferences({ mode: next }, { immediate: true });
  return next;
}

export function subscribeAppearance(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ── Startup ───────────────────────────────────────────────────────────

/** Call once, before the first app content is mounted. */
export function initAppearance(): void {
  if (started) return;
  started = true;
  prefs = load();
  applyPreferences(prefs);

  // Live OS changes: System mode follows colour scheme; System motion
  // follows reduced-motion. Explicit choices are never overridden.
  window.addEventListener('pagehide', flushAppearanceSave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAppearanceSave();
  });

  const onSystemChange = () => {
    peeking = false;
    applyPreferences(prefs);
    notify();
  };
  for (const mq of [mqDark, mqLight, mqReduce, mqCoarse]) {
    if (!mq) continue;
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onSystemChange);
    else (mq as MediaQueryList).addListener?.(onSystemChange);
  }
}

// ── "Choose your vibe" (one-time, skippable) ──────────────────────────

const VIBE_KEY = 'cinematch-vibe:v1';

export interface Vibe {
  id: 'cinematic' | 'minimal' | 'editorial' | 'neon';
  label: string;
  blurb: string;
  patch: Partial<AppearancePreferences>;
}

export const VIBES: Vibe[] = [
  { id: 'cinematic', label: 'Cinematic', blurb: 'Aurora, subtle motion, balanced particles.', patch: { palette: 'aurora', fontPreset: 'default', motion: 'subtle', particles: 'balanced' } },
  { id: 'minimal', label: 'Minimal', blurb: 'Monochrome, system font, calm.', patch: { palette: 'monochrome', fontPreset: 'system', motion: 'subtle', particles: 'off', surfaceStyle: 'solid' } },
  { id: 'editorial', label: 'Editorial', blurb: 'Paper tones, serif headings, quiet motion.', patch: { palette: 'indie-paper', fontPreset: 'prestige-cinema', motion: 'subtle', particles: 'subtle' } },
  { id: 'neon', label: 'Neon', blurb: 'Aurora with interactive particles.', patch: { palette: 'aurora', fontPreset: 'modern-grotesk', motion: 'full', particles: 'interactive' } },
];

export function vibeAlreadyHandled(): boolean {
  return safeGet(VIBE_KEY) !== null;
}

export function markVibeHandled(choice: string): void {
  safeSet(VIBE_KEY, choice);
}

/** Applies a vibe as ordinary preferences. Accessibility wins: an OS
 * reduced-motion request still keeps System-resolved motion off unless the
 * person later chooses otherwise, so vibes never force motion on. */
export function applyVibe(id: Vibe['id']): void {
  const vibe = VIBES.find((v) => v.id === id);
  if (!vibe) return;
  const patch = { ...vibe.patch };
  if (systemRequestsReducedMotion()) delete patch.motion;
  updatePreferences(patch, { immediate: true });
  markVibeHandled(id);
}


// ── Starter presets (Settings → Overview) ─────────────────────────────
// Convenience actions, not modes: each one writes ordinary preference
// values, after which every field can still be changed on its own. They
// never touch text size, contrast, transparency, AI mode or any personal data.

export interface StarterPreset {
  id: 'cinematic' | 'minimal' | 'film-journal' | 'performance';
  label: string;
  blurb: string;
  patch: Partial<AppearancePreferences>;
}

export const STARTER_PRESETS: StarterPreset[] = [
  {
    id: 'cinematic',
    label: 'Cinematic',
    blurb: 'Interactive cards, cinematic design, grouped search.',
    patch: { cardType: 'interactive', designStyle: 'cinematic', searchType: 'grouped', resultLayout: 'grid' },
  },
  {
    id: 'minimal',
    label: 'Minimal',
    blurb: 'Compact cards, flat surfaces, quiet effects.',
    patch: {
      cardType: 'compact', designStyle: 'minimal', searchType: 'compact', resultLayout: 'grid',
      posterLabels: 'essential', posterTilt: 'off', hoverGlow: 'off', artworkAmbience: 'off', shadows: 'minimal',
    },
  },
  {
    id: 'film-journal',
    label: 'Film journal',
    blurb: 'Editorial cards, journal typography, roomy layout.',
    patch: {
      cardType: 'editorial', designStyle: 'film-journal', searchType: 'expanded', resultLayout: 'grid',
      density: 'comfortable', posterSize: 'large', posterLabels: 'detailed',
    },
  },
  {
    id: 'performance',
    label: 'Performance',
    blurb: 'Light on effects for older or low-power devices.',
    patch: {
      cardType: 'compact', designStyle: 'minimal', searchType: 'compact', resultLayout: 'grid',
      posterTilt: 'off', hoverGlow: 'off', artworkAmbience: 'off', shadows: 'minimal', grain: 'off',
      particles: 'off', transitionIntensity: 'minimal',
    },
  },
];

/** Applies a starter preset as one undoable change. A preset may ask for
 * less motion but never forces motion on: the Motion profile is left alone. */
export function applyStarterPreset(id: StarterPreset['id']): void {
  const preset = STARTER_PRESETS.find((x) => x.id === id);
  if (!preset) return;
  updatePreferences({ ...preset.patch }, { immediate: true });
}

/** The preset whose every value matches the current preferences, if any. */
export function matchingStarterPreset(p: AppearancePreferences = prefs): StarterPreset['id'] | null {
  const hit = STARTER_PRESETS.find((x) => Object.entries(x.patch).every(([k, v]) => (p as unknown as Record<string, unknown>)[k] === v));
  return hit ? hit.id : null;
}

// ── Compare / restore (Theme Studio) ──────────────────────────────────

let baseline: AppearancePreferences | null = null;
let peeking = false;

/** Remembers the appearance at the moment the settings panel opened, so
 * "Restore previous appearance" has a meaningful target. */
export function markAppearanceBaseline(): void {
  baseline = { ...prefs };
}

export function hasBaselineDifference(): boolean {
  return !!baseline && JSON.stringify(baseline) !== JSON.stringify(prefs);
}

export function restoreBaseline(): void {
  if (baseline) commit({ ...baseline }, { immediate: true });
}

/** Before/After: while on, the page shows the appearance from the panel's
 * baseline *without* changing or saving anything; turning it off puts the
 * live appearance back exactly. Safe to leave on when closing — callers
 * must call peek(false) on close. */
export function peekBaseline(on: boolean): void {
  if (on === peeking) return;
  if (on && !baseline) return;
  peeking = on;
  applyPreferences(on ? baseline! : prefs);
  notify();
}

export function isPeeking(): boolean {
  return peeking;
}

// ── Saved looks (up to three) + versioned export / import ─────────────
// Looks are appearance fields only — never ratings, watchlist or profile.

export interface SavedLook {
  id: string;
  name: string;
  prefs: AppearancePreferences;
}

const LOOKS_KEY = 'cinematch-looks:v1';
export const MAX_LOOKS = 3;
const MAX_IMPORT_BYTES = 8 * 1024;

export function listLooks(): SavedLook[] {
  const raw = safeGet(LOOKS_KEY);
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as unknown;
    if (typeof data !== 'object' || data === null || (data as { version?: unknown }).version !== 1) return [];
    const looks = (data as { looks?: unknown }).looks;
    if (!Array.isArray(looks)) return [];
    const out: SavedLook[] = [];
    for (const l of looks.slice(0, MAX_LOOKS)) {
      if (typeof l !== 'object' || l === null) continue;
      const { id, name, prefs: p } = l as Record<string, unknown>;
      if (typeof id !== 'string' || typeof name !== 'string') continue;
      out.push({ id: id.slice(0, 40), name: cleanName(name), prefs: sanitizePreferences(p) });
    }
    return out;
  } catch {
    return [];
  }
}

function cleanName(name: string): string {
  return Array.from(name, (ch) => (ch.charCodeAt(0) < 32 ? ' ' : ch)).join('').trim().slice(0, 24) || 'My look';
}

function writeLooks(looks: SavedLook[]): boolean {
  return safeSet(LOOKS_KEY, JSON.stringify({ version: 1, looks }));
}

/** Saves the current appearance under a name. Returns an error string if it
 * can't (limit reached, storage blocked). */
export function saveLook(name: string): { ok: true; look: SavedLook } | { ok: false; error: string } {
  const looks = listLooks();
  if (looks.length >= MAX_LOOKS) return { ok: false, error: `You can keep up to ${MAX_LOOKS} looks. Delete one first.` };
  const look: SavedLook = { id: `look-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36)}`, name: cleanName(name), prefs: { ...prefs } };
  if (!writeLooks([...looks, look])) return { ok: false, error: 'Couldn\u2019t save \u2014 browser storage is blocked.' };
  notify();
  return { ok: true, look };
}

export function deleteLook(id: string): void {
  writeLooks(listLooks().filter((l) => l.id !== id));
  notify();
}

export function applyLook(id: string): boolean {
  const look = listLooks().find((l) => l.id === id);
  if (!look) return false;
  commit({ ...look.prefs }, { immediate: true });
  return true;
}

/** Appearance-only JSON. Contains no media history, ratings or profile. */
export function exportAppearance(): string {
  return JSON.stringify({ app: 'cinematch-appearance', version: 1, preferences: prefs }, null, 2);
}

/** Validates strictly, then applies as one undoable change. */
export function importAppearance(text: string): { ok: true } | { ok: false; error: string } {
  if (new Blob([text]).size > MAX_IMPORT_BYTES) return { ok: false, error: 'That file is too large to be an appearance export.' };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That isn\u2019t valid JSON.' };
  }
  if (typeof data !== 'object' || data === null || (data as { app?: unknown }).app !== 'cinematch-appearance') {
    return { ok: false, error: 'That isn\u2019t a Moodsift appearance export.' };
  }
  const result = validatePreferencesStrict((data as { preferences?: unknown }).preferences);
  if (!result.ok) return result;
  commit({ ...result.prefs }, { immediate: true });
  return { ok: true };
}
