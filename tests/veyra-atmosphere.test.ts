import { createLegacyGameState } from './fixtures/legacyGameState';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { BODY_VISUALS } from '../src/content/bodyVisuals';
import { GameState } from '../src/sim/state';
import type { RenderCaps } from '../src/render/context';
import { TerrestrialAtmosphere } from '../src/render/terrestrial/atmosphere';
import { usesLegacyAtmosphereTint } from '../src/render/worldScene';

const universe = createLegacyGameState().universe;
const veyra = universe.get('veyra');
const visual = BODY_VISUALS.veyra.atmosphereVisual!;

function atmosphere(path: RenderCaps['atmospherePath']): TerrestrialAtmosphere {
  return new TerrestrialAtmosphere(veyra, { atmospherePath: path }, visual);
}

describe('Veyra atmosphere', () => {
  it.each(['analytic', 'lookup', 'limb-haze'] as const)(
    'selects only the probed %s path and preserves physical uniforms',
    (path) => {
      const layer = atmosphere(path);
      const physical = veyra.def.atmosphere!;
      expect(layer.path).toBe(path);
      expect(layer.material.userData.atmospherePath).toBe(path);
      expect(layer.material.defines).toMatchObject({
        ATMOSPHERE_ANALYTIC: path === 'analytic' ? 1 : 0,
        ATMOSPHERE_LOOKUP: path === 'lookup' ? 1 : 0,
        ATMOSPHERE_LIMB_HAZE: path === 'limb-haze' ? 1 : 0,
        ATMOSPHERE_LUT_SCATTERING: 1,
      });
      expect(layer.material.userData.atmosphereModel).toBe('hillaire-lut-foundation');
      expect(layer.material.userData.quality).toBe('medium');
      expect(layer.material.defines.ATMOSPHERE_VIEW_SAMPLES).toBe(
        path === 'analytic' ? 8 : path === 'lookup' ? 6 : 5,
      );
      expect(layer.material.uniforms.uAtmosphereHeight.value).toBe(physical.height);
      expect(layer.material.uniforms.uSeaLevelPressure.value).toBe(physical.seaLevelPressure);
      expect(layer.material.uniforms.uSeaLevelDensity.value).toBe(physical.seaLevelDensity);
      expect(layer.material.uniforms.uScaleHeight.value).toBe(physical.scaleHeight);
      layer.dispose();
    },
  );

  it('uses the exact physical top while opaque consumers own aerial perspective', () => {
    const layer = atmosphere('analytic');
    const physical = veyra.def.atmosphere!;
    expect(layer.shellRadius).toBe(veyra.radius + physical.height);
    expect(layer.mesh.scale.x).toBe(layer.shellRadius);
    expect(layer.material.side).toBe(THREE.FrontSide);

    layer.update({
      cameraRelativeOrigin: { x: 10, y: 20, z: 30 },
      cameraBodyFixed: { x: veyra.radius + 1_000, y: 0, z: 0 },
      bodySunDirection: { x: 0, y: 2, z: 0 },
    });
    expect(layer.mesh.position.toArray()).toEqual([10, 20, 30]);
    expect(layer.material.uniforms.uInsideAtmosphere.value).toBe(1);
    expect(layer.material.side).toBe(THREE.BackSide);
    expect(layer.material.uniforms.uAerialPerspective).toBeUndefined();
    expect((layer.material.uniforms.uSunDirection.value as THREE.Vector3).toArray()).toEqual([0, 1, 0]);

    layer.update({
      cameraRelativeOrigin: { x: 0, y: 0, z: 0 },
      cameraBodyFixed: { x: veyra.radius + physical.height + 1, y: 0, z: 0 },
      bodySunDirection: { x: 1, y: 0, z: 0 },
    });
    expect(layer.material.uniforms.uInsideAtmosphere.value).toBe(0);
    expect(layer.material.side).toBe(THREE.FrontSide);
    layer.dispose();
  });

  it('binds transmittance, scattering, sky-view, and aerial-perspective LUTs', () => {
    const layer = atmosphere('analytic');
    const transmittance = layer.material.uniforms.uTransmittanceLut.value as THREE.DataTexture;
    const multipleScattering = layer.material.uniforms.uMultipleScatteringLut.value as THREE.DataTexture;
    const skyView = layer.material.uniforms.uSkyViewLut.value as THREE.DataTexture;
    const aerial = layer.material.uniforms.uAerialPerspectiveLut.value as THREE.DataTexture;
    expect(transmittance.image).toMatchObject({ width: 128, height: 32 });
    expect(multipleScattering.image).toMatchObject({ width: 32, height: 32 });
    expect(skyView.image).toMatchObject({ width: 64, height: 32 });
    expect(aerial.image).toMatchObject({ width: 32, height: 32 });
    expect(transmittance.userData.atmosphereLut).toBe('transmittance');
    expect(multipleScattering.userData.atmosphereLut).toBe('multiple-scattering');
    expect(skyView.userData.atmosphereLut).toBe('sky-view');
    expect(aerial.userData.atmosphereLut).toBe('aerial-perspective');
    const transmittanceBytes = transmittance.image.data as Uint8Array;
    const upwardGroundOffset = ((32 - 1) * 128) * 4;
    const upwardTopOffset = ((32 - 1) * 128 + 127) * 4;
    expect(transmittanceBytes[upwardGroundOffset + 2]).toBeLessThan(transmittanceBytes[upwardGroundOffset]);
    expect(transmittanceBytes[upwardTopOffset + 2]).toBeGreaterThan(transmittanceBytes[upwardGroundOffset + 2]);
    expect(Array.from(multipleScattering.image.data as Uint8Array).some((value) => value > 0 && value < 255)).toBe(true);
    expect(layer.material.fragmentShader).toContain('atmosphereRaySphere');
    expect(layer.material.fragmentShader).toContain('sunTransmittance');
    expect(layer.material.fragmentShader).toContain('viewTransmittance');
    layer.dispose();
  });

  it('rejects airless bodies and declares terrestrial ownership over legacy tint', () => {
    expect(() => new TerrestrialAtmosphere(
      universe.get('palla'),
      { atmospherePath: 'limb-haze' },
      visual,
    )).toThrow(/no physical atmosphere/i);
    expect(usesLegacyAtmosphereTint('legacy')).toBe(true);
    expect(usesLegacyAtmosphereTint(undefined)).toBe(true);
    expect(usesLegacyAtmosphereTint('terrestrial')).toBe(false);
  });

  it('disposes geometry, material, and both atmosphere LUTs only once', () => {
    const layer = atmosphere('lookup');
    const geometryDispose = vi.spyOn(layer.mesh.geometry, 'dispose');
    const materialDispose = vi.spyOn(layer.mesh.material, 'dispose');
    const transmittance = layer.material.uniforms.uTransmittanceLut.value as THREE.DataTexture;
    const multipleScattering = layer.material.uniforms.uMultipleScatteringLut.value as THREE.DataTexture;
    const transmittanceDispose = vi.spyOn(transmittance, 'dispose');
    const multipleScatteringDispose = vi.spyOn(multipleScattering, 'dispose');
    layer.dispose();
    layer.dispose();
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(transmittanceDispose).toHaveBeenCalledOnce();
    expect(multipleScatteringDispose).toHaveBeenCalledOnce();
  });
});
