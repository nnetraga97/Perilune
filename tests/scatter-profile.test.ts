import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { SOL_SYSTEM } from '../src/content/system';
import { Body } from '../src/sim/universe';
import { recipeForBody } from '../src/sim/terrainRecipe';
import {
  createRecipeSurfaceSampler,
  EARTH_GEOLOGY_SCATTER_PROFILE,
  generateScatterCell,
  MOON_REGOLITH_SCATTER_PROFILE,
  SCATTER_TIERS,
  TerrestrialScatter,
  VEYRA_SCATTER_PROFILE,
  type SurfaceSampler,
} from '../src/render/terrestrial/scatter';
import { SurfaceClass } from '../src/render/terrestrial/surfaceClass';

const RADIUS = 600_000;
const flat = (height: number): SurfaceSampler => () => ({
  height, normalX: 1, normalY: 0, normalZ: 0,
});

function moon(): Body {
  return new Body(structuredClone(SOL_SYSTEM.find((body) => body.id === 'moon')!), null);
}

describe('surface scatter profiles', () => {
  it('preserves pinned Veyra class and transform output', () => {
    const result = generateScatterCell(
      42, 3, -1, 7, RADIUS, SCATTER_TIERS.high, flat(10), VEYRA_SCATTER_PROFILE,
    );
    expect(result.slice(0, 3).map((instance) => instance.cls)).toEqual(['rock', 'grass', 'grass']);
    expect(result[0]).toMatchObject({ cls: 'rock', nx: 1, ny: 0, nz: 0 });
    expect(result[0].px).toBeCloseTo(273_908.4113168269, 6);
    expect(result[0].scale).toBeCloseTo(1.2869782206339244, 12);
    expect(result[0].yaw).toBeCloseTo(0.6664020268173013, 12);
  });

  it('keeps quality density as a deterministic strict subset', () => {
    const args = [9, 1, 2, 3, RADIUS] as const;
    const low = generateScatterCell(...args, SCATTER_TIERS.low, flat(10), VEYRA_SCATTER_PROFILE);
    const medium = generateScatterCell(...args, SCATTER_TIERS.medium, flat(10), VEYRA_SCATTER_PROFILE);
    const high = generateScatterCell(...args, SCATTER_TIERS.high, flat(10), VEYRA_SCATTER_PROFILE);
    expect(medium.slice(0, low.length)).toEqual(low);
    expect(high.slice(0, medium.length)).toEqual(medium);
  });

  it('populates below-datum lunar basins without vegetation', () => {
    const result = generateScatterCell(
      7, 1, 2, 3, 1_737_400, SCATTER_TIERS.high, flat(-2_500), MOON_REGOLITH_SCATTER_PROFILE,
    );
    expect(result.length).toBeGreaterThan(0);
    for (const instance of result) expect(['boulder', 'clast']).toContain(instance.cls);
  });

  it('keeps Earth geology dry and neutral', () => {
    const args = [7, 1, 2, 3, 6_378_137, SCATTER_TIERS.high] as const;
    expect(generateScatterCell(
      ...args, flat(20), EARTH_GEOLOGY_SCATTER_PROFILE, () => SurfaceClass.EstuarineDeepwater,
    )).toHaveLength(0);
    const land = generateScatterCell(
      ...args, flat(-20), EARTH_GEOLOGY_SCATTER_PROFILE, () => SurfaceClass.Land,
    );
    expect(land.length).toBeGreaterThan(0);
    for (const instance of land) expect(['stone', 'clast']).toContain(instance.cls);
  });

  it('suppresses instances inside authored exclusion spheres', () => {
    const scatter = new TerrestrialScatter(
      6_378_137, 399, flat(20), 'medium', EARTH_GEOLOGY_SCATTER_PROFILE,
    );
    const frame = {
      cameraBodyFixed: { x: 6_378_157, y: 0, z: 0 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      cameraRelativeOrigin: { x: 0, y: 0, z: 0 },
    };
    scatter.update(frame);
    expect(scatter.stats().total).toBeGreaterThan(0);
    scatter.update({
      ...frame,
      suppression: [{ x: 6_378_157, y: 0, z: 0, radius: 1_000 }],
    });
    expect(scatter.stats().total).toBe(0);
    scatter.dispose();
  });

  it('returns finite unit normals at equatorial and polar directions', () => {
    const sampler = createRecipeSurfaceSampler(recipeForBody(moon()));
    for (const direction of [
      [1, 0, 0],
      [1e-9, 0, 1],
      [1e-9, 0, -1],
    ] as const) {
      const sample = sampler(direction[0], direction[1], direction[2]);
      expect(Number.isFinite(sample.height)).toBe(true);
      expect(Number.isFinite(sample.normalX)).toBe(true);
      expect(Number.isFinite(sample.normalY)).toBe(true);
      expect(Number.isFinite(sample.normalZ)).toBe(true);
      expect(Math.hypot(sample.normalX, sample.normalY, sample.normalZ)).toBeCloseTo(1, 10);
    }
  });

  it('applies shadow policy to every profile pool and disposes owned resources once', () => {
    const scatter = new TerrestrialScatter(
      1_737_400, 7, flat(-100), 'medium', MOON_REGOLITH_SCATTER_PROFILE,
    );
    scatter.setShadows(true);
    const materials: THREE.Material[] = [];
    const geometries: THREE.BufferGeometry[] = [];
    scatter.group.traverse((object) => {
      if (!(object instanceof THREE.InstancedMesh)) return;
      expect(object.castShadow).toBe(true);
      expect(object.receiveShadow).toBe(true);
      materials.push(object.material as THREE.Material);
      geometries.push(object.geometry);
    });
    const materialDisposals = materials.map((material) => vi.spyOn(material, 'dispose'));
    const geometryDisposals = geometries.map((geometry) => vi.spyOn(geometry, 'dispose'));
    scatter.dispose();
    scatter.dispose();
    for (const dispose of [...materialDisposals, ...geometryDisposals]) expect(dispose).toHaveBeenCalledTimes(1);
  });
});
