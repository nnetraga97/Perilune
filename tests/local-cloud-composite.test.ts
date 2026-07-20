import { describe, expect, it } from 'vitest';
import {
  clipCloudIntervalToOpaqueDepth,
  crossfadeCloudOpticalDepth,
  CURRENT_LOCAL_CLOUD_DECISION,
  decideLocalCloudFeasibility,
  integrateLocalCloudOpticalDepth,
  sampleLocalCloudDensity,
} from '../src/proto/localCloudCompositeProto';

describe('local cloud composition feasibility', () => {
  it('clips all integration behind the first opaque depth', () => {
    expect(clipCloudIntervalToOpaqueDepth({ start: 100, end: 1_000 }, 550))
      .toEqual({ start: 100, end: 550 });
    expect(clipCloudIntervalToOpaqueDepth({ start: 100, end: 1_000 }, 100)).toBeNull();
    expect(clipCloudIntervalToOpaqueDepth({ start: 100, end: 1_000 }, Number.POSITIVE_INFINITY))
      .toEqual({ start: 100, end: 1_000 });
  });

  it('uses stable body-fixed 3D density rather than a repeated vertical sheet', () => {
    const common = {
      bodyRadius: 6_378_137,
      baseAltitude: 1_000,
      topAltitude: 6_000,
      macroCoverage: 0.8,
      opticalDensity: 0.9,
      timeSeconds: 12,
    } as const;
    const lower = sampleLocalCloudDensity({
      ...common,
      positionBodyFixed: { x: common.bodyRadius + 2_000, y: 10_000, z: 3_000 },
    });
    const repeated = sampleLocalCloudDensity({
      ...common,
      positionBodyFixed: { x: common.bodyRadius + 4_000, y: 10_000, z: 3_000 },
    });
    expect(lower).toBeGreaterThanOrEqual(0);
    expect(lower).toBeLessThanOrEqual(1);
    expect(repeated).not.toBe(lower);
    expect(sampleLocalCloudDensity({
      ...common,
      positionBodyFixed: { x: common.bodyRadius + 500, y: 0, z: 0 },
    })).toBe(0);
  });

  it('integrates only the clipped interval and produces Beer-Lambert alpha', () => {
    const interval = clipCloudIntervalToOpaqueDepth({ start: 0, end: 1_000 }, 500)!;
    const result = integrateLocalCloudOpticalDepth({
      interval,
      samples: 8,
      extinctionPerMeter: 0.001,
      densityAtDistance: () => 0.5,
    });
    expect(result.opticalDepth).toBeCloseTo(0.25, 12);
    expect(result.transmittance).toBeCloseTo(Math.exp(-0.25), 12);
    expect(result.alpha).toBeCloseTo(1 - Math.exp(-0.25), 12);
  });

  it('crossfades optical depth rather than adding shell and local alpha', () => {
    expect(crossfadeCloudOpticalDepth(2, 0.5, 0).opticalDepth).toBe(2);
    expect(crossfadeCloudOpticalDepth(2, 0.5, 1).opticalDepth).toBe(0.5);
    const middle = crossfadeCloudOpticalDepth(2, 0.5, 0.5);
    expect(middle.opticalDepth).toBe(1.25);
    expect(middle.alpha).toBeCloseTo(1 - Math.exp(-1.25), 12);
  });

  it('keeps production integration closed until a complete candidate is proven', () => {
    expect(CURRENT_LOCAL_CLOUD_DECISION.approvedMethod).toBeNull();
    expect(CURRENT_LOCAL_CLOUD_DECISION.blockers).toEqual([
      'no-readable-opaque-depth',
      'no-half-resolution-composite',
      'depth-reconstruction-unproven',
      'shell-cannot-clip-integrated-ray',
    ]);
    expect(decideLocalCloudFeasibility({
      readableOpaqueDepth: true,
      halfResolutionComposite: true,
      depthReconstructionValidated: true,
      shellCanClipIntegratedRay: false,
    }).approvedMethod).toBe('depth-clipped-raymarch');
  });
});
