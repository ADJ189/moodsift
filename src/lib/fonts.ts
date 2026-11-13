// src/lib/fonts.ts
//
// Curated, self-hosted font presets (Fontsource). The default pairing
// (Sora + Manrope) is imported statically in main.ts so first paint has no
// third-party font request; every other family is loaded on demand, only
// when someone actually selects that preset. "System" needs nothing.
//
// Presets are identified by id — never an arbitrary family string or URL.

export type FontPresetId =
  | 'default'
  | 'modern-grotesk'
  | 'soft-minimal'
  | 'indie-editorial'
  | 'prestige-cinema'
  | 'polished-product'
  | 'studio-technical'
  | 'system';

export interface FontPreset {
  id: FontPresetId;
  label: string;
  blurb: string;
  display: string;
  body: string;
  mono: string;
  headingWeight: number;
  /** Lazy loaders for the font CSS this preset needs. */
  load: () => Promise<unknown>[];
}

const SYS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const MONO = "ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace";
const INTER = () => import('@fontsource-variable/inter/wght.css');

export const FONT_PRESETS: FontPreset[] = [
  {
    id: 'default',
    label: 'Moodsift Default',
    blurb: 'Sora + Manrope — geometric headings, warm neutral body.',
    display: `'Sora Variable', ${SYS}`,
    body: `'Manrope Variable', ${SYS}`,
    mono: MONO,
    headingWeight: 600,
    load: () => [], // statically imported in main.ts
  },
  {
    id: 'modern-grotesk',
    label: 'Modern Grotesk',
    blurb: 'Space Grotesk + Inter — distinctive, technical.',
    display: `'Space Grotesk Variable', ${SYS}`,
    body: `'Inter Variable', ${SYS}`,
    mono: MONO,
    headingWeight: 600,
    load: () => [import('@fontsource-variable/space-grotesk/wght.css'), INTER()],
  },
  {
    id: 'soft-minimal',
    label: 'Soft Minimal',
    blurb: 'Manrope + DM Sans — calm and approachable.',
    display: `'Manrope Variable', ${SYS}`,
    body: `'DM Sans Variable', ${SYS}`,
    mono: MONO,
    headingWeight: 700,
    load: () => [import('@fontsource-variable/manrope/wght.css'), import('@fontsource-variable/dm-sans/wght.css')],
  },
  {
    id: 'indie-editorial',
    label: 'Indie Editorial',
    blurb: 'Bricolage Grotesque + Inter — expressive headings.',
    display: `'Bricolage Grotesque Variable', ${SYS}`,
    body: `'Inter Variable', ${SYS}`,
    mono: MONO,
    headingWeight: 700,
    load: () => [import('@fontsource-variable/bricolage-grotesque/wght.css'), INTER()],
  },
  {
    id: 'prestige-cinema',
    label: 'Prestige Cinema',
    blurb: 'Fraunces + Inter — editorial serif headings.',
    display: `'Fraunces Variable', Georgia, 'Times New Roman', serif`,
    body: `'Inter Variable', ${SYS}`,
    mono: MONO,
    headingWeight: 600,
    load: () => [import('@fontsource-variable/fraunces/wght.css'), INTER()],
  },
  {
    id: 'polished-product',
    label: 'Polished Product',
    blurb: 'Plus Jakarta Sans + Inter — balanced, friendly.',
    display: `'Plus Jakarta Sans Variable', ${SYS}`,
    body: `'Inter Variable', ${SYS}`,
    mono: MONO,
    headingWeight: 700,
    load: () => [import('@fontsource-variable/plus-jakarta-sans/wght.css'), INTER()],
  },
  {
    id: 'studio-technical',
    label: 'Studio / Technical',
    blurb: 'IBM Plex Sans + Plex Mono for metadata.',
    display: `'IBM Plex Sans', ${SYS}`,
    body: `'IBM Plex Sans', ${SYS}`,
    mono: `'IBM Plex Mono', ${MONO}`,
    headingWeight: 600,
    load: () => [
      import('@fontsource/ibm-plex-sans/400.css'),
      import('@fontsource/ibm-plex-sans/500.css'),
      import('@fontsource/ibm-plex-sans/600.css'),
      import('@fontsource/ibm-plex-mono/400.css'),
    ],
  },
  {
    id: 'system',
    label: 'System / Fast',
    blurb: 'Your device\u2019s own fonts — no download at all.',
    display: SYS,
    body: SYS,
    mono: MONO,
    headingWeight: 600,
    load: () => [],
  },
];

export function getFontPreset(id: string): FontPreset {
  return FONT_PRESETS.find((p) => p.id === id) ?? FONT_PRESETS[0]!;
}

const loaded = new Set<FontPresetId>(['default', 'system']);

/** Loads a preset's font files once. Never throws: if the files fail to
 * load, the stacks above fall back to system fonts, so text stays visible. */
export async function ensureFontLoaded(id: FontPresetId): Promise<void> {
  if (loaded.has(id)) return;
  try {
    await Promise.all(getFontPreset(id).load());
    loaded.add(id);
  } catch {
    /* system fallback in the font stack keeps text readable */
  }
}
