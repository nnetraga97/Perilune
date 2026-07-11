import { describe, expect, it } from 'vitest';
import {
  assessCertificationEligibility,
  browserExecutableForMode,
  buildCertificationGates,
  expectedReferenceForTier,
} from '../scripts/lib/feasibility-certification.mjs';

const metadata = {
  model: 'MacBook Pro (Mac15,10)',
  firmware: '11881.121.1',
  driver: 'Apple / ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Unspecified Version)',
  os: 'macOS 15.5 (24F74)',
  power: 'Battery Power; powermode 0',
  'sustained-power': 'powermode 0; automatic thermal management',
};

const host = {
  modelName: 'MacBook Pro',
  modelIdentifier: 'Mac15,10',
  chip: 'Apple M3 Max',
  gpuCoreCount: 30,
  memoryBytes: 36 * 1024 ** 3,
  firmwareVersion: '11881.121.1',
  osVersion: '15.5',
  osBuild: '24F74',
  powerSource: 'Battery Power',
  powerMode: 0,
};

const browser = {
  userAgent: 'Mozilla/5.0 Chrome/138.0.0.0 Safari/537.36',
  product: 'Chrome/138.0.7204.50',
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Unspecified Version)',
  webglVendor: 'Apple',
};

function state(tier: 'medium' | 'low' = 'medium', requestedStage = 0) {
  const effectiveStage = tier === 'low' ? Math.max(4, requestedStage) : requestedStage;
  return {
    mode: 'reference',
    tier,
    requestedReductionStage: requestedStage,
    effectiveReductionStage: effectiveStage,
    phase: 'complete',
    protocol: { warmupSeconds: 30, journeySeconds: 300, journeyCount: 3, drainSeconds: 2 },
    elapsedSeconds: 932,
    caps: {
      backend: 'webgl2', drawingBufferWidth: 1920, drawingBufferHeight: 1080,
      gpuTimerSupported: true, renderer: browser.webglRenderer, vendor: browser.webglVendor,
    },
    features: {
      cloudShadows: effectiveStage < 1,
      atmosphereSamples: effectiveStage < 2 ? 12 : 8,
      secondCloudScale: effectiveStage < 3,
      visualScatterCount: effectiveStage < 4 ? 50_000 : 25_000,
      oceanGlitter: effectiveStage < 5,
      physicalProxyCount: 128,
      terrainEnabled: true,
    },
    scene: {
      cloudShadows: effectiveStage < 1,
      atmosphereSamples: effectiveStage < 2 ? 12 : 8,
      cloudLayerCount: effectiveStage < 3 ? 2 : 1,
      visualScatterCount: effectiveStage < 4 ? 50_000 : 25_000,
      oceanGlitter: effectiveStage < 5,
      physicalProxyCount: 128,
      terrainEnabled: true,
      transitionMeshCount: 2,
      terrainCoverageGaps: 0,
      estimatedGpuBytes: 1,
      estimatedRendererGpuBytes: 1,
      profilingGroups: {
        terrain: true, atmosphere: true, ocean: true, clouds: true,
        scatter: true, transition: true,
      },
    },
    visitedRegimes: ['orbit', 'atmosphere', 'low-flight', 'surface'],
    journeys: [0, 1, 2].map(() => ({
      sampleCount: 100, validGpuSamples: 96, unavailableGpuSamples: 3, disjointGpuSamples: 1,
      invalidGpuSamples: 0,
    })),
    summary: {
      fpsMedian: 60, frameP95Ms: 16.6, submissionP95Ms: 4, terrainP95Ms: 2,
      gpuP95Ms: 8, validGpuSamples: 288, unavailableGpuSamples: 9,
      disjointGpuSamples: 3, invalidGpuSamples: 0, journeyCount: 3,
    },
    gpuTimer: {
      supported: true, pending: 0, saturatedBegins: 0,
      validSamples: 288, disjointSamples: 3, invalidSamples: 0,
    },
    telemetry: { transitionMode: 'forced-combined-fixture', transitionOverlapMs: 900_000 },
  };
}

function input(overrides: Record<string, unknown> = {}): Parameters<typeof assessCertificationEligibility>[0] {
  return {
    mode: 'reference', tier: 'medium', reference: 'm3-max-30c', metadata,
    disabled: '', requestedStage: 0, host, browser, state: state(), runtimeErrors: [],
    ...overrides,
  } as Parameters<typeof assessCertificationEligibility>[0];
}

function expectReason(overrides: Record<string, unknown>, fragment: string) {
  expect(assessCertificationEligibility(input(overrides)).reasons.join('\n')).toContain(fragment);
}

describe('feasibility certification integrity', () => {
  it('uses the approved M3 Max reference for Medium and Low', () => {
    expect(expectedReferenceForTier('medium')).toBe('m3-max-30c');
    expect(expectedReferenceForTier('low')).toBe('m3-max-30c');
  });

  it('requires the installed stable Google Chrome executable for reference mode', () => {
    const stable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    expect(browserExecutableForMode('reference', undefined, (path) => path === stable)).toBe(stable);
    expect(() => browserExecutableForMode('reference', '/tmp/playwright/chrome', () => false))
      .toThrow(/stable Google Chrome/);
    expect(browserExecutableForMode('smoke', '/tmp/playwright/chrome', () => false))
      .toBe('/tmp/playwright/chrome');
    expect(browserExecutableForMode('smoke', undefined, () => false)).toBeUndefined();
  });

  it('accepts a complete observed full-duration M3 Max record', () => {
    expect(assessCertificationEligibility(input())).toEqual({ eligible: true, reasons: [] });
  });

  it('rejects wrong hardware and inconsistent CLI metadata', () => {
    expectReason({ host: { ...host, modelIdentifier: 'Mac14,5' } }, 'host modelIdentifier must be Mac15,10');
    expectReason({ host: { ...host, chip: 'Apple M2 Max' } }, 'host chip must be Apple M3 Max');
    expectReason({ host: { ...host, gpuCoreCount: 38 } }, 'host GPU core count must be 30');
    expectReason({ host: { ...host, memoryBytes: 32 * 1024 ** 3 } }, 'host memory must be 36 GB');
    expectReason({ metadata: { ...metadata, firmware: 'invented' } }, 'metadata firmware does not match observed host');
    expectReason({ metadata: { ...metadata, driver: 'invented' } }, 'metadata driver does not match observed browser');
  });

  it('rejects headless, software, missing, or wrong WebGL browser evidence', () => {
    expectReason({ browser: { ...browser, userAgent: `${browser.userAgent} HeadlessChrome/138` } }, 'headed Chrome is required');
    expectReason({ browser: { ...browser, webglRenderer: 'ANGLE (Google, Vulkan SwiftShader)' } }, 'SwiftShader is not certifying');
    expectReason({ browser: { ...browser, webglRenderer: 'ANGLE Metal Renderer: Apple M2 Max' } }, 'WebGL renderer must identify Apple M3 Max');
    expectReason({ browser: { ...browser, webglVendor: '' } }, 'WebGL vendor is required');
    expectReason({ browser: { ...browser, product: 'Chromium/138.0.0.0' } }, 'stable Google Chrome product is required');
    expectReason({ browser: { ...browser, executablePath: '/tmp/playwright/chrome' } }, 'stable Google Chrome executable is required');
  });

  it('rejects mode, tier, stage, protocol, duration, and drawing-buffer mismatches', () => {
    expectReason({ state: { ...state(), mode: 'smoke' } }, 'state mode must match CLI mode');
    expectReason({ state: { ...state(), tier: 'low' } }, 'state tier must match CLI tier');
    expectReason({ state: { ...state(), requestedReductionStage: 1 } }, 'state requested stage must match CLI stage');
    expectReason({ state: { ...state(), protocol: { ...state().protocol, warmupSeconds: 29 } } }, 'protocol must declare warmup30/journey300 x3/drain2');
    expectReason({ state: { ...state(), elapsedSeconds: 931.99 } }, 'elapsed time must be at least 932 seconds');
    expectReason({ state: { ...state(), caps: { ...state().caps, drawingBufferWidth: 1919 } } }, 'drawing buffer must be exactly 1920x1080');
  });

  it('rejects missing journeys, regimes, groups, expected features, and scene counts', () => {
    expectReason({ state: { ...state(), journeys: [state().journeys[0], state().journeys[1]] } }, 'exactly three nonempty journeys are required');
    expectReason({ state: { ...state(), visitedRegimes: ['orbit', 'atmosphere', 'surface'] } }, 'all four camera regimes are required');
    expectReason({ state: { ...state(), scene: { ...state().scene, profilingGroups: { ...state().scene.profilingGroups, clouds: false } } } }, 'all profiling groups must be enabled');
    expectReason({ state: { ...state(), features: { ...state().features, secondCloudScale: false } } }, 'features do not match tier/effective stage');
    expectReason({ state: { ...state(), scene: { ...state().scene, visualScatterCount: 25_000 } } }, 'scene counts do not match tier/effective stage');
    expectReason({ state: { ...state(), scene: { ...state().scene, physicalProxyCount: 127 } } }, '128 physical proxies are required');
    expectReason({ state: { ...state(), scene: { ...state().scene, terrainCoverageGaps: 1 } } }, 'terrain coverage gaps must be zero');
  });

  it('rejects weak transition overlap and runtime errors', () => {
    expectReason({ state: { ...state(), telemetry: { transitionMode: 'production-clock', transitionOverlapMs: 900_000 } } }, 'transition mode must be forced-combined-fixture');
    expect(assessCertificationEligibility(input({
      state: { ...state(), telemetry: { transitionMode: 'forced-combined-fixture', transitionOverlapMs: 900_000 - 1000 / 60 } },
    }))).toMatchObject({ eligible: true });
    expectReason({
      state: { ...state(), telemetry: { transitionMode: 'forced-combined-fixture', transitionOverlapMs: 900_000 - 1000 / 60 - 0.001 } },
    }, 'transition overlap must cover the 900000 ms journey window');
    expectReason({ runtimeErrors: ['shader failed'] }, 'runtime errors must be zero');
  });

  it('rejects unsupported, pending, saturated, or insufficient GPU timing coverage', () => {
    expectReason({ state: { ...state(), gpuTimer: { supported: false, pending: 0, saturatedBegins: 0 } } }, 'GPU timer must be supported');
    expectReason({ state: { ...state(), gpuTimer: { supported: true, pending: 1, saturatedBegins: 0 } } }, 'GPU timer pending count must be zero');
    expectReason({ state: { ...state(), gpuTimer: { supported: true, pending: 0, saturatedBegins: 1 } } }, 'GPU timer saturated count must be zero');
    const badJourneys = state().journeys.map((journey) => ({ ...journey, validGpuSamples: 94, unavailableGpuSamples: 5 }));
    expectReason({ state: { ...state(), journeys: badJourneys, summary: { ...state().summary, validGpuSamples: 282, unavailableGpuSamples: 15 } } }, 'valid GPU coverage must be at least 95%');
    expectReason({ state: { ...state(), summary: { ...state().summary, validGpuSamples: 287 } } }, 'summary GPU totals must equal journey totals');
    const invalidJourneys = state().journeys.map((journey, index) => index === 0
      ? { ...journey, validGpuSamples: 95, invalidGpuSamples: 1 }
      : journey);
    expectReason({
      state: {
        ...state(),
        journeys: invalidJourneys,
        summary: { ...state().summary, validGpuSamples: 287, invalidGpuSamples: 1 },
        gpuTimer: { ...state().gpuTimer, validSamples: 287, invalidSamples: 1 },
      },
    }, 'GPU timer invalid sample count must be zero');
    expectReason({
      state: { ...state(), gpuTimer: { ...state().gpuTimer, validSamples: 287 } },
    }, 'GPU timer totals must equal journey totals');
  });

  it('labels Low requested stage 0 as effective stage 4', () => {
    const low = state('low', 0);
    expect(assessCertificationEligibility(input({ tier: 'low', state: low }))).toEqual({ eligible: true, reasons: [] });
    expectReason({ tier: 'low', state: { ...low, effectiveReductionStage: 0 } }, 'effective stage must be 4');
  });

  it('exposes a reason on every failed performance gate for both tiers', () => {
    const failing = state();
    failing.summary = { ...failing.summary, fpsMedian: 59, frameP95Ms: 17, submissionP95Ms: 4.1, terrainP95Ms: 2.1, gpuP95Ms: 8.1 };
    for (const tier of ['medium', 'low'] as const) {
      const gates = buildCertificationGates(failing, tier);
      expect(gates.filter((gate) => !gate.pass)).toHaveLength(5);
      expect(gates.filter((gate) => !gate.pass).every((gate) => Boolean(gate.reason))).toBe(true);
    }
  });
});
