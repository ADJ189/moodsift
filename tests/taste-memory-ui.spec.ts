import { MAX_IMPORT_CHARS } from '../src/lib/profile';
import { expect, openSettings, test } from './fixtures';

test('backup files are bounded before reading; accepted Unicode files still reach preview', async ({ page, mock }) => {
  void mock;
  await page.goto('/');
  await openSettings(page, 'Taste memory');
  const input = page.getByLabel('Choose a taste-memory backup file');
  const card = page.locator('[data-tm-card]');
  const backup = JSON.stringify({
    format: 'moodsift-taste-memory', formatVersion: 1,
    profile: { version: 1, displayName: '界'.repeat(1_700_000), history: [], watchlist: [] },
  });
  expect(backup.length).toBeLessThan(MAX_IMPORT_CHARS);
  expect(Buffer.byteLength(backup)).toBeGreaterThan(MAX_IMPORT_CHARS);
  await input.setInputFiles({ name: 'unicode.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
  await expect(card.getByText('This backup has 0 rated titles', { exact: false })).toBeVisible();

  // Make reading observable: the oversized file must be rejected before text().
  await page.evaluate(() => {
    File.prototype.text = async () => { throw new Error('Oversized file was read'); };
  });
  await input.setInputFiles({ name: 'oversized.json', mimeType: 'application/json', buffer: Buffer.alloc(MAX_IMPORT_CHARS * 3 + 1) });
  await expect(card.getByText('That file is too large to be a Moodsift backup.', { exact: true })).toBeVisible();
  await expect(card.locator('[data-tm="merge"]')).toHaveCount(0);
});
