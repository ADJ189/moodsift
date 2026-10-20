import { completeQuiz, expect, mockSearchResults, openSettings, test, toResults } from './fixtures';
import type { Page } from '@playwright/test';

const KEY = 'cinematch-appearance:v1';
const html = (page: Page) => page.locator('html');

async function seed(page: Page, prefs: Record<string, unknown>) {
  await page.addInitScript(
    ([k, v]) => {
      if (!localStorage.getItem('seeded-design')) {
        localStorage.setItem('seeded-design', '1');
        localStorage.setItem(k as string, JSON.stringify({ version: 1, motion: 'off', particles: 'off', ...(v as object) }));
        localStorage.setItem('cinematch-vibe:v1', 'skipped');
      }
    },
    [KEY, prefs]
  );
}

const searchInput = (page: Page) => page.getByRole('combobox', { name: 'Search for a title' });
async function openSearch(page: Page) {
  await page.getByRole('button', { name: 'Search for a title', exact: true }).click();
  await expect(searchInput(page)).toBeVisible();
}

test.describe('preferences', () => {
  test('defaults apply and old stored appearance without the new keys still loads', async ({ page, mock }) => {
    void mock;
    await seed(page, { palette: 'forest' });
    await page.goto('/');
    await expect(html(page)).toHaveAttribute('data-palette', 'forest');
    await expect(html(page)).toHaveAttribute('data-card-type', 'interactive');
    await expect(html(page)).toHaveAttribute('data-design-style', 'cinematic');
    await expect(html(page)).toHaveAttribute('data-search-type', 'grouped');
  });

  test('hostile values for the new keys fall back to defaults', async ({ page, mock }) => {
    void mock;
    await seed(page, { cardType: '"><img src=x>', designStyle: 'glitter', searchType: ['grouped'] });
    await page.goto('/');
    await expect(html(page)).toHaveAttribute('data-card-type', 'interactive');
    await expect(html(page)).toHaveAttribute('data-design-style', 'cinematic');
    await expect(html(page)).toHaveAttribute('data-search-type', 'grouped');
  });

  test('card type, design style and search type persist across reload', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await openSettings(page, 'Cards & layout');
    await page.getByRole('radio', { name: /Editorial/ }).click();
    await page.getByRole('tab', { name: 'Theme' }).click();
    await page.getByRole('radio', { name: /Neon noir/ }).click();
    await page.getByRole('tab', { name: 'Search' }).click();
    await page.getByRole('radio', { name: /Expanded/ }).click();
    await expect(html(page)).toHaveAttribute('data-card-type', 'editorial');
    await expect(html(page)).toHaveAttribute('data-design-style', 'neon-noir');
    await expect(html(page)).toHaveAttribute('data-search-type', 'expanded');
    await page.waitForTimeout(500);
    await page.reload();
    await expect(html(page)).toHaveAttribute('data-card-type', 'editorial');
    await expect(html(page)).toHaveAttribute('data-design-style', 'neon-noir');
    await expect(html(page)).toHaveAttribute('data-search-type', 'expanded');
  });

  test('export/import carries the new keys and rejects bad ones', async ({ page, mock }) => {
    void mock;
    await seed(page, { cardType: 'compact', designStyle: 'glass', searchType: 'compact' });
    await page.goto('/');
    await openSettings(page, 'Advanced');
    await page.getByRole('button', { name: 'Export appearance' }).click();
    const parsed = JSON.parse(await page.getByLabel('Exported appearance JSON').inputValue());
    expect(parsed.preferences).toMatchObject({ cardType: 'compact', designStyle: 'glass', searchType: 'compact' });
    await page.getByRole('button', { name: /Import from JSON/ }).click();
    const box = page.getByLabel('Paste appearance JSON to import');
    await box.fill(JSON.stringify({ ...parsed, preferences: { ...parsed.preferences, designStyle: 'nope' } }));
    await page.getByRole('button', { name: 'Import appearance' }).click();
    await expect(page.getByText('Invalid value for “designStyle”.')).toBeVisible();
    await box.fill(JSON.stringify({ ...parsed, preferences: { ...parsed.preferences, designStyle: 'minimal', searchType: 'full-page' } }));
    await page.getByRole('button', { name: 'Import appearance' }).click();
    await expect(html(page)).toHaveAttribute('data-design-style', 'minimal');
    await expect(html(page)).toHaveAttribute('data-search-type', 'full-page');
  });
});

test.describe('settings workspace', () => {
  test('opens on Overview; the section tabs work with the arrow keys', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await openSettings(page);
    await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await page.getByRole('tab', { name: 'Overview' }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('tab', { name: 'Cards & layout' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Cards & layout' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: 'Advanced' })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  test('option tiles are a radiogroup: arrow keys move and select, focus stays put', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await openSettings(page, 'Cards & layout');
    const interactive = page.getByRole('radio', { name: /Interactive/ });
    await expect(interactive).toHaveAttribute('aria-checked', 'true');
    await interactive.focus();
    await page.keyboard.press('ArrowRight');
    await expect(html(page)).toHaveAttribute('data-card-type', 'poster');
    await expect(page.getByRole('radio', { name: /Poster gallery/ })).toBeFocused();
    await expect(page.getByRole('radio', { name: /Poster gallery/ })).toHaveAttribute('aria-checked', 'true');
  });

  test('Overview summaries jump to their section; presets apply as ordinary settings and can be undone', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await openSettings(page);
    await page.getByRole('button', { name: /Search type/ }).click();
    await expect(page.getByRole('tab', { name: 'Search' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Overview' }).click();
    await page.getByRole('button', { name: /Film journal/ }).click();
    await expect(html(page)).toHaveAttribute('data-card-type', 'editorial');
    await expect(html(page)).toHaveAttribute('data-design-style', 'film-journal');
    await expect(html(page)).toHaveAttribute('data-search-type', 'expanded');
    // a preset never lowers text size, contrast or transparency
    await expect(html(page)).toHaveAttribute('data-contrast', 'standard');
    await page.getByRole('button', { name: 'Undo', exact: true }).first().click();
    await expect(html(page)).toHaveAttribute('data-card-type', 'interactive');
    await expect(html(page)).toHaveAttribute('data-design-style', 'cinematic');
  });

  test('Performance preset reduces effects but leaves motion profile and text size alone', async ({ page, mock }) => {
    void mock;
    await seed(page, { motion: 'full', textScale: 125 });
    await page.goto('/');
    await openSettings(page);
    await page.getByRole('button', { name: /Performance/ }).click();
    await expect(html(page)).toHaveAttribute('data-card-type', 'compact');
    await expect(html(page)).toHaveAttribute('data-motion', 'full');
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--text-scale'))).toBe('1.25');
  });

  test('section resets are scoped: Search reset leaves card type alone', async ({ page, mock }) => {
    void mock;
    await seed(page, { cardType: 'compact', searchType: 'expanded' });
    await page.goto('/');
    await openSettings(page, 'Search');
    await page.getByRole('button', { name: 'Reset this section' }).click();
    await expect(html(page)).toHaveAttribute('data-search-type', 'grouped');
    await expect(html(page)).toHaveAttribute('data-card-type', 'compact');
  });

  test('on a phone the settings are a sheet with no horizontal overflow in any section', async ({ page, mock }) => {
    void mock;
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto('/');
    await openSettings(page);
    for (const name of ['Overview', 'Cards & layout', 'Search', 'Theme', 'Readability', 'Motion & performance', 'AI engine', 'Advanced']) {
      await page.getByRole('tab', { name }).click();
      const over = await page.evaluate(() => {
        const panel = document.querySelector('.appearance-panel') as HTMLElement;
        const body = document.querySelector('.ap-body') as HTMLElement;
        return { panel: panel.scrollWidth - panel.clientWidth, body: body.scrollWidth - body.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      expect(over, name).toEqual({ panel: 0, body: 0, page: 0 });
    }
  });
});

test.describe('search', () => {
  test('grouped: headings, labelled options, no rating when TMDB has no votes', async ({ page, mock }) => {
    void mock;
    await mockSearchResults(page);
    await page.goto('/');
    await openSearch(page);
    await searchInput(page).fill('midnight');
    const list = page.getByRole('listbox', { name: 'Search suggestions' });
    await expect(list).toBeVisible();
    await expect(page.getByRole('group', { name: 'Movies & TV Shows' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'People' })).toBeVisible();
    await expect(searchInput(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('option', { name: /The Midnight Reel/ })).toContainText('7.8');
    // zero-vote title: no invented rating
    await expect(page.getByRole('option', { name: /Midnight Express Lane/ })).not.toContainText('TMDB rating');
    await expect(page.getByRole('option', { name: /Mira Calloway/ })).toContainText('Known for');
  });

  test('keyboard: arrows move the active option, Enter picks it, Escape keeps the typed text', async ({ page, mock }) => {
    void mock;
    await mockSearchResults(page);
    await page.goto('/');
    await openSearch(page);
    const input = searchInput(page);
    await input.fill('midnight');
    await expect(page.getByRole('option').first()).toBeVisible();
    await input.press('ArrowDown');
    await expect(page.getByRole('option').nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(input).toHaveAttribute('aria-activedescendant', /search-suggestions-o0/);
    await input.press('ArrowDown');
    await expect(page.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
    await input.press('ArrowUp');
    await input.press('ArrowUp'); // wraps to the last option
    await expect(page.getByRole('option').last()).toHaveAttribute('aria-selected', 'true');
    await input.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(input).toHaveValue('midnight');
    await expect(input).toBeFocused();
    await input.press('ArrowDown'); // reopens
    await expect(page.getByRole('listbox')).toBeVisible();
    await input.press('Enter');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(input).toHaveValue('');
  });

  test('a click on a suggestion picks it and closes the panel', async ({ page, mock }) => {
    void mock;
    await mockSearchResults(page);
    await page.goto('/');
    await openSearch(page);
    await searchInput(page).fill('midnight');
    await page.getByRole('option', { name: /Midnight Harbor/ }).click();
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(page.locator('.search-hero')).toBeVisible();
  });

  test('compact shows type tags; expanded shows a preview of the highlighted result', async ({ page, mock, isMobile }) => {
    test.skip(isMobile, 'the expanded preview pane needs a wide viewport');
    void mock;
    await mockSearchResults(page);
    await seed(page, { searchType: 'compact' });
    await page.goto('/');
    await openSearch(page);
    await searchInput(page).fill('midnight');
    await expect(page.locator('.search-panel[data-variant="compact"] .search-tag').first()).toBeVisible();
    // switching type from Settings redraws from the cache — no new request
    const before = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/search/')).length);
    await page.getByRole('button', { name: 'Appearance settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Search' }).click();
    await page.getByRole('radio', { name: /Expanded/ }).click();
    await page.keyboard.press('Escape');
    await searchInput(page).focus();
    await expect(page.locator('.search-panel[data-variant="expanded"] .search-preview')).toBeVisible();
    const after = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/search/')).length);
    expect(after).toBe(before);
  });

  test('full page: filters with real counts; See all results opens it from other types', async ({ page, mock }) => {
    void mock;
    await mockSearchResults(page);
    await page.goto('/');
    await openSearch(page);
    await searchInput(page).fill('midnight');
    await page.getByRole('button', { name: /See all results for/ }).click();
    const group = page.getByRole('group', { name: 'Filter results' });
    await expect(group.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true');
    await expect(group.getByRole('button', { name: /^Movies/ })).toContainText('4');
    await expect(group.getByRole('button', { name: /^TV Shows/ })).toContainText('2');
    await expect(page.locator('.search-full .result-card')).toHaveCount(6);
    await group.getByRole('button', { name: /^People/ }).click();
    await expect(page.locator('.search-full .result-card')).toHaveCount(0);
    await expect(page.locator('.search-person-card')).toHaveCount(2);
    await group.getByRole('button', { name: /^Movies/ }).click();
    await expect(page.locator('.search-full .result-card')).toHaveCount(4);
    // the card links to the same detail flow
    await page.locator('.search-full .result-title-btn').first().click();
    await expect(page.locator('.search-hero')).toBeVisible();
  });

  test('full-page type shows results inline with no dropdown', async ({ page, mock }) => {
    void mock;
    await mockSearchResults(page);
    await seed(page, { searchType: 'full-page' });
    await page.goto('/');
    await openSearch(page);
    await searchInput(page).fill('midnight');
    await expect(page.locator('.search-full .result-card').first()).toBeVisible();
    await expect(page.getByRole('listbox')).toHaveCount(0);
  });

  test('loading, empty and error states; Retry recovers', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await mockSearchResults(page, { empty: true });
    await openSearch(page);
    await searchInput(page).fill('zzzz');
    await expect(page.getByText('No matches')).toBeVisible();

    const failing = await mockSearchResults(page, { fail: true });
    void failing;
    await searchInput(page).fill('midnight');
    await expect(page.getByRole('alert')).toContainText('Search failed');
    await mockSearchResults(page);
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('option').first()).toBeVisible();
  });

  test('one-character queries never hit the network', async ({ page, mock }) => {
    void mock;
    const { calls } = await mockSearchResults(page);
    await page.goto('/');
    await openSearch(page);
    await searchInput(page).fill('m');
    await page.waitForTimeout(500);
    expect(calls).toEqual([]);
    await expect(page.getByRole('listbox')).toHaveCount(0);
  });

  test('phone: the panel stays inside the viewport and scrolls internally', async ({ page, mock }) => {
    void mock;
    await mockSearchResults(page);
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto('/');
    await openSearch(page);
    await searchInput(page).fill('midnight');
    await expect(page.locator('.search-panel')).toBeVisible();
    const box = await page.locator('.search-panel').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});

test.describe('result cards', () => {
  test('every card type × layout keeps its actions reachable and never overflows', async ({ page, mock }) => {
    void mock;
    test.setTimeout(180_000);
    await seed(page, {});
    await page.goto('/');
    await completeQuiz(page);
    await toResults(page);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const type of ['interactive', 'poster', 'editorial', 'compact']) {
        for (const layout of ['grid', 'list', 'spotlight']) {
          await page.evaluate(([t, l]) => {
            document.documentElement.setAttribute('data-card-type', t!);
            document.documentElement.setAttribute('data-results-layout', l!);
          }, [type, layout]);
          const info = await page.evaluate(() => {
            const card = document.querySelector('.result-card') as HTMLElement;
            const visible = (sel: string) => {
              const n = card.querySelector(sel) as HTMLElement | null;
              return !!n && getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().width > 0;
            };
            return {
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              title: visible('.result-title-btn'),
              watch: visible('.watchlist-btn'),
              compare: visible('.compare-btn'),
              stars: visible('.star'),
              badge: !!card.querySelector('.poster-match-badge'),
            };
          });
          const label = `${type}/${layout}@${width}`;
          expect(info.overflow, label).toBeLessThanOrEqual(0);
          expect(info.title, label).toBe(true);
          expect(info.watch, label).toBe(true);
          expect(info.compare, label).toBe(true);
          expect(info.stars, label).toBe(true);
        }
      }
    }
  });

  test('keyboard focus reveals the quick actions; Details opens the same sheet as the title', async ({ page, mock, isMobile }) => {
    test.skip(isMobile, 'touch devices show the quick actions at rest');
    void mock;
    await seed(page, {});
    await page.goto('/');
    await completeQuiz(page);
    await toResults(page);
    const card = page.locator('.result-card').first();
    const quick = card.locator('.result-quick-btn');
    await expect(quick).toHaveCSS('opacity', '0');
    await card.locator('.result-title-btn').focus();
    await expect(quick).toHaveCSS('opacity', '1');
    await quick.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.modal-card')).toBeVisible();
  });

  test('the poster-wide target is not a tab stop', async ({ page, mock }) => {
    void mock;
    await seed(page, {});
    await page.goto('/');
    await completeQuiz(page);
    await toResults(page);
    await expect(page.locator('.result-card .result-open').first()).toHaveAttribute('tabindex', '-1');
  });

  test('touch: quick actions are visible without hover', async ({ browser }) => {
    const ctx = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 } });
    const page = await ctx.newPage();
    const { mockTmdb } = await import('./fixtures');
    await mockTmdb(page);
    await seed(page, {});
    await page.goto('/');
    await completeQuiz(page);
    await toResults(page);
    await expect(page.locator('.result-card .result-quick-btn').first()).toHaveCSS('opacity', '1');
    await ctx.close();
  });

  test('Motion Off removes the card lift; glass turns opaque under Reduced transparency', async ({ page, mock }) => {
    void mock;
    await seed(page, { cardType: 'interactive', motion: 'off', designStyle: 'glass' });
    await page.goto('/');
    await completeQuiz(page);
    await toResults(page);
    const card = page.locator('.result-card').nth(1);
    await card.hover();
    expect(await card.evaluate((n) => getComputedStyle(n).transform)).toBe('none');
    const bg = () => page.evaluate(() => getComputedStyle(document.querySelector('.result-card')!).backgroundColor);
    const translucent = await bg();
    await page.evaluate(() => document.documentElement.setAttribute('data-transparency', 'reduced'));
    const opaque = await bg();
    expect(translucent).not.toBe(opaque);
    expect(opaque).not.toMatch(/rgba\(.*,\s*0\.\d+\)$/);
  });

  test('every design style renders the results without overflow', async ({ page, mock }) => {
    void mock;
    test.setTimeout(120_000);
    await seed(page, {});
    await page.goto('/');
    await completeQuiz(page);
    await toResults(page);
    for (const style of ['cinematic', 'minimal', 'film-journal', 'glass', 'neon-noir']) {
      await page.evaluate((s) => document.documentElement.setAttribute('data-design-style', s), style);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), style).toBe(true);
    }
  });
});
