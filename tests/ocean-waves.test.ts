import { describe, expect, it } from 'vitest';
import {
  createOceanCapMaterial,
  OCEAN_MAX_NORMAL_SLOPE,
  OCEAN_WAVE_COMPONENTS,
  oceanWavePolicy,
  sampleOceanWaveGradient,
} from '../src/render/terrestrial/oceanMaterial';

const RADIUS = 6_378_137;

function spherePoint(latitude: number, longitude: number) {
  return {
    x: RADIUS * Math.cos(latitude) * Math.cos(longitude),
    y: RADIUS * Math.cos(latitude) * Math.sin(longitude),
    z: RADIUS * Math.sin(latitude),
  };
}

describe('body-fixed ocean wave normals', () => {
  it('is deterministic and respects the declared normal-slope bound', () => {
    const point = spherePoint(0.4, -1.2);
    for (const quality of ['low', 'medium', 'high'] as const) {
      const first = sampleOceanWaveGradient(point, 123.5, quality);
      const second = sampleOceanWaveGradient(point, 123.5, quality);
      expect(first).toEqual(second);
      expect(first.phases).toHaveLength(oceanWavePolicy(quality).componentCount);
      expect(first.slope).toBeLessThanOrEqual(OCEAN_MAX_NORMAL_SLOPE);
      expect(Math.hypot(...first.gradient)).toBeLessThanOrEqual(OCEAN_MAX_NORMAL_SLOPE);
    }
    expect(oceanWavePolicy('low').componentCount).toBe(1);
    expect(oceanWavePolicy('medium').componentCount).toBe(2);
    expect(oceanWavePolicy('high').componentCount).toBe(OCEAN_WAVE_COMPONENTS.length);
  });

  it('is continuous across the longitude seam and finite at both poles', () => {
    const epsilon = 1e-10;
    const west = sampleOceanWaveGradient(spherePoint(0.2, Math.PI - epsilon), 42, 'high');
    const east = sampleOceanWaveGradient(spherePoint(0.2, -Math.PI + epsilon), 42, 'high');
    for (let axis = 0; axis < 3; axis++) {
      expect(west.gradient[axis]).toBeCloseTo(east.gradient[axis], 4);
    }
    for (const point of [spherePoint(Math.PI / 2, 0), spherePoint(-Math.PI / 2, 0)]) {
      const sample = sampleOceanWaveGradient(point, 7, 'high');
      expect(sample.slope).toBeLessThanOrEqual(OCEAN_MAX_NORMAL_SLOPE);
      for (const value of [...sample.phases, ...sample.gradient]) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it('filters every wave band in fragment space while leaving cap vertices untouched', () => {
    const medium = createOceanCapMaterial('medium', null, '#173d5c', RADIUS);
    const source = medium.fragmentShader;
    expect(source).toContain('float phaseFootprint = fwidth(phase)');
    expect(source).toContain('smoothstep(0.75, 2.5, phaseFootprint)');
    expect(source).toContain('filteredOceanWaveNormal');
    expect(source).toContain(`totalSlope > ${OCEAN_MAX_NORMAL_SLOPE.toFixed(3)}`);
    expect(source).not.toContain('sin(vBodyDirection.x * 170.0');
    expect(medium.vertexShader).not.toContain('uTime');
    expect(medium.vertexShader).not.toContain('wave');
    expect(medium.uniforms.uWaveComponentCount.value).toBe(2);
    expect(medium.customProgramCacheKey()).toContain('terrestrial-ocean-v4');
    medium.dispose();
  });
});
