import { completeQuiz, expect, test as base, toResults } from './fixtures';
import { mockTmdb } from './fixtures';

// Device/environment matrix. Runs in every Playwright project (desktop, tablet,
// small phone, landscape, WebKit, Firefox). Each check is engine-agnostic: no
// CDP, no hover-only assumptions, no fixed pixel expectations beyond the WCAG
// minimum target size.

const test = base;

async function horizontalOverflow(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    return Math.max(doc.scrollWidth, document.body.scrollWidth) - window.innerWidth;
  });
}

/** Elements whose right edge crosses the viewport, for an actionable failure. */
async function overflowOffenders(page: import('@playwright/test').Page): Promise<{ tag: string; cls: string; label: string; right: number }[]> {
  return page.evaluate(() => {
    const out: { tag: string; cls: string; label: string; right: number }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.right <= window.innerWidth + 1) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.position === 'fixed') continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: el.className && typeof el.className === 'string' ? el.className.slice(0, 60) : '',
        label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40),
        right: Math.round(rect.right),
      });
      if (out.length >= 8) break;
    }
    return out;
  });
}

async function expectNoOverflow(page: import('@playwright/test').Page, label: string): Promise<void> {
  await page.waitForTimeout(150);
  const overflow = await horizontalOverflow(page);
  const detail = overflow > 1 ? ` by ${overflow}px; offenders: ${JSON.stringify(await overflowOffenders(page))}` : '';
  expect(overflow, `${label}: horizontal overflow${detail}`).toBeLessThanOrEqual(1);
}

test.describe('environment matrix', () => {
  test('landing renders inside every viewport', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await expect(page.getByRole('button', { name: /find my next watch|get fresh picks/i })).toBeVisible();
    await expectNoOverflow(page, 'landing');
  });

  test('screen padding at 320px viewport uses the narrow override', async ({ page, mock }) => {
    void mock;
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/');
    const padding = await page.evaluate(() => {
      const screen = document.querySelector('.screen');
      if (!screen) return null;
      const s = getComputedStyle(screen);
      return { top: s.paddingTop, right: s.paddingRight, bottom: s.paddingBottom, left: s.paddingLeft };
    });
    expect(padding).toEqual({ top: '16px', right: '12px', bottom: '16px', left: '12px' });
  });

  test('quiz and results render inside every viewport', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await completeQuiz(page);
    await expectNoOverflow(page, 'quiz/rating');
    await toResults(page);
    await expectNoOverflow(page, 'results');
    const card = await page.locator('.result-card').first().boundingBox();
    const viewport = page.viewportSize()!;
    expect(card).not.toBeNull();
    expect(card!.x, 'result card starts on screen').toBeGreaterThanOrEqual(-1);
    expect(card!.x + card!.width, 'result card ends on screen').toBeLessThanOrEqual(viewport.width + 1);
  });

  test('interactive targets meet the 24×24 WCAG 2.2 minimum', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    const small = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll<HTMLElement>('button, [role="button"], a[href]')];
      return nodes
        // A closed dialog or collapsed panel is still in the DOM and can have
        // a measurable box (the settings sheet is translated off-screen), but
        // it is not a control the user can currently reach.
        .filter((n) => !n.closest('[hidden], [inert], [aria-hidden="true"]'))
        .filter((n) => {
          const style = getComputedStyle(n);
          const rect = n.getBoundingClientRect();
          if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) return false;
          // A closed popover is still laid out (opacity: 0, pointer-events:
          // none); it is not a control the user can currently reach.
          if (style.pointerEvents === 'none') return false;
          // ...and it must actually intersect the viewport.
          return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
        })
        .map((n) => ({ label: (n.getAttribute('aria-label') || n.textContent || '').trim().slice(0, 40), w: Math.round(n.getBoundingClientRect().width), h: Math.round(n.getBoundingClientRect().height) }))
        // Inline links inside prose are exempt from the target-size rule.
        .filter((n) => n.w > 0 && n.h > 0 && (n.w < 24 || n.h < 24));
    });
    expect(small, 'visible controls below 24×24').toEqual([]);
  });

  test('200% text zoom does not create horizontal overflow', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    await expectNoOverflow(page, 'landing at 200% text');
    await expect(page.getByRole('button', { name: /find my next watch|get fresh picks/i })).toBeVisible();
  });

  test('forced-colors mode keeps the landing usable', async ({ page, mock }) => {
    void mock;
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto('/');
    const cta = page.getByRole('button', { name: /find my next watch|get fresh picks/i });
    await expect(cta).toBeVisible();
    await cta.focus();
    await expect(cta).toBeFocused();
    await expectNoOverflow(page, 'forced colors');
  });

  test('reduced motion resolves to the off profile and keeps content visible', async ({ page, mock }) => {
    void mock;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-motion')), { timeout: 5_000 })
      .toBe('off');
    await expect(page.getByRole('button', { name: /find my next watch|get fresh picks/i })).toBeVisible();
    await expectNoOverflow(page, 'reduced motion');
  });

  test('system colour scheme follows the OS preference', async ({ page, mock }) => {
    void mock;
    await page.emulateMedia({ colorScheme: 'light' });
    await page.addInitScript(() => localStorage.setItem('cinematch-appearance:v1', JSON.stringify({ version: 1, mode: 'system' })));
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-theme')), { timeout: 5_000 }).toBe('light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('light');
  });

  test('a blocked localStorage never blanks the app', async ({ page, mock }) => {
    void mock;
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('blocked', 'SecurityError');
        },
      });
    });
    await page.goto('/');
    await expect(page.getByRole('button', { name: /find my next watch|get fresh picks/i })).toBeVisible();
    await expectNoOverflow(page, 'blocked storage');
  });

  test('an unreadable stored profile is set aside, not deleted', async ({ page, mock }) => {
    void mock;
    await page.addInitScript(() => localStorage.setItem('cinematch.profile.v2', 'MOODPROFILE|2|lz-utf16|not-real-data'));
    await page.goto('/');
    await expect(page.getByRole('button', { name: /find my next watch|get fresh picks/i })).toBeVisible();
    const kept = await page.evaluate(() => ({
      original: localStorage.getItem('cinematch.profile.v2'),
      setAside: localStorage.getItem('cinematch.profile.v2.unreadable'),
    }));
    expect(kept.setAside !== null || kept.original !== null, 'unreadable data must not be destroyed').toBe(true);
  });

  test('boots under a non-English locale and timezone', async ({ browser, browserName }) => {
    test.skip(browserName !== 'chromium', 'one engine is enough for locale plumbing');
    const ctx = await browser.newContext({ locale: 'de-DE', timezoneId: 'Europe/Berlin', viewport: { width: 390, height: 844 }, hasTouch: true });
    const page = await ctx.newPage();
    await mockTmdb(page);
    await page.goto('/');
    await expect(page.getByRole('button', { name: /find my next watch|get fresh picks/i })).toBeVisible();
    await expectNoOverflow(page, 'de-DE');
    await ctx.close();
  });
});
