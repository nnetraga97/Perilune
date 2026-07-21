/**
 * NASA-style part model acceptance: every enhanced part renders its imported
 * model, a failed asset falls back to procedural geometry without blocking
 * launch, and multi-nozzle engines build one plume per authored anchor.
 */
import { expect, test, Page } from '@playwright/test';

interface TestProbe {
  screen(): string;
  partCount(): number;
  stageCount(): number;
  parts(): Array<{ defId: string; x: number; y: number; z: number }>;
  stackSpots(): Array<{ kind: string; x: number; y: number; z: number }>;
  projectEditor(x: number, y: number, z: number): { x: number; y: number };
  partVisualSource(key: number): 'model' | 'procedural' | null;
  plumeCount(key: number): number;
  debug(): { selected: number | null };
  throttle(): number;
}

declare global {
  interface Window {
    __TEST__: TestProbe;
  }
}

async function probe<T>(page: Page, fn: (t: TestProbe) => T): Promise<T> {
  return page.evaluate((src) => (0, eval)(`(${src})`)(window.__TEST__), fn.toString()) as Promise<T>;
}

async function enterSandbox(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sandbox — just build and fly' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'editor');
}

async function placeRoot(page: Page, category: string, name: string): Promise<void> {
  await page.getByRole('button', { name: category, exact: true }).click();
  await page.locator('.ed-part', { hasText: name }).click();
  await page.mouse.move(640, 400);
  await page.waitForTimeout(120);
  await page.mouse.click(640, 400);
  await page.waitForTimeout(120);
}

/** Click the canvas at a free stack node to attach the held part there. */
async function clickStackSpot(page: Page, kind: 'stack-top' | 'stack-bottom'): Promise<void> {
  const pt = await page.evaluate((k) => {
    const spots = window.__TEST__.stackSpots().filter((s) => s.kind === k);
    if (!spots.length) return null;
    spots.sort((a, b) => (k === 'stack-bottom' ? a.y - b.y : b.y - a.y));
    const s = spots[0];
    return window.__TEST__.projectEditor(s.x, s.y, s.z);
  }, kind);
  expect(pt, `no free ${kind} node found`).not.toBeNull();
  await page.mouse.move(pt!.x, pt!.y);
  await page.waitForTimeout(120);
  await page.mouse.click(pt!.x, pt!.y);
  await page.waitForTimeout(120);
}

/** Select the sole placed part and return its craft key. */
async function selectSinglePart(page: Page): Promise<number> {
  const p = await probe(page, (t) => t.parts()[0]);
  const pt = await page.evaluate((pp) => window.__TEST__.projectEditor(pp.x, pp.y, pp.z), p);
  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(100);
  const key = await probe(page, (t) => t.debug().selected);
  expect(key, 'selected part key').not.toBeNull();
  return key as number;
}

const ENHANCED_PARTS = [
  { category: 'Pods', name: 'Voyager Pod' },
  { category: 'Tanks', name: 'PL-100 Tank' },
  { category: 'Tanks', name: 'PL-400 Tank' },
  { category: 'Tanks', name: 'HV-1600 Tank' },
  { category: 'Engines', name: 'Mule' },
  { category: 'Engines', name: 'Colt' },
  { category: 'Utility', name: 'Homecoming Chute' },
  { category: 'Utility', name: 'Longtalk Dish' },
  { category: 'Utility', name: 'Stilt Leg' },
  { category: 'Ground', name: 'Mesa Wheel' },
];

test('all enhanced parts render their imported model', async ({ page }) => {
  test.setTimeout(120_000);
  await enterSandbox(page);
  for (const { category, name } of ENHANCED_PARTS) {
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.waitForTimeout(80);
    await placeRoot(page, category, name);
    expect(await probe(page, (t) => t.partCount()), `${name} placed`).toBe(1);
    const key = await selectSinglePart(page);
    const source = await page.evaluate((k) => window.__TEST__.partVisualSource(k), key);
    expect(source, `${name} visual source`).toBe('model');
  }
});

test('a failed part asset falls back to procedural geometry and still launches', async ({ page }) => {
  // Force one model to 500 before the shared library preloads it.
  await page.route('**/parts/generated/orion-voyager-pod.glb*', (route) =>
    route.fulfill({ status: 500, contentType: 'model/gltf-binary', body: '' }),
  );
  await enterSandbox(page);

  await placeRoot(page, 'Pods', 'Voyager Pod');
  expect(await probe(page, (t) => t.partCount())).toBe(1);
  const podKey = await selectSinglePart(page);
  const podSource = await page.evaluate((k) => window.__TEST__.partVisualSource(k), podKey);
  expect(podSource, 'routed pod falls back').toBe('procedural');

  // A non-routed part still resolves its model on the same craft.
  await page.getByRole('button', { name: 'Tanks', exact: true }).click();
  await page.locator('.ed-part', { hasText: 'PL-400 Tank' }).click();
  await clickStackSpot(page, 'stack-bottom');
  expect(await probe(page, (t) => t.partCount())).toBe(2);
  const tankKey = await page.evaluate(() => {
    const tank = window.__TEST__.parts().find((p) => p.defId === 'tank-s4')!;
    const pt = window.__TEST__.projectEditor(tank.x, tank.y, tank.z);
    return { pt };
  });
  await page.mouse.click(tankKey.pt.x, tankKey.pt.y);
  await page.waitForTimeout(100);
  const selectedTank = await probe(page, (t) => t.debug().selected);
  const tankSource = await page.evaluate((k) => window.__TEST__.partVisualSource(k as number), selectedTank);
  expect(tankSource, 'tank still model').toBe('model');

  // Launch remains available despite the fallback.
  await page.getByRole('button', { name: 'Launch this craft' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'flight');
  expect(await probe(page, (t) => t.screen())).toBe('flight');
});

test('multi-nozzle engines build one plume per authored anchor', async ({ page }) => {
  test.setTimeout(180_000);
  await enterSandbox(page);

  // Pod → Mule → Colt, stacked so both engines fire bottom-up.
  await placeRoot(page, 'Pods', 'Voyager Pod');
  await page.getByRole('button', { name: 'Engines', exact: true }).click();
  await page.locator('.ed-part', { hasText: 'Mule' }).click();
  await clickStackSpot(page, 'stack-bottom');
  await page.locator('.ed-part', { hasText: 'Colt' }).click();
  await clickStackSpot(page, 'stack-bottom');
  expect(await probe(page, (t) => t.partCount())).toBe(3);

  await page.getByRole('button', { name: 'Auto-stage' }).click();
  await page.waitForTimeout(120);

  await page.getByRole('button', { name: 'Launch this craft' }).click();
  await page.waitForFunction(() => window.__TEST__?.screen() === 'flight');
  // Ignite so the active-vessel visual (and its plume groups) is live.
  await page.keyboard.press('KeyZ');
  await page.keyboard.press('Space');
  await page.waitForTimeout(600);

  // The Mule contributes three nozzle plumes and the Colt one; scan keys so the
  // test does not depend on exact craft-key assignment.
  const counts = await probe(page, (t) => {
    const found: number[] = [];
    for (let key = 0; key < 40; key++) {
      const count = t.plumeCount(key);
      if (count > 0) found.push(count);
    }
    return found.sort((a, b) => a - b);
  });
  expect(counts).toEqual([1, 3]);
});
