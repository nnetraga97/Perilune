import { expect, test } from '@playwright/test';

test('analyzes the current craft and returns to the unchanged workshop', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Sandbox — just build and fly' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');
  await expect(page.getByRole('button', { name: 'Add at least one part before simulating airflow' })).toBeDisabled();
  await page.getByRole('button', { name: 'Load built-in craft Wayfarer Heavy Demonstrator' }).click();
  await expect.poll(() => page.evaluate(() => window.__TEST__.partCount())).toBe(21);
  const before = await page.evaluate(() => window.__TEST__.parts());

  await page.getByRole('button', { name: 'Open the Aerodynamics Lab for this craft' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'aero-lab');
  await expect(page.getByRole('heading', { name: 'AERODYNAMICS LAB' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__TEST__.aeroLab()?.status), {
    timeout: 15_000,
  }).toMatch(/^READY/);
  await expect(page.locator('.aero-lab-metrics')).toContainText('Dynamic pressure');
  await expect(page.locator('.aero-lab-regime')).toContainText('SUBSONIC');
  await page.screenshot({ path: 'test-results/aero-lab-flow.png', fullPage: true });

  await page.getByLabel('Environment').selectOption('moon');
  await expect.poll(() => page.evaluate(() => (window as any).__TEST__.aeroLab()?.status)).toBe('VACUUM');
  await expect.poll(() => page.evaluate(() => (window as any).__TEST__.aeroLab()?.dynamicPressure)).toBe(0);
  await page.getByLabel('Environment').selectOption('earth');
  await expect.poll(() => page.evaluate(() => (window as any).__TEST__.aeroLab()?.status), {
    timeout: 15_000,
  }).toMatch(/^READY/);

  await page.getByRole('button', { name: 'RE-ENTRY' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__TEST__.aeroLab()?.status), {
    timeout: 15_000,
  }).toMatch(/^READY/);
  await expect(
    page.locator('.aero-lab-metrics dt', { hasText: 'Stability tendency' }).locator('xpath=following-sibling::dd[1]'),
  ).toHaveText('RESTORING');

  await page.getByRole('button', { name: 'LOAD', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__TEST__.aeroLab()?.mode)).toBe('load');
  await page.getByRole('button', { name: 'HEATING', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__TEST__.aeroLab()?.mode)).toBe('thermal');
  await page.screenshot({ path: 'test-results/aero-lab.png', fullPage: true });

  const canvas = page.locator('#game-canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const cameraBefore = await page.evaluate(() => (window as any).__TEST__.aeroLab()?.cameraPosition);
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 120, box!.y + box!.height / 2 + 30, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const cameraAfterOrbit = await page.evaluate(() => (window as any).__TEST__.aeroLab()?.cameraPosition);
  expect(cameraAfterOrbit).not.toEqual(cameraBefore);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(200);
  const cameraAfterZoom = await page.evaluate(() => (window as any).__TEST__.aeroLab()?.cameraPosition);
  expect(cameraAfterZoom).not.toEqual(cameraAfterOrbit);

  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');
  await expect(page.getByRole('heading', { name: 'AERODYNAMICS LAB' })).toBeHidden();
  expect(await page.evaluate(() => window.__TEST__.parts())).toEqual(before);
  expect(errors, `console errors:\n${errors.join('\n')}`).toEqual([]);
});
