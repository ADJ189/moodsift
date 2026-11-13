// src/lib/a11y.ts — focus management for overlays.

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Makes `container` behave like a real modal dialog for keyboard users:
 * moves focus inside (to `initialFocus` or the first control), keeps Tab /
 * Shift+Tab cycling within it, calls `onEscape` on Escape, and — when the
 * returned release function runs — puts focus back on whatever opened it.
 *
 * `also` names extra regions that live outside `container` (e.g. a toast
 * with an Undo button) but must stay reachable. Their controls follow the
 * container's in the Tab order.
 */
export function trapFocus(
  container: HTMLElement,
  opts: { initialFocus?: HTMLElement; onEscape: () => void; also?: () => (HTMLElement | null)[]; restoreFocus?: HTMLElement | null }
): () => void {
  const opener = opts.restoreFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);

  const regions = () => [container, ...(opts.also?.() ?? [])].filter((r): r is HTMLElement => !!r && document.contains(r));
  const isVisible = (n: HTMLElement) => n.offsetParent !== null || n === document.activeElement || getComputedStyle(n).position === 'fixed';
  // `tabIndex >= 0` drops controls a roving-tabindex group has parked at -1
  // (inactive tabs / radio choices): native Tab skips them, and so must the
  // explicit order below, or every group would add a stop per option and
  // defeat its arrow-key navigation.
  const focusables = () =>
    regions().flatMap((r) => Array.from(r.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.tabIndex >= 0 && isVisible(n)));

  (opts.initialFocus ?? focusables()[0] ?? container).focus({ preventScroll: true });

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      opts.onEscape();
      return;
    }
    if (e.key !== 'Tab') return;
    const nodes = focusables();
    if (nodes.length === 0) {
      e.preventDefault();
      return;
    }
    // Move focus explicitly through `nodes` (container first, then the
    // `also` regions) instead of trusting the browser. Document order can
    // differ from that list — a toast host created before the dialog sits
    // *earlier* in the DOM — so native Tab could step out to the page
    // behind the dialog from the last control or from the toast.
    const active = document.activeElement as HTMLElement | null;
    const index = active ? nodes.indexOf(active) : -1;
    const step = e.shiftKey ? -1 : 1;
    const nextIndex = index === -1 ? (e.shiftKey ? nodes.length - 1 : 0) : (index + step + nodes.length) % nodes.length;
    e.preventDefault();
    nodes[nextIndex]!.focus({ preventScroll: true });
  }

  document.addEventListener('keydown', onKey);
  return () => {
    document.removeEventListener('keydown', onKey);
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
  };
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
