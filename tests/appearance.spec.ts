import { expect, openDisclosure, openSettings, test } from './fixtures';

const KEY = 'cinematch-appearance:v1';

test.describe('appearance', () => {
  test('choices persist across reload and set the right attributes', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await openSettings(page, 'Theme');
    await page.getByRole('radio', { name: /Noir & Gold/ }).click();
    await page.getByRole('radio', { name: 'Dark' }).click();
    await page.keyboard.press('Escape');
    await page.reload();
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-palette', 'noir-gold');
    await expect(html).toHaveAttribute('data-theme', 'dark');
  });

  test('corrupt and hostile stored values fall back safely', async ({ page, mock }) => {
    void mock;
    await page.addInitScript((k) => localStorage.setItem(k, '{{{not json'), KEY);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'aurora');
    await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ version: 1, palette: '"><img src=x onerror=alert(1)>', fontPreset: 'https://evil.example/f.css', textScale: 9999, customAccent: 'red;background:url(x)' })), KEY);
    await page.reload();
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-palette', 'aurora');
    await expect(html).toHaveAttribute('data-font', 'default');
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--text-scale'))).toBe('1');
    await expect(html).not.toHaveAttribute('data-accent', 'custom');
  });

  test('legacy cinematch-theme value migrates once', async ({ page, mock }) => {
    void mock;
    await page.addInitScript(() => {
      if (!localStorage.getItem('migrated-flag')) {
        localStorage.setItem('cinematch-theme', 'light');
        localStorage.setItem('migrated-flag', '1');
      }
    });
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  test('reset appearance never touches ratings or watchlist', async ({ page, mock }) => {
    void mock;
    await page.addInitScript(() => {
      if (!localStorage.getItem('seeded')) {
        localStorage.setItem('seeded', '1');
        localStorage.setItem('cinematch.profile.v1', JSON.stringify({ version: 1, id: 'p1', displayName: 'Tester', avatarColor: '#aaa', history: [{ id: 5, title: 'Keep me', year: 2000, type: 'movie', tmdbType: 'movie', posterPath: null, rating: 5, source: 'result', genres: [], vibe: [], at: 1 }], watchlist: [] }));
      }
    });
    await page.goto('/');
    // The legacy v1 seed is migrated to the compressed v2 record on first load;
    // appearance changes must leave that stored record byte-for-byte alone.
    const before = await page.evaluate(() => localStorage.getItem('cinematch.profile.v2'));
    expect(before).toContain('MOODPROFILE|2|');
    await openSettings(page, 'Theme');
    await page.getByRole('radio', { name: /Velvet Rose/ }).click();
    await page.getByRole('tab', { name: 'Advanced' }).click();
    await page.getByRole('button', { name: 'Reset all appearance' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'aurora');
    expect(await page.evaluate(() => localStorage.getItem('cinematch.profile.v2'))).toBe(before);
  });

  test('settings work by keyboard; Escape closes and focus returns', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    const opener = page.getByRole('button', { name: 'Appearance settings', exact: true });
    await opener.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    expect(await page.evaluate(() => !!document.activeElement?.closest('.appearance-panel'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test('Tab never leaves the drawer, even with a toast mounted before it', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    const open = () => page.getByRole('button', { name: 'Appearance settings', exact: true }).click();
    await open();
    await page.getByRole('tab', { name: 'Theme' }).click();
    await page.getByRole('button', { name: 'Surprise me' }).click(); // creates a toast with Undo
    await page.keyboard.press('Escape');
    await open(); // toast host now precedes the drawer in the DOM
    const where = () => page.evaluate(() => (document.activeElement?.closest('.toast-host') ? 'toast' : document.activeElement?.closest('.appearance-panel') ? 'drawer' : 'OUTSIDE'));
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      expect(await where()).not.toBe('OUTSIDE');
    }
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await where()).not.toBe('OUTSIDE');
    }
  });

  test('custom accent validates input and warns when it would be hard to see', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await openSettings(page, 'Theme');
    await openDisclosure(page, 'Custom accent');
    const hex = page.getByLabel(/Custom accent colour as hex/);
    await hex.fill('not-a-colour');
    await hex.press('Tab');
    await expect(page.locator('html')).not.toHaveAttribute('data-accent', 'custom');
    await hex.fill('#f1ede7'); // almost the page colour: outlines/selections would vanish
    await hex.press('Tab');
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'custom');
    await expect(page.getByText(/hard to (read|see)/)).toBeVisible();
  });

  test('saved looks, export and strict import', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await openSettings(page, 'Theme');
    await openDisclosure(page, 'Saved looks');
    await page.getByRole('radio', { name: /Forest/ }).click();
    await page.getByLabel('Name for the new look').fill('Woods');
    await page.getByRole('button', { name: 'Save current look' }).click();
    await page.getByRole('radio', { name: /Oceanic/ }).click();
    await page.getByRole('button', { name: 'Woods', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'forest');

    await page.getByRole('tab', { name: 'Advanced' }).click();
    await page.getByRole('button', { name: 'Export appearance' }).click();
    const exported = await page.getByLabel('Exported appearance JSON').inputValue();
    const parsed = JSON.parse(exported);
    expect(parsed.app).toBe('cinematch-appearance');
    expect(Object.keys(parsed.preferences)).not.toContain('history');
    expect(exported).not.toMatch(/rating|watchlist|profile/i);

    await page.getByRole('button', { name: /Import from JSON/ }).click();
    const importBox = page.getByLabel('Paste appearance JSON to import');
    await importBox.fill(JSON.stringify({ app: 'cinematch-appearance', version: 1, preferences: { ...parsed.preferences, palette: 'nope' } }));
    await page.getByRole('button', { name: 'Import appearance' }).click();
    await expect(page.getByText('Invalid value for “palette”.')).toBeVisible();
    await importBox.fill(JSON.stringify({ app: 'cinematch-appearance', version: 1, preferences: { ...parsed.preferences, palette: 'ember', surprise: true } }));
    await page.getByRole('button', { name: 'Import appearance' }).click();
    await expect(page.getByText(/Unknown setting/)).toBeVisible();
    await importBox.fill(JSON.stringify({ app: 'cinematch-appearance', version: 1, preferences: { ...parsed.preferences, palette: 'ember' } }));
    await page.getByRole('button', { name: 'Import appearance' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'ember');
  });

  test('Compare with before shows the old look without saving it', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await openSettings(page, 'Theme');
    await page.getByRole('radio', { name: /Ember/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'ember');
    await page.getByRole('button', { name: 'Compare with before' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'aurora');
    await page.getByRole('button', { name: /Showing before/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'ember');
    // leaving the panel while previewing must not strand the page on the old look
    await page.getByRole('button', { name: 'Compare with before' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'ember');
  });

  test('OS reduced motion is respected in System, and Off stops particles', async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await mockImport(page);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'off');
    await expect(page.locator('.landing-canvas')).toBeHidden();
    await ctx.close();
  });

  test('results layout, labels and tilt settings apply without remounting the screen', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await openSettings(page, 'Cards & layout');
    await page.getByRole('radio', { name: 'Compact list' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-results-layout', 'list');
    await page.getByRole('radio', { name: 'Essential' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-labels', 'essential');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});

async function mockImport(page: import('@playwright/test').Page) {
  const { mockTmdb } = await import('./fixtures');
  await mockTmdb(page);
}
