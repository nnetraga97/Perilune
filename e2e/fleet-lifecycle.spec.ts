import { expect, test } from '@playwright/test';

interface FleetProbe {
  screen(): string;
  vesselCount(): number;
  fleetOrbitCount(): number;
  externalVisualAttached(vesselId: string): boolean;
  vessels(): Array<{
    id: string;
    name: string;
    bodyId: string;
    situation: string;
    active: boolean;
  }>;
}

for (const entry of [
  { mode: 'sandbox', button: 'Sandbox — just build and fly' },
  { mode: 'exploration', button: 'Exploration — unlock technology with science' },
  { mode: 'program', button: 'Space Program — funding, technology, and contracts' },
] as const) {
  test(`${entry.mode} starts flight with the lunar concept craft in orbit`, async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: entry.button }).click();
    await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');
    await page.locator('.ed-part', { hasText: 'Voyager Pod' }).dragTo(page.locator('#game-canvas'), {
      targetPosition: { x: 640, y: 400 },
    });
    await page.locator('.ed-launch').click();
    await page.waitForFunction(() => window.__TEST__?.screen() === 'flight');
    const concept = await page.evaluate(() => (
      window.__TEST__ as unknown as FleetProbe
    ).vessels().find((vessel) => vessel.name === 'Artemis IV lander concept'));
    expect(concept).toMatchObject({ bodyId: 'moon', situation: 'orbit', active: false });
  });
}

test('launch and Revert preserve the fleet while the lunar concept orbit stays on the map', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sandbox — just build and fly' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');

  await page.getByRole('button', { name: 'Load built-in craft Odyssey Orbital Vehicle' }).click();
  await page.getByRole('button', { name: 'Launch this craft' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'flight');
  await expect.poll(() => page.evaluate(() => window.__TEST__.vesselCount())).toBe(2);

  const firstFleet = await page.evaluate(() => (window.__TEST__ as unknown as FleetProbe).vessels());
  const odyssey = firstFleet.find((vessel) => vessel.name === 'Odyssey Orbital Vehicle');
  const concept = firstFleet.find((vessel) => vessel.name === 'Artemis IV lander concept');
  expect(odyssey).toMatchObject({ bodyId: 'earth', active: true });
  expect(concept).toMatchObject({ bodyId: 'moon', situation: 'orbit', active: false });

  await page.getByRole('button', { name: 'Map' }).click();
  await expect.poll(() => page.evaluate(() => (
    window.__TEST__ as unknown as FleetProbe
  ).fleetOrbitCount())).toBeGreaterThanOrEqual(1);
  await page.getByRole('button', { name: 'Map' }).click();

  await page.getByLabel('Active craft').selectOption({ label: 'Artemis IV lander concept' });
  await expect.poll(() => page.evaluate((vesselId) => (
    window.__TEST__ as unknown as FleetProbe
  ).externalVisualAttached(vesselId), concept!.id), { timeout: 60_000 }).toBe(true);

  await page.getByRole('button', { name: 'Workshop' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');
  await page.getByRole('button', { name: 'Load built-in craft Wayfarer Heavy Demonstrator' }).click();
  await page.getByRole('button', { name: 'Launch this craft' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'flight');
  await expect.poll(() => page.evaluate(() => window.__TEST__.vesselCount())).toBe(3);

  const beforeRevert = await page.evaluate(() => (window.__TEST__ as unknown as FleetProbe).vessels());
  const wayfarerBefore = beforeRevert.find((vessel) => vessel.name === 'Wayfarer Heavy Demonstrator');
  expect(wayfarerBefore?.active).toBe(true);

  await page.getByRole('button', { name: 'Revert', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__TEST__.vesselCount())).toBe(3);
  const afterRevert = await page.evaluate(() => (window.__TEST__ as unknown as FleetProbe).vessels());
  expect(afterRevert.find((vessel) => vessel.id === odyssey?.id)).toBeDefined();
  expect(afterRevert.find((vessel) => vessel.id === concept?.id)).toBeDefined();
  const wayfarerAfter = afterRevert.find((vessel) => vessel.name === 'Wayfarer Heavy Demonstrator');
  expect(wayfarerAfter).toMatchObject({ bodyId: 'earth', situation: 'prelaunch', active: true });
  expect(wayfarerAfter?.id).not.toBe(wayfarerBefore?.id);
});
