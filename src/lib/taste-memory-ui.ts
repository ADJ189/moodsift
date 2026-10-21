// src/lib/taste-memory-ui.ts
//
// Settings → Taste memory: the person's view of, and control over, the ratings
// and watchlist stored in THIS browser. Status text reflects the real result
// of the most recent write (see profile.ts), never an assumption.

import { el } from './dom';
import {
  applyTasteMemoryImport,
  eraseTasteMemory,
  exportTasteMemory,
  getTasteMemoryInfo,
  MAX_IMPORT_CHARS,
  parseTasteMemoryImport,
  setPersonalizationPaused,
  subscribeTasteMemory,
  type TasteMemoryPreview,
} from './profile';
import { showToast } from './toast';

export interface TasteMemoryCard {
  node: HTMLElement;
  destroy(): void;
}

const STATUS_TEXT = {
  saved: 'Saved on this device.',
  session: 'Session only — your last change could not be saved (browser storage may be full). Export a backup to keep it.',
  unavailable: 'Not saved — browser storage is unavailable, so your taste memory only lasts until you close this tab.',
} as const;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Builds subscribed taste-memory status and pause/backup/erase controls.
 * Imports require preview confirmation; call destroy() when removed to unsubscribe. */
export function buildTasteMemoryCard(): TasteMemoryCard {
  const status = el('p', { class: 'tm-status', role: 'status', 'aria-live': 'polite' });
  const issue = el('p', { class: 'setting-hint warn', role: 'status' });
  const facts = el('dl', { class: 'ai-diag-facts' });
  const pauseBtn = el('button', { class: 'tm-switch', type: 'button', role: 'switch', 'data-tm': 'pause' });
  const pauseHint = el('p', { class: 'setting-hint' });
  const importMsg = el('p', { class: 'setting-hint', role: 'status', 'aria-live': 'polite' });
  const preview = el('div', { class: 'tm-preview' });
  const fileInput = el('input', { type: 'file', accept: '.json,application/json', class: 'visually-hidden', 'aria-label': 'Choose a taste-memory backup file', onchange: () => void onFile() }) as HTMLInputElement;

  function row(term: string, value: string): HTMLElement[] {
    return [el('dt', {}, [term]), el('dd', {}, [value])];
  }

  /** Refreshes counts, save status, storage sizes and the personalization switch. */
  function render(): void {
    const info = getTasteMemoryInfo();
    status.textContent = STATUS_TEXT[info.status];
    status.dataset.state = info.status;
    issue.textContent = info.loadIssue ?? '';
    issue.hidden = !info.loadIssue;

    facts.replaceChildren(
      ...row('Rated titles', info.ratedCount === 0 ? 'None yet' : `${info.ratedCount.toLocaleString()} (${info.deliberateCount.toLocaleString()} rated in Moodsift, ${info.importedCount.toLocaleString()} imported)`),
      ...row('Watchlist', plural(info.watchlistCount, 'title')),
      ...row('Most recent rating', info.mostRecentRatingAt ? new Date(info.mostRecentRatingAt).toLocaleDateString() : '—'),
      ...row(
        'Storage used',
        info.rawChars !== null && info.storedChars !== null
          ? `${info.storedChars.toLocaleString()} characters stored, down from ${info.rawChars.toLocaleString()} uncompressed (${Math.round((info.storedChars / Math.max(1, info.rawChars)) * 100)}% of the original). Characters are what the browser counts toward its storage limit.`
          : 'Not measured yet'
      )
    );

    pauseBtn.setAttribute('aria-checked', info.paused ? 'true' : 'false');
    pauseBtn.textContent = info.paused ? 'Personalization is paused' : 'Pause personalization';
    pauseHint.textContent = info.paused
      ? 'Your saved ratings are kept but are not used to rank new picks. Ratings you give during a quiz still count for that quiz. Resume any time.'
      : 'Stop your saved ratings from influencing new picks without deleting them.';
  }

  pauseBtn.addEventListener('click', () => {
    const next = !getTasteMemoryInfo().paused;
    const saved = setPersonalizationPaused(next);
    showToast(next ? 'Personalization paused. Applies to the next picks you generate.' : 'Personalization resumed.');
    if (!saved) showToast('That choice could not be saved on this device.');
  });

  /** Starts a readable JSON backup download and schedules release of its object URL. */
  function download(): void {
    const blob = new Blob([exportTasteMemory()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `moodsift-taste-memory-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Reads the selected backup and displays a preview or validation error without
   * applying it. Files over 15,000,000 bytes are rejected before reading; decoded
   * text is also subject to the import parser's character limit.
   * File-reading errors propagate. */
  async function onFile(): Promise<void> {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    preview.replaceChildren();
    importMsg.textContent = '';
    if (!file) return;
    // UTF-8 needs at most three bytes per UTF-16 code unit; keep all backups
    // that the character limit accepts eligible for parsing.
    if (file.size > MAX_IMPORT_CHARS * 3) {
      importMsg.textContent = 'That file is too large to be a Moodsift backup.';
      return;
    }
    const result = parseTasteMemoryImport(await file.text());
    if (!result.ok) {
      importMsg.textContent = result.error;
      return;
    }
    showPreview(result.preview);
  }

  /** Shows backup counts and actions to merge/replace only when explicitly chosen. */
  function showPreview(p: TasteMemoryPreview): void {
    const apply = (mode: 'replace' | 'merge') => {
      const saved = applyTasteMemoryImport(p.profile, mode);
      preview.replaceChildren();
      importMsg.textContent = saved ? 'Backup restored.' : 'Backup restored for this session, but it could not be saved on this device.';
      render();
    };
    preview.replaceChildren(
      el('p', { class: 'setting-hint' }, [
        `This backup has ${plural(p.ratedCount, 'rated title')} (${p.importedCount.toLocaleString()} imported) and ${plural(p.watchlistCount, 'watchlist title')}.` +
          (p.skippedRows > 0 ? ` ${plural(p.skippedRows, 'row')} could not be used and will be skipped.` : ''),
      ]),
      el('div', { class: 'ai-diag-actions' }, [
        el('button', { class: 'btn btn-primary', type: 'button', 'data-tm': 'merge', onclick: () => apply('merge') }, ['Merge into current']),
        el('button', { class: 'btn btn-ghost', type: 'button', 'data-tm': 'replace', onclick: () => apply('replace') }, ['Replace current']),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => preview.replaceChildren() }, ['Cancel']),
      ])
    );
  }

  /** Requests confirmation before resetting taste memory and showing a completion toast. */
  function erase(): void {
    if (!confirm('Erase your taste memory? This deletes your saved ratings, watchlist and personalization settings from this browser. It cannot be undone — export a backup first if you want to keep a copy.')) return;
    eraseTasteMemory();
    showToast('Taste memory erased from this browser.');
  }

  const node = el('div', { class: 'ap-section', 'data-tm-card': '' }, [
    el('div', { class: 'setting' }, [
      el('div', { class: 'setting-label' }, ['Local taste memory']),
      el('p', { class: 'setting-hint' }, [
        'Your ratings and watchlist are stored only in this browser. They are not uploaded, and no AI model receives them. Storage is compressed to save space — that is not encryption, so anyone with access to this browser profile can still read it.',
      ]),
      status,
      issue,
      facts,
    ]),
    el('div', { class: 'setting' }, [el('div', { class: 'setting-label' }, ['Personalization']), pauseBtn, pauseHint]),
    el('div', { class: 'setting' }, [
      el('div', { class: 'setting-label' }, ['Backup and restore']),
      el('p', { class: 'setting-hint' }, ['Export a readable JSON file, or restore one. You see what is in a file before anything changes.']),
      el('div', { class: 'ai-diag-actions' }, [
        el('button', { class: 'btn btn-ghost', type: 'button', 'data-tm': 'export', onclick: download }, ['Export backup']),
        el('button', { class: 'btn btn-ghost', type: 'button', 'data-tm': 'import', onclick: () => fileInput.click() }, ['Import backup…']),
      ]),
      fileInput,
      importMsg,
      preview,
    ]),
    el('div', { class: 'setting' }, [
      el('div', { class: 'setting-label' }, ['Erase']),
      el('p', { class: 'setting-hint' }, ['Deletes everything above from this browser. It does not remove files you exported.']),
      el('button', { class: 'btn-text-danger', type: 'button', 'data-tm': 'erase', onclick: erase }, ['Erase saved taste memory']),
    ]),
  ]);

  const off = subscribeTasteMemory(render);
  render();
  return { node, destroy: off };
}
