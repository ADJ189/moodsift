// src/lib/settings-panel.ts
//
// The Settings workspace: a right-hand drawer (a full-height sheet on phones)
// with a navigation rail, one task-based section at a time, live preview,
// auto-save and full reversibility. It is built once; controls are *synced*
// (attributes toggled) on every preference change rather than re-rendered, so
// keyboard focus never jumps while an option is being tried. It never
// remounts the screen underneath and never touches ratings, watchlist,
// profile or quiz state. AI mode is stored separately (see ai-settings.ts) and
// is deliberately outside appearance undo/redo, looks, export and reset.

import { AI_MODE_OPTIONS, getAiMode, isAiModePersisted, setAiMode, subscribeAiMode } from './ai-settings';
import { MODELS } from './ai-policy';
import { trapFocus } from './a11y';
import {
  accentForeground,
  applyLook,
  applyStarterPreset,
  applyVibe,
  canRedo,
  canUndo,
  contrastRatio,
  DEFAULT_PREFERENCES,
  deleteLook,
  effectiveMode,
  exportAppearance,
  getPreferences,
  hasBaselineDifference,
  importAppearance,
  isAppearancePersisted,
  isCoarsePointer,
  isPeeking,
  isValidHex,
  listLooks,
  markAppearanceBaseline,
  matchingStarterPreset,
  MAX_LOOKS,
  PALETTES,
  peekBaseline,
  randomizePalette,
  redo,
  resetAllAppearance,
  resetSection,
  restoreBaseline,
  saveLook,
  STARTER_PRESETS,
  subscribeAppearance,
  systemRequestsReducedMotion,
  undo,
  updatePreferences,
  VIBES,
  type AppearancePreferences,
  type ResetSection,
} from './appearance';
import { el } from './dom';
import { ensureFontLoaded, FONT_PRESETS } from './fonts';
import { ICON } from './icons';
import { cardPreview, layoutPreview, searchPreview, stylePreview } from './settings-previews';
import { showToast } from './toast';

export type SettingsSection = 'overview' | 'cards' | 'search' | 'theme' | 'readability' | 'motion' | 'ai' | 'advanced';
/** Names used before the workspace redesign; still accepted by callers. */
type LegacyTab = 'themes' | 'typography' | 'layout' | 'accessibility';
const LEGACY: Record<LegacyTab, SettingsSection> = { themes: 'theme', typography: 'readability', layout: 'cards', accessibility: 'readability' };

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'cards', label: 'Cards & layout' },
  { id: 'search', label: 'Search' },
  { id: 'theme', label: 'Theme' },
  { id: 'readability', label: 'Readability' },
  { id: 'motion', label: 'Motion & performance' },
  { id: 'ai', label: 'AI engine' },
  { id: 'advanced', label: 'Advanced' },
];

const ACCENT_CHOICES = ['#a78bfa', '#38bdf8', '#34d399', '#fbbf24', '#fb7185', '#f472b6', '#e08a5c'];

interface TileOption<V> {
  value: V;
  label: string;
  desc: string;
  preview?: () => HTMLElement;
}

const CARD_OPTIONS: TileOption<AppearancePreferences['cardType']>[] = [
  { value: 'interactive', label: 'Interactive', desc: 'Poster-first. Actions and a quick look appear on hover or focus.', preview: () => cardPreview('interactive') },
  { value: 'poster', label: 'Poster gallery', desc: 'Artwork leads, with a title and year underneath. Great for browsing.', preview: () => cardPreview('poster') },
  { value: 'editorial', label: 'Editorial', desc: 'Roomier cards with a short synopsis and the main action.', preview: () => cardPreview('editorial') },
  { value: 'compact', label: 'Compact', desc: 'Small poster, key facts only. Quick to scan.', preview: () => cardPreview('compact') },
];

const STYLE_OPTIONS: TileOption<AppearancePreferences['designStyle']>[] = [
  { value: 'cinematic', label: 'Cinematic', desc: 'Atmospheric surfaces and a gentle accent glow.', preview: () => stylePreview('cinematic') },
  { value: 'minimal', label: 'Minimal', desc: 'Flat, solid surfaces with very little decoration.', preview: () => stylePreview('minimal') },
  { value: 'film-journal', label: 'Film journal', desc: 'Thin rules, a mat around each poster, magazine-like details.', preview: () => stylePreview('film-journal') },
  { value: 'glass', label: 'Glass', desc: 'Translucent layers. Becomes solid when transparency is reduced.', preview: () => stylePreview('glass') },
  { value: 'neon-noir', label: 'Neon noir', desc: 'Accent edge light on the card you hover or focus.', preview: () => stylePreview('neon-noir') },
];

const SEARCH_OPTIONS: TileOption<AppearancePreferences['searchType']>[] = [
  { value: 'grouped', label: 'Grouped', desc: 'Movies & TV Shows and People in separate sections.', preview: () => searchPreview('grouped') },
  { value: 'compact', label: 'Compact', desc: 'A narrow list with one line per result.', preview: () => searchPreview('compact') },
  { value: 'expanded', label: 'Expanded', desc: 'A wide panel with a preview of the highlighted result.', preview: () => searchPreview('expanded') },
  { value: 'full-page', label: 'Full page', desc: 'Results open as a page, with filters.', preview: () => searchPreview('full-page') },
];

const LAYOUT_OPTIONS: TileOption<AppearancePreferences['resultLayout']>[] = [
  { value: 'grid', label: 'Poster grid', desc: 'Rows of cards.', preview: () => layoutPreview('grid') },
  { value: 'list', label: 'Compact list', desc: 'One row per title.', preview: () => layoutPreview('list') },
  { value: 'spotlight', label: 'Spotlight', desc: 'Larger cards with more room.', preview: () => layoutPreview('spotlight') },
];

const MOTION_TILES: TileOption<AppearancePreferences['motion']>[] = [
  { value: 'system', label: 'System', desc: 'Follows your device. Large movement stops if it asks for less.' },
  { value: 'full', label: 'Full', desc: 'Dynamic: tilt, lift and longer transitions.' },
  { value: 'subtle', label: 'Subtle', desc: 'Shorter, gentler movement.' },
  { value: 'off', label: 'Off', desc: 'No movement. Focus and state changes stay instant.' },
];

let openPanel: { close: () => void } | null = null;

export function isAppearanceOpen(): boolean {
  return openPanel !== null;
}

export function closeAppearancePanel(): void {
  openPanel?.close();
}

export function openAppearancePanel(initial: SettingsSection | LegacyTab = 'overview'): void {
  if (openPanel) return;
  const initialSection: SettingsSection = initial in LEGACY ? LEGACY[initial as LegacyTab] : (initial as SettingsSection);

  const syncers: (() => void)[] = [];
  const onChange = (fn: () => void) => syncers.push(fn);
  const aiModeUnsubscribers: (() => void)[] = [];

  // ── generic controls ────────────────────────────────────────────────

  /** Arrow-key navigation shared by every radiogroup. */
  function wireRadioKeys(group: HTMLElement, items: { b: HTMLElement }[]) {
    group.addEventListener('keydown', (e) => {
      if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
      e.preventDefault();
      const i = items.findIndex(({ b }) => b === document.activeElement);
      const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
      const next = items[(i + dir + items.length) % items.length]!;
      next.b.focus();
      next.b.click();
    });
  }

  /** A labelled radio-style group of text buttons. */
  function choice<K extends keyof AppearancePreferences>(
    label: string,
    key: K,
    options: { value: AppearancePreferences[K]; label: string }[],
    hint?: string
  ): HTMLElement {
    const buttons = options.map((o) => {
      const b = el(
        'button',
        {
          class: 'seg-btn',
          type: 'button',
          role: 'radio',
          onclick: () => updatePreferences({ [key]: o.value } as Partial<AppearancePreferences>),
        },
        [o.label]
      );
      return { b, value: o.value };
    });
    const group = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': label }, buttons.map((x) => x.b));
    onChange(() => {
      const cur = getPreferences()[key];
      for (const { b, value } of buttons) {
        const on = value === cur;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      }
    });
    wireRadioKeys(group, buttons);
    return el('div', { class: 'setting' }, [
      el('div', { class: 'setting-label' }, [label]),
      group,
      ...(hint ? [el('p', { class: 'setting-hint' }, [hint])] : []),
    ]);
  }

  /** Visual option tiles: a preview, a name, one line of description and a
   * clear selected state. Same radiogroup semantics as `choice`. */
  function tiles<K extends keyof AppearancePreferences>(label: string, key: K, options: TileOption<AppearancePreferences[K]>[], hint?: string, cols = 2): HTMLElement {
    const items = options.map((o) => {
      const b = el(
        'button',
        { class: 'ap-tile', type: 'button', role: 'radio', onclick: () => updatePreferences({ [key]: o.value } as Partial<AppearancePreferences>) },
        [
          ...(o.preview ? [el('span', { class: 'ap-tile-preview', 'aria-hidden': 'true' }, [o.preview()])] : []),
          el('span', { class: 'ap-tile-name' }, [o.label]),
          el('span', { class: 'ap-tile-desc' }, [o.desc]),
        ]
      );
      return { b, value: o.value };
    });
    const group = el('div', { class: 'ap-tiles', role: 'radiogroup', 'aria-label': label, style: `--cols:${cols}` }, items.map((x) => x.b));
    onChange(() => {
      const cur = getPreferences()[key];
      for (const { b, value } of items) {
        const on = value === cur;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      }
    });
    wireRadioKeys(group, items);
    return el('div', { class: 'setting' }, [el('div', { class: 'setting-label' }, [label]), ...(hint ? [el('p', { class: 'setting-hint' }, [hint])] : []), group]);
  }

  function disclosure(summary: string, children: (Node | string)[]): HTMLElement {
    return el('details', { class: 'ap-advanced' }, [el('summary', {}, [summary]), ...children]);
  }

  function sectionResetButton(label: string, run: () => void): HTMLElement {
    return el(
      'button',
      {
        class: 'btn-text',
        type: 'button',
        onclick: () => {
          const before = { ...getPreferences() };
          run();
          showToast('Section reset to defaults', { action: { label: 'Undo', run: () => updatePreferences(before, { immediate: true }) } });
        },
      },
      [label]
    );
  }

  function sectionReset(section: ResetSection): HTMLElement {
    return sectionResetButton('Reset this section', () => resetSection(section));
  }

  function paneTitle(text: string): HTMLElement {
    return el('h3', { class: 'ap-pane-title' }, [text]);
  }

  // ── Overview ────────────────────────────────────────────────────────

  function overviewPane(): HTMLElement {
    const label = <T extends string>(opts: TileOption<T>[], v: T) => opts.find((o) => o.value === v)?.label ?? v;
    const summaryItems: { name: string; section: SettingsSection; text: () => string }[] = [
      { name: 'Card type', section: 'cards', text: () => label(CARD_OPTIONS, getPreferences().cardType) },
      { name: 'Design style', section: 'theme', text: () => label(STYLE_OPTIONS, getPreferences().designStyle) },
      { name: 'Search type', section: 'search', text: () => label(SEARCH_OPTIONS, getPreferences().searchType) },
    ];
    const summary = summaryItems.map((s) => {
      const value = el('span', { class: 'ap-summary-value' });
      const b = el('button', { class: 'ap-summary', type: 'button', onclick: () => showSection(s.section, true) }, [el('span', { class: 'ap-summary-name' }, [s.name]), value]);
      return { b, value, s };
    });

    const miniCard = el('div', { class: 'ap-mini', 'aria-hidden': 'true' });
    const miniSearch = el('div', { class: 'ap-mini ap-mini-wide', 'aria-hidden': 'true' });

    const presets = STARTER_PRESETS.map((p) => {
      const b = el(
        'button',
        {
          class: 'ap-tile ap-preset',
          type: 'button',
          onclick: () => {
            const before = { ...getPreferences() };
            applyStarterPreset(p.id);
            showToast(`${p.label} preset applied`, { action: { label: 'Undo', run: () => updatePreferences(before, { immediate: true }) } });
          },
        },
        [
          el('span', { class: 'ap-tile-preview', 'aria-hidden': 'true' }, [cardPreview(p.patch.cardType ?? 'interactive')]),
          el('span', { class: 'ap-tile-name' }, [p.id === 'cinematic' ? 'Cinematic (recommended)' : p.label]),
          el('span', { class: 'ap-tile-desc' }, [p.blurb]),
        ]
      );
      return { b, id: p.id };
    });

    onChange(() => {
      const p = getPreferences();
      for (const { value, s } of summary) value.textContent = s.text();
      miniCard.replaceChildren(cardPreview(p.cardType));
      miniSearch.replaceChildren(searchPreview(p.searchType));
      const match = matchingStarterPreset(p);
      for (const { b, id } of presets) {
        if (id === match) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
        b.classList.toggle('active', id === match);
      }
    });

    return el('div', { class: 'ap-section' }, [
      el('p', { class: 'ap-lead' }, ['Make Moodsift yours']),
      el('p', { class: 'setting-hint' }, ['These choices change how Moodsift looks and feels. They never change what it recommends, and they stay on this device.']),
      el('div', { class: 'ap-summaries' }, summary.map((x) => x.b)),
      el('div', { class: 'ap-mini-row' }, [miniCard, miniSearch]),
      el('div', { class: 'setting' }, [
        el('div', { class: 'setting-label' }, ['Starter presets']),
        el('p', { class: 'setting-hint' }, ['A shortcut that sets ordinary options — you can change any of them afterwards. Text size, contrast and your motion setting are never lowered.']),
        el('div', { class: 'ap-tiles', style: '--cols:2' }, presets.map((x) => x.b)),
      ]),
    ]);
  }

  // ── Cards & layout ──────────────────────────────────────────────────

  function cardsPane(): HTMLElement {
    return el('div', { class: 'ap-section' }, [
      tiles('Card type', 'cardType', CARD_OPTIONS, 'What is inside each title card. This is separate from how the cards are arranged, below.'),
      tiles('Results layout', 'resultLayout', LAYOUT_OPTIONS, 'How the cards are arranged. Every layout keeps details, watchlist, compare and rating within reach. The top pick always gets its featured card.', 3),
      choice('Poster size', 'posterSize', [
        { value: 'small', label: 'Small' },
        { value: 'medium', label: 'Medium' },
        { value: 'large', label: 'Large' },
      ]),
      choice('Density', 'density', [
        { value: 'comfortable', label: 'Comfortable' },
        { value: 'compact', label: 'Compact' },
      ], 'Density changes spacing only — touch targets keep their minimum size.'),
      choice('Poster labels', 'posterLabels', [
        { value: 'detailed', label: 'Detailed' },
        { value: 'essential', label: 'Essential' },
      ], 'Essential shows title, year and match on cards; the reason chips move to the detail sheet.'),
      disclosure('More layout details', [
        choice('Card corners', 'cardShape', [
          { value: 'sharp', label: 'Sharp' },
          { value: 'standard', label: 'Standard' },
          { value: 'rounded', label: 'Rounded' },
        ]),
        choice('Surface', 'surfaceStyle', [
          { value: 'solid', label: 'Solid' },
          { value: 'glass', label: 'Soft glass' },
        ], 'Soft glass adds a gentle blur to floating surfaces; it is turned off by Reduced transparency.'),
        choice('Content width', 'contentWidth', [
          { value: 'compact', label: 'Compact' },
          { value: 'comfortable', label: 'Comfortable' },
          { value: 'wide', label: 'Wide' },
        ]),
        choice('Shadows', 'shadows', [
          { value: 'minimal', label: 'Minimal' },
          { value: 'standard', label: 'Standard' },
          { value: 'expressive', label: 'Expressive' },
        ]),
        choice('Decorative grain', 'grain', [
          { value: 'off', label: 'Off' },
          { value: 'subtle', label: 'Subtle' },
        ], 'A static texture on the landing page only — never an animated filter.'),
      ]),
      sectionReset('layout'),
    ]);
  }

  // ── Search ──────────────────────────────────────────────────────────

  function searchPane(): HTMLElement {
    const demo = el('div', { class: 'ap-demo', 'aria-hidden': 'true' });
    onChange(() => demo.replaceChildren(searchPreview(getPreferences().searchType)));
    return el('div', { class: 'ap-section' }, [
      tiles('Search type', 'searchType', SEARCH_OPTIONS, 'Every option searches the same titles and people the same way. This only changes how the results are presented.'),
      el('div', { class: 'setting' }, [el('div', { class: 'setting-label' }, ['Preview']), el('p', { class: 'setting-hint' }, ['Sample results only — nothing is searched here.']), demo]),
      sectionReset('search'),
    ]);
  }

  // ── Theme ───────────────────────────────────────────────────────────

  function themePane(): HTMLElement {
    const paletteBtns = PALETTES.map((p) => {
      const btn = el(
        'button',
        { class: 'palette-btn', type: 'button', role: 'radio', 'data-palette-id': p.id, onclick: () => updatePreferences({ palette: p.id, customAccent: undefined }) },
        [
          el('span', { class: 'palette-swatch', 'aria-hidden': 'true' }, [
            el('i', { class: 'sw-dark', style: `background:${p.swatch[0]}` }, [el('b', { style: `background:${p.swatch[1]}` }), el('b', { style: `background:${p.swatch[2]}` })]),
            el('i', { class: 'sw-light', style: `background:${p.swatch[3]}` }, [el('b', { style: `background:${p.swatch[4]}` }), el('b', { style: `background:${p.swatch[5]}` })]),
          ]),
          el('span', { class: 'palette-name' }, [p.label]),
          el('span', { class: 'palette-mood' }, [p.mood]),
        ]
      );
      return { btn, id: p.id, b: btn };
    });
    onChange(() => {
      const cur = getPreferences().palette;
      for (const { btn, id } of paletteBtns) {
        btn.classList.toggle('active', id === cur);
        btn.setAttribute('aria-checked', id === cur ? 'true' : 'false');
        btn.tabIndex = id === cur ? 0 : -1;
      }
    });
    const paletteGroup = el('div', { class: 'palette-grid', role: 'radiogroup', 'aria-label': 'Palette' }, paletteBtns.map((p) => p.btn));
    wireRadioKeys(paletteGroup, paletteBtns);

    // Accent: curated swatches first; picker and hex are one disclosure away.
    const hexInput = el('input', {
      class: 'hex-input',
      type: 'text',
      inputmode: 'text',
      maxlength: '7',
      placeholder: '#a78bfa',
      spellcheck: 'false',
      'aria-label': 'Custom accent colour as hex, for example #a78bfa',
    }) as HTMLInputElement;
    const picker = el('input', { class: 'color-input', type: 'color', value: '#a78bfa', 'aria-label': 'Pick a custom accent colour' }) as HTMLInputElement;
    const accentNote = el('p', { class: 'setting-hint', role: 'status' });

    const applyAccent = (hex: string) => {
      if (!isValidHex(hex)) {
        accentNote.textContent = 'Use a six-digit hex colour like #a78bfa.';
        return;
      }
      updatePreferences({ customAccent: hex.toLowerCase() });
    };
    hexInput.addEventListener('change', () => applyAccent(hexInput.value.trim().startsWith('#') ? hexInput.value.trim() : `#${hexInput.value.trim()}`));
    picker.addEventListener('input', () => applyAccent(picker.value));

    const accentBtns = ACCENT_CHOICES.map((hex) => {
      const b = el('button', { class: 'accent-dot', type: 'button', style: `background:${hex}`, 'aria-label': `Use accent ${hex}`, onclick: () => applyAccent(hex) });
      return { b, hex };
    });
    onChange(() => {
      const acc = getPreferences().customAccent;
      for (const { b, hex } of accentBtns) b.classList.toggle('active', acc === hex);
      if (acc) {
        hexInput.value = acc;
        picker.value = acc;
        const fg = accentForeground(acc);
        // Two separate risks: text on the accent (buttons), and the accent
        // against the page itself (borders, selected states, focus cues).
        const pageBg = getComputedStyle(document.documentElement).getPropertyValue('--bg-0').trim();
        const onPage = /^#[0-9a-f]{6}$/i.test(pageBg) ? contrastRatio(acc, pageBg) : 21;
        accentNote.textContent = !fg.ok
          ? `Heads up: this accent only reaches ${fg.ratio.toFixed(1)}:1 contrast with button text \u2014 it may be hard to read. A different shade is safer.`
          : onPage < 3
            ? `Heads up: this accent is very close to the page background (${onPage.toFixed(1)}:1), so selections and outlines may be hard to see. Try a stronger shade.`
            : 'Accent applied to buttons, selections and particles. Success and error colours are unchanged.';
      } else {
        hexInput.value = '';
        accentNote.textContent = 'Using the palette\u2019s own accent. Pick a swatch or enter a hex colour to override it.';
      }
    });

    return el('div', { class: 'ap-section' }, [
      choice('Appearance', 'mode', [
        { value: 'system', label: 'System' },
        { value: 'dark', label: 'Dark' },
        { value: 'light', label: 'Light' },
      ], 'System follows your device until you pick Light or Dark.'),
      tiles('Design style', 'designStyle', STYLE_OPTIONS, 'The surface treatment for cards and panels. It does not change your palette or light/dark choice, and it keeps your motion and accessibility settings.', 3),
      el('div', { class: 'setting' }, [el('div', { class: 'setting-label' }, ['Palette']), paletteGroup]),
      el('div', { class: 'setting' }, [
        el('div', { class: 'setting-label' }, ['Accent colour']),
        el('div', { class: 'accent-row' }, accentBtns.map((a) => a.b)),
        accentNote,
        disclosure('Custom accent', [
          el('div', { class: 'accent-row' }, [picker, hexInput]),
          el('button', { class: 'btn-text', type: 'button', onclick: () => updatePreferences({ customAccent: undefined }) }, ['Reset accent to palette default']),
        ]),
      ]),
      el('div', { class: 'setting' }, [
        el('div', { class: 'setting-label' }, ['Choose a vibe']),
        el('div', { class: 'vibe-row' }, VIBES.map((v) => el('button', { class: 'chip chip-btn', type: 'button', title: v.blurb, onclick: () => applyVibe(v.id) }, [v.label]))),
        el('p', { class: 'setting-hint' }, ['A shortcut that sets ordinary palette, font and motion options — nothing hidden.']),
      ]),
      el('div', { class: 'ap-inline-actions' }, [
        (() => {
          const b = el('button', {
            class: 'btn btn-ghost toolbar-btn',
            type: 'button',
            onclick: () => {
              randomizePalette();
              showToast('Tried a random look', { action: { label: 'Undo', run: undo } });
            },
          });
          b.innerHTML = `<span class="icon-inline" style="width:15px;height:15px">${ICON.dice}</span> Surprise me`;
          return b;
        })(),
        sectionResetButton('Reset theme', () => resetSection('themes')),
      ]),
      disclosure('Saved looks', [looksBlock()]),
    ]);
  }

  /** Up to three named looks. Appearance fields only — never ratings,
   * watchlist, profile or quiz answers. */
  function looksBlock(): HTMLElement {
    const list = el('div', { class: 'ap-section', style: 'gap:8px' });
    const nameInput = el('input', { class: 'look-input', type: 'text', maxlength: '24', placeholder: 'Name this look', 'aria-label': 'Name for the new look' }) as HTMLInputElement;
    const msg = el('p', { class: 'ap-msg', role: 'status' });
    const saveBtn = el('button', {
      class: 'btn btn-ghost toolbar-btn',
      type: 'button',
      onclick: () => {
        const r = saveLook(nameInput.value || 'My look');
        msg.classList.toggle('error', !r.ok);
        msg.textContent = r.ok ? `Saved \u201c${r.look.name}\u201d.` : r.error;
        if (r.ok) nameInput.value = '';
      },
    }, ['Save current look']);

    // The list is rebuilt only when the saved looks themselves change.
    // `onChange` fires on *every* appearance change and debounced save —
    // rebuilding then would destroy the focused row mid-keyboard-use (so the
    // next Tab would restart from the top of the drawer). When a rebuild is
    // needed, focus is handed to the equivalent new control.
    let lastSignature = '';
    const render = () => {
      const looks = listLooks();
      const signature = JSON.stringify(looks.map((l) => [l.id, l.name]));
      if (signature !== lastSignature) {
        const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement : null;
        const focusedId = focused?.dataset.lookId ?? null;
        const focusedAction = focused?.dataset.lookAction ?? null;
        const previousIds = lastSignature ? (JSON.parse(lastSignature) as [string, string][]).map((x) => x[0]) : [];
        lastSignature = signature;

        list.replaceChildren(
          ...(looks.length
            ? looks.map((l) =>
                el('div', { class: 'look-row' }, [
                  el('button', { class: 'btn-text', type: 'button', 'data-look-id': l.id, 'data-look-action': 'apply', onclick: () => applyLook(l.id) }, [l.name]),
                  el('button', { class: 'btn-text-danger', type: 'button', 'data-look-id': l.id, 'data-look-action': 'delete', 'aria-label': `Delete look ${l.name}`, onclick: () => deleteLook(l.id) }, ['Delete']),
                ])
              )
            : [el('p', { class: 'ap-msg' }, ['No saved looks yet.'])])
        );

        if (focused && focusedId) {
          const same = list.querySelector<HTMLElement>(`[data-look-id="${focusedId}"][data-look-action="${focusedAction}"]`);
          if (same) same.focus({ preventScroll: true });
          else {
            // The focused look was deleted: land on the look that took its place
            // (or the previous one), else the name field — never on <body>.
            const idx = previousIds.indexOf(focusedId);
            const neighbour = looks[Math.min(idx, looks.length - 1)];
            const target = neighbour ? list.querySelector<HTMLElement>(`[data-look-id="${neighbour.id}"][data-look-action="apply"]`) : null;
            (target ?? nameInput).focus({ preventScroll: true });
          }
        } else if (focused) {
          nameInput.focus({ preventScroll: true });
        }
      }
      saveBtn.toggleAttribute('disabled', looks.length >= MAX_LOOKS);
      nameInput.toggleAttribute('disabled', looks.length >= MAX_LOOKS);
    };
    onChange(render);

    return el('div', { class: 'setting' }, [
      el('div', { class: 'setting-label' }, [`My looks (up to ${MAX_LOOKS})`]),
      list,
      el('div', { class: 'look-row' }, [nameInput, saveBtn]),
      msg,
    ]);
  }

  // ── Readability ─────────────────────────────────────────────────────

  let fontsPrimed = false;
  function primeFonts() {
    if (fontsPrimed) return;
    fontsPrimed = true;
    for (const f of FONT_PRESETS) void ensureFontLoaded(f.id);
  }

  function readabilityPane(): HTMLElement {
    const presets = FONT_PRESETS.map((f) => {
      const btn = el(
        'button',
        { class: 'font-btn', type: 'button', role: 'radio', onclick: () => updatePreferences({ fontPreset: f.id }) },
        [
          el('span', { class: 'font-sample', style: `font-family:${f.display};font-weight:${f.headingWeight}` }, ['Aa — Find your next film']),
          el('span', { class: 'font-name' }, [f.label]),
          el('span', { class: 'font-blurb', style: `font-family:${f.body}` }, [f.blurb]),
        ]
      );
      return { btn, id: f.id, b: btn };
    });
    onChange(() => {
      const cur = getPreferences().fontPreset;
      for (const { btn, id } of presets) {
        btn.classList.toggle('active', id === cur);
        btn.setAttribute('aria-checked', id === cur ? 'true' : 'false');
        btn.tabIndex = id === cur ? 0 : -1;
      }
    });
    const fontGroup = el('div', { class: 'font-grid', role: 'radiogroup', 'aria-label': 'Font pairing' }, presets.map((p) => p.btn));
    wireRadioKeys(fontGroup, presets);

    return el('div', { class: 'ap-section' }, [
      el('div', { class: 'ap-block' }, [
        el('h4', { class: 'ap-block-title' }, ['Text']),
        el('div', { class: 'setting' }, [
          el('div', { class: 'setting-label' }, ['Font pairing']),
          fontGroup,
          el('p', { class: 'setting-hint' }, ['Fonts are bundled with the app and only downloaded when you preview or choose them.']),
        ]),
        choice('Text size', 'textScale', [
          { value: 90, label: '90%' },
          { value: 100, label: '100%' },
          { value: 110, label: '110%' },
          { value: 125, label: '125%' },
        ]),
        choice('Line spacing', 'lineSpacing', [
          { value: 'compact', label: 'Compact' },
          { value: 'comfortable', label: 'Comfortable' },
          { value: 'relaxed', label: 'Relaxed' },
        ]),
      ]),
      el('div', { class: 'ap-block' }, [
        el('h4', { class: 'ap-block-title' }, ['Contrast and surfaces']),
        choice('Contrast', 'contrast', [
          { value: 'standard', label: 'Standard' },
          { value: 'high', label: 'High' },
        ], 'Strengthens text, borders and selected states.'),
        choice('Transparency', 'transparency', [
          { value: 'standard', label: 'Standard' },
          { value: 'reduced', label: 'Reduced' },
        ], 'Reduced uses solid surfaces and removes background blur everywhere, including the Glass design style.'),
      ]),
      el('div', { class: 'ap-block' }, [
        el('h4', { class: 'ap-block-title' }, ['Quick comfort']),
        el('div', { class: 'setting' }, [
          el('p', { class: 'setting-hint' }, ['The comfort preset changes only these settings:']),
          el('ul', { class: 'ap-list' }, [el('li', {}, ['Text size 110%']), el('li', {}, ['High contrast']), el('li', {}, ['Reduced transparency']), el('li', {}, ['Subtle motion']), el('li', {}, ['Comfortable density'])]),
          el('button', {
            class: 'btn btn-ghost toolbar-btn',
            type: 'button',
            onclick: () => {
              const before = { ...getPreferences() };
              updatePreferences({ density: 'comfortable', textScale: 110, contrast: 'high', transparency: 'reduced', motion: 'subtle' }, { immediate: true });
              showToast('Comfort preset applied', { action: { label: 'Undo', run: () => updatePreferences(before, { immediate: true }) } });
            },
          }, ['Apply comfort preset']),
          el('p', { class: 'setting-hint' }, ['Keyboard focus is always visible and can\u2019t be switched off.']),
        ]),
      ]),
      sectionResetButton('Reset readability', () => {
        resetSection('typography');
        resetSection('accessibility');
      }),
    ]);
  }

  // ── Motion & performance ────────────────────────────────────────────

  function motionPane(): HTMLElement {
    const note = el('p', { class: 'setting-hint', role: 'status' });
    onChange(() => {
      const p = getPreferences();
      note.textContent =
        p.motion === 'system' && systemRequestsReducedMotion()
          ? 'Your device asks for reduced motion, so large and continuous movement is off while this is System.'
          : isCoarsePointer()
            ? 'This device uses touch, so pointer effects such as tilt and glow are off automatically.'
            : '';
      note.style.display = note.textContent ? '' : 'none';
    });
    return el('div', { class: 'ap-section' }, [
      tiles('Motion profile', 'motion', MOTION_TILES, undefined, 2),
      note,
      el('div', { class: 'ap-block' }, [
        el('h4', { class: 'ap-block-title' }, ['Card interactions']),
        choice('Hover glow', 'hoverGlow', [
          { value: 'off', label: 'Off' },
          { value: 'subtle', label: 'Subtle' },
          { value: 'strong', label: 'Strong' },
        ], 'A soft highlight under the pointer on result cards. Text contrast is kept at every level.'),
        choice('Poster tilt', 'posterTilt', [
          { value: 'off', label: 'Off' },
          { value: 'gentle', label: 'Gentle' },
        ], 'Mouse only; always off on touch and with reduced motion.'),
      ]),
      el('div', { class: 'ap-block' }, [
        el('h4', { class: 'ap-block-title' }, ['Atmosphere']),
        choice('Hero particles', 'particles', [
          { value: 'off', label: 'Off' },
          { value: 'subtle', label: 'Subtle' },
          { value: 'balanced', label: 'Balanced' },
          { value: 'interactive', label: 'Interactive' },
        ], 'Only the landing hero has an animated background. Interactive reacts to a mouse pointer; on touch or low-power devices the effect is automatically reduced. Off is always respected.'),
        choice('Artwork ambience', 'artworkAmbience', [
          { value: 'off', label: 'Off' },
          { value: 'subtle', label: 'Subtle' },
          { value: 'balanced', label: 'Balanced' },
        ], 'A soft halo around your top pick, tinted from its poster. Decoration only \u2014 it never changes text or button colours. Reduced automatically on touch and low-power devices.'),
      ]),
      el('div', { class: 'ap-block' }, [
        el('h4', { class: 'ap-block-title' }, ['Transitions']),
        choice('Transition intensity', 'transitionIntensity', [
          { value: 'minimal', label: 'Minimal' },
          { value: 'standard', label: 'Standard' },
          { value: 'cinematic', label: 'Cinematic' },
        ], 'Cinematic lengthens the hero entry and the top-pick reveal; it never adds waiting before you can act.'),
      ]),
      disclosure('Advanced effects', [
        choice('Particle density', 'particleDensity', [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
        ], 'High is capped on touch and low-power devices.'),
        choice('Connection lines', 'connections', [
          { value: 'off', label: 'Off' },
          { value: 'faint', label: 'Faint' },
          { value: 'normal', label: 'Normal' },
        ]),
        choice('Pointer response', 'pointerResponse', [
          { value: 'off', label: 'Off' },
          { value: 'gentle', label: 'Gentle' },
          { value: 'noticeable', label: 'Noticeable' },
        ], 'Only applies with Hero particles set to Interactive and a mouse. Nothing ever requires pointer movement.'),
        choice('Click pulse', 'clickPulse', [
          { value: 'off', label: 'Off' },
          { value: 'on', label: 'On' },
        ], 'One small, soft ripple in the hero. Mouse only.'),
      ]),
      sectionReset('motion'),
    ]);
  }

  // ── AI engine ───────────────────────────────────────────────────────
  // A priority policy for the optional on-device explanation writer. Stored
  // separately from appearance (see ai-settings.ts), so it is never touched by
  // appearance undo/redo, looks, export/import, presets or reset.
  function aiPane(): HTMLElement {
    const buttons = AI_MODE_OPTIONS.map((o) => {
      const b = el(
        'button',
        {
          class: 'ai-mode-btn',
          type: 'button',
          role: 'radio',
          'data-ai-mode': o.id,
          onclick: () => {
            setAiMode(o.id);
            syncAi();
          },
        },
        [el('span', { class: 'ai-mode-name' }, [o.label]), el('span', { class: 'ai-mode-summary' }, [o.summary])]
      );
      return { b, id: o.id };
    });
    const group = el('div', { class: 'ai-mode-group', role: 'radiogroup', 'aria-label': 'AI engine priority' }, buttons.map((x) => x.b));
    wireRadioKeys(group, buttons);

    const detail = el('p', { class: 'setting-hint', 'aria-live': 'polite' });
    const saved = el('p', { class: 'setting-hint' });

    function syncAi() {
      const cur = getAiMode();
      for (const { b, id } of buttons) {
        const on = id === cur;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      }
      detail.textContent = AI_MODE_OPTIONS.find((o) => o.id === cur)?.detail ?? '';
      saved.textContent = isAiModePersisted()
        ? 'Saved on this device, separately from your appearance.'
        : 'Applied for this session only \u2014 browser storage is blocked.';
      saved.classList.toggle('warn', !isAiModePersisted());
    }
    onChange(syncAi);
    // The mode can also change from another tab (storage event) while this
    // panel is open; follow it, and stop following when the panel closes.
    aiModeUnsubscribers.push(subscribeAiMode(syncAi));

    // Sizes come straight from the model catalogue so this list can't drift
    // from what the engine actually requests.
    const sizes = el(
      'ul',
      { class: 'ai-size-list' },
      Object.values(MODELS).map((m) => el('li', {}, [`${m.label}: about ${m.webgpu.approxMb} MB (WebGPU) / ${m.wasm.approxMb} MB (WASM)`]))
    );

    return el('div', { class: 'ap-section' }, [
      el('div', { class: 'setting' }, [
        el('div', { class: 'setting-label' }, ['AI engine']),
        el('p', { class: 'setting-hint' }, [
          'Optional on-device AI only rewords the reasons behind each pick into one sentence \u2014 it never chooses or reorders titles. If it is off, slow or unavailable, you keep the original reasons.',
        ]),
        group,
        detail,
        saved,
      ]),
      disclosure('Model details', [
        el('div', { class: 'setting' }, [
          el('div', { class: 'setting-label' }, ['Approximate download sizes']),
          sizes,
          el('p', { class: 'setting-hint' }, [
            'Model-file sizes only \u2014 not memory use, and not a speed guarantee. The first run downloads the model; your browser may keep it for next time. Your device decides which models are eligible.',
          ]),
        ]),
      ]),
      el('div', { class: 'setting' }, [
        el('div', { class: 'setting-label' }, ['Privacy']),
        el('p', { class: 'setting-hint' }, [
          'The model runs in your browser. Your answers, ratings and searches are not sent to any AI service, and no cloud AI is used as a fallback. Changing this setting resets any model that is already loaded.',
        ]),
      ]),
    ]);
  }

  // ── Advanced ────────────────────────────────────────────────────────

  function advancedPane(): HTMLElement {
    const exportBox = el('textarea', { class: 'ap-textarea', readonly: true, 'aria-label': 'Exported appearance JSON', rows: '4' }) as HTMLTextAreaElement;
    const exportWrap = el('div', { class: 'ap-reveal', hidden: true }, [exportBox]);
    const importBox = el('textarea', { class: 'ap-textarea', 'aria-label': 'Paste appearance JSON to import', placeholder: 'Paste an exported appearance here', rows: '4' }) as HTMLTextAreaElement;
    const ioMsg = el('p', { class: 'ap-msg', role: 'status' });
    const importWrap = el('div', { class: 'ap-reveal', hidden: true }, [
      importBox,
      el('div', { class: 'ap-inline-actions' }, [
        el('button', {
          class: 'btn btn-ghost toolbar-btn',
          type: 'button',
          onclick: () => {
            const r = importAppearance(importBox.value);
            ioMsg.classList.toggle('error', !r.ok);
            ioMsg.textContent = r.ok ? 'Imported. Undo is available if you want the previous look back.' : r.error;
            if (r.ok) {
              importBox.value = '';
              importWrap.hidden = true;
            }
          },
        }, ['Import appearance']),
      ]),
    ]);

    return el('div', { class: 'ap-section' }, [
      el('div', { class: 'setting' }, [
        el('div', { class: 'setting-label' }, ['Share or back up']),
        el('p', { class: 'setting-hint' }, ['Exports only appearance settings. Your ratings, watchlist, profile and AI engine choice are never included.']),
        el('div', { class: 'ap-inline-actions' }, [
          el('button', {
            class: 'btn btn-ghost toolbar-btn',
            type: 'button',
            onclick: () => {
              exportBox.value = exportAppearance();
              exportWrap.hidden = false;
              exportBox.select();
              void navigator.clipboard?.writeText(exportBox.value).then(
                () => (ioMsg.textContent = 'Copied to your clipboard.'),
                () => (ioMsg.textContent = 'Select the text above and copy it.')
              );
            },
          }, ['Export appearance']),
          el('button', {
            class: 'btn btn-ghost toolbar-btn',
            type: 'button',
            'aria-expanded': 'false',
            onclick: (e: Event) => {
              importWrap.hidden = !importWrap.hidden;
              (e.currentTarget as HTMLElement).setAttribute('aria-expanded', importWrap.hidden ? 'false' : 'true');
              if (!importWrap.hidden) importBox.focus();
            },
          }, ['Import from JSON\u2026']),
        ]),
        exportWrap,
        importWrap,
        ioMsg,
      ]),
      el('div', { class: 'setting ap-danger-zone' }, [
        el('div', { class: 'setting-label' }, ['Reset']),
        el('p', { class: 'setting-hint' }, ['Resets every appearance option on this page \u2014 theme, design style, cards, search, readability and motion \u2014 to its default. Your ratings, watchlist, profile, quiz answers and AI engine choice are not touched, and you can undo it.']),
        (() => {
          const b = el('button', {
            class: 'btn-text-danger',
            type: 'button',
            onclick: () => {
              const before = { ...getPreferences() };
              resetAllAppearance();
              showToast('Appearance reset \u2014 your ratings and watchlist are untouched', {
                action: { label: 'Undo', run: () => updatePreferences(before, { immediate: true }) },
              });
            },
          }, ['Reset all appearance']);
          onChange(() => b.toggleAttribute('disabled', JSON.stringify(getPreferences()) === JSON.stringify(DEFAULT_PREFERENCES)));
          return b;
        })(),
      ]),
    ]);
  }

  // ── shell ───────────────────────────────────────────────────────────

  const panes: Record<SettingsSection, () => HTMLElement> = {
    overview: overviewPane,
    cards: cardsPane,
    search: searchPane,
    theme: themePane,
    readability: readabilityPane,
    motion: motionPane,
    ai: aiPane,
    advanced: advancedPane,
  };

  const built = new Map<SettingsSection, HTMLElement>();
  const body = el('div', { class: 'ap-body', id: 'ap-body', role: 'tabpanel' });
  const tabButtons = SECTIONS.map((t) => {
    const b = el(
      'button',
      { class: 'ap-tab', type: 'button', role: 'tab', id: `ap-tab-${t.id}`, 'aria-controls': 'ap-body', onclick: () => showSection(t.id) },
      [t.label]
    );
    return { b, id: t.id };
  });
  const tablist = el('div', { class: 'ap-tabs', role: 'tablist', 'aria-label': 'Settings sections' }, tabButtons.map((t) => t.b));
  tablist.addEventListener('keydown', (e) => {
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const i = Math.max(0, tabButtons.findIndex((t) => t.b === document.activeElement));
    const last = tabButtons.length - 1;
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? last : (i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + tabButtons.length) % tabButtons.length;
    const next = tabButtons[j]!;
    next.b.focus();
    showSection(next.id);
  });

  let currentSection: SettingsSection = initialSection;
  function showSection(id: SettingsSection, focusTab = false) {
    currentSection = id;
    let node = built.get(id);
    if (!node) {
      node = panes[id]();
      built.set(id, node);
    }
    const title = SECTIONS.find((s) => s.id === id)!.label;
    const heading = id === 'overview' ? null : paneTitle(title);
    body.replaceChildren(...(heading ? [heading] : []), node);
    body.setAttribute('aria-labelledby', `ap-tab-${id}`);
    body.scrollTop = 0;
    for (const t of tabButtons) {
      const on = t.id === id;
      t.b.classList.toggle('active', on);
      t.b.setAttribute('aria-selected', on ? 'true' : 'false');
      t.b.tabIndex = on ? 0 : -1;
      if (on) {
        t.b.setAttribute('aria-current', 'page');
        t.b.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      } else t.b.removeAttribute('aria-current');
    }
    if (id === 'readability') primeFonts();
    // The Compare/Restore row describes appearance only.
    studioRow.style.display = id === 'ai' ? 'none' : 'flex';
    runSync();
    if (focusTab) tabButtons.find((t) => t.id === id)?.b.focus({ preventScroll: true });
  }

  // Theme Studio: Before/After against the appearance from when this panel
  // opened (preview only — nothing is saved while comparing), and a one-click
  // return to that appearance.
  markAppearanceBaseline();
  const compareBtn = el('button', {
    class: 'btn btn-ghost toolbar-btn',
    type: 'button',
    'aria-pressed': 'false',
    onclick: () => peekBaseline(!isPeeking()),
  }, ['Compare with before']);
  const restoreBtn = el('button', { class: 'btn-text', type: 'button', onclick: () => restoreBaseline() }, ['Restore previous']);
  const studioRow = el('div', { class: 'ap-studio' }, [
    compareBtn,
    restoreBtn,
    el('span', { class: 'ap-msg', 'data-peek-note': '', role: 'status' }),
  ]);

  const status = el('span', { class: 'ap-status', role: 'status', 'aria-live': 'polite' });
  const undoBtn = el('button', { class: 'btn-text', type: 'button', onclick: undo }, []);
  undoBtn.innerHTML = `<span class="icon-inline" style="width:14px;height:14px">${ICON.undo}</span> Undo`;
  const redoBtn = el('button', { class: 'btn-text', type: 'button', onclick: redo }, []);
  redoBtn.innerHTML = `<span class="icon-inline" style="width:14px;height:14px">${ICON.redo}</span> Redo`;

  function runSync() {
    for (const s of syncers) s();
    undoBtn.toggleAttribute('disabled', !canUndo());
    redoBtn.toggleAttribute('disabled', !canRedo());
    const differs = hasBaselineDifference();
    const peek = isPeeking();
    compareBtn.setAttribute('aria-pressed', peek ? 'true' : 'false');
    compareBtn.textContent = peek ? 'Showing before \u2014 tap to return' : 'Compare with before';
    compareBtn.toggleAttribute('disabled', !differs && !peek);
    restoreBtn.toggleAttribute('disabled', !differs);
    const note = studioRow.querySelector('[data-peek-note]');
    if (note) note.textContent = peek ? 'Preview only \u2014 your changes are kept.' : '';
    status.textContent = isAppearancePersisted() ? 'Saved on this device' : 'Applied for this session only \u2014 browser storage is blocked';
    status.classList.toggle('warn', !isAppearancePersisted());
  }

  const closeBtn = el('button', { class: 'modal-close ap-close', type: 'button', 'aria-label': 'Close settings' });
  closeBtn.innerHTML = ICON.close;

  const titleId = 'ap-title';
  const sub = el('p', { class: 'ap-sub' }, [`Currently ${effectiveMode()} \u00b7 changes apply instantly`]);
  const panel = el('aside', { class: 'appearance-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId }, [
    el('div', { class: 'ap-head' }, [el('div', {}, [el('h2', { id: titleId }, ['Settings']), sub]), closeBtn]),
    el('div', { class: 'ap-layout' }, [tablist, el('div', { class: 'ap-main' }, [studioRow, body])]),
    el('div', { class: 'ap-foot' }, [el('div', { class: 'ap-foot-row' }, [undoBtn, redoBtn, status])]),
  ]);
  const scrim = el('div', { class: 'ap-scrim' }, [panel]);
  document.body.appendChild(scrim);
  document.body.style.overflow = 'hidden';

  const unsubscribe = subscribeAppearance(() => {
    runSync();
    sub.textContent = `Currently ${effectiveMode()} \u00b7 changes apply instantly`;
  });

  showSection(initialSection);
  const release = trapFocus(panel, {
    initialFocus: tabButtons.find((t) => t.id === initialSection)!.b,
    onEscape: close,
    // The toast host sits outside the drawer; keep its Undo button reachable.
    also: () => [document.querySelector<HTMLElement>('.toast-host')],
  });

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    openPanel = null;
    peekBaseline(false); // never leave the page showing a comparison preview
    unsubscribe();
    for (const off of aiModeUnsubscribers) off();
    aiModeUnsubscribers.length = 0;
    scrim.classList.add('closing');
    const done = () => {
      scrim.remove();
      document.body.style.overflow = '';
      release();
    };
    // Match the exit animation; fall back immediately if motion is off.
    if (getComputedStyle(panel).animationName === 'none' || document.documentElement.getAttribute('data-motion') === 'off') done();
    else window.setTimeout(done, 180);
  }
  openPanel = { close };
  void currentSection;

  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim) close();
  });
  closeBtn.addEventListener('click', close);
}
