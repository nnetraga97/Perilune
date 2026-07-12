import { expect, test } from '@playwright/test';

interface FeasibilityState {
  runNonce: string;
  mode: string;
  tier: string;
  reductionStage: number;
  requestedReductionStage: number;
  effectiveReductionStage: number;
  protocol: {
    warmupSeconds: number;
    journeySeconds: number;
    journeyCount: number;
    drainSeconds: number;
  };
  phase: string;
  caps: {
    backend: string;
    drawingBufferWidth: number;
    drawingBufferHeight: number;
    drawingBufferSamples: number;
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
    profilingGroups: Record<string, boolean>;
  };
  resources: {
    categories: Record<string, number>;
    activeBodyBytes: number;
    totalRendererBytes: number;
    transientBytes: number;
    uncompressedWorstCaseBytes: number;
  };
  transfer: {
    bodyPackCompressedBytes: number;
    bootCriticalBytes: number;
    transientBytes: number;
    manifestPackCount: number;
    selectedPackCount: number;
    applicationTransferBytes: number;
    applicationEncodedBytes: number;
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
    invalidGpuSamples: number;
  }>;
  summary: null | {
    journeyCount: number;
    frameMedianMs: number;
    frameP95Ms: number;
    validGpuSamples: number;
    unavailableGpuSamples: number;
    disjointGpuSamples: number;
    invalidGpuSamples: number;
  };
  gpuTimer: {
    pending: number;
    validSamples: number;
    disjointSamples: number;
    invalidSamples: number;
    saturatedBegins: number;
  };
  telemetry: {
    drawCalls: number;
    triangles: number;
    maxDrawCalls: number;
    maxTriangles: number;
    transitionOverlapMs: number;
    transitionMode: string;
    rendererGeometryCount: number;
    rendererTextureCount: number;
    accountedGeometryCount: number;
    accountedTextureCount: number;
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

  const nonce = 'e2e-feasibility-nonce';
  await page.goto(`/?proto=feasibility&mode=smoke&tier=medium&stage=0&nonce=${nonce}`);
  await page.waitForFunction(() => window.__FEASIBILITY__?.scene.visualScatterCount === 50_000);

  const initial = await page.evaluate(() => window.__FEASIBILITY__!);
  expect(initial).toMatchObject({
    runNonce: nonce,
    mode: 'smoke',
    tier: 'medium',
    reductionStage: 0,
    requestedReductionStage: 0,
    effectiveReductionStage: 0,
    protocol: { warmupSeconds: 1.5, journeySeconds: 3, journeyCount: 3, drainSeconds: 0.75 },
  });
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
  expect(result.runNonce).toBe(nonce);
  expect(result.visitedRegimes).toEqual(expect.arrayContaining(['orbit', 'atmosphere', 'low-flight', 'surface']));
  expect(result.journeys).toHaveLength(3);
  for (const journey of result.journeys) {
    expect(journey.sampleCount).toBeGreaterThan(20);
    expect(journey.frameP95Ms).toBeGreaterThan(0);
    expect(journey.submissionP95Ms).toBeGreaterThanOrEqual(0);
    expect(journey.terrainP95Ms).toBeGreaterThanOrEqual(0);
    expect(journey.validGpuSamples + journey.unavailableGpuSamples + journey.disjointGpuSamples + journey.invalidGpuSamples)
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
  expect(result.summary!.invalidGpuSamples)
    .toBe(result.journeys.reduce((sum, journey) => sum + journey.invalidGpuSamples, 0));
  expect(result.gpuTimer.pending).toBe(0);
  expect(result.gpuTimer.saturatedBegins).toBe(0);
  expect(result.gpuTimer.invalidSamples).toBe(0);
  expect(result.scene.terrainCoverageGaps).toBe(0);
  expect(result.telemetry.drawCalls).toBeGreaterThan(0);
  expect(result.telemetry.triangles).toBeGreaterThan(0);
  expect(result.telemetry.maxDrawCalls).toBeGreaterThanOrEqual(result.telemetry.drawCalls);
  expect(result.telemetry.maxTriangles).toBeGreaterThanOrEqual(result.telemetry.triangles);
  expect(result.telemetry.transitionOverlapMs).toBeGreaterThan(8_900);
  expect(result.telemetry.transitionOverlapMs).toBeLessThan(9_100);
  expect(result.telemetry.transitionMode).toBe('forced-combined-fixture');
  const activeCategoryNames = [
    'terrainGeometryBytes', 'oceanGeometryBytes', 'atmosphereGeometryBytes',
    'cloudGeometryBytes', 'cloudTextureBytes', 'scatterGeometryBytes',
    'scatterInstanceBytes', 'physicalProxyGeometryBytes', 'physicalProxyInstanceBytes',
    'transitionGeometryBytes', 'shadowBytes',
  ];
  const rendererCategoryNames = [
    'starfieldGeometryBytes', 'drawingBufferColorBytes', 'drawingBufferDepthBytes',
  ];
  for (const category of [...activeCategoryNames, ...rendererCategoryNames]) {
    expect(result.resources.categories[category], category).toBeGreaterThan(0);
  }
  const activeSum = activeCategoryNames.reduce((sum, name) => sum + result.resources.categories[name], 0);
  const rendererOnlySum = rendererCategoryNames.reduce((sum, name) => sum + result.resources.categories[name], 0);
  expect(result.resources.activeBodyBytes).toBe(activeSum);
  expect(result.resources.totalRendererBytes).toBe(activeSum + rendererOnlySum);
  expect(result.resources.uncompressedWorstCaseBytes)
    .toBe(result.resources.totalRendererBytes + result.resources.transientBytes);
  expect(result.caps.drawingBufferSamples).toBeGreaterThanOrEqual(0);
  expect(result.telemetry.rendererGeometryCount).toBeGreaterThan(0);
  expect(result.telemetry.rendererGeometryCount).toBeLessThanOrEqual(result.telemetry.accountedGeometryCount);
  expect(result.telemetry.rendererTextureCount).toBeGreaterThan(0);
  expect(result.telemetry.rendererTextureCount).toBeLessThanOrEqual(result.telemetry.accountedTextureCount);
  expect(result.transfer.applicationTransferBytes > 0 || result.transfer.applicationEncodedBytes > 0).toBe(true);
  expect(result.transfer).toMatchObject({
    manifestPackCount: 3,
    selectedPackCount: 1,
  });
  expect(result.transfer.bodyPackCompressedBytes).toBeGreaterThan(0);
  expect(result.transfer.bootCriticalBytes).toBe(result.transfer.bodyPackCompressedBytes);
  expect(result.transfer.transientBytes).toBeGreaterThan(0);
  const overlay = await page.evaluate(() => (
    window as unknown as { __PERF__: { transitionMs: number; drawingBufferWidth: number; drawingBufferHeight: number } }
  ).__PERF__);
  expect(overlay.transitionMs).toBeGreaterThan(5_000);
  expect(overlay).toMatchObject({ drawingBufferWidth: 1920, drawingBufferHeight: 1080 });
});
