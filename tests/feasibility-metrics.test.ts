import { describe, expect, it } from 'vitest';
import {
  percentile,
  reductionStage,
  summarizeJourney,
  summarizeReferenceRun,
  type FeasibilitySample,
} from '../src/proto/feasibilityMetrics';

function sample(frameMs: number, gpuMs: number | null = frameMs / 2): FeasibilitySample {
  return {
    frameMs,
    submissionMs: frameMs / 4,
    terrainMs: frameMs / 8,
    gpuMs,
  };
}

describe('feasibility metrics', () => {
  it('uses nearest-rank percentiles without mutating samples', () => {
    const values = [9, 1, 5, 3, 7];
    expect(percentile(values, 0.5)).toBe(5);
    expect(percentile(values, 0.95)).toBe(9);
    expect(values).toEqual([9, 1, 5, 3, 7]);
  });

  it('excludes unavailable GPU timings instead of converting them to zero', () => {
    const summary = summarizeJourney([
      sample(16, 7),
      sample(17, null),
      sample(15, 6),
    ], { disjointGpuSamples: 2 });
    expect(summary.gpuP95Ms).toBe(7);
    expect(summary.validGpuSamples).toBe(2);
    expect(summary.unavailableGpuSamples).toBe(1);
    expect(summary.disjointGpuSamples).toBe(2);
  });

  it('aggregates the median of run medians and the worst run p95', () => {
    const runs = [
      summarizeJourney([sample(10), sample(12), sample(14)]),
      summarizeJourney([sample(15), sample(16), sample(20)]),
      summarizeJourney([sample(8), sample(9), sample(10)]),
    ];
    const result = summarizeReferenceRun(runs);
    expect(result.frameMedianMs).toBe(12);
    expect(result.fpsMedian).toBeCloseTo(1000 / 12);
    expect(result.frameP95Ms).toBe(20);
    expect(result.submissionP95Ms).toBe(5);
    expect(result.terrainP95Ms).toBe(2.5);
    expect(result.gpuP95Ms).toBe(10);
  });

  it('applies Medium reductions only in the approved order', () => {
    const full = reductionStage(0, 'medium');
    expect(full).toMatchObject({
      cloudShadows: true,
      atmosphereSamples: 12,
      secondCloudScale: true,
      visualScatterCount: 50_000,
      oceanGlitter: true,
      physicalProxyCount: 128,
      terrainEnabled: true,
    });

    expect(reductionStage(1, 'medium')).toMatchObject({ cloudShadows: false, atmosphereSamples: 12 });
    expect(reductionStage(2, 'medium')).toMatchObject({ cloudShadows: false, atmosphereSamples: 8 });
    expect(reductionStage(3, 'medium')).toMatchObject({ secondCloudScale: false });
    expect(reductionStage(4, 'medium')).toMatchObject({ visualScatterCount: 25_000 });
    expect(reductionStage(5, 'medium')).toMatchObject({ oceanGlitter: false });
  });

  it('never reduces physical terrain or proxies', () => {
    for (const tier of ['low', 'medium'] as const) {
      for (let stage = 0; stage <= 5; stage++) {
        expect(reductionStage(stage, tier).terrainEnabled).toBe(true);
        expect(reductionStage(stage, tier).physicalProxyCount).toBe(128);
      }
    }
  });

  it('rejects reduction stages outside the approved range', () => {
    expect(() => reductionStage(-1, 'medium')).toThrow(/stage/i);
    expect(() => reductionStage(6, 'medium')).toThrow(/stage/i);
  });
});
