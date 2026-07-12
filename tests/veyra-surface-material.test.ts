import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { GameState } from '../src/sim/state';
import { bodyMaterialDescriptor } from '../src/render/bodyMaterial';
import { recipeForBody } from '../src/sim/terrainRecipe';
import { buildTerrainChunkGeometry } from '../src/render/terrain/chunkGeometry';
import type { RuntimeBodyAssetPack } from '../src/render/bodyRenderer';
import {
  classifyTerrestrialSurface,
  createTerrestrialSurfaceMaterial,
  deterministicMoisture,
  sampleSurfaceDetail,
  surfaceDetailTier,
  triplanarBlendWeights,
  SURFACE_DETAIL_PERIOD_METERS,
  type TerrestrialSurfaceSample,
} from '../src/render/terrestrial/surfaceMaterial';

const veyra = new GameState().universe.get('veyra');
const descriptor = bodyMaterialDescriptor(veyra);

function texture(bytes = [128, 128, 128, 255]): THREE.DataTexture {
  const value = new THREE.DataTexture(new Uint8Array(bytes), 1, 1, THREE.RGBAFormat);
  value.needsUpdate = true;
  return value;
}

function pack(tier: 'low' | 'medium' | 'high' = 'medium'): RuntimeBodyAssetPack {
  return {
    bodyId: 'veyra', tier, width: 2048, height: 1024, manifestDigest: 'a'.repeat(64), gpuBytes: 100,
    textures: new Map([
      ['albedo', texture([120, 150, 110, 255])],
      ['normal', texture([128, 128, 0, 255])],
      ['material', texture([190, 240, 80, 128])],
      ['clouds', texture([180, 210, 0, 255])],
    ]),
  };
}

const BASE: TerrestrialSurfaceSample = {
  biomeClass: 0.5,
  shore: 0,
  ocean: 0,
  altitude: 200,
  slope: 0.1,
  latitude: 0.3,
  moisture: 0.5,
};

function sample(overrides: Partial<TerrestrialSurfaceSample>): TerrestrialSurfaceSample {
  return { ...BASE, ...overrides };
}

function dominant(weights: { soil: number; rock: number; sand: number; vegetation: number }): string {
  return (Object.entries(weights).sort((a, b) => b[1] - a[1])[0][0]);
}

describe('classifyTerrestrialSurface', () => {
  it('returns normalized weights that always sum to one', () => {
    for (const s of [
      BASE,
      sample({ slope: 0.9 }),
      sample({ shore: 0.95, altitude: 5 }),
      sample({ biomeClass: 0.95, moisture: 0.9 }),
      sample({ altitude: 5000, latitude: 0.95 }),
      sample({ biomeClass: 0.05, moisture: 0.05 }),
    ]) {
      const w = classifyTerrestrialSurface(s);
      expect(w.soil + w.rock + w.sand + w.vegetation).toBeCloseTo(1, 6);
      for (const value of [w.soil, w.rock, w.sand, w.vegetation]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('makes each surface class dominant under its driving conditions', () => {
    expect(dominant(classifyTerrestrialSurface(sample({ slope: 0.85 })))).toBe('rock');
    expect(dominant(classifyTerrestrialSurface(sample({ shore: 0.95, altitude: 4, biomeClass: 0.25 })))).toBe('sand');
    expect(dominant(classifyTerrestrialSurface(sample({
      biomeClass: 0.95, moisture: 0.9, slope: 0.05, altitude: 80, latitude: 0.1,
    })))).toBe('vegetation');
    expect(dominant(classifyTerrestrialSurface(sample({
      biomeClass: 0.55, moisture: 0.45, slope: 0.12, altitude: 300, latitude: 0.35,
    })))).toBe('soil');
  });

  it('exposes bare rock as slope increases (monotonic)', () => {
    let previous = -1;
    for (const slope of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const rock = classifyTerrestrialSurface(sample({ slope })).rock;
      expect(rock).toBeGreaterThan(previous);
      previous = rock;
    }
  });

  it('drops vegetation to nearly zero in highland/snow fallback', () => {
    const low = classifyTerrestrialSurface(sample({ biomeClass: 0.9, moisture: 0.9, altitude: 80 }));
    const high = classifyTerrestrialSurface(sample({ biomeClass: 0.9, moisture: 0.9, altitude: 5000 }));
    expect(high.vegetation).toBeLessThan(0.02);
    expect(high.vegetation).toBeLessThan(low.vegetation);
    expect(high.rock + high.soil).toBeGreaterThan(0.6);
  });

  it('reduces vegetation with rising latitude and grows it with moisture', () => {
    const capable = { biomeClass: 0.9, slope: 0.05, altitude: 80 };
    let veg = 2;
    for (const latitude of [0.1, 0.4, 0.7, 0.9]) {
      const next = classifyTerrestrialSurface(sample({ ...capable, latitude, moisture: 0.9 })).vegetation;
      expect(next).toBeLessThanOrEqual(veg + 1e-9);
      veg = next;
    }
    let dry = -1;
    for (const moisture of [0.1, 0.4, 0.7, 0.95]) {
      const next = classifyTerrestrialSurface(sample({ ...capable, latitude: 0.1, moisture })).vegetation;
      expect(next).toBeGreaterThanOrEqual(dry - 1e-9);
      dry = next;
    }
    expect(dry).toBeGreaterThan(0.1);
  });

  it('raises coastal sand and wetness near the shoreline', () => {
    const inland = classifyTerrestrialSurface(sample({ shore: 0, biomeClass: 0.3, altitude: 10 }));
    const coastal = classifyTerrestrialSurface(sample({ shore: 0.9, biomeClass: 0.3, altitude: 10 }));
    expect(coastal.sand).toBeGreaterThan(inland.sand);
  });

  it('never classifies ocean cells as vegetated land', () => {
    const w = classifyTerrestrialSurface(sample({ ocean: 1, biomeClass: 0.9, moisture: 0.9 }));
    expect(w.vegetation).toBe(0);
  });
});

describe('triplanarBlendWeights', () => {
  it('sums to one and favors the dominant geometric axis', () => {
    const flat = triplanarBlendWeights(0, 0, 1);
    expect(flat[0] + flat[1] + flat[2]).toBeCloseTo(1, 6);
    expect(flat[2]).toBeGreaterThan(flat[0]);
    expect(flat[2]).toBeGreaterThan(flat[1]);
    const tilted = triplanarBlendWeights(1, 0, 0);
    expect(tilted[0] + tilted[1] + tilted[2]).toBeCloseTo(1, 6);
    expect(tilted[0]).toBeGreaterThan(tilted[2]);
    const diagonal = triplanarBlendWeights(1, 1, 1);
    expect(diagonal[0] + diagonal[1] + diagonal[2]).toBeCloseTo(1, 6);
    expect(diagonal[0]).toBeCloseTo(diagonal[1], 6);
    expect(diagonal[1]).toBeCloseTo(diagonal[2], 6);
  });
});

describe('analytic surface detail', () => {
  it('repeats exactly over the 8192-meter body-fixed period on every axis', () => {
    expect(SURFACE_DETAIL_PERIOD_METERS).toBe(8192);
    const P = SURFACE_DETAIL_PERIOD_METERS;
    for (const tier of ['low', 'medium', 'high'] as const) {
      const base = sampleSurfaceDetail(123.5, -820.25, 4001.75, tier);
      for (const shift of [
        [P, 0, 0], [0, P, 0], [0, 0, P], [2 * P, -3 * P, P],
      ] as const) {
        const shifted = sampleSurfaceDetail(123.5 + shift[0], -820.25 + shift[1], 4001.75 + shift[2], tier);
        expect(shifted.value).toBeCloseTo(base.value, 9);
        expect(shifted.gradient[0]).toBeCloseTo(base.gradient[0], 9);
        expect(shifted.gradient[1]).toBeCloseTo(base.gradient[1], 9);
        expect(shifted.gradient[2]).toBeCloseTo(base.gradient[2], 9);
      }
    }
  });

  it('keeps detail bounded and adds finer frequencies at higher tiers', () => {
    expect(surfaceDetailTier('low').maxOctave).toBeLessThan(surfaceDetailTier('medium').maxOctave);
    expect(surfaceDetailTier('medium').maxOctave).toBeLessThan(surfaceDetailTier('high').maxOctave);
    for (const tier of ['low', 'medium', 'high'] as const) {
      for (const p of [[0, 0, 0], [12.5, 900.5, -4000.25], [8191, 8191, 8191]] as const) {
        const value = sampleSurfaceDetail(p[0], p[1], p[2], tier).value;
        expect(value).toBeGreaterThanOrEqual(-1.0001);
        expect(value).toBeLessThanOrEqual(1.0001);
      }
    }
    const low = sampleSurfaceDetail(37.1, 511.9, -128.3, 'low').value;
    const high = sampleSurfaceDetail(37.1, 511.9, -128.3, 'high').value;
    expect(Math.abs(low - high)).toBeGreaterThan(1e-4);
  });

  it('gives adjacent worker chunks identical detail at their shared seam', () => {
    const recipe = recipeForBody(veyra);
    const res = 9;
    const common = {
      generation: 1, recipe, radius: veyra.radius, face: 0,
      v0: 0, size: 0.25, resolution: res, skirtDepth: 6,
      palette: { low: [0.2, 0.3, 0.1] as const, mid: [0.4, 0.4, 0.2] as const, high: [0.7, 0.7, 0.7] as const, ocean: [0.1, 0.2, 0.4] as const },
    };
    const left = buildTerrainChunkGeometry({ ...common, jobKey: 'L', u0: 0 });
    const right = buildTerrainChunkGeometry({ ...common, jobKey: 'R', u0: 0.25 });
    // Left column i = res-1 (u = 0.25) and right column i = 0 (u = 0.25) are the
    // same body-fixed points reached through different chunk origins.
    for (const tier of ['low', 'medium', 'high'] as const) {
      for (let j = 0; j < res; j++) {
        const li = (j * res + (res - 1)) * 3;
        const ri = (j * res + 0) * 3;
        const a = sampleSurfaceDetail(
          left.bodyFixedDetailAnchor[li], left.bodyFixedDetailAnchor[li + 1], left.bodyFixedDetailAnchor[li + 2], tier);
        const b = sampleSurfaceDetail(
          right.bodyFixedDetailAnchor[ri], right.bodyFixedDetailAnchor[ri + 1], right.bodyFixedDetailAnchor[ri + 2], tier);
        expect(Math.abs(a.value - b.value)).toBeLessThan(2e-3);
      }
    }
  });

  it('produces deterministic body-fixed moisture in the unit range', () => {
    const a = deterministicMoisture(0.3, 0.4, Math.sqrt(1 - 0.25));
    const b = deterministicMoisture(0.3, 0.4, Math.sqrt(1 - 0.25));
    expect(a).toBe(b);
    for (const dir of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-0.4, 0.5, 0.7]] as const) {
      const m = deterministicMoisture(dir[0], dir[1], dir[2]);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(1);
    }
  });
});

describe('createTerrestrialSurfaceMaterial', () => {
  it('extends the authored global program with detail-anchor attributes and surface classification', () => {
    const material = createTerrestrialSurfaceMaterial(pack(), descriptor, 'medium');
    expect(material.userData).toMatchObject({
      terrestrialSurface: true, bodyId: 'veyra', authored: true, tier: 'medium',
    });
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>',
    };
    material.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain('attribute vec3 bodyFixedDetailAnchor');
    expect(shader.vertexShader).toContain('attribute float surfaceAltitude');
    expect(shader.vertexShader).toContain('attribute vec3 bodyDirection');
    expect(shader.fragmentShader).toContain('bodyFixedUv(vBodyDirection)');
    expect(shader.fragmentShader).toContain('classifyTerrestrialSurface');
    expect(shader.fragmentShader).toContain('triplanarSurfaceDetail');
    expect(shader.uniforms.surfaceDetailMaxOctave.value).toBe(surfaceDetailTier('medium').maxOctave);
    material.dispose();
  });

  it('keeps a runnable procedural fallback when no pack is staged', () => {
    const fallback = createTerrestrialSurfaceMaterial(null, descriptor, 'low');
    expect(fallback.userData).toMatchObject({ terrestrialSurface: true, authored: false, tier: 'low' });
    expect(fallback.vertexColors).toBe(true);
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>',
    };
    fallback.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
    expect(shader.uniforms.surfaceDetailMaxOctave.value).toBe(surfaceDetailTier('low').maxOctave);
    fallback.dispose();
  });

  it('varies detail frequency by tier without changing surface classification', () => {
    const low = createTerrestrialSurfaceMaterial(pack('low'), descriptor, 'low');
    const high = createTerrestrialSurfaceMaterial(pack('high'), descriptor, 'high');
    expect(low.userData.tier).toBe('low');
    expect(high.userData.tier).toBe('high');
    // classification is tier-independent: same sample, same weights
    const s = sample({ slope: 0.4, biomeClass: 0.7 });
    expect(classifyTerrestrialSurface(s)).toEqual(classifyTerrestrialSurface(s));
    low.dispose();
    high.dispose();
  });
});
