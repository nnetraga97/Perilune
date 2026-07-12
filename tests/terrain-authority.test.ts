import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import { GameState } from '../src/sim/state';
import {
  contactSurface,
  solidHeight,
  waterSurfaceHeight,
} from '../src/sim/terrain';
import { evaluateRecipeHeight, recipeForBody } from '../src/sim/terrainRecipe';
import { renderedTerrainHeight } from '../src/render/planet';
import {
  decodeOctNormal,
  directionFromEquirectUv,
  generateVeyraCanonicalMaps,
} from '../scripts/lib/veyra-global-maps';

function findDirection(predicate: (direction: Vec3) => boolean): Vec3 {
  for (let lat = -80; lat <= 80; lat += 5) {
    for (let lon = -180; lon < 180; lon += 5) {
      const phi = (lat * Math.PI) / 180;
      const theta = (lon * Math.PI) / 180;
      const direction = new Vec3(
        Math.cos(phi) * Math.cos(theta),
        Math.cos(phi) * Math.sin(theta),
        Math.sin(phi),
      );
      if (predicate(direction)) return direction;
    }
  }
  throw new Error('No matching deterministic terrain sample');
}

describe('planet surface authority', () => {
  it('derives deterministic Veyra masks and normals from the shared height evaluator', () => {
    const veyra = new GameState().universe.get('veyra');
    const source = new Uint8Array(32 * 16 * 3);
    for (let index = 0; index < source.length; index++) source[index] = (index * 17) & 0xff;
    const generate = () => generateVeyraCanonicalMaps({
      width: 32,
      height: 16,
      source: { data: source, width: 32, height: 16, channels: 3 },
      radius: veyra.radius,
      heightAt: (direction) => {
        const result = solidHeight(veyra, direction);
        if (result.kind !== 'solid') throw new Error('expected solid Veyra terrain');
        return result.height;
      },
      seed: veyra.def.terrain.seed,
    });

    const first = generate();
    const second = generate();
    expect(first.rawHashes).toEqual(second.rawHashes);
    expect(first.material).toEqual(second.material);
    expect(first.normal).toEqual(second.normal);

    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 32; x++) {
        const pixel = y * 32 + x;
        const direction = directionFromEquirectUv((x + 0.5) / 32, (y + 0.5) / 16);
        const result = solidHeight(veyra, direction);
        if (result.kind !== 'solid') throw new Error('expected solid Veyra terrain');
        if (Math.abs(result.height) > first.texelHeightRange) {
          expect(first.material[pixel * 4 + 3] === 255).toBe(result.height < 0);
        }
        const normal = decodeOctNormal(first.normal[pixel * 2], first.normal[pixel * 2 + 1]);
        expect(normal.x * direction.x + normal.y * direction.y + normal.z * direction.z)
          .toBeGreaterThan(0.9);
      }
    }
  });

  it('keeps body-fixed longitude seams and exact poles continuous', () => {
    expect(directionFromEquirectUv(0, 0.5)).toEqual(directionFromEquirectUv(1, 0.5));
    expect(directionFromEquirectUv(0.1, 0)).toEqual(directionFromEquirectUv(0.9, 0));
    expect(directionFromEquirectUv(0.1, 1)).toEqual(directionFromEquirectUv(0.9, 1));
  });

  it('matches authoritative shoreline signs and finite-difference normals across 10,000 seeded samples', () => {
    const width = 144;
    const height = 72;
    const veyra = new GameState().universe.get('veyra');
    const source = new Uint8Array(width * height * 3);
    for (let index = 0; index < source.length; index++) source[index] = (index * 29 + 17) & 0xff;
    const heightAt = (direction: Readonly<Vec3>): number => {
      const result = solidHeight(veyra, direction);
      if (result.kind !== 'solid') throw new Error('expected solid Veyra terrain');
      return result.height;
    };
    const maps = generateVeyraCanonicalMaps({
      width,
      height,
      source: { data: source, width, height, channels: 3 },
      radius: veyra.radius,
      heightAt,
      seed: veyra.def.terrain.seed,
    });
    const eastPosition = new Vec3();
    const westPosition = new Vec3();
    const northPosition = new Vec3();
    const southPosition = new Vec3();
    const tangentU = new Vec3();
    const tangentV = new Vec3();
    const expectedNormal = new Vec3();
    const minimumAgreement = Math.cos((2 * Math.PI) / 180);

    for (let y = 0; y < height; y++) {
      const northY = Math.max(0, y - 1);
      const southY = Math.min(height - 1, y + 1);
      for (let x = 0; x < width; x++) {
        const pixel = y * width + x;
        const direction = directionFromEquirectUv((x + 0.5) / width, (y + 0.5) / height);
        const authoritativeHeight = heightAt(direction);
        if (Math.abs(authoritativeHeight) > maps.texelHeightRange) {
          expect(maps.material[pixel * 4 + 3] === 255).toBe(authoritativeHeight < 0);
        }

        const eastDirection = directionFromEquirectUv((x + 1.5) / width, (y + 0.5) / height);
        const westDirection = directionFromEquirectUv((x - 0.5) / width, (y + 0.5) / height);
        const northDirection = directionFromEquirectUv((x + 0.5) / width, (northY + 0.5) / height);
        const southDirection = directionFromEquirectUv((x + 0.5) / width, (southY + 0.5) / height);
        eastPosition.copy(eastDirection).scale(veyra.radius + heightAt(eastDirection));
        westPosition.copy(westDirection).scale(veyra.radius + heightAt(westDirection));
        northPosition.copy(northDirection).scale(veyra.radius + heightAt(northDirection));
        southPosition.copy(southDirection).scale(veyra.radius + heightAt(southDirection));
        tangentU.copy(eastPosition).sub(westPosition);
        tangentV.copy(southPosition).sub(northPosition);
        Vec3.cross(tangentV, tangentU, expectedNormal).normalize();
        if (expectedNormal.dot(direction) < 0) expectedNormal.negate();

        const decoded = decodeOctNormal(maps.normal[pixel * 2], maps.normal[pixel * 2 + 1]);
        expect(decoded.dot(expectedNormal)).toBeGreaterThanOrEqual(minimumAgreement);
      }
    }
  });

  it('returns raw seafloor separately from water contact', () => {
    const veyra = new GameState().universe.get('veyra');
    const ocean = findDirection((direction) => {
      const surface = solidHeight(veyra, direction);
      return surface.kind === 'solid' && surface.height < 0;
    });

    const solid = solidHeight(veyra, ocean);
    expect(solid.kind).toBe('solid');
    if (solid.kind !== 'solid') throw new Error('Expected solid seafloor');
    expect(solid.height).toBeLessThan(0);
    expect(waterSurfaceHeight(veyra, ocean)).toEqual({ kind: 'water', height: 0 });
    expect(contactSurface(veyra, ocean)).toEqual({ kind: 'water', height: 0 });
    expect(renderedTerrainHeight(solid.height, true)).toBe(solid.height);
  });

  it('uses the same versioned recipe evaluator as the public solid query', () => {
    const game = new GameState();
    for (const body of game.universe.bodies.values()) {
      const recipe = recipeForBody(body);
      expect(recipe.version).toBe(1);
      expect(recipe.hash).toMatch(/^[a-f0-9]{32}$/);
      const direction = new Vec3(0.3, -0.4, 0.8660254).normalize();
      const surface = solidHeight(body, direction);
      if (body.def.surfaceKind === 'solid') {
        expect(surface).toEqual({ kind: 'solid', height: evaluateRecipeHeight(recipe, direction) });
      } else {
        expect(surface).toEqual({ kind: 'none' });
      }
    }
  });

  it('returns a typed no-surface result for Tyran and Auren', () => {
    const game = new GameState();
    for (const id of ['tyran', 'auren']) {
      const body = game.universe.get(id);
      expect(solidHeight(body, new Vec3(1, 0, 0))).toEqual({ kind: 'none' });
      expect(contactSurface(body, new Vec3(1, 0, 0))).toEqual({ kind: 'none' });
    }
  });
});
