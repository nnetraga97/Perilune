import { expect, test, type Page } from '@playwright/test';

async function openEditor(page: Page, mode: 'sandbox' | 'exploration'): Promise<void> {
  await page.goto('/');
  const label = mode === 'sandbox'
    ? 'Sandbox — just build and fly'
    : 'Exploration — unlock technology with science';
  await page.getByRole('button', { name: label }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');
}

test('Science archive is bounded, scrollable, searchable, and filterable in the VAB', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEditor(page, 'sandbox');
  await page.locator('.ed-utility-host .k-launcher').getByRole('button', { name: 'Science' }).click();

  const archive = page.locator('[data-window-id="science-archive"]');
  await expect(archive).toBeVisible();
  const box = await archive.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(600);
  expect(box!.height).toBeLessThanOrEqual(700);

  const scroll = archive.locator('.science-archive-scroll');
  await expect(scroll).toBeVisible();
  const scrollGeometry = await scroll.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
  }));
  expect(scrollGeometry.overflowY).toBe('auto');
  expect(scrollGeometry.scrollHeight).toBeGreaterThan(scrollGeometry.clientHeight);

  await archive.getByLabel('Filter science by world').selectOption('palla');
  await expect(archive.locator('.science-filter-summary')).toContainText('across 1 world');
  await expect(archive.locator('.science-world-dossier')).toHaveCount(1);
  await expect(archive.locator('.science-world-summary')).toContainText('Palla');

  await archive.getByLabel('Filter science by status').selectOption('complete');
  await expect(archive.locator('.science-empty-state')).toBeVisible();
  await archive.getByRole('button', { name: 'Clear filters' }).click();
  const search = archive.getByLabel('Search science archive');
  await search.fill('Thermoscope');
  const filteredRecords = archive.locator('.science-record-row');
  await expect.poll(() => filteredRecords.count()).toBeGreaterThan(0);
  const labels = await filteredRecords.locator('.science-record-copy strong').allTextContents();
  expect(new Set(labels)).toEqual(new Set(['Thermoscope Reading']));
  await page.screenshot({ path: 'test-results/science-archive-redesign.png' });
});

test('Program Control presents a connected game-style technology tree and dedicated views', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openEditor(page, 'exploration');
  await page.locator('.ed-utility-host .k-launcher').getByRole('button', { name: 'Program Control' }).click();

  const program = page.locator('[data-window-id="program-control"]');
  await expect(program).toBeVisible();
  await expect(program.getByRole('button', { name: 'Technology Tree' })).toHaveAttribute('aria-pressed', 'true');
  await expect(program.locator('.tech-node')).toHaveCount(9);
  await expect(program.locator('.tech-tree-links path')).toHaveCount(8);
  await expect(program.locator('[data-tech-id="foundations"]')).toHaveClass(/deployed/);
  await expect(program.locator('[data-tech-id="orbital-engineering"]')).toHaveClass(/available/);
  await expect(program.locator('[data-tech-id="exploration-instruments"]')).toHaveClass(/locked/);

  const treeScroller = program.locator('.tech-tree-scroll');
  const treeGeometry = await treeScroller.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflowX: getComputedStyle(element).overflowX,
  }));
  expect(treeGeometry.overflowX).toBe('auto');
  expect(treeGeometry.scrollWidth).toBeGreaterThan(treeGeometry.clientWidth);

  await page.screenshot({ path: 'test-results/program-control-redesign.png' });

  await program.getByRole('button', { name: 'Repeatable Research' }).click();
  await expect(program.locator('.research-program-card')).toHaveCount(2);
  await expect(program.locator('.research-program-card').first()).toContainText('LEVEL');
  await expect(program.getByRole('button', { name: 'Contracts' })).toHaveCount(0);
});
