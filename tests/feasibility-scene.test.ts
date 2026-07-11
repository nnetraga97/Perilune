import { describe, expect, it, vi } from 'vitest';
import { reductionStage } from '../src/proto/feasibilityMetrics';
import { categorizeResources } from '../src/render/resourceAccounting';
import {
  DisposableBag,
  classifyCloudResources,
  feasibilityFixtureSpec,
  generateScatterRecords,
  physicalProxyIds,
} from '../src/proto/feasibilityScene';

describe('feasibility scene fixture', () => {
  it('generates deterministic visual scatter records', () => {
    const first = generateScatterRecords(4217, 16);
    const second = generateScatterRecords(4217, 16);
    expect(second.ids).toEqual(first.ids);
    expect(second.transforms).toEqual(first.transforms);
    expect(generateScatterRecords(4218, 16).transforms).not.toEqual(first.transforms);
    expect(new Set(first.ids).size).toBe(16);
  });

  it('keeps stable physical IDs at every quality reduction', () => {
    const expected = physicalProxyIds(4217, 128);
    expect(new Set(expected).size).toBe(128);
    for (let stage = 0; stage <= 5; stage++) {
      const fixture = feasibilityFixtureSpec(reductionStage(stage, 'medium'), 4217);
      expect(fixture.physicalProxyCount).toBe(128);
      expect(fixture.physicalProxyIds).toEqual(expected);
      expect(fixture.terrainEnabled).toBe(true);
    }
  });

  it('describes the complete Medium fixture and ordered reductions', () => {
    const full = feasibilityFixtureSpec(reductionStage(0, 'medium'), 4217);
    expect(full).toMatchObject({
      visualScatterCount: 50_000,
      physicalProxyCount: 128,
      cloudLayerCount: 2,
      atmosphereSamples: 12,
      transitionMeshCount: 2,
      cloudShadows: true,
      oceanGlitter: true,
    });

    expect(feasibilityFixtureSpec(reductionStage(1, 'medium'), 4217).cloudShadows).toBe(false);
    expect(feasibilityFixtureSpec(reductionStage(2, 'medium'), 4217).atmosphereSamples).toBe(8);
    expect(feasibilityFixtureSpec(reductionStage(3, 'medium'), 4217).cloudLayerCount).toBe(1);
    expect(feasibilityFixtureSpec(reductionStage(4, 'medium'), 4217).visualScatterCount).toBe(25_000);
    expect(feasibilityFixtureSpec(reductionStage(5, 'medium'), 4217).oceanGlitter).toBe(false);
  });

  it('keeps both cloud allocations active at stage 0', () => {
    expect(classifyCloudResources([
      { geometryBytes: 100, textureBytes: 200 },
      { geometryBytes: 10, textureBytes: 20 },
    ], reductionStage(0, 'medium').secondCloudScale)).toEqual({
      activeGeometryBytes: 110,
      activeTextureBytes: 220,
      activeGeometryCount: 2,
      activeTextureCount: 2,
    });
  });

  it('moves the allocated second cloud out of active-body bytes at stage 4', () => {
    const clouds = classifyCloudResources([
      { geometryBytes: 100, textureBytes: 200 },
      { geometryBytes: 10, textureBytes: 20 },
    ], reductionStage(4, 'medium').secondCloudScale);
    expect(clouds).toEqual({
      activeGeometryBytes: 100,
      activeTextureBytes: 200,
      activeGeometryCount: 1,
      activeTextureCount: 1,
    });
    const resources = categorizeResources({
      activeBody: {
        cloudGeometryBytes: clouds.activeGeometryBytes,
        cloudTextureBytes: clouds.activeTextureBytes,
      },
      rendererOnly: {
        starfieldGeometryBytes: 10,
        drawingBufferColorBytes: 20,
        drawingBufferDepthBytes: 30,
      },
      transientBytes: 0,
    });
    expect(resources.activeBodyBytes).toBe(300);
    expect(resources.totalRendererBytes).toBe(360);
  });

  it('disposes every owned resource exactly once', () => {
    const first = { dispose: vi.fn() };
    const second = { dispose: vi.fn() };
    const bag = new DisposableBag();
    bag.add(first);
    bag.add(second);
    bag.add(first);
    bag.dispose();
    bag.dispose();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).toHaveBeenCalledTimes(1);
    expect(() => bag.add({ dispose() {} })).toThrow(/disposed/i);
  });
});
