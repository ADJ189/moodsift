import { completeQuiz, expect, test, toResults } from './fixtures';
import type { Page } from '@playwright/test';

const KEY = 'cinematch-local-ai:v1';
const MODEL_HOSTS = /huggingface\.co|esm\.sh|cdn\.jsdelivr\.net|unpkg\.com/;

async function openAiTab(page: Page) {
  await page.getByRole('button', { name: 'Appearance settings', exact: true }).click();
  await page.getByRole('tab', { name: 'AI engine' }).click();
}

test.describe('local AI engine settings', () => {
  test('mode persists separately from appearance and survives appearance reset', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await openAiTab(page);
    await expect(page.getByRole('radio', { name: /Balanced/ })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('radio', { name: /Fastest/ }).click();
    expect(JSON.parse((await page.evaluate((k) => localStorage.getItem(k), KEY)) ?? 'null')).toEqual({ version: 1, mode: 'fastest' });
    // Not part of the appearance preferences.
    expect(await page.evaluate(() => localStorage.getItem('cinematch-appearance:v1') ?? '')).not.toContain('fastest');

    await page.getByRole('tab', { name: 'Theme' }).click();
    await page.getByRole('radio', { name: /Velvet Rose/ }).click();
    await page.getByRole('tab', { name: 'Advanced' }).click();
    await page.getByRole('button', { name: 'Reset all appearance' }).click();
    expect(JSON.parse((await page.evaluate((k) => localStorage.getItem(k), KEY)) ?? 'null').mode).toBe('fastest');

    await page.keyboard.press('Escape');
    await page.reload();
    await openAiTab(page);
    await expect(page.getByRole('radio', { name: /Fastest/ })).toHaveAttribute('aria-checked', 'true');
  });

  test('corrupt and hostile stored values fall back to Balanced', async ({ page, mock }) => {
    void mock;
    for (const bad of ['{{{nope', JSON.stringify({ version: 1, mode: '"><img src=x onerror=alert(1)>' }), JSON.stringify({ version: 2, mode: 'best' }), JSON.stringify({ mode: 'best' })]) {
      await page.addInitScript(([k, v]) => localStorage.setItem(k!, v!), [KEY, bad]);
      await page.goto('/');
      await openAiTab(page);
      await expect(page.getByRole('radio', { name: /Balanced/ })).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('Escape');
    }
  });

  test('data saver downloads nothing and never starts a worker', async ({ page, mock }) => {
    void mock;
    const requests: string[] = [];
    page.on('request', (r) => {
      if (MODEL_HOSTS.test(r.url())) requests.push(r.url());
    });
    await page.addInitScript(
      ([k]) => {
        localStorage.setItem(k!, JSON.stringify({ version: 1, mode: 'lightweight' }));
        const w = window as unknown as { __workers: number; Worker: typeof Worker };
        w.__workers = 0;
        const Orig = w.Worker;
        w.Worker = class extends Orig {
          constructor(...args: ConstructorParameters<typeof Worker>) {
            super(...args);
            w.__workers++;
          }
        };
      },
      [KEY]
    );
    await page.goto('/');
    await completeQuiz(page);
    await toResults(page);

    const aiBtn = page.getByRole('button', { name: /On-device AI: off/ });
    await expect(aiBtn).toBeVisible();
    await aiBtn.click(); // opens the setting rather than loading anything
    await expect(page.getByRole('radio', { name: /Lightweight/ })).toHaveAttribute('aria-checked', 'true');
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { __workers: number }).__workers)).toBe(0);
    expect(requests).toEqual([]);
    await expect(page.locator('.ai-reason')).toHaveCount(0);
  });

  test('a model that cannot load leaves the rule-based reasons in place', async ({ page, mock }) => {
    void mock;
    await page.route(MODEL_HOSTS, (r) => r.abort());
    await page.goto('/');
    await completeQuiz(page);
    await toResults(page);
    const before = await page.locator('.result-reasons').first().innerText();
    await page.getByRole('button', { name: /Explain with on-device AI/ }).click();
    await expect(page.getByRole('button', { name: /AI unavailable/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.ai-reason')).toHaveCount(0);
    expect(await page.locator('.result-reasons').first().innerText()).toBe(before);
  });
});
