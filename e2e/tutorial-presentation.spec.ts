import { expect, test } from '@playwright/test';

async function startFirstLight(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'First Light tutorial' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');
}

test('First Light presents one clear objective and confirms completion before advancing', async ({ page }) => {
  await startFirstLight(page);

  const guide = page.locator('.tut-box');
  await expect(guide.locator('.tut-chapter')).toHaveText('FIRST LIGHT · EARTH');
  await expect(guide.locator('.tut-progress')).toHaveText('STEP 1 OF 15');
  await expect(guide.locator('.tut-step-kind')).toHaveText('DO');
  await expect(guide.locator('.tut-next-label')).toHaveText('DO NEXT');
  await expect(guide.locator('.tut-next-text')).toHaveText('Select LAUNCH in the Vehicle Assembly Building.');

  const rail = guide.getByRole('progressbar', { name: 'Tutorial progress' });
  await expect(rail).toHaveAttribute('aria-valuenow', '1');
  await expect(rail).toHaveAttribute('aria-valuemax', '15');
  await expect(rail.locator('.tut-progress-segment')).toHaveCount(15);
  await expect(rail.locator('.tut-progress-segment.is-current')).toHaveCount(1);

  await expect(guide.locator('.tut-primary-action:visible')).toHaveCount(1);
  await expect(guide.getByRole('button', { name: 'Show control for The mission: make an orbit' })).toBeVisible();
  await expect(guide.getByRole('button', { name: 'Previous step' })).toHaveText('Back');
  await expect(guide.getByRole('button', { name: 'Dismiss tutorial' })).toHaveText('Exit guide');

  await page.getByRole('button', { name: 'Launch this craft' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'flight');

  const confirmation = guide.locator('.tut-confirmation');
  await expect(confirmation).toBeVisible({ timeout: 300 });
  await expect(confirmation).toHaveText('STEP COMPLETE');
  await expect(guide).toHaveClass(/tut-step-complete/);
  await expect(guide.locator('.tut-title')).toHaveText('The mission: make an orbit');

  await expect(guide.locator('.tut-title')).toHaveText('Set full throttle');
  await expect(confirmation).toBeHidden();
  await expect(guide).not.toHaveClass(/tut-step-complete/);
});

test('Second Light exposes the map-layout hook only while the map is visible', async ({ page }) => {
  await startFirstLight(page);
  const guide = page.locator('.tut-box');

  await guide.getByRole('button', { name: 'Start Second Light' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'flight');
  await expect(page.locator('.map-panel')).toBeVisible();
  await expect(guide).toHaveClass(/tut-map-visible/);

  await page.keyboard.press('m');
  await expect(page.locator('.map-panel')).toBeHidden();
  await expect(guide).not.toHaveClass(/tut-map-visible/);
});
