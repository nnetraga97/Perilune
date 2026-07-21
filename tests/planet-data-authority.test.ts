import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import { createBodySurfaceProvider } from '../src/render/terrain/surfaceProvider';
import {
  installPlanetDataAuthority,
  planetDataAuthorityForBody,
  preparePlanetDataAuthority,
  type FrozenPlanetDataAuthority,
} from '../src/sim/planetDataAuthority';
import { GameState } from '../src/sim/state';
import { solidHeight } from '../src/sim/terrain';
import { evaluateRecipeHeight, recipeForBody } from '../src/sim/terrainRecipe';

function direction(longitudeDegrees: number, latitudeDegrees: number): Vec3 {
  const longitude = longitudeDegrees * Math.PI / 180;
  const latitude = latitudeDegrees * Math.PI / 180;
  return new Vec3(
    Math.cos(latitude) * Math.cos(longitude),
    Math.cos(latitude) * Math.sin(longitude),
    Math.sin(latitude),
  );
}

describe('frozen planet data authority', () => {
  it('keeps parent preparation offline and tied to the checked body source', async () => {
    const earth = new GameState().universe.get('earth');
    const authority = await preparePlanetDataAuthority(earth, 'parent');
    expect(authority).toEqual(planetDataAuthorityForBody(earth));
    expect(authority.mode).toBe('resident-parent');
    expect(authority.coverage).toEqual([-180, -90, 180, 90]);
  });

  it('keys contact and worker recipes to one promoted generation and matches the parent edge', () => {
    const earth = new GameState().universe.get('earth');
    const parent = planetDataAuthorityForBody(earth);
    const parentRecipe = recipeForBody(earth, parent);
    const coverage = Object.freeze([130, -30, 131, -29] as const);
    const authority: FrozenPlanetDataAuthority = Object.freeze({
      bodyId: earth.id,
      datasetId: 'synthetic-bounded-height',
      version: 'test-v1',
      coverage,
      datum: parent.datum,
      generation: 'synthetic-bounded-height:test-v1:digest',
      terrainGeneration: 42,
      mode: 'promoted-region',
      region: Object.freeze({
        datasetId: 'synthetic-bounded-height',
        version: 'test-v1',
        digest: 'digest',
        coverage,
        verticalDatum: parent.datum,
        engineDatum: parent.datum,
        width: 2,
        height: 2,
        blendBandDegrees: 0.1,
        minimumHeightMeters: 100,
        maximumHeightMeters: 100,
        samples: new Float32Array([100, 100, 100, 100]),
      }),
    });
    installPlanetDataAuthority(earth, authority);
    const promotedRecipe = recipeForBody(earth, authority);
    const center = direction(130.5, -29.5);
    const edge = direction(130, -29.5);

    expect(promotedRecipe.hash).not.toBe(parentRecipe.hash);
    expect(promotedRecipe.authorityGeneration).toBe(authority.generation);
    expect(evaluateRecipeHeight(promotedRecipe, center)).toBeCloseTo(100, 6);
    expect(evaluateRecipeHeight(promotedRecipe, edge))
      .toBeCloseTo(evaluateRecipeHeight(parentRecipe, edge), 9);
    expect(solidHeight(earth, center)).toEqual({ kind: 'solid', height: 100 });

    const provider = createBodySurfaceProvider(earth, {
      generation: authority.terrainGeneration,
      gridResolution: 9,
      recipe: promotedRecipe,
    });
    expect(provider.generation).toBe(authority.terrainGeneration);
    expect(provider.buildSnapshot.recipe.hash).toBe(promotedRecipe.hash);
    expect(provider.buildSnapshot.recipe.sourceHeightRegion?.samples)
      .toBe(authority.region?.samples);
  });
});
