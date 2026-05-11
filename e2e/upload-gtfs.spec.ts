import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zip2021 = path.join(__dirname, '../testfiles/20211210-0353_gtfs_vor_2021.zip');
const zip2025 = path.join(__dirname, '../testfiles/20260110-0433_gtfs_vor_2025.zip');

test('uploads both GTFS zips without DuckDB OPFS temp errors', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Load feeds/ }).click();
  await page.locator('.upload-menu input[type="file"]').setInputFiles([zip2021, zip2025]);

  await expect(page.getByText('2 feeds')).toBeVisible();
  await expect(page.locator('.upload-job--error')).toHaveCount(0);
});
