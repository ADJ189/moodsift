import { expect, openSettings, test } from './fixtures';
import type { Page } from '@playwright/test';

// Regression coverage for the Settings "studio" presentation (v1.13.6 redesign):
// rail index numbers must stay decorative, every pane gets an editorial head,
// the preview stages follow the live <html> attributes without remounting, and
// the AI / Taste memory sections keep their distinct treatments.

const html = (page: Page) => page.locator('html');

const SECTIONS = ['Overview', 'Cards & layout', 'Search', 'Theme', 'Readability', 'Motion & performance', 'AI engine', 'Taste memory', 'Advanced'];

test.describe('settings studio', () => {
  test('rail tabs keep plain accessible names; index numbers are decorative', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await openSettings(page);
    for (const name of SECTIONS) {
      const tab = page.getByRole('tab', { name, exact: true });
      await expect(tab).toBeVisible();
      await expect(tab.locator('.ap-tab-num')).toHaveAttribute('aria-hidden', 'true');
    }
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  });

  test('every section opens with an editorial head (index, title, lede)', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await openSettings(page);
    for (const name of SECTIONS) {
      await page.getByRole('tab', { name, exact: true }).click();
      const head = page.locator('.ap-pane-head');
      await expect(head).toBeVisible();
      await expect(head.locator('.ap-pane-title')).not.toBeEmpty();
      await expect(head.locator('.ap-pane-lede')).not.toBeEmpty();
    }
  });

  test('the search stage follows the Search type without moving focus', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await openSettings(page, 'Search');
    const radio = page.getByRole('radio', { name: /Compact/ });
    await radio.click();
    await expect(html(page)).toHaveAttribute('data-search-type', 'compact');
    await expect(page.locator('.st-variant[data-v="compact"]')).toBeVisible();
    await expect(page.locator('.st-variant[data-v="grouped"]')).toBeHidden();
    await expect(radio).toBeFocused();
  });

  test('the cards stage reflects card type and layout from the live attributes', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await openSettings(page, 'Cards & layout');
    await expect(page.locator('.st-cards')).toBeVisible();
    await expect(page.locator('.st-cards .st-blurb').first()).toBeHidden();
    await page.getByRole('radio', { name: /Editorial/ }).click();
    await expect(page.locator('.st-cards .st-blurb').first()).toBeVisible();
    await page.getByRole('radio', { name: /Compact list/ }).click();
    await expect(html(page)).toHaveAttribute('data-results-layout', 'list');
  });

  test('selected options are marked by more than colour', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await openSettings(page, 'Theme');
    const active = page.locator('.palette-btn.active');
    await expect(active).toHaveCount(1);
    await expect(active).toHaveAttribute('aria-checked', 'true');
    // a heavier frame than the unselected palettes, not just a different hue
    const widths = await page.evaluate(() => {
      const on = document.querySelector('.palette-btn.active') as HTMLElement;
      const off = document.querySelector('.palette-btn:not(.active)') as HTMLElement;
      return { on: getComputedStyle(on).boxShadow, off: getComputedStyle(off).boxShadow };
    });
    expect(widths.on).not.toBe('none');
    expect(widths.off).toBe('none');
  });

  test('Readability shows a live specimen that follows text size', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await openSettings(page, 'Readability');
    const title = page.locator('.sp-title');
    const before = await title.evaluate((n) => parseFloat(getComputedStyle(n).fontSize));
    await page.getByRole('radio', { name: '125%' }).click();
    await expect.poll(() => title.evaluate((n) => parseFloat(getComputedStyle(n).fontSize))).toBeGreaterThan(before);
  });

  test('AI engine is a distinct lab section with the test action up front', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await openSettings(page, 'AI engine');
    await expect(page.locator('.ap-lab')).toBeVisible();
    await expect(page.locator('[data-ai-diag-card]')).toBeVisible();
    // the long explanation is tucked behind a disclosure; the test action is not
    await expect(page.locator('[data-ai-diag="test"]')).toBeVisible();
    await expect(page.locator('summary', { hasText: 'What this test checks' })).toBeVisible();
  });

  test('Taste memory is visually separate from appearance and keeps its controls', async ({ page, mock }) => {
    void mock;
    await page.goto('/');
    await openSettings(page, 'Taste memory');
    await expect(page.locator('.ap-personal[data-tm-card]')).toBeVisible();
    await expect(page.locator('[data-tm="pause"]')).toBeVisible();
    await expect(page.locator('[data-tm="erase"]')).toBeVisible();
  });

  test('on a phone the rail stays a labelled scroller with no horizontal overflow', async ({ page, mock }) => {
    void mock;
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto('/');
    await openSettings(page);
    await expect(page.locator('.ap-tab-num').first()).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toBeVisible();
    for (const name of SECTIONS) {
      await page.getByRole('tab', { name, exact: true }).click();
      const over = await page.evaluate(() => {
        const body = document.querySelector('.ap-body') as HTMLElement;
        return body.scrollWidth - body.clientWidth;
      });
      expect(over, name).toBe(0);
    }
  });
});
