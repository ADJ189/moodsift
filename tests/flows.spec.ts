import { completeQuiz, expect, IMPORT_FILMS, rateCards, test, toResults } from './fixtures';

const PROFILE = 'cinematch.profile.v1';
const history = (page: import('@playwright/test').Page) =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{"history":[],"watchlist":[]}'), PROFILE) as Promise<{
    history: { id: number; tmdbType: string; title: string; source: string; rating: number }[];
    watchlist: { id: number; tmdbType: string }[];
  }>;

test.describe('core flow', () => {
  test('quiz → rating → results works end to end', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await completeQuiz(page);
    await toResults(page);
    await expect(page.locator('.featured')).toBeVisible();
    expect(await page.locator('.result-card').count()).toBeGreaterThan(2);
  });

  test('movie and TV titles with the same TMDB id never collide', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await completeQuiz(page);
    await toResults(page);
    // rate + save two titles that share an id but differ in media type, via the profile API surface
    await page.evaluate((k) => {
      const p = JSON.parse(localStorage.getItem(k) ?? '{}');
      p.history = [...(p.history ?? []), { id: 1399, title: 'Movie 1399', year: 2000, type: 'movie', tmdbType: 'movie', posterPath: null, rating: 2, source: 'result', genres: [], vibe: [], at: 1 }, { id: 1399, title: 'Show 1399', year: 2010, type: 'series', tmdbType: 'tv', posterPath: null, rating: 5, source: 'result', genres: [], vibe: [], at: 2 }];
      localStorage.setItem(k, JSON.stringify(p));
    }, PROFILE);
    await page.reload();
    const h = (await history(page)).history.filter((x) => x.id === 1399);
    expect(h.map((x) => x.tmdbType).sort()).toEqual(['movie', 'tv']);
  });

  test('watchlist toggle confirms with a toast and is type-aware', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await completeQuiz(page);
    await toResults(page);
    await page.locator('.result-card .watchlist-btn').first().click();
    await expect(page.getByRole('status').filter({ hasText: /to your watchlist/ })).toBeVisible();
    const wl = (await history(page)).watchlist;
    expect(wl).toHaveLength(1);
    expect(['movie', 'tv']).toContain(wl[0]!.tmdbType);
  });

  test('"Who’s watching" changes what is recommended', async ({ page, mock }) => {
    void mock;
    const titlesFor = async (optionIndex: number) => {
      await page.goto('/');
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      await page.getByRole('button', { name: /find my next watch/i }).click();
      for (let i = 0; i < 7; i++) {
        const opts = page.locator('.quiz-option');
        await opts.first().waitFor();
        // the last question is "Who's watching?": solo = 0, family = last
        await opts.nth(i === 6 ? optionIndex : 0).click();
        await page.waitForTimeout(450);
      }
      await page.locator('.rating-grid').waitFor();
      await toResults(page);
      return page.locator('.result-title').allInnerTexts();
    };
    const solo = await titlesFor(0);
    const family = await titlesFor(3);
    expect(family.join('|')).not.toBe(solo.join('|'));
  });

  test('rapid navigation never leaves the app dimmed or stuck', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    for (let i = 0; i < 6; i++) {
      await page.getByRole('button', { name: /find my next watch/i }).click();
      await page.locator('a.app-brand').click();
    }
    await page.waitForTimeout(600);
    await expect(page.locator('#app')).not.toHaveClass(/screen-loading/);
    await expect(page.locator('.landing')).toBeVisible();
    expect(await page.locator('.landing-canvas').count()).toBe(1); // no duplicate screens/canvases
  });

  test('hero particle loop stops when leaving the landing screen', async ({ page, mock }) => {
    void mock;
    await page.addInitScript(() => {
      const raf = window.requestAnimationFrame.bind(window);
      let live = 0;
      (window as unknown as { __raf: () => number }).__raf = () => live;
      window.requestAnimationFrame = (cb) => {
        live++;
        return raf((t) => {
          live--;
          cb(t);
        });
      };
    });
    await page.goto('/');
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /find my next watch/i }).click();
    await page.waitForTimeout(800);
    const ticks = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let n = 0;
          const orig = window.requestAnimationFrame;
          window.requestAnimationFrame = (cb) => {
            n++;
            return orig(cb);
          };
          setTimeout(() => resolve(n), 500);
        })
    );
    // Only CSS/animation bookkeeping may remain; a running canvas loop would tick ~30 times in 500ms.
    expect(ticks).toBeLessThan(6);
  });
});

test.describe('library re-import', () => {
  async function importCsv(page: import('@playwright/test').Page, rows: [string, number, number][]) {
    const csv = 'Date,Name,Year,Letterboxd URI,Rating\n' + rows.map(([n, y, r]) => `2024-01-01,${n},${y},x,${r}`).join('\n');
    await page.locator('input[type=file]').setInputFiles({ name: 'ratings.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await expect(page.locator('.import-status')).toContainText(/^Imported/, { timeout: 10_000 });
  }
  const imported = async (page: import('@playwright/test').Page) => (await history(page)).history.filter((h) => h.source === 'import').map((h) => h.title).sort();

  test('a smaller clean re-import replaces the old library; failed lookups never erase it', async ({ page, mock }) => {
    await page.goto('/');
    await completeQuiz(page);
    await importCsv(page, [['Alpha', 2001, 4], ['Beta', 2002, 3], ['Gamma', 2003, 5]]);
    expect(await imported(page)).toEqual(['Alpha', 'Beta', 'Gamma']);

    mock.failTitles.add('Delta');
    await importCsv(page, [['Alpha', 2001, 2], ['Delta', IMPORT_FILMS.Delta![1], 5]]);
    expect(await imported(page)).toEqual(['Alpha', 'Beta', 'Gamma']);
    await expect(page.locator('.import-status')).toContainText(/lookup failed/);

    mock.failTitles.clear();
    await importCsv(page, [['Alpha', 2001, 2]]);
    expect(await imported(page)).toEqual(['Alpha']);
  });

  test('ratings given in the app survive any re-import', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await completeQuiz(page);
    await rateCards(page, 2);
    const before = (await history(page)).history.filter((h) => h.source !== 'import').length;
    await importCsv(page, [['Alpha', 2001, 4]]);
    await importCsv(page, [['Beta', 2002, 3]]);
    expect((await history(page)).history.filter((h) => h.source !== 'import').length).toBe(before);
  });
});

test.describe('compare', () => {
  test('select two, compare, remove, clear — with keyboard and announcements', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await completeQuiz(page);
    await toResults(page);
    const buttons = page.locator('.result-card .compare-btn');
    await buttons.nth(0).click();
    await expect(page.locator('.compare-tray')).toBeVisible();
    await expect(page.getByRole('button', { name: /Pick 2.3 to compare/ })).toBeDisabled();
    await buttons.nth(1).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-compare-live]')).toContainText('2 of 3 selected');
    await buttons.nth(2).click();
    await buttons.nth(3).click(); // fourth is refused
    await expect(page.locator('[data-compare-live]')).toContainText(/up to 3/);
    await expect(page.locator('.compare-chip')).toHaveCount(3);

    const opener = page.getByRole('button', { name: 'Compare 3' });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Compare your shortlist' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.compare-col')).toHaveCount(3);
    await expect(dialog.getByText('Runtime').first()).toBeVisible();
    await expect(dialog.getByText('Not available').first()).toBeVisible();
    await dialog.getByRole('button', { name: /^Remove .* from comparison$/ }).first().click();
    await expect(dialog.locator('.compare-col')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Compare 2' })).toBeFocused();
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(page.locator('.compare-tray')).toBeHidden();
  });

  test('selection is cleared and the tray removed when leaving results', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await completeQuiz(page);
    await toResults(page);
    await page.locator('.result-card .compare-btn').first().click();
    await page.locator('a.app-brand').click();
    await expect(page.locator('.compare-tray')).toHaveCount(0);
  });
});

test.describe('command menu and shortcuts', () => {
  test('Ctrl+K opens, filters, navigates by keyboard, and Escape restores focus', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: 'Command menu' });
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole('combobox');
    await expect(input).toBeFocused();
    await input.fill('quiz');
    await expect(page.getByRole('option', { name: /Take the quiz/ })).toHaveAttribute('aria-selected', 'true');
    await expect(input).toHaveAttribute('aria-activedescendant', /cmd-opt-/);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.keyboard.press('Control+k');
    await dialog.getByRole('combobox').fill('inception');
    await page.keyboard.press('Enter');
    await expect(page.locator('.search-input')).toHaveValue('inception');
  });

  test('"/" and "?" do not fire while typing in a field', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await page.getByRole('button', { name: 'Search for a title' }).click();
    await page.locator('.search-input').fill('a/b?');
    await expect(page.getByRole('dialog', { name: 'Command menu' })).toHaveCount(0);
    await expect(page.locator('.search-input')).toHaveValue('a/b?');
    await page.locator('.search-input').blur();
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0);
  });

  test('shortcuts do not open on top of another dialog', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await page.getByRole('button', { name: 'Appearance settings', exact: true }).click();
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Command menu' })).toHaveCount(0);
  });
});

test.describe('onboarding', () => {
  test('"Choose your vibe" can be skipped, stays dismissed, and never blocks the CTA', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await expect(page.getByRole('region', { name: 'Choose your look' })).toBeVisible();
    await expect(page.getByRole('button', { name: /find my next watch/i })).toBeEnabled();
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('region', { name: 'Choose your look' })).toHaveCount(0);
  });

  test('choosing a vibe sets ordinary settings and respects OS reduced motion', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const { mockTmdb } = await import('./fixtures');
    await mockTmdb(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Neon' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'off'); // accessibility wins over the vibe
    await ctx.close();
  });
});
