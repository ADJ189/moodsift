// src/lib/ai-diagnostics-ui.ts
//
// The "Test on this device" card in Settings → AI engine. All decisions live
// in ai-diagnostics.ts / ai-engine.ts; this file only renders state and
// forwards the four user actions (test, cancel, use recommendation, copy).
//
// Status is announced through a polite live region. The saved AI mode is only
// ever changed by the explicit "Use recommended mode" button.

import { APP_VERSION } from './app-version';
import { getAiMode, setAiMode } from './ai-settings';
import { browserFamily, buildReport, modeLabel, outcomeLabel, type DiagnosticResult } from './ai-diagnostics';
import { cancelDiagnostics, getLastDiagnostic, getLlmStageText, isDiagnosing, runDiagnostics, subscribeLlm } from './llm';
import { el } from './dom';
import { showToast } from './toast';

export interface DiagnosticCard {
  node: HTMLElement;
  destroy(): void;
}

const INTEGRITY_LABEL = { verified: 'Verified', 'not-verified': 'Not yet verified', failed: 'Verification failed' } as const;

export function buildDiagnosticCard(): DiagnosticCard {
  let withQuality = false;
  /** The recommendation the person already declined for the current result. */
  let dismissedFor: DiagnosticResult | null = null;

  const status = el('p', { class: 'ai-diag-status', role: 'status', 'aria-live': 'polite' });
  const stage = el('p', { class: 'setting-hint ai-diag-stage' });
  const facts = el('dl', { class: 'ai-diag-facts' });
  const problem = el('p', { class: 'ai-diag-problem' });
  const advice = el('p', { class: 'ai-diag-advice' });

  const testBtn = el('button', { class: 'btn btn-primary', type: 'button', 'data-ai-diag': 'test', onclick: () => void start() });
  const cancelBtn = el('button', { class: 'btn btn-ghost', type: 'button', 'data-ai-diag': 'cancel', onclick: () => cancelDiagnostics() }, ['Cancel']);
  const useBtn = el('button', { class: 'btn btn-primary', type: 'button', 'data-ai-diag': 'use' }, ['Use recommended mode']);
  const keepBtn = el('button', { class: 'btn btn-ghost', type: 'button', 'data-ai-diag': 'keep' }, ['Keep current setting']);
  const copyBtn = el('button', { class: 'btn btn-ghost', type: 'button', 'data-ai-diag': 'copy', onclick: () => void copyReport() }, ['Copy diagnostic report']);
  const qualityBox = el('input', { type: 'checkbox', id: 'ai-diag-quality', onchange: (e: Event) => (withQuality = (e.target as HTMLInputElement).checked) }) as HTMLInputElement;
  const qualityRow = el('label', { class: 'ai-diag-check', for: 'ai-diag-quality' }, [qualityBox, ' Also run a short format check (a few extra seconds; not a factuality test)']);
  const actions = el('div', { class: 'ai-diag-actions' }, [testBtn, cancelBtn, copyBtn]);
  const recActions = el('div', { class: 'ai-diag-actions' }, [useBtn, keepBtn]);

  async function start(): Promise<void> {
    dismissedFor = null;
    const done = runDiagnostics({ quality: withQuality });
    render();
    await done;
    render();
  }

  async function copyReport(): Promise<void> {
    const r = getLastDiagnostic();
    if (!r) return;
    // Technical facts only — see buildReport(). Copying is always user-initiated.
    const text = buildReport(r, { browser: browserFamily(navigator.userAgent), appVersion: APP_VERSION });
    try {
      await navigator.clipboard.writeText(text);
      showToast('Diagnostic report copied.');
    } catch {
      showToast('Could not copy automatically — your browser blocked clipboard access.');
    }
  }

  function row(term: string, value: string): HTMLElement[] {
    return [el('dt', {}, [term]), el('dd', {}, [value])];
  }

  function render(): void {
    const testing = isDiagnosing();
    const r = getLastDiagnostic();
    const mode = getAiMode();

    const label = testing ? 'Testing…' : r ? outcomeLabel(r.outcome) : 'Not tested';
    status.textContent = `Status: ${label}`;
    status.dataset.state = testing ? 'testing' : r ? r.outcome : 'idle';
    stage.textContent = testing ? getLlmStageText() || 'Preparing…' : '';
    stage.hidden = !testing;

    const hadActionFocus = document.activeElement === testBtn || document.activeElement === cancelBtn;
    testBtn.textContent = r && r.outcome !== 'disabled' ? 'Retry test' : 'Test on this device';
    testBtn.disabled = testing;
    testBtn.hidden = testing;
    cancelBtn.hidden = !testing;
    if (hadActionFocus) (testing ? cancelBtn : testBtn).focus({ preventScroll: true });
    copyBtn.hidden = testing || !r || r.outcome === 'disabled';
    qualityRow.hidden = mode === 'lightweight';
    qualityBox.disabled = testing;

    facts.replaceChildren();
    problem.textContent = '';
    advice.textContent = '';
    recActions.hidden = true;

    if (testing || !r) return;

    if (r.outcome === 'disabled') {
      problem.textContent = r.summary;
      return;
    }
    if (r.model) {
      facts.append(
        ...row('Model', `${r.model.label} (about ${r.model.approxMb} MB of weights)`),
        ...row('Backend', r.model.backend === 'webgpu' ? 'WebGPU' : 'WASM / CPU'),
        ...row('Precision', r.model.dtype),
        ...row('Revision', r.model.revision.slice(0, 12))
      );
    }
    if (r.integrity) facts.append(...row('Integrity', `${INTEGRITY_LABEL[r.integrity.state]} — ${r.integrity.detail}`));
    if (typeof r.startupMs === 'number') facts.append(...row('Start-up', `${(r.startupMs / 1000).toFixed(1)} s`));
    if (r.quality) facts.append(...row('Format check', `${r.quality.passed} of ${r.quality.total} passed`));
    if (r.outcome === 'failed') problem.textContent = r.summary;
    else if (r.outcome === 'passed-fallback') problem.textContent = r.summary;

    // Always reassure: a failed AI start never affects the recommendations.
    if (r.outcome === 'failed') advice.textContent = 'Your recommendations are unaffected — the rule-based reasons stay visible.';

    if (r.recommendation && dismissedFor !== r) {
      advice.textContent = r.recommendation.message;
      recActions.hidden = false;
      useBtn.onclick = () => {
        setAiMode(r.recommendation!.mode); // user-initiated; this resets the diagnostic to "Not tested"
        showToast(`AI engine set to ${modeLabel(r.recommendation!.mode)}.`);
      };
      keepBtn.onclick = () => {
        dismissedFor = r;
        render();
      };
    }
  }

  const node = el('div', { class: 'setting ai-diag', 'data-ai-diag-card': '' }, [
    el('div', { class: 'setting-label' }, ['Test on this device']),
    el('p', { class: 'setting-hint' }, [
      'Local AI runs in this browser on your device. The first run may download model files from the configured model/CDN hosts and can take longer. \u201cTest on this device\u201d checks runtime access, model integrity, startup, and a short real inference. If a model is unsuitable, Moodsift can try a smaller eligible local model. If local AI is unavailable, the original rule-based reasons remain. Moodsift does not silently send quiz answers or search data to a cloud AI service.',
    ]),
    qualityRow,
    actions,
    status,
    stage,
    problem,
    facts,
    advice,
    recActions,
  ]);

  const off = subscribeLlm(render);
  render();
  return { node, destroy: off };
}
