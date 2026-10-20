// src/lib/icons.ts
//
// A small, consistent inline-SVG icon set, replacing the emoji pictographs
// (🔀🌙☀️🍅Ⓜ️⭐✕) that were scattered through the app. Emoji render
// differently per OS/browser (a different weight, a different color, a
// different silhouette entirely on some platforms) — a custom set stays
// visually consistent everywhere, inherits `currentColor` so it themes for
// free in both light and dark mode, and reads as considered rather than
// default. All 20x20 viewBoxes, 1.6 stroke width, matched to the existing
// --ease-spring / --dur-fast motion tokens where they animate.

export const ICON = {
  sun: `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="3.6" stroke="currentColor" stroke-width="1.6"/><path d="M10 1.5v2M10 16.5v2M18.5 10h-2M3.5 10h-2M15.6 4.4l-1.4 1.4M5.8 14.2l-1.4 1.4M15.6 15.6l-1.4-1.4M5.8 5.8L4.4 4.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,

  moon: `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M17.2 12.4A7.5 7.5 0 0 1 7.6 2.8a7.5 7.5 0 1 0 9.6 9.6Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`,

  shuffle: `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2.5 5.5h2.8c1.4 0 2.1.6 3 1.8l4.4 5.4c.9 1.2 1.6 1.8 3 1.8h1.8M2.5 14.5h2.8c1.4 0 2.1-.6 3-1.8l.4-.5M13.7 5.5c1.4 0 2.1.6 3 1.8h.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 3.3 17.5 5.5 15 7.7M15 12.3l2.5 2.2-2.5 2.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,

  close: `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4.5 4.5l11 11M15.5 4.5l-11 11" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,

  starFilled: `<svg viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M10 1.8l2.36 5.1 5.54.62-4.15 3.8 1.13 5.5L10 13.9l-4.88 2.92 1.13-5.5-4.15-3.8 5.54-.62L10 1.8Z"/></svg>`,

  tomato: `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7.6 4.2c.5-1.1 1.5-1.8 2.4-1.8s1.9.7 2.4 1.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="10" cy="11" r="7" fill="currentColor" fill-opacity="0.15" stroke="currentColor" stroke-width="1.4"/></svg>`,

  bookmark: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 3.5C6 2.67 6.67 2 7.5 2h9c.83 0 1.5.67 1.5 1.5V21l-6.5-3.75L4 21V4.5C4 3.94 4.34 3.44 4.83 3.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,

  bookmarkFilled: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M6 3.5C6 2.67 6.67 2 7.5 2h9c.83 0 1.5.67 1.5 1.5V21l-6.5-3.75L4 21V4.5c0-.83.67-1.5 1.5-1.5" /></svg>`,

  chevronLeft: `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12.5 4.5 7 10l5.5 5.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,

  chevronRight: `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7.5 4.5 13 10l-5.5 5.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,

  pause: `<svg viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="4" width="3.4" height="12" rx="1"/><rect x="11.6" y="4" width="3.4" height="12" rx="1"/></svg>`,

  play: `<svg viewBox="0 0 20 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M6.5 4.3v11.4c0 .6.7 1 1.2.6l8.4-5.7c.4-.3.4-.9 0-1.2L7.7 3.7c-.5-.4-1.2 0-1.2.6Z"/></svg>`,

  arrowUpRight: `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 14 14 6M7.5 6H14v6.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,

  info: `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10" cy="10" r="7.3" stroke="currentColor" stroke-width="1.5"/><path d="M10 9v5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="10" cy="6.3" r="1" fill="currentColor"/></svg>`,

  metacritic: `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1.5" y="1.5" width="17" height="17" rx="3.5" stroke="currentColor" stroke-width="1.4"/><text x="10" y="14" font-size="10" font-weight="700" text-anchor="middle" fill="currentColor" font-family="sans-serif">M</text></svg>`,

  compare: `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2.5" y="4" width="7" height="12" rx="1.6" stroke="currentColor" stroke-width="1.5"/><rect x="10.5" y="4" width="7" height="12" rx="1.6" stroke="currentColor" stroke-width="1.5"/></svg>`,

  command: `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6.5 3.5a2 2 0 1 0 0 4h7a2 2 0 1 0-2-2v9a2 2 0 1 0 2-2h-7a2 2 0 1 0 2 2v-9a2 2 0 1 0-2 2Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,

  sliders: `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 5.5h7M14 5.5h3M3 14.5h3M10 14.5h7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="5.5" r="2" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="14.5" r="2" stroke="currentColor" stroke-width="1.6"/></svg>`,

  check: `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4.5 10.5l3.6 3.6 7.4-8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,

  undo: `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7.5 4.5 3.5 8.5l4 4M4 8.5h8a4 4 0 0 1 0 8H9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,

  redo: `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="m12.5 4.5 4 4-4 4M16 8.5H8a4 4 0 0 0 0 8h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,

  dice: `<svg viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="14" height="14" rx="3.2" stroke="currentColor" stroke-width="1.5"/><circle cx="7.3" cy="7.3" r="1.1" fill="currentColor"/><circle cx="12.7" cy="12.7" r="1.1" fill="currentColor"/><circle cx="12.7" cy="7.3" r="1.1" fill="currentColor"/><circle cx="7.3" cy="12.7" r="1.1" fill="currentColor"/></svg>`,
} as const;

/** Wraps an icon string as an inline-flex span sized to `size` (px), so it
 * drops into text flow the way an emoji glyph did without extra markup at
 * every call site. */
export function iconSpan(svg: string, size = 16, extraClass = ''): string {
  return `<span class="icon-inline${extraClass ? ` ${extraClass}` : ''}" style="width:${size}px;height:${size}px" aria-hidden="true">${svg}</span>`;
}
