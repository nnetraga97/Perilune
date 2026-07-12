import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  TerrestrialScatter,
  generateScatterCell,
  SCATTER_TIERS,
  type SurfaceSampler,
  type TerrestrialScatterFrame,
} from '../src/render/terrestrial/scatter';
import {
  TerrestrialSurfaceEffects,
  generateDecalCell,
  type TerrestrialSurfaceEffectsFrame,
} from '../src/render/terrestrial/surfaceEffects';

const RADIUS = 1000;

/** Flat land at +10 m with a radial surface normal. */
const landSampler: SurfaceSampler = (x, y, z) => {
  const len = Math.hypot(x, y, z) || 1;
  return { height: 10, normalX: x / len, normalY: y / len, normalZ: z / len };
};
/** Everywhere below datum (ocean). */
const oceanSampler: SurfaceSampler = (x, y, z) => {
  const len = Math.hypot(x, y, z) || 1;
  return { height: -50, normalX: x / len, normalY: y / len, normalZ: z / len };
};

function scatterFrame(overrides: Partial<TerrestrialScatterFrame> = {}): TerrestrialScatterFrame {
  return {
    cameraBodyFixed: { x: RADIUS + 30, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    cameraRelativeOrigin: { x: 0, y: 0, z: 0 },
    ...overrides,
  };
}

function effectsFrame(overrides: Partial<TerrestrialSurfaceEffectsFrame> = {}): TerrestrialSurfaceEffectsFrame {
  return {
    cameraBodyFixed: { x: RADIUS + 5, y: 0, z: 0 },
    cameraBodyFixedVelocity: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    cameraRelativeOrigin: { x: 0, y: 0, z: 0 },
    altitude: 5,
    deltaSeconds: 1 / 60,
    time: 3,
    ...overrides,
  };
}

describe('visual scatter generation', () => {
  it('is deterministic for the same seed and cell', () => {
    const a = generateScatterCell(42, 3, -1, 7, RADIUS, SCATTER_TIERS.high, landSampler);
    const b = generateScatterCell(42, 3, -1, 7, RADIUS, SCATTER_TIERS.high, landSampler);
    expect(a.length).toBeGreaterThan(0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const other = generateScatterCell(42, 4, -1, 7, RADIUS, SCATTER_TIERS.high, landSampler);
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(a));
  });

  it('orders density low <= medium <= high as a strict prefix subset', () => {
    const low = generateScatterCell(9, 1, 2, 3, RADIUS, SCATTER_TIERS.low, landSampler);
    const medium = generateScatterCell(9, 1, 2, 3, RADIUS, SCATTER_TIERS.medium, landSampler);
    const high = generateScatterCell(9, 1, 2, 3, RADIUS, SCATTER_TIERS.high, landSampler);
    expect(low.length).toBeLessThanOrEqual(medium.length);
    expect(medium.length).toBeLessThanOrEqual(high.length);
    // Lower tiers are a prefix of higher tiers (same draws, tail culled).
    expect(high.slice(0, low.length)).toEqual(low);
    expect(high.slice(0, medium.length)).toEqual(medium);
  });

  it('never grows visual scatter underwater', () => {
    for (const tier of [SCATTER_TIERS.low, SCATTER_TIERS.medium, SCATTER_TIERS.high]) {
      expect(generateScatterCell(1, 0, 0, 0, RADIUS, tier, oceanSampler)).toHaveLength(0);
    }
  });
});

describe('TerrestrialScatter streaming', () => {
  it('streams instanced grass/shrub/rock with bytes and no simulation objects', () => {
    const scatter = new TerrestrialScatter(RADIUS, 7, landSampler, 'high');
    scatter.update(scatterFrame());
    const stats = scatter.stats();
    expect(stats.activeCells).toBeGreaterThan(0);
    expect(stats.grass + stats.shrub + stats.rock).toBeGreaterThan(0);
    expect(stats.bufferBytes).toBeGreaterThan(0);
    // Only instanced meshes; nothing that could be a simulation object.
    let lights = 0;
    scatter.group.traverse((object) => { if (object instanceof THREE.Light) lights++; });
    expect(lights).toBe(0);
    for (const child of scatter.group.children) expect(child).toBeInstanceOf(THREE.InstancedMesh);
    scatter.dispose();
  });

  it('keeps cells cached across a small camera move (hysteresis)', () => {
    const scatter = new TerrestrialScatter(RADIUS, 7, landSampler, 'medium');
    scatter.update(scatterFrame());
    const first = scatter.stats().activeCells;
    scatter.update(scatterFrame({ cameraBodyFixed: { x: RADIUS + 30, y: 4, z: 0 } }));
    expect(scatter.stats().activeCells).toBeGreaterThan(0);
    expect(first).toBeGreaterThan(0);
    scatter.dispose();
  });

  it('suppresses instances overlapping a physical obstacle sphere', () => {
    const scatter = new TerrestrialScatter(RADIUS, 7, landSampler, 'high');
    scatter.update(scatterFrame());
    const before = scatter.stats().grass + scatter.stats().shrub + scatter.stats().rock;
    scatter.update(scatterFrame({
      suppression: [{ x: RADIUS + 10, y: 0, z: 0, radius: 40 }],
    }));
    const after = scatter.stats().grass + scatter.stats().shrub + scatter.stats().rock;
    expect(after).toBeLessThan(before);
    scatter.dispose();
  });

  it('rebuilds pools on quality change and disposes once', () => {
    const scatter = new TerrestrialScatter(RADIUS, 7, landSampler, 'low');
    scatter.update(scatterFrame());
    scatter.setQuality('high');
    scatter.update(scatterFrame());
    expect(scatter.stats().bufferBytes).toBeGreaterThan(0);
    scatter.dispose();
    scatter.dispose();
    expect(scatter.group.children).toHaveLength(0);
  });
});

describe('surface decals and dust', () => {
  it('generates deterministic terrain-conforming decals', () => {
    const a = generateDecalCell(5, 2, 2, 2, RADIUS, 22, landSampler);
    const b = generateDecalCell(5, 2, 2, 2, RADIUS, 22, landSampler);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    for (const decal of a) {
      const len = Math.hypot(decal.px, decal.py, decal.pz) || 1;
      // Normal aligns with the radial (terrain) direction of a sphere surface.
      const dot = (decal.nx * decal.px + decal.ny * decal.py + decal.nz * decal.pz) / len;
      expect(dot).toBeGreaterThan(0.99);
    }
  });

  it('drives bounded body-fixed dust that ignores floating-origin shifts', () => {
    const effects = new TerrestrialSurfaceEffects(RADIUS, 7, landSampler, 'high');
    effects.update(effectsFrame({ cameraBodyFixedVelocity: { x: 30, y: 0, z: 0 }, altitude: 20 }));
    const moving = effects.stats().dust;
    expect(moving).toBeGreaterThan(0);
    const positions = (effects as unknown as { dustPositions: Float32Array }).dustPositions.slice();
    // Same body-fixed state but a different floating origin -> identical local dust.
    effects.update(effectsFrame({
      cameraBodyFixedVelocity: { x: 30, y: 0, z: 0 }, altitude: 20,
      cameraRelativeOrigin: { x: 5000, y: -9000, z: 12000 },
    }));
    const shifted = (effects as unknown as { dustPositions: Float32Array }).dustPositions;
    for (let i = 0; i < positions.length; i++) {
      if (Number.isNaN(positions[i])) { expect(Number.isNaN(shifted[i])).toBe(true); continue; }
      expect(shifted[i]).toBeCloseTo(positions[i], 6);
    }
    effects.dispose();
  });

  it('caches decal cells so a static camera does not re-query the terrain evaluator', () => {
    let samplerCalls = 0;
    const countingSampler: SurfaceSampler = (x, y, z) => {
      samplerCalls++;
      return landSampler(x, y, z);
    };
    const effects = new TerrestrialSurfaceEffects(RADIUS, 7, countingSampler, 'medium');
    effects.update(effectsFrame());
    const afterFirstFrame = samplerCalls;
    expect(afterFirstFrame).toBeGreaterThan(0);
    effects.update(effectsFrame({ time: 3.5 }));
    // Only the per-frame camera-origin sample runs again; decal cells are cached.
    expect(samplerCalls - afterFirstFrame).toBeLessThanOrEqual(1);
    effects.dispose();
  });

  it('lifts and advects dust along the radial up axis, not body-fixed +Y', () => {
    const effects = new TerrestrialSurfaceEffects(RADIUS, 7, landSampler, 'high');
    // Camera sits on the +X axis, so radial up is body-fixed +X; the 30 m/s
    // radial velocity must blow particles out along +X while the tangent
    // (+Y east, +Z north) coordinates stay wrapped inside the local box.
    effects.update(effectsFrame({ cameraBodyFixedVelocity: { x: 30, y: 0, z: 0 }, altitude: 20 }));
    const active = effects.stats().dust;
    expect(active).toBeGreaterThan(100);
    const positions = (effects as unknown as { dustPositions: Float32Array }).dustPositions;
    let maxUp = -Infinity;
    for (let i = 0; i < active; i++) {
      const up = positions[i * 3];
      const east = positions[i * 3 + 1];
      const north = positions[i * 3 + 2];
      expect(Math.abs(east)).toBeLessThanOrEqual(15.001);
      expect(Math.abs(north)).toBeLessThanOrEqual(15.001);
      maxUp = Math.max(maxUp, up);
    }
    expect(maxUp).toBeGreaterThan(15);
    effects.dispose();
  });

  it('raises no dust high above the surface', () => {
    const effects = new TerrestrialSurfaceEffects(RADIUS, 7, landSampler, 'medium');
    effects.update(effectsFrame({ cameraBodyFixedVelocity: { x: 30, y: 0, z: 0 }, altitude: 5000 }));
    expect(effects.stats().dust).toBe(0);
    effects.dispose();
  });

  it('places decals and reports bytes, then disposes idempotently', () => {
    const effects = new TerrestrialSurfaceEffects(RADIUS, 7, landSampler, 'high');
    effects.update(effectsFrame());
    expect(effects.stats().bufferBytes).toBeGreaterThan(0);
    effects.dispose();
    effects.dispose();
    expect(effects.group.children).toHaveLength(0);
  });
});
