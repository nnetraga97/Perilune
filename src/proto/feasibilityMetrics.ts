export type FeasibilityTier = 'low' | 'medium';

export interface FeasibilityFeatureConfig {
  readonly effectiveStage: number;
  readonly cloudShadows: boolean;
  readonly atmosphereSamples: number;
  readonly secondCloudScale: boolean;
  readonly visualScatterCount: number;
  readonly oceanGlitter: boolean;
  readonly physicalProxyCount: 128;
  readonly terrainEnabled: true;
}

export interface FeasibilitySample {
  readonly frameMs: number;
  readonly submissionMs: number;
  readonly terrainMs: number;
  /** Null means the timer query was unavailable, pending, or discarded. */
  readonly gpuMs: number | null;
}

export interface JourneySummary {
  readonly frameMedianMs: number;
  readonly fpsMedian: number;
  readonly frameP95Ms: number;
  readonly submissionP95Ms: number;
  readonly terrainP95Ms: number;
  readonly gpuP95Ms: number | null;
  readonly validGpuSamples: number;
  readonly unavailableGpuSamples: number;
  readonly disjointGpuSamples: number;
  readonly invalidGpuSamples: number;
  readonly sampleCount: number;
}

export interface ReferenceRunSummary {
  readonly frameMedianMs: number;
  readonly fpsMedian: number;
  readonly frameP95Ms: number;
  readonly submissionP95Ms: number;
  readonly terrainP95Ms: number;
  readonly gpuP95Ms: number | null;
  readonly validGpuSamples: number;
  readonly unavailableGpuSamples: number;
  readonly disjointGpuSamples: number;
  readonly invalidGpuSamples: number;
  readonly journeyCount: number;
}

export function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) throw new Error('Cannot calculate a percentile from no samples');
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
    throw new Error(`Invalid percentile quantile ${quantile}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(quantile * sorted.length));
  return sorted[rank - 1];
}

export function reductionStage(stage: number, tier: FeasibilityTier): Readonly<FeasibilityFeatureConfig> {
  if (!Number.isInteger(stage) || stage < 0 || stage > 5) {
    throw new Error(`Reduction stage must be an integer from 0 through 5; received ${stage}`);
  }

  // Low begins at the sparse-scatter point but preserves the same ordered
  // feature ladder if further investigation requests stage 5.
  const effectiveStage = tier === 'low' ? Math.max(4, stage) : stage;
  return Object.freeze({
    effectiveStage,
    cloudShadows: effectiveStage < 1,
    atmosphereSamples: effectiveStage < 2 ? 12 : 8,
    secondCloudScale: effectiveStage < 3,
    visualScatterCount: effectiveStage < 4 ? 50_000 : 25_000,
    oceanGlitter: effectiveStage < 5,
    physicalProxyCount: 128,
    terrainEnabled: true,
  });
}

export function summarizeJourney(
  samples: readonly FeasibilitySample[],
  counts: {
    readonly disjointGpuSamples?: number;
    readonly invalidGpuSamples?: number;
  } = {},
): Readonly<JourneySummary> {
  if (samples.length === 0) throw new Error('A feasibility journey requires at least one sample');
  const frame = samples.map((entry) => entry.frameMs);
  const gpu = samples.flatMap((entry) => entry.gpuMs === null ? [] : [entry.gpuMs]);
  const disjointGpuSamples = counts.disjointGpuSamples ?? 0;
  const invalidGpuSamples = counts.invalidGpuSamples ?? 0;
  if (!Number.isInteger(disjointGpuSamples) || disjointGpuSamples < 0
    || !Number.isInteger(invalidGpuSamples) || invalidGpuSamples < 0
    || disjointGpuSamples + invalidGpuSamples > samples.length - gpu.length) {
    throw new Error(`Invalid disjoint GPU sample count ${disjointGpuSamples}`);
  }
  const frameMedianMs = percentile(frame, 0.5);
  return Object.freeze({
    frameMedianMs,
    fpsMedian: frameMedianMs > 0 ? 1000 / frameMedianMs : Number.POSITIVE_INFINITY,
    frameP95Ms: percentile(frame, 0.95),
    submissionP95Ms: percentile(samples.map((entry) => entry.submissionMs), 0.95),
    terrainP95Ms: percentile(samples.map((entry) => entry.terrainMs), 0.95),
    gpuP95Ms: gpu.length > 0 ? percentile(gpu, 0.95) : null,
    validGpuSamples: gpu.length,
    unavailableGpuSamples: samples.length - gpu.length - disjointGpuSamples - invalidGpuSamples,
    disjointGpuSamples,
    invalidGpuSamples,
    sampleCount: samples.length,
  });
}

export function summarizeReferenceRun(
  journeys: readonly JourneySummary[],
): Readonly<ReferenceRunSummary> {
  if (journeys.length === 0) throw new Error('A reference run requires at least one journey');
  const frameMedianMs = percentile(journeys.map((run) => run.frameMedianMs), 0.5);
  const gpuP95 = journeys.flatMap((run) => run.gpuP95Ms === null ? [] : [run.gpuP95Ms]);
  return Object.freeze({
    frameMedianMs,
    fpsMedian: frameMedianMs > 0 ? 1000 / frameMedianMs : Number.POSITIVE_INFINITY,
    frameP95Ms: Math.max(...journeys.map((run) => run.frameP95Ms)),
    submissionP95Ms: Math.max(...journeys.map((run) => run.submissionP95Ms)),
    terrainP95Ms: Math.max(...journeys.map((run) => run.terrainP95Ms)),
    gpuP95Ms: gpuP95.length > 0 ? Math.max(...gpuP95) : null,
    validGpuSamples: journeys.reduce((sum, run) => sum + run.validGpuSamples, 0),
    unavailableGpuSamples: journeys.reduce((sum, run) => sum + run.unavailableGpuSamples, 0),
    disjointGpuSamples: journeys.reduce((sum, run) => sum + run.disjointGpuSamples, 0),
    invalidGpuSamples: journeys.reduce((sum, run) => sum + run.invalidGpuSamples, 0),
    journeyCount: journeys.length,
  });
}
