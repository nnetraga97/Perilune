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
