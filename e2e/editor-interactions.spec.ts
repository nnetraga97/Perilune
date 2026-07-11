import { expect, test } from '@playwright/test';

test('parts can be dragged from the palette onto the craft canvas', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Sandbox — just build and fly').click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');

  const pod = page.locator('.ed-part', { hasText: 'Voyager Pod' });
  const canvas = page.locator('#game-canvas');
  await pod.dragTo(canvas, { targetPosition: { x: 640, y: 400 } });

  await expect.poll(() => page.evaluate(() => window.__TEST__.partCount())).toBe(1);

  await page.getByRole('button', { name: '▲ LAUNCH' }).click();
  await page.waitForFunction(() => window.__TEST__.screen() === 'flight');
  await page.getByTitle('Prograde').click();
  await expect(page.getByTitle('Prograde')).toHaveClass(/active/);

  await page.getByRole('button', { name: 'Map' }).click();
  await page.getByRole('button', { name: '+ Node in 2 min' }).click();
  const prograde = page.locator('.map-axis', { hasText: 'Prograde' });
  await prograde.getByRole('button', { name: '+', exact: true }).click();
  await expect(page.locator('.map-readout').filter({ hasText: 'Δv' })).toContainText('5.0 m/s');
});
