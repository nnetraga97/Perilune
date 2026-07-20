import { expect, test } from '@playwright/test';

test('mission windows connect alarms, transfers, targets, and maneuver sketches', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sandbox — just build and fly' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');

  const pod = page.locator('.ed-part', { hasText: 'Voyager Pod' });
  await pod.dragTo(page.locator('#game-canvas'), { targetPosition: { x: 640, y: 400 } });
  await expect.poll(() => page.evaluate(() => window.__TEST__.partCount())).toBe(1);
  await page.getByRole('button', { name: 'Launch this craft' }).click();
  await page.waitForFunction(() => window.__TEST__.screen() === 'flight');

  await page.getByRole('button', { name: 'Alarms', exact: true }).click();
  await page.getByPlaceholder('Alarm label').fill('Systems check');
  await page.locator('.mission-alarm-form input[type="number"]').fill('120');
  await page.locator('.mission-alarm-form').getByRole('button', { name: 'Add' }).click();
  await expect.poll(() => page.evaluate(() => window.__TEST__.alarmCount())).toBe(1);
  await expect(page.locator('.mission-row', { hasText: 'Systems check' })).toBeVisible();

  // Transfer sketches are intentionally gated until the craft has a stable
  // parking orbit, because a surface-state conic produces a meaningless node.
  await page.getByRole('button', { name: 'Fleet', exact: true }).click();
  const veyra = page.locator('.body-row').filter({ has: page.locator('strong:text-is("Veyra")') });
  await veyra.getByRole('button', { name: 'Target', exact: true }).click();
  await veyra.getByRole('button', { name: 'Orbit', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__TEST__.situation())).toBe('orbit');
  await page.getByRole('button', { name: 'Fleet', exact: true }).click();

  await page.getByRole('button', { name: 'Transfers', exact: true }).click();
  const palla = page.locator('.transfer-row', { hasText: 'Palla' });
  await expect(palla).toBeVisible();
  await palla.getByRole('button', { name: 'Target', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__TEST__.target())).toBe('palla');
  await palla.getByRole('button', { name: 'Sketch node' }).click();
  await expect.poll(() => page.evaluate(() => window.__TEST__.maneuverNode())).not.toBeNull();
  await expect(page.locator('.map-panel')).toBeVisible();

  await page.getByRole('button', { name: 'Fleet', exact: true }).click();
  await expect(page.locator('.fleet-row .fleet-name')).toHaveValue('Orion');
  const pallaTarget = page.locator('.body-row', { hasText: 'Palla' });
  await expect(pallaTarget.getByRole('button', { name: 'Orbit', exact: true })).toBeVisible();
  await pallaTarget.getByRole('button', { name: 'Orbit', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__TEST__.activeBody())).toBe('palla');
  await expect.poll(() => page.evaluate(() => window.__TEST__.situation())).toBe('orbit');
  await expect.poll(() => page.evaluate(() => window.__TEST__.target())).toBeNull();
  await expect.poll(() => page.evaluate(() => window.__TEST__.orbit()?.eccentricity ?? 1)).toBeLessThan(1e-8);
});
