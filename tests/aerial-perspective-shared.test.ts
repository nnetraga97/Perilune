import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SOL_SYSTEM } from '../src/content/system';
import { Body } from '../src/sim/universe';
import { bodyMaterialDescriptor } from '../src/render/bodyMaterial';
import {
  createTerrestrialAerialPerspectiveState,
  evaluateTerrestrialAerialPerspective,
  terrestrialAerialPerspectiveState,
  updateTerrestrialAerialPerspective,
} from '../src/render/terrestrial/aerialPerspective';
import { createTerrestrialGlobalMaterial } from '../src/render/terrestrial/globalMaterial';
import { createTerrestrialSurfaceMaterial } from '../src/render/terrestrial/surfaceMaterial';
import { TerrestrialOcean } from '../src/render/terrestrial/ocean';

function earth(): Body {
  return new Body(structuredClone(SOL_SYSTEM.find((body) => body.id === 'earth')!), null);
}

function shaderSource(): {
  uniforms: Record<string, { value: unknown }>;
  vertexShader: string;
  fragmentShader: string;
} {
  return {
    uniforms: {},
    vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>',
    fragmentShader: '#include <common>\n#include <map_fragment>\n#include <emissivemap_fragment>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>\n#include <opaque_fragment>',
  };
}

describe('shared terrestrial aerial perspective', () => {
  it('owns independent state per consumer material', () => {
    const first = createTerrestrialAerialPerspectiveState('first', 10);
    const second = createTerrestrialAerialPerspectiveState('second', 20);
    first.cameraBodyFixed.value.set(1, 2, 3);
    first.lookup.value = new THREE.Texture();
    expect(second.cameraBodyFixed.value.toArray()).toEqual([0, 0, 0]);
    expect(second.lookup.value).toBeNull();
    expect(second.bodyRadius.value).toBe(20);
  });

  it('is a strict no-op without atmosphere', () => {
    const base = [0.1, 0.3, 0.7] as const;
    const result = evaluateTerrestrialAerialPerspective({
      shadedPointBodyFixed: { x: 10, y: 0, z: 0 },
      baseColor: base,
      cameraBodyFixed: { x: 12, y: 0, z: 0 },
      bodyRadius: 10,
      atmosphereHeight: 0,
      scaleHeight: 1,
      sunDirection: { x: 1, y: 0, z: 0 },
      solarVisibleFraction: 1,
    });
    expect(result).toEqual({ color: base, amount: 0, airPath: 0 });
  });

  it('reduces long-path contrast while adding more in-scatter', () => {
    const bodyRadius = 6_378_137;
    const point = { x: bodyRadius, y: 0, z: 0 };
    const common = {
      shadedPointBodyFixed: point,
      bodyRadius,
      atmosphereHeight: 100_000,
      scaleHeight: 8_500,
      sunDirection: { x: 1, y: 0, z: 0 },
      solarVisibleFraction: 1,
    } as const;
    const nearCamera = { x: bodyRadius + 20, y: 0, z: 0 };
    const farCamera = { x: bodyRadius + 20, y: 50_000, z: 0 };
    const nearBlack = evaluateTerrestrialAerialPerspective({
      ...common, cameraBodyFixed: nearCamera, baseColor: [0, 0, 0],
    });
    const farBlack = evaluateTerrestrialAerialPerspective({
      ...common, cameraBodyFixed: farCamera, baseColor: [0, 0, 0],
    });
    const nearWhite = evaluateTerrestrialAerialPerspective({
      ...common, cameraBodyFixed: nearCamera, baseColor: [1, 1, 1],
    });
    const farWhite = evaluateTerrestrialAerialPerspective({
      ...common, cameraBodyFixed: farCamera, baseColor: [1, 1, 1],
    });
    const contrast = (white: readonly number[], black: readonly number[]) => (
      white.reduce((sum, channel, index) => sum + Math.abs(channel - black[index]), 0)
    );
    expect(farBlack.amount).toBeGreaterThan(nearBlack.amount);
    expect(farBlack.color[2]).toBeGreaterThan(nearBlack.color[2]);
    expect(contrast(farWhite.color, farBlack.color))
      .toBeLessThan(contrast(nearWhite.color, nearBlack.color));
  });

  it('updates ocean camera and LUT state instead of only declaring uniforms', () => {
    const body = earth();
    const ocean = new TerrestrialOcean(body, 'medium', null);
    const lookup = new THREE.DataTexture(new Uint8Array([1, 2, 3, 4]), 1, 1, THREE.RGBAFormat);
    const baseFrame = {
      cameraRelativeOrigin: { x: 0, y: 0, z: 0 },
      cameraBodyFixed: { x: body.radius + 25, y: 0, z: 0 },
      bodySunDirection: { x: 1, y: 0, z: 0 },
      solarVisibleFraction: 0.7,
      time: 0,
      orientation: { x: 0, y: 0, z: 0, w: 1 },
    };
    ocean.update(baseFrame, lookup);
    const state = terrestrialAerialPerspectiveState(ocean.material)!;
    expect(state.consumer).toBe('ocean');
    expect(state.cameraBodyFixed.value.toArray()).toEqual([body.radius + 25, 0, 0]);
    expect(state.lookup.value).toBe(lookup);
    expect(state.useLookup.value).toBe(1);
    ocean.update({
      ...baseFrame,
      cameraBodyFixed: { x: 0, y: body.radius + 1_000, z: 0 },
      solarVisibleFraction: 0.2,
    });
    expect(state.cameraBodyFixed.value.toArray()).toEqual([0, body.radius + 1_000, 0]);
    expect(state.lookup.value).toBeNull();
    expect(state.useLookup.value).toBe(0);
    expect(state.solarVisibleFraction.value).toBe(0.2);
    ocean.dispose();
  });

  it('binds the same explicit-point GLSL function to compact land, terrain, and ocean', () => {
    const body = earth();
    const descriptor = bodyMaterialDescriptor(body);
    const compact = createTerrestrialGlobalMaterial(null, descriptor, 1, body.radius);
    const surface = createTerrestrialSurfaceMaterial(null, descriptor, 'medium');
    const compactShader = shaderSource();
    const surfaceShader = shaderSource();
    compact.onBeforeCompile(compactShader as never, {} as THREE.WebGLRenderer);
    surface.onBeforeCompile(surfaceShader as never, {} as THREE.WebGLRenderer);
    expect(compactShader.fragmentShader).toContain('applyTerrestrialAerialPerspective(vec3 shadedPointBodyFixed');
    expect(compactShader.fragmentShader).toContain('terrestrialAerialBodyRadius + vGlobalSurfaceAltitude');
    expect(surfaceShader.fragmentShader).toContain('applyTerrestrialAerialPerspective(vec3 shadedPointBodyFixed');
    expect(surfaceShader.fragmentShader).toContain('terrestrialAerialBodyRadius + vGlobalSurfaceAltitude');
    const ocean = new TerrestrialOcean(body, 'medium', null);
    expect(ocean.material.fragmentShader).toContain('normalize(vBodyDirection) * uBodyRadius');
    expect(compact.customProgramCacheKey()).toContain('terrestrial-global-v3');
    expect(surface.customProgramCacheKey()).toContain('terrestrial-surface-v3');
    expect(ocean.material.customProgramCacheKey()).toContain('terrestrial-ocean-v3');
    compact.dispose();
    surface.dispose();
    ocean.dispose();
  });

  it('updates any attached material through the stable userData state', () => {
    const body = earth();
    const material = createTerrestrialGlobalMaterial(null, bodyMaterialDescriptor(body));
    const lookup = new THREE.Texture();
    updateTerrestrialAerialPerspective(material, body, {
      cameraBodyFixed: { x: body.radius + 10, y: 2, z: 3 },
      bodySunDirection: { x: 0, y: 2, z: 0 },
      solarVisibleFraction: 0.4,
    }, lookup);
    const state = terrestrialAerialPerspectiveState(material)!;
    expect(state.cameraBodyFixed.value.toArray()).toEqual([body.radius + 10, 2, 3]);
    expect(state.sunDirection.value.toArray()).toEqual([0, 1, 0]);
    expect(state.atmosphereHeight.value).toBe(100_000);
    expect(state.lookup.value).toBe(lookup);
    material.dispose();
  });
});
