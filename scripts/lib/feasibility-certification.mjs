export const FEASIBILITY_METADATA_KEYS = Object.freeze([
  'model', 'firmware', 'driver', 'os', 'power', 'sustained-power',
]);

const GROUPS = Object.freeze(['terrain', 'atmosphere', 'ocean', 'clouds', 'scatter', 'transition']);
const REGIMES = Object.freeze(['orbit', 'atmosphere', 'low-flight', 'surface']);
export const STABLE_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FRAME_BOUNDARY_TOLERANCE_MS = 1000 / 60;

export function browserExecutableForMode(mode, requestedPath, pathExists) {
  if (mode === 'reference') {
    if (!pathExists(STABLE_CHROME_PATH)) {
      throw new Error(`Reference profiling requires stable Google Chrome at ${STABLE_CHROME_PATH}`);
    }
    return STABLE_CHROME_PATH;
  }
  return requestedPath;
}

export function expectedReferenceForTier(tier) {
  if (tier !== 'medium' && tier !== 'low') throw new Error(`Unknown feasibility tier ${tier}`);
  return 'm3-max-30c';
}

export function effectiveStageFor(tier, requestedStage) {
  return tier === 'low' ? Math.max(4, requestedStage) : requestedStage;
}

function expectedConfiguration(tier, requestedStage) {
  const effectiveStage = effectiveStageFor(tier, requestedStage);
  return {
    effectiveStage,
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
      transitionMeshCount: 2,
      terrainEnabled: true,
    },
  };
}

function sameFields(actual, expected) {
  return Object.entries(expected).every(([key, value]) => actual?.[key] === value);
}

function canonicalMetadata(host, browser) {
  return {
    model: `${host?.modelName ?? ''} (${host?.modelIdentifier ?? ''})`,
    firmware: host?.firmwareVersion ?? '',
    driver: `${browser?.webglVendor ?? ''} / ${browser?.webglRenderer ?? ''}`,
    os: `macOS ${host?.osVersion ?? ''} (${host?.osBuild ?? ''})`,
    power: `${host?.powerSource ?? ''}; powermode ${host?.powerMode ?? ''}`,
    'sustained-power': `powermode ${host?.powerMode ?? ''}; automatic thermal management`,
  };
}

export function assessCertificationEligibility(input) {
  const { mode, tier, reference, metadata, disabled, requestedStage, host, browser, state, runtimeErrors } = input;
  const reasons = [];
  const expectedReference = expectedReferenceForTier(tier);
  const reject = (condition, reason) => { if (condition) reasons.push(reason); };
  reject(mode !== 'reference', 'mode must be reference');
  reject(reference !== expectedReference, `reference must be ${expectedReference}`);
  const missing = FEASIBILITY_METADATA_KEYS.filter((key) => !metadata?.[key]?.trim());
  reject(missing.length > 0, `missing metadata: ${missing.join(', ')}`);
  reject(Boolean(disabled?.trim()), 'feature-disabled runs are diagnostic only');

  reject(host?.modelIdentifier !== 'Mac15,10', 'host modelIdentifier must be Mac15,10');
  reject(host?.chip !== 'Apple M3 Max', 'host chip must be Apple M3 Max');
  reject(host?.gpuCoreCount !== 30, 'host GPU core count must be 30');
  reject(host?.memoryBytes !== 36 * 1024 ** 3, 'host memory must be 36 GB');
  reject(!host?.firmwareVersion, 'host firmware is required');
  reject(!host?.osVersion || !host?.osBuild, 'observed OS version and build are required');
  reject(!host?.powerSource || host?.powerMode !== 0, 'observed power source and powermode 0 are required');

  const ua = browser?.userAgent ?? '';
  const renderer = browser?.webglRenderer ?? '';
  const vendor = browser?.webglVendor ?? '';
  reject(!/Chrome\//.test(ua) || /HeadlessChrome/i.test(ua), 'headed Chrome is required');
  reject(!renderer, 'WebGL renderer is required');
  reject(!vendor, 'WebGL vendor is required');
  reject(/SwiftShader/i.test(renderer), 'SwiftShader is not certifying');
  reject(Boolean(renderer) && !/Apple M3 Max/i.test(renderer), 'WebGL renderer must identify Apple M3 Max');
  reject(!/^Chrome\//.test(browser?.product ?? ''), 'stable Google Chrome product is required');
  reject(browser?.executablePath !== STABLE_CHROME_PATH, 'stable Google Chrome executable is required');

  const canonical = canonicalMetadata(host, browser);
  for (const key of FEASIBILITY_METADATA_KEYS) {
    reject(Boolean(metadata?.[key]) && metadata[key] !== canonical[key],
      `metadata ${key} does not match observed ${key === 'driver' ? 'browser' : 'host'}`);
  }

  reject(state?.mode !== mode, 'state mode must match CLI mode');
  reject(state?.tier !== tier, 'state tier must match CLI tier');
  reject(state?.requestedReductionStage !== requestedStage, 'state requested stage must match CLI stage');
  const expected = expectedConfiguration(tier, requestedStage);
  reject(state?.effectiveReductionStage !== expected.effectiveStage,
    `effective stage must be ${expected.effectiveStage}`);
  reject(state?.phase !== 'complete', 'state phase must be complete');
  reject(!sameFields(state?.protocol, { warmupSeconds: 30, journeySeconds: 300, journeyCount: 3, drainSeconds: 2 }),
    'protocol must declare warmup30/journey300 x3/drain2');
  reject(!(state?.elapsedSeconds >= 932), 'elapsed time must be at least 932 seconds');
  reject(state?.caps?.backend !== 'webgl2', 'WebGL2 is required');
  reject(state?.caps?.drawingBufferWidth !== 1920 || state?.caps?.drawingBufferHeight !== 1080,
    'drawing buffer must be exactly 1920x1080');
  reject(state?.caps?.renderer !== renderer || state?.caps?.vendor !== vendor,
    'state WebGL identity must match observed browser');
  reject(state?.caps?.gpuTimerSupported !== true || state?.gpuTimer?.supported !== true,
    'GPU timer must be supported');
  reject(state?.gpuTimer?.pending !== 0, 'GPU timer pending count must be zero');
  reject(state?.gpuTimer?.saturatedBegins !== 0, 'GPU timer saturated count must be zero');
  reject(state?.gpuTimer?.invalidSamples !== 0, 'GPU timer invalid sample count must be zero');

  const journeys = state?.journeys ?? [];
  reject(journeys.length !== 3 || journeys.some((journey) => !(journey?.sampleCount > 0)),
    'exactly three nonempty journeys are required');
  reject(REGIMES.some((regime) => !state?.visitedRegimes?.includes(regime)),
    'all four camera regimes are required');
  reject(GROUPS.some((group) => state?.scene?.profilingGroups?.[group] !== true),
    'all profiling groups must be enabled');
  reject(!sameFields(state?.features, expected.features), 'features do not match tier/effective stage');
  reject(!sameFields(state?.scene, expected.scene), 'scene counts do not match tier/effective stage');
  reject(state?.scene?.physicalProxyCount !== 128, '128 physical proxies are required');
  reject(state?.scene?.terrainCoverageGaps !== 0, 'terrain coverage gaps must be zero');
  reject(state?.telemetry?.transitionMode !== 'forced-combined-fixture',
    'transition mode must be forced-combined-fixture');
  reject(!(state?.telemetry?.transitionOverlapMs >= 900_000 - FRAME_BOUNDARY_TOLERANCE_MS),
    'transition overlap must cover the 900000 ms journey window within one 60Hz frame');
  reject((runtimeErrors?.length ?? 0) !== 0, 'runtime errors must be zero');

  const totals = journeys.reduce((sum, journey) => ({
    valid: sum.valid + (journey.validGpuSamples ?? 0),
    unavailable: sum.unavailable + (journey.unavailableGpuSamples ?? 0),
    disjoint: sum.disjoint + (journey.disjointGpuSamples ?? 0),
    invalid: sum.invalid + (journey.invalidGpuSamples ?? 0),
    samples: sum.samples + (journey.sampleCount ?? 0),
  }), { valid: 0, unavailable: 0, disjoint: 0, invalid: 0, samples: 0 });
  reject(totals.valid + totals.unavailable + totals.disjoint + totals.invalid !== totals.samples,
    'journey GPU totals must equal journey sample totals');
  reject(state?.summary?.validGpuSamples !== totals.valid ||
    state?.summary?.unavailableGpuSamples !== totals.unavailable ||
    state?.summary?.disjointGpuSamples !== totals.disjoint ||
    state?.summary?.invalidGpuSamples !== totals.invalid,
  'summary GPU totals must equal journey totals');
  reject(state?.gpuTimer?.validSamples !== totals.valid ||
    state?.gpuTimer?.disjointSamples !== totals.disjoint ||
    state?.gpuTimer?.invalidSamples !== totals.invalid,
  'GPU timer totals must equal journey totals');
  reject(totals.samples === 0 || totals.valid / totals.samples < 0.95,
    'valid GPU coverage must be at least 95%');

  return Object.freeze({ eligible: reasons.length === 0, reasons: Object.freeze(reasons) });
}

export function buildCertificationGates(state, tier) {
  const activeBudget = tier === 'medium' ? 128 * 1024 * 1024 : 64 * 1024 * 1024;
  const totalBudget = tier === 'medium' ? 384 * 1024 * 1024 : 256 * 1024 * 1024;
  return Object.freeze([
    gate('fpsMedian', state.summary.fpsMedian, 60, '>=', state.summary.fpsMedian >= 60),
    gate('frameP95Ms', state.summary.frameP95Ms, 16.7, '<', state.summary.frameP95Ms < 16.7),
    gate('activeGpuBytes', state.scene.estimatedGpuBytes, activeBudget, '<=', state.scene.estimatedGpuBytes <= activeBudget),
    gate('totalRendererGpuBytes', state.scene.estimatedRendererGpuBytes, totalBudget, '<=', state.scene.estimatedRendererGpuBytes <= totalBudget),
    gate('submissionP95Ms', state.summary.submissionP95Ms, 4, '<=', state.summary.submissionP95Ms <= 4),
    gate('terrainP95Ms', state.summary.terrainP95Ms, 2, '<=', state.summary.terrainP95Ms <= 2),
    gate('gpuP95Ms', state.summary.gpuP95Ms, 8, '<=', state.summary.gpuP95Ms !== null && state.summary.gpuP95Ms <= 8),
  ]);
}

function gate(name, actual, limit, comparison, pass) {
  return Object.freeze({
    name, actual, limit, comparison, pass,
    reason: pass ? null : `${name} must be ${comparison} ${limit}; observed ${actual}`,
  });
}
