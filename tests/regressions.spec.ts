import { completeQuiz, expect, openDisclosure, test, toResults } from './fixtures';

// Regression tests for review findings on the command menu, focus handling,
// saved looks, compare buttons and the Compare-with-before preview.

test.describe('command menu → search', () => {
  test('searching from the command menu while already on the search page applies it, and does not replay later', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await page.getByRole('button', { name: 'Search for a title', exact: true }).click();
    const input = page.locator('.search-input');
    await expect(input).toBeVisible();
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog', { name: 'Command menu' }).getByRole('combobox').fill('dune');
    await page.keyboard.press('Enter');
    await expect(input).toHaveValue('dune');
    // leave and reopen: the consumed target must not reappear
    await page.locator('a.app-brand').click();
    await page.getByRole('button', { name: 'Search for a title', exact: true }).click();
    await expect(page.locator('.search-input')).toHaveValue('');
  });
});

test.describe('dialog stacking', () => {
  test('"?" does not open shortcut help over the compare dialog or a detail sheet', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await completeQuiz(page);
    await toResults(page);

    // detail sheet
    await page.locator('.result-card .result-title-btn').first().click();
    await expect(page.locator('.modal-card')).toBeVisible();
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal-card')).toHaveCount(0);

    // compare dialog: Escape must close only it
    const buttons = page.locator('.result-card .compare-btn');
    await buttons.nth(0).click();
    await buttons.nth(1).click();
    await page.getByRole('button', { name: 'Compare 2' }).click();
    const dialog = page.getByRole('dialog', { name: 'Compare your shortlist' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });
});

test.describe('appearance drawer focus', () => {
  const open = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'Appearance settings', exact: true }).click();

  test('Tab visits each roving group once — never a parked (tabindex -1) option', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await open(page);
    await page.getByRole('tab', { name: 'Theme' }).click();
    const stops: string[] = [];
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const a = document.activeElement as HTMLElement;
        return { tabIndex: a.tabIndex, label: (a.getAttribute('aria-label') ?? a.textContent ?? '').trim().slice(0, 30), inDrawer: !!a.closest('.appearance-panel, .toast-host') };
      });
      expect(info.tabIndex, `parked control focused: ${info.label}`).toBeGreaterThanOrEqual(0);
      expect(info.inDrawer).toBe(true);
      stops.push(info.label);
    }
    // Tab must have reached the System/Dark/Light group at most once per lap of the drawer
    // (it used to land on all three options each time).
    const modeStops = stops.filter((s) => ['System', 'Dark', 'Light'].includes(s)).length;
    const laps = stops.filter((s) => s === 'Close settings').length || 1;
    expect(modeStops).toBeLessThanOrEqual(laps + 1);
  });

  test('applying a saved look by keyboard keeps focus on that look and continues Tab from it', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await open(page);
    await page.getByRole('tab', { name: 'Theme' }).click();
    await openDisclosure(page, 'Saved looks');
    for (const [name, palette] of [['One', /Forest/], ['Two', /Ember/]] as const) {
      await page.getByRole('radio', { name: palette }).click();
      await page.getByLabel('Name for the new look').fill(name);
      await page.getByRole('button', { name: 'Save current look' }).click();
    }
    const first = page.locator('[data-look-action="apply"]').first();
    await first.focus();
    await page.keyboard.press('Enter'); // applies the look → appearance notifies
    await page.waitForTimeout(500); // past the debounced save, which notifies again
    const focused = await page.evaluate(() => ({ id: document.activeElement?.getAttribute('data-look-id'), action: document.activeElement?.getAttribute('data-look-action') }));
    expect(focused.action).toBe('apply');
    expect(focused.id).toBe(await first.getAttribute('data-look-id'));
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-look-action'))).toBe('delete');
  });

  test('deleting the focused look moves focus to a neighbour, not the page', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await open(page);
    await page.getByRole('tab', { name: 'Theme' }).click();
    await openDisclosure(page, 'Saved looks');
    for (const name of ['One', 'Two']) {
      await page.getByLabel('Name for the new look').fill(name);
      await page.getByRole('button', { name: 'Save current look' }).click();
    }
    const del = page.getByRole('button', { name: 'Delete look One' });
    await del.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-look-action="apply"]')).toHaveCount(1);
    expect(await page.evaluate(() => !!document.activeElement?.closest('.appearance-panel'))).toBe(true);
  });
});

test.describe('Compare with before + hero canvas', () => {
  test('the particle canvas follows the previewed baseline, not the live preference', async ({ page, mock }) => {
    void mock;
    await page.addInitScript(() => {
      if (!localStorage.getItem('seeded')) {
        localStorage.setItem('seeded', '1');
        localStorage.setItem('cinematch-appearance:v1', JSON.stringify({ version: 1, motion: 'full', particles: 'off' }));
        localStorage.setItem('cinematch-vibe:v1', 'x');
      }
    });
    await page.goto('/');
    const canvas = page.locator('.landing-canvas');
    await expect(canvas).toBeHidden(); // baseline: particles Off
    await page.getByRole('button', { name: 'Appearance settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Motion' }).click();
    await page.getByRole('radio', { name: 'Balanced', exact: true }).first().click();
    await expect(canvas).toBeVisible(); // live: particles on
    await page.getByRole('button', { name: 'Compare with before' }).click();
    await expect(canvas).toBeHidden(); // previewing the old look → no particles
    await page.getByRole('button', { name: /Showing before/ }).click();
    await expect(canvas).toBeVisible();
  });
});

test.describe('rating a result', () => {
  test('the title you just rated stays on screen (filled stars) after the grid re-curates', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await completeQuiz(page);
    await toResults(page);

    const card = page.locator('.result-card').first();
    const title = (await card.locator('.result-title-btn').textContent())?.trim() ?? '';
    expect(title).not.toBe('');
    await card.getByRole('button', { name: 'Rate 4 stars', exact: true }).click();

    // wait for the debounced re-curation to land (the indicator toggles), then
    // the rated title must still be present and still show its rating.
    await expect(page.locator('.curating-indicator')).toBeHidden({ timeout: 10_000 });
    const again = page.locator('.result-card', { has: page.locator('.result-title-btn', { hasText: title }) });
    await expect(again).toHaveCount(1);
    await expect(again.locator('.star.filled')).toHaveCount(4);
  });
});
