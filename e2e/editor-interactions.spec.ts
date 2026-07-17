import { expect, test, type Page } from '@playwright/test';

async function openEditor(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sandbox — just build and fly' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');
}

async function loadWayfarer(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Load built-in craft Wayfarer Heavy Demonstrator' }).click();
  await expect.poll(() => page.evaluate(() => window.__TEST__.partCount())).toBeGreaterThan(10);
}

async function projectPart(page: Page, key: number): Promise<{ x: number; y: number }> {
  return page.evaluate((partKey) => {
    const part = (window as any).__TEST__.parts().find((candidate: any) => candidate.key === partKey);
    return (window as any).__TEST__.projectEditor(part.x, part.y, part.z);
  }, key);
}

async function touch(
  page: Page,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  pointerId: number,
  x: number,
  y: number,
): Promise<void> {
  await page.locator('#game-canvas').dispatchEvent(type, {
    pointerId,
    pointerType: 'touch',
    isPrimary: pointerId === 1,
    button: type === 'pointerup' ? 0 : 0,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX: x,
    clientY: y,
  });
}

test('desktop selection, hover, movement history, and launch remain coherent', async ({ page }) => {
  await openEditor(page);
  const pod = page.locator('.ed-part', { hasText: 'Voyager Pod' });
  const canvas = page.locator('#game-canvas');
  await pod.dragTo(canvas, { targetPosition: { x: 640, y: 400 } });
  await expect.poll(() => page.evaluate(() => window.__TEST__.partCount())).toBe(1);

  const rootPoint = await page.evaluate(() => window.__TEST__.projectEditor(0, 3, 0));
  await page.mouse.move(20, 120);
  await page.mouse.move(rootPoint.x, rootPoint.y);
  await expect.poll(() => page.evaluate(() => (window as any).__TEST__.debug().hovered)).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as any).__TEST__.debug().selected)).toBeNull();
  await expect.poll(() => page.evaluate(() => (window as any).__TEST__.debug().rootIndicatorVisible)).toBe(true);

  const historyBeforeClick = await page.evaluate(() => (window as any).__TEST__.debug().editorUndoDepth);
  await page.mouse.click(rootPoint.x, rootPoint.y);
  await expect.poll(() => page.evaluate(() => (window as any).__TEST__.debug().selectedKeys)).toEqual([1]);
  await expect.poll(() => page.evaluate(() => (window as any).__TEST__.debug().selectionHighlighted)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__TEST__.debug().contextMenuOpen)).toBe(false);
  expect(await page.evaluate(() => (window as any).__TEST__.debug().editorUndoDepth)).toBe(historyBeforeClick);

  await page.mouse.move(rootPoint.x, rootPoint.y);
  await page.mouse.down();
  await page.mouse.move(rootPoint.x + 120, rootPoint.y + 40, { steps: 8 });
  await page.mouse.up();
  const moved = await page.evaluate(() => (window as any).__TEST__.parts()[0]);
  expect(Math.hypot(moved.x, moved.z)).toBeGreaterThan(0.2);
  expect(await page.evaluate(() => (window as any).__TEST__.debug().editorUndoDepth)).toBe(historyBeforeClick + 1);

  await page.keyboard.press('Control+KeyZ');
  const restored = await page.evaluate(() => (window as any).__TEST__.parts()[0]);
  expect(restored.x).toBeCloseTo(0, 5);
  expect(restored.z).toBeCloseTo(0, 5);

  await page.getByRole('button', { name: 'Launch this craft' }).click();
  await page.waitForFunction(() => window.__TEST__.screen() === 'flight');
  await expect(page.locator('.hud-ut')).toHaveCount(0);
  const commandDeckBox = await page.locator('.hud-top').boundingBox();
  const apsisBox = await page.locator('.hud-apsis-indicator.ap').boundingBox();
  const recoverBox = await page.getByRole('button', { name: 'Recover' }).boundingBox();
  const crewBox = await page.locator('.hud-crew').boundingBox();
  const vesselBox = await page.locator('.hud-vessel-control').boundingBox();
  const alarmBox = await page.locator('.hud-next-alarm').boundingBox();
  const warpGroupBox = await page.locator('.hud-warp-group').boundingBox();
  expect(commandDeckBox).not.toBeNull();
  expect(apsisBox).not.toBeNull();
  expect(recoverBox).not.toBeNull();
  expect(crewBox).not.toBeNull();
  expect(vesselBox).not.toBeNull();
  expect(alarmBox).not.toBeNull();
  expect(warpGroupBox).not.toBeNull();
  expect(commandDeckBox!.width).toBeLessThan(1100);
  expect(apsisBox!.x - commandDeckBox!.x).toBeLessThan(24);
  expect(recoverBox!.x + recoverBox!.width).toBeLessThanOrEqual(commandDeckBox!.x + commandDeckBox!.width);
  expect(vesselBox!.x - (crewBox!.x + crewBox!.width)).toBeLessThan(80);
  expect(warpGroupBox!.x - (alarmBox!.x + alarmBox!.width)).toBeLessThan(80);
  await expect(page.locator('.hud-mode-badge').filter({ hasText: 'CAM' })).toHaveCount(0);
  await expect(page.locator('.hud-apsis-value').first()).toHaveCSS('font-size', '11px');
  await expect(page.getByRole('button', { name: 'Main', exact: true })).toHaveCSS('font-size', '13px');
  const scienceBox = await page.locator('.hud-sys [data-action="science"]').boundingBox();
  expect(scienceBox).not.toBeNull();
  expect(recoverBox!.x - (scienceBox!.x + scienceBox!.width)).toBeGreaterThanOrEqual(10);
  await page.keyboard.press('Escape');
  const pauseDialog = page.getByRole('dialog', { name: 'Flight paused' });
  await expect(pauseDialog).toBeVisible();
  const pauseButtons = pauseDialog.getByRole('button');
  await expect(pauseButtons).toHaveCount(6);
  const pauseBounds = await pauseDialog.boundingBox();
  expect(pauseBounds).not.toBeNull();
  for (let index = 0; index < 6; index++) {
    const buttonBounds = await pauseButtons.nth(index).boundingBox();
    expect(buttonBounds).not.toBeNull();
    expect(buttonBounds!.x).toBeGreaterThanOrEqual(pauseBounds!.x);
    expect(buttonBounds!.x + buttonBounds!.width).toBeLessThanOrEqual(pauseBounds!.x + pauseBounds!.width);
  }
  const firstPauseButton = await pauseButtons.nth(0).boundingBox();
  const thirdPauseButton = await pauseButtons.nth(2).boundingBox();
  expect(thirdPauseButton!.y).toBeGreaterThan(firstPauseButton!.y + firstPauseButton!.height);
  await page.keyboard.press('Escape');
  await expect(pauseDialog).toBeHidden();
  await expect(page.locator('.hud-sas')).toHaveClass(/open/);
  const guidanceBox = await page.locator('.hud-sas').boundingBox();
  const navballBox = await page.locator('.hud-navball').boundingBox();
  expect(guidanceBox).not.toBeNull();
  expect(navballBox).not.toBeNull();
  expect(guidanceBox!.x + guidanceBox!.width).toBeLessThan(navballBox!.x);
  await page.getByTitle('Prograde').click();
  await expect(page.getByTitle('Prograde')).toHaveClass(/active/);
  await expect(page.locator('.hud-sas')).toHaveClass(/open/);
  await page.getByRole('button', { name: 'Map' }).click();
  await page.getByRole('button', { name: '+ Node in 2 min' }).click();
  await page.locator('.map-panel').getByRole('button', { name: 'Prograde', exact: true }).click();
  await expect(page.locator('.map-readout').filter({ hasText: 'Δv' })).toContainText('1.0 m/s');
});

test('two selected branches move together and undo as one action', async ({ page }) => {
  await openEditor(page);
  await loadWayfarer(page);
  const boosters = await page.evaluate(() => (window as any).__TEST__.parts().filter((part: any) => part.defId === 'srb-torch'));
  expect(boosters).toHaveLength(2);
  const firstPoint = await projectPart(page, boosters[0].key);
  const secondPoint = await projectPart(page, boosters[1].key);

  await page.mouse.click(firstPoint.x, firstPoint.y);
  await page.keyboard.down('Shift');
  await page.mouse.click(secondPoint.x, secondPoint.y);
  await page.keyboard.up('Shift');
  await expect.poll(() => page.evaluate(() => (window as any).__TEST__.debug().selectedKeys.length)).toBe(2);
  const historyBeforeMove = await page.evaluate(() => (window as any).__TEST__.debug().editorUndoDepth);

  await page.mouse.move(secondPoint.x, secondPoint.y);
  await page.mouse.down();
  await page.mouse.move(secondPoint.x + 90, secondPoint.y + 35, { steps: 8 });
  await page.mouse.up();
  const after = await page.evaluate(() => (window as any).__TEST__.parts().filter((part: any) => part.defId === 'srb-torch'));
  const deltas = after.map((part: any, index: number) => ({ x: part.x - boosters[index].x, y: part.y - boosters[index].y, z: part.z - boosters[index].z }));
  expect(Math.hypot(deltas[0].x, deltas[0].y, deltas[0].z)).toBeGreaterThan(0.1);
  expect(deltas[0].x).toBeCloseTo(deltas[1].x, 5);
  expect(deltas[0].y).toBeCloseTo(deltas[1].y, 5);
  expect(deltas[0].z).toBeCloseTo(deltas[1].z, 5);
  expect(await page.evaluate(() => (window as any).__TEST__.debug().editorUndoDepth)).toBe(historyBeforeMove + 1);

  await page.keyboard.press('Control+KeyZ');
  const restored = await page.evaluate(() => (window as any).__TEST__.parts().filter((part: any) => part.defId === 'srb-torch'));
  expect(restored[0].x).toBeCloseTo(boosters[0].x, 5);
  expect(restored[1].x).toBeCloseTo(boosters[1].x, 5);
});

test('secondary click exposes Make root while secondary drag remains camera orbit', async ({ page }) => {
  await openEditor(page);
  await loadWayfarer(page);
  const tank = await page.evaluate(() => (window as any).__TEST__.parts().find((part: any) => part.defId === 'tank-s2'));
  const tankPoint = await projectPart(page, tank.key);

  await page.mouse.click(tankPoint.x, tankPoint.y, { button: 'right' });
  await expect(page.locator('.ed-part-context')).toBeVisible();
  const contextPartKey = await page.evaluate(() => (window as any).__TEST__.debug().selected);
  await page.getByRole('button', { name: 'Make root' }).click();
  const rootKeys = await page.evaluate(() => (window as any).__TEST__.parts().filter((part: any) => part.parentKey === null).map((part: any) => part.key));
  expect(rootKeys).toEqual([contextPartKey]);
  await page.keyboard.press('Control+KeyZ');

  await page.keyboard.down('Control');
  await page.mouse.click(tankPoint.x, tankPoint.y);
  await page.keyboard.up('Control');
  await expect(page.locator('.ed-part-context')).toBeVisible();
  await page.locator('.ed-part-context .k-window-btn').click();

  const yawBefore = await page.evaluate(() => (window as any).__TEST__.debug().editorCameraYaw);
  await page.mouse.move(tankPoint.x, tankPoint.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(tankPoint.x + 100, tankPoint.y + 20, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  const yawAfter = await page.evaluate(() => (window as any).__TEST__.debug().editorCameraYaw);
  expect(yawAfter).not.toBeCloseTo(yawBefore, 3);
  await expect(page.locator('.ed-part-context')).toHaveCount(0);
});

test('narrow touch layout supports dock sheets, tap placement, long press, pinch, and multi-select', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openEditor(page);
  const dock = page.locator('.ed-mobile-dock');
  await expect(dock).toBeVisible();
  await dock.getByRole('button', { name: 'Parts' }).click();
  await expect(page.locator('[data-mobile-panel="parts"]')).toHaveClass(/mobile-open/);
  await page.locator('.ed-part', { hasText: 'Voyager Pod' }).click();
  await dock.getByRole('button', { name: 'Parts' }).click();

  await touch(page, 'pointerdown', 1, 195, 300);
  await touch(page, 'pointerup', 1, 195, 300);
  await expect.poll(() => page.evaluate(() => window.__TEST__.partCount())).toBe(1);
  const rootPoint = await page.evaluate(() => window.__TEST__.projectEditor(0, 3, 0));
  await touch(page, 'pointerdown', 1, rootPoint.x, rootPoint.y);
  await page.waitForTimeout(500);
  await expect(page.locator('.ed-part-context.touch-sheet')).toBeVisible();
  await touch(page, 'pointerup', 1, rootPoint.x, rootPoint.y);
  await page.locator('.ed-part-context .k-window-btn').click();

  const yawBefore = await page.evaluate(() => (window as any).__TEST__.debug().editorCameraYaw);
  await touch(page, 'pointerdown', 1, 24, 210);
  await touch(page, 'pointermove', 1, 84, 230);
  await touch(page, 'pointerup', 1, 84, 230);
  const yawAfter = await page.evaluate(() => (window as any).__TEST__.debug().editorCameraYaw);
  expect(yawAfter).not.toBeCloseTo(yawBefore, 3);

  const zoomBefore = await page.evaluate(() => (window as any).__TEST__.debug().editorCameraDistance);
  await touch(page, 'pointerdown', 1, 80, 260);
  await touch(page, 'pointerdown', 2, 180, 260);
  await touch(page, 'pointermove', 2, 250, 260);
  await touch(page, 'pointerup', 2, 250, 260);
  await touch(page, 'pointerup', 1, 80, 260);
  const zoomAfter = await page.evaluate(() => (window as any).__TEST__.debug().editorCameraDistance);
  expect(zoomAfter).toBeLessThan(zoomBefore);

  await dock.getByRole('button', { name: 'Stages' }).click();
  await expect(page.locator('[data-mobile-panel="stages"]')).toHaveClass(/mobile-open/);
  await dock.getByRole('button', { name: 'Engineer' }).click();
  await expect(page.locator('[data-mobile-panel="engineer"]')).toHaveClass(/mobile-open/);
  await dock.getByRole('button', { name: 'Craft' }).click();
  await loadWayfarer(page);
  await dock.getByRole('button', { name: 'Craft' }).click();

  await page.getByRole('button', { name: 'Select multiple', exact: true }).click();
  const boosters = await page.evaluate(() => (window as any).__TEST__.parts().filter((part: any) => part.defId === 'srb-torch'));
  for (let index = 0; index < boosters.length; index++) {
    const point = await projectPart(page, boosters[index].key);
    await touch(page, 'pointerdown', 1, point.x, point.y);
    await touch(page, 'pointerup', 1, point.x, point.y);
  }
  await expect.poll(() => page.evaluate(() => (window as any).__TEST__.debug().selectedKeys.length)).toBe(2);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Launch this craft' })).toBeVisible();
});

test('narrow flight view exposes throttle, touch steering, collapsible data, and Workshop navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openEditor(page);
  await page.getByRole('button', { name: 'Craft', exact: true }).click();
  await loadWayfarer(page);
  await page.getByRole('button', { name: 'Launch this craft' }).click();
  await page.waitForFunction(() => window.__TEST__.screen() === 'flight');

  const guidance = page.locator('.hud-sas');
  await expect(guidance).not.toHaveClass(/open/);
  await page.getByRole('button', { name: 'Choose guidance mode' }).click();
  await expect(guidance).toHaveClass(/open/);
  await page.getByTitle('Prograde').click();
  await expect(guidance).not.toHaveClass(/open/);

  const throttle = page.getByRole('slider', { name: 'Throttle percentage' });
  await expect(throttle).toBeVisible();
  await expect(throttle.locator('xpath=..')).toHaveClass(/hud-navwrap/);
  const throttleBox = await throttle.boundingBox();
  expect(throttleBox).not.toBeNull();
  await page.mouse.click(throttleBox!.x + throttleBox!.width / 2, throttleBox!.y + 5);
  await expect.poll(() => page.evaluate(() => window.__TEST__.throttle())).toBeGreaterThan(0.95);
  await page.mouse.click(throttleBox!.x + throttleBox!.width / 2, throttleBox!.y + throttleBox!.height - 5);
  await expect.poll(() => page.evaluate(() => window.__TEST__.throttle())).toBeLessThan(0.05);
  await throttle.fill('60');
  await expect.poll(() => page.evaluate(() => window.__TEST__.throttle())).toBeCloseTo(0.6, 2);
  await expect(throttle).toHaveAttribute('aria-valuetext', '60 percent throttle');

  for (const resource of ['Fuel', 'Charge', 'Monopropellant']) {
    const meter = page.getByRole('meter', { name: resource });
    await expect(meter).toBeAttached();
    await expect(meter.locator('svg')).toBeVisible();
    await expect(meter).toHaveAttribute('title', new RegExp(`^${resource}:`));
  }
  await expect(page.locator('.hud-orbit-strip .hud-apsis-indicator')).toHaveCount(2);
  await expect(page.locator('.hud-apsis-indicator.ap')).toBeVisible();
  await expect(page.locator('.hud-apsis-indicator.pe')).toBeVisible();
  await expect(page.locator('.hud-resource-strip')).toHaveCount(1);
  await expect(page.locator('.hud-right .hud-resources')).toBeHidden();
  const mapBox = await page.getByRole('button', { name: 'Map' }).boundingBox();
  const actionStripBox = await page.locator('.hud-sys').boundingBox();
  expect(mapBox).not.toBeNull();
  expect(actionStripBox).not.toBeNull();
  expect(mapBox!.x + mapBox!.width).toBeLessThanOrEqual(actionStripBox!.x + actionStripBox!.width);

  await expect(page.getByRole('button', { name: 'Pitch up' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Switch touch controls between attitude and RCS translation' })).toBeVisible();
  const flightData = page.locator('.hud-data-toggle');
  await expect(flightData).toHaveAttribute('aria-expanded', 'false');
  await flightData.click();
  await expect(flightData).toHaveAttribute('aria-expanded', 'true');

  await page.getByRole('button', { name: 'Workshop' }).click();
  await page.waitForFunction(() => window.__TEST__.screen() === 'editor');
});
