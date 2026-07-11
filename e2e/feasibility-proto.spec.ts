import { expect, test } from '@playwright/test';

interface FeasibilityState {
  phase: string;
  caps: {
    backend: string;
    drawingBufferWidth: number;
    drawingBufferHeight: number;
    gpuTimerSupported: boolean;
  };
  features: {
    cloudShadows: boolean;
    secondCloudScale: boolean;
  };
  scene: {
    visualScatterCount: number;
    physicalProxyCount: number;
    cloudLayerCount: number;
    atmosphereSamples: number;
    transitionMeshCount: number;
    terrainCoverageGaps: number;
    estimatedGpuBytes: number;
    profilingGroups: Record<string, boolean>;
  };
  visitedRegimes: string[];
  journeys: Array<{
    sampleCount: number;
    frameP95Ms: number;
    submissionP95Ms: number;
    terrainP95Ms: number;
    gpuP95Ms: number | null;
    validGpuSamples: number;
    unavailableGpuSamples: number;
    disjointGpuSamples: number;
  }>;
  summary: null | {
    journeyCount: number;
    frameMedianMs: number;
    frameP95Ms: number;
    validGpuSamples: number;
    unavailableGpuSamples: number;
    disjointGpuSamples: number;
  };
  gpuTimer: {
    pending: number;
    validSamples: number;
    disjointSamples: number;
    invalidSamples: number;
    saturatedBegins: number;
  };
}

declare global {
  interface Window {
    __FEASIBILITY__?: FeasibilityState;
    __FEASIBILITY_DONE__?: boolean;
    __SET_FEASIBILITY_FEATURE__?: (feature: string, enabled: boolean) => void;
    __SET_FEASIBILITY_GROUP__?: (group: string, enabled: boolean) => void;
  }
}

test('combined planet feasibility scene is measurable and stable', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/?proto=feasibility&mode=smoke&tier=medium&stage=0');
  await page.waitForFunction(() => window.__FEASIBILITY__?.scene.visualScatterCount === 50_000);

  const initial = await page.evaluate(() => window.__FEASIBILITY__!);
  expect(initial.caps).toMatchObject({
    backend: 'webgl2',
    drawingBufferWidth: 1920,
    drawingBufferHeight: 1080,
  });
  expect(typeof initial.caps.gpuTimerSupported).toBe('boolean');
  expect(initial.scene).toMatchObject({
    visualScatterCount: 50_000,
    physicalProxyCount: 128,
    cloudLayerCount: 2,
    atmosphereSamples: 12,
    transitionMeshCount: 2,
  });
  expect(initial.scene.estimatedGpuBytes).toBeLessThan(128 * 1024 * 1024);
  expect(initial.scene.profilingGroups).toEqual({
    terrain: true,
    atmosphere: true,
    ocean: true,
    clouds: true,
    scatter: true,
    transition: true,
  });

  await page.evaluate(() => window.__SET_FEASIBILITY_GROUP__?.('atmosphere', false));
  await expect.poll(async () => (
    await page.evaluate(() => window.__FEASIBILITY__!.scene.profilingGroups.atmosphere)
  )).toBe(false);
  expect((await page.evaluate(() => window.__FEASIBILITY__!.scene.physicalProxyCount))).toBe(128);
  await page.evaluate(() => window.__SET_FEASIBILITY_GROUP__?.('atmosphere', true));

  await page.evaluate(() => window.__SET_FEASIBILITY_FEATURE__?.('secondCloudScale', false));
  await expect.poll(async () => (
    await page.evaluate(() => window.__FEASIBILITY__!.scene.cloudLayerCount)
  )).toBe(1);
  const afterToggle = await page.evaluate(() => window.__FEASIBILITY__!);
  expect(afterToggle.scene.physicalProxyCount).toBe(128);
  expect(afterToggle.scene.visualScatterCount).toBe(50_000);
  await page.evaluate(() => window.__SET_FEASIBILITY_FEATURE__?.('secondCloudScale', true));

  await page.waitForFunction(() => window.__FEASIBILITY_DONE__ === true, undefined, { timeout: 60_000 });
  const result = await page.evaluate(() => window.__FEASIBILITY__!);
  expect(errors, `console/shader errors: ${errors.join('\n')}`).toEqual([]);
  expect(result.phase).toBe('complete');
  expect(result.visitedRegimes).toEqual(expect.arrayContaining(['orbit', 'atmosphere', 'low-flight', 'surface']));
  expect(result.journeys).toHaveLength(3);
  for (const journey of result.journeys) {
    expect(journey.sampleCount).toBeGreaterThan(20);
    expect(journey.frameP95Ms).toBeGreaterThan(0);
    expect(journey.submissionP95Ms).toBeGreaterThanOrEqual(0);
    expect(journey.terrainP95Ms).toBeGreaterThanOrEqual(0);
    expect(journey.validGpuSamples + journey.unavailableGpuSamples + journey.disjointGpuSamples)
      .toBe(journey.sampleCount);
  }
  expect(result.summary).toMatchObject({ journeyCount: 3 });
  expect(result.summary!.frameMedianMs).toBeGreaterThan(0);
  expect(result.summary!.frameP95Ms).toBeGreaterThan(0);
  expect(result.summary!.validGpuSamples)
    .toBe(result.journeys.reduce((sum, journey) => sum + journey.validGpuSamples, 0));
  expect(result.summary!.unavailableGpuSamples)
    .toBe(result.journeys.reduce((sum, journey) => sum + journey.unavailableGpuSamples, 0));
  expect(result.summary!.disjointGpuSamples)
    .toBe(result.journeys.reduce((sum, journey) => sum + journey.disjointGpuSamples, 0));
  expect(result.gpuTimer.pending).toBe(0);
  expect(result.gpuTimer.saturatedBegins).toBe(0);
  expect(result.scene.terrainCoverageGaps).toBe(0);
});
