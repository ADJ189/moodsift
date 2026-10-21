import AxeBuilder from '@axe-core/playwright';
import { completeQuiz, expect, test, toResults } from './fixtures';

// Automated checks catch a class of problems, not all of them — keyboard and
// screen-reader review still matter. These guard against regressions.
const scan = (page: import('@playwright/test').Page) => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();

test('landing has no serious/critical axe violations in default dark and light', async ({ page, mock }) => {
  void mock;
  for (const mode of ['dark', 'light'] as const) {
    await page.addInitScript((m) => localStorage.setItem('cinematch-appearance:v1', JSON.stringify({ version: 1, mode: m })), mode);
    await page.goto('/');
    await page.waitForTimeout(2000); // hero reveal animations must finish before sampling colours
    const r = await scan(page);
    expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'), `${mode}: ${JSON.stringify(r.violations.map((v) => v.id))}`).toEqual([]);
  }
});

test('appearance drawer and results have no serious/critical violations', async ({ page, mock }) => {
  void mock;
  await page.goto('/');
  await page.getByRole('button', { name: 'Appearance settings', exact: true }).click();
  await page.waitForTimeout(500); // let the entrance animation finish — axe samples mid-fade colours otherwise
  const drawer = await new AxeBuilder({ page }).include('.appearance-panel').withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(drawer.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'), JSON.stringify(drawer.violations.map((v) => v.id))).toEqual([]);
  await page.keyboard.press('Escape');
  await completeQuiz(page);
  await toResults(page);
  await page.waitForTimeout(2000); // staggered card entrances must finish — axe samples mid-fade colours otherwise
  const r = await scan(page);
  expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'), JSON.stringify(r.violations.map((v) => v.id))).toEqual([]);
});

test('combined high contrast + large text + compact density has no horizontal overflow', async ({ page, mock }) => {
  void mock;
  await page.addInitScript(() => localStorage.setItem('cinematch-appearance:v1', JSON.stringify({ version: 1, contrast: 'high', textScale: 125, density: 'compact', transparency: 'reduced', contentWidth: 'wide' })));
  await page.goto('/');
  await completeQuiz(page);
  await toResults(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
});

// ── Visual-direction surfaces: settings sections, search types, card types ──
const serious = (r: Awaited<ReturnType<typeof scan>>) => r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');

test('every settings section has no serious/critical violations (light and dark)', async ({ page, mock }) => {
  void mock;
  test.setTimeout(120_000);
  for (const mode of ['light', 'dark'] as const) {
    await page.addInitScript((m) => localStorage.setItem('cinematch-appearance:v1', JSON.stringify({ version: 1, mode: m, motion: 'off', particles: 'off' })), mode);
    await page.goto('/');
    await page.getByRole('button', { name: 'Appearance settings', exact: true }).click();
    for (const name of ['Overview', 'Cards & layout', 'Search', 'Theme', 'Readability', 'Motion & performance', 'AI engine', 'Taste memory', 'Advanced']) {
      await page.getByRole('tab', { name }).click();
      await page.waitForTimeout(150);
      const r = await new AxeBuilder({ page }).include('.appearance-panel').withTags(['wcag2a', 'wcag2aa']).analyze();
      expect(serious(r), `${mode} · ${name}: ${JSON.stringify(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`))}`).toEqual([]);
    }
    await page.keyboard.press('Escape');
  }
});

test('each search type has no serious/critical violations', async ({ page, mock }) => {
  void mock;
  test.setTimeout(120_000);
  const { mockSearchResults } = await import('./fixtures');
  await mockSearchResults(page);
  for (const searchType of ['grouped', 'compact', 'expanded', 'full-page']) {
    await page.addInitScript((t) => localStorage.setItem('cinematch-appearance:v1', JSON.stringify({ version: 1, motion: 'off', particles: 'off', searchType: t })), searchType);
    await page.goto('/');
    await page.getByRole('button', { name: 'Search for a title', exact: true }).click();
    await page.getByRole('combobox', { name: 'Search for a title' }).fill('midnight');
    await page.locator(searchType === 'full-page' ? '.search-full .result-card' : '.search-option').first().waitFor();
    await page.waitForTimeout(400);
    const r = await scan(page);
    expect(serious(r), `${searchType}: ${JSON.stringify(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`))}`).toEqual([]);
  }
});

test('each card type and design style has no serious/critical violations', async ({ page, mock }) => {
  void mock;
  test.setTimeout(180_000);
  await page.addInitScript(() => localStorage.setItem('cinematch-appearance:v1', JSON.stringify({ version: 1, motion: 'off', particles: 'off' })));
  await page.goto('/');
  await completeQuiz(page);
  await toResults(page);
  const set = (a: Record<string, string>) => page.evaluate((x) => Object.entries(x).forEach(([k, v]) => document.documentElement.setAttribute(k, v)), a);
  for (const [type, style] of [['interactive', 'cinematic'], ['poster', 'minimal'], ['editorial', 'film-journal'], ['compact', 'glass'], ['interactive', 'neon-noir']] as const) {
    await set({ 'data-card-type': type, 'data-design-style': style });
    await page.waitForTimeout(300);
    const r = await scan(page);
    expect(serious(r), `${type}/${style}: ${JSON.stringify(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`))}`).toEqual([]);
  }
});
