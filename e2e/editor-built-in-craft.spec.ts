import { expect, test } from '@playwright/test';

test('loads the integrated Wayfarer from its own VAB section', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sandbox — just build and fly' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');

  const library = page.locator('[data-section="built-in-crafts"]');
  await expect(library).toBeVisible();
  await expect(library.locator('[data-craft-id="wayfarer-heavy-demonstrator"]')).toContainText('Wayfarer Heavy Demonstrator');
  await page.getByRole('button', { name: 'Load built-in craft Wayfarer Heavy Demonstrator' }).click();

  await expect(page.locator('input.ed-name')).toHaveValue('Wayfarer Heavy Demonstrator');
  await expect.poll(() => page.evaluate(() => window.__TEST__.partCount())).toBe(21);
  await expect.poll(() => page.evaluate(() => window.__TEST__.stageCount())).toBe(3);
  const counts = await page.evaluate(() => {
    const result: Record<string, number> = {};
    for (const part of window.__TEST__.parts()) result[part.defId] = (result[part.defId] ?? 0) + 1;
    return result;
  });
  expect(counts['srb-torch']).toBe(2);
  expect(counts['srb-flare'] ?? 0).toBe(0);
  expect(counts['dec-interstage-ms']).toBe(1);

  await expect(page.locator('.ed-unstaged .ed-stage-part')).toHaveCount(0);
  const initialStageLabels = await page.locator('.ed-stage:not(.ed-unstaged) .ed-stage-head > span:first-child').allTextContents();
  expect(initialStageLabels).toEqual(['STAGE 0', 'STAGE 1', 'STAGE 2']);

  await page.getByRole('button', { name: '+ Stage', exact: true }).click();
  const stageRows = page.locator('.ed-stage:not(.ed-unstaged)');
  await expect(stageRows).toHaveCount(4);
  const addedStageLabels = await stageRows.locator('.ed-stage-head > span:first-child').allTextContents();
  expect(addedStageLabels).toEqual(['STAGE 0', 'STAGE 1', 'STAGE 2', 'STAGE 3']);
  await expect(stageRows.last()).toContainText('drop staged parts here');

  await page.getByRole('button', { name: 'Auto-stage' }).click();
  await expect(stageRows).toHaveCount(3);
  const autoStageRows = await stageRows.allTextContents();
  expect(autoStageRows).toHaveLength(3);
  expect(autoStageRows[0]).toContain('Wayfarer Interstage M–S');
  expect(autoStageRows[0]).toContain('Colt');
  expect(autoStageRows[1]).toContain('Side Latch');
  expect(autoStageRows[2]).toContain('Mule');
  expect(autoStageRows[2]).toContain('SB-90 "Torch"');

  await page.getByRole('button', { name: 'Coupling', exact: true }).click();
  await expect(page.locator('.ed-part', { hasText: 'Wayfarer Separator M' })).toBeVisible();
  await expect(page.locator('.ed-part', { hasText: 'Wayfarer Interstage M–S' })).toBeVisible();

  await expect(page.getByRole('heading', { name: 'SAVED CRAFT' })).toBeVisible();
  await page.getByRole('button', { name: 'Launch this craft' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'flight');
});
