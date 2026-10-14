import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SOL_SYSTEM } from '../src/content/system';
import { BODY_VISUALS } from '../src/content/bodyVisuals';
import { Body, Universe } from '../src/sim/universe';
import { bodyMaterialDescriptor } from '../src/render/bodyMaterial';
import type { BodyRenderFrame } from '../src/render/bodyRenderer';
import type { RenderCaps } from '../src/render/context';
import {
  applyAtmosphereScatteringProfile,
  atmosphereSunTransmittance,
  createAtmosphereScatteringState,
  integrateAtmosphere,
} from '../src/render/atmosphereScattering';
import { terrestrialScatteringProfile } from '../src/render/terrestrial/atmosphereLuts';
import { createAtmosphereLuts } from '../src/render/terrestrial/atmosphereLuts';
import { CompactPlanetBodyRenderer } from '../src/render/compactPlanetBodyRenderer';
import { SolarBodyRenderer } from '../src/render/solarBodyRenderer';
import { TerrestrialCloudDeck, WEATHER_CLOUD_DRIFT_RATE } from '../src/render/terrestrial/cloudLayer';

const earth = new Body(structuredClone(SOL_SYSTEM.find((body) => body.id === 'earth')!), null);
const earthAtmosphere = earth.def.atmosphere!;
const profile = terrestrialScatteringProfile(
  earth.radius,
  earthAtmosphere,
  BODY_VISUALS.earth.atmosphereVisual!,
);
const topRadius = 1 + earthAtmosphere.height / earth.radius;

const caps: RenderCaps = {
  backend: 'webgl2',
  fragmentHighp: { precision: 23, rangeMin: 127, rangeMax: 127 },
  atmospherePath: 'analytic',
  compressedTextures: { astc: false, etc2: true, etc1: false, s3tc: false, bptc: false, pvrtc: false },
  maxTextureSize: 8192,
  maxAnisotropy: 8,
  drawingBufferSamples: 4,
};

/** Ray from a ground-relative altitude looking at an elevation angle (degrees). */
function skyRay(altitude: number, elevationDegrees: number, sunElevationDegrees: number) {
  const origin: [number, number, number] = [0, 0, 1 + altitude / earth.radius];
  const elevation = THREE.MathUtils.degToRad(elevationDegrees);
  const direction: [number, number, number] = [Math.cos(elevation), 0, Math.sin(elevation)];
  const sunElevation = THREE.MathUtils.degToRad(sunElevationDegrees);
  const sun: [number, number, number] = [Math.cos(sunElevation), 0, Math.sin(sunElevation)];
  const b = origin[2] * direction[2];
  const c = origin[2] ** 2 - topRadius ** 2;
  const tEnd = -b + Math.sqrt(b * b - c);
  return integrateAtmosphere(profile, origin, direction, 0, tEnd, sun, 16);
}

describe('shared atmosphere scattering', () => {
  it('transmits most noon sunlight and reddens it toward the horizon', () => {
    const noon = atmosphereSunTransmittance(profile, 0, 1);
    expect(noon[0]).toBeGreaterThan(0.85);
    expect(noon[2]).toBeGreaterThan(0.6);
    expect(noon[2]).toBeLessThan(noon[0]);
    const lowSun = atmosphereSunTransmittance(profile, 0, Math.sin(THREE.MathUtils.degToRad(4)));
    expect(lowSun[0] / lowSun[2]).toBeGreaterThan(5);
  });

  it('casts the planet shadow: no direct sunlight after sunset at the surface', () => {
    const night = atmosphereSunTransmittance(profile, 0, -0.2);
    expect(Math.max(...night)).toBe(0);
    // A cloud top at 10 km still catches sunlight just past the ground terminator.
    const cloudTop = atmosphereSunTransmittance(profile, 10_000, -0.03);
    expect(cloudTop[0]).toBeGreaterThan(0);
  });

  it('produces a blue daytime sky and no sky light at night', () => {
    const zenith = skyRay(0, 90, 45);
    expect(zenith.inscatter[2]).toBeGreaterThan(zenith.inscatter[1]);
    expect(zenith.inscatter[1]).toBeGreaterThan(zenith.inscatter[0]);
    const horizon = skyRay(0, 2, 45);
    // Long horizon paths whiten: the red/blue ratio rises toward the horizon.
    expect(horizon.inscatter[0] / horizon.inscatter[2]).toBeGreaterThan(zenith.inscatter[0] / zenith.inscatter[2]);
    const night = skyRay(0, 30, -30);
    expect(Math.max(...night.inscatter)).toBeLessThan(1e-4);
  });

  it('keeps physical Rayleigh colour instead of the full art-direction tint', () => {
    const ratio = profile.rayleigh[0] / profile.rayleigh[2];
    // Earth reference red/blue Rayleigh ratio is ~0.175; a full tint would be ~0.063.
    expect(ratio).toBeGreaterThan(0.14);
    expect(ratio).toBeLessThan(0.2);
  });

  it('normalizes coefficients by body radius for float32 orbital precision', () => {
    const state = createAtmosphereScatteringState();
    applyAtmosphereScatteringProfile(state, profile);
    expect(state.topRadius.value).toBeCloseTo(topRadius, 10);
    expect(state.rayleighScaleHeight.value).toBeCloseTo(earthAtmosphere.scaleHeight / earth.radius, 12);
    expect(state.rayleigh.value.z).toBeCloseTo(profile.rayleigh[2] * earth.radius, 6);
    expect(() => applyAtmosphereScatteringProfile(state, { ...profile, radius: 0 })).toThrow();
  });

  it('does not brighten legacy sky LUTs when the sun is below the horizon', () => {
    const luts = createAtmosphereLuts(earth.radius, earthAtmosphere, BODY_VISUALS.earth.atmosphereVisual!);
    const data = luts.multipleScattering.image.data as Uint8Array;
    const width = luts.multipleScattering.image.width;
    const height = luts.multipleScattering.image.height;
    const groundTexel = (row: number) => data[(row * width) * 4 + 2];
    // Row 0 is sun straight below, the last row is sun at zenith.
    expect(groundTexel(0)).toBe(0);
    expect(groundTexel(height - 1)).toBeGreaterThan(0);
    for (const texture of luts.textures) texture.dispose();
  });
});

describe('compact planet presentation', () => {
  const universe = new Universe([...SOL_SYSTEM], 'earth');

  function compact(id: 'mars' | 'mercury'): CompactPlanetBodyRenderer {
    const body = universe.get(id);
    return new CompactPlanetBodyRenderer(
      body,
      bodyMaterialDescriptor(body),
      BODY_VISUALS[id].compactPlanetVisual!,
      caps,
      'medium',
    );
  }

  it('draws a scattering shell only for bodies with an atmosphere', () => {
    const mars = compact('mars');
    const mercury = compact('mercury');
    expect(mars.root.getObjectByName('compact-planet-atmosphere:mars:physical')).toBeDefined();
    expect(mercury.root.getObjectByName('compact-planet-atmosphere:mercury:physical')).toBeUndefined();
    const marsSurface = mars.root.getObjectByName('compact-planet-surface:mars:physical') as THREE.Mesh;
    const mercurySurface = mercury.root.getObjectByName('compact-planet-surface:mercury:physical') as THREE.Mesh;
    expect((marsSurface.material as THREE.ShaderMaterial).userData.photometry).toBe('rocky');
    expect((mercurySurface.material as THREE.ShaderMaterial).userData.photometry).toBe('airless');
    mars.dispose();
    mercury.dispose();
  });

  it('applies tone mapping and output encoding like the standard materials', () => {
    const mars = compact('mars');
    for (const name of ['compact-planet-surface:mars:physical', 'compact-planet-atmosphere:mars:physical']) {
      const mesh = mars.root.getObjectByName(name) as THREE.Mesh;
      const shader = (mesh.material as THREE.ShaderMaterial).fragmentShader;
      expect(shader).toContain('#include <tonemapping_fragment>');
      expect(shader).toContain('#include <colorspace_fragment>');
    }
    mars.dispose();
  });
});

describe('solar glare', () => {
  function frame(overrides: Partial<BodyRenderFrame> = {}): BodyRenderFrame {
    return {
      cameraRelativeOrigin: { x: 149_597_870_700, y: 0, z: 0 },
      cameraBodyFixed: { x: 0, y: 0, z: 0 },
      cameraBodyFixedVelocity: { x: 0, y: 0, z: 0 },
      verticalFovRadians: Math.PI / 3,
      drawingBufferHeight: 1080,
      projection: {
        trueObserverDistance: 149_597_870_700,
        angularRadius: 0.00465047,
        projectedPixelRadius: 4.35,
        proxyDepth: 444_000_000,
        proxyRadius: 2_064_000,
        visibility: 'far-field',
      },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      cameraSunDirection: { x: 1, y: 0, z: 0 },
      bodySunDirection: { x: 1, y: 0, z: 0 },
      solarVisibleFraction: 1,
      time: 0,
      deltaSeconds: 1 / 60,
      framePressure: false,
      altitude: 0,
      allowFlightTerrain: false,
      ...overrides,
    };
  }

  it('keeps a pixel-sized glare for an unresolved sun and hides it when occulted', () => {
    const sun = new Body(structuredClone(SOL_SYSTEM.find((body) => body.id === 'sun')!), null);
    const solar = new SolarBodyRenderer(sun, bodyMaterialDescriptor(sun), caps, 'medium');
    solar.update(frame());
    const glare = solar.root.getObjectByName('solar-glare:sun')!;
    expect(glare.visible).toBe(true);
    // ~480 px of glare around a ~4 px disk.
    expect(glare.scale.x / 2_064_000).toBeGreaterThan(100);
    expect(solar.stats().solarRegionLuminance?.glare).toBeCloseTo(1);
    solar.update(frame({ solarVisibleFraction: 0 }));
    expect(glare.visible).toBe(false);
    solar.update(frame({ solarVisibleFraction: 0.25 }));
    expect(solar.stats().solarRegionLuminance?.glare).toBeCloseTo(0.125);
    solar.dispose();
  });
});

describe('cloud lighting frame', () => {
  it('shades clouds with the sun expressed in the drifting cloud frame', () => {
    const texture = new THREE.DataTexture(new Uint8Array([180, 210, 0, 255]), 1, 1, THREE.RGBAFormat);
    const deck = new TerrestrialCloudDeck(earth, 'medium', texture);
    const time = 50_000;
    deck.update({
      cameraRelativeOrigin: { x: 0, y: 0, z: 0 },
      cameraBodyFixed: { x: earth.radius + 400_000, y: 0, z: 0 },
      orientation: { x: 0, y: 0, z: 0, w: 1 },
      bodySunDirection: { x: 1, y: 0, z: 0 },
      time,
      altitude: 400_000,
    });
    const weather = deck.shells[0];
    const sunCloudFixed = weather.mesh.material.uniforms.uSunCloudFixed.value as THREE.Vector3;
    const driftAngle = time * WEATHER_CLOUD_DRIFT_RATE;
    expect(sunCloudFixed.x).toBeCloseTo(Math.cos(driftAngle), 6);
    expect(sunCloudFixed.y).toBeCloseTo(-Math.sin(driftAngle), 6);
    deck.dispose();
    texture.dispose();
  });
});
