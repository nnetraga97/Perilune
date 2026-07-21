import * as THREE from 'three';
import type { BodyRendererKind } from '../content/bodyVisuals';
import type { SurfaceKind } from '../sim/universe';
import { SPACE_BACKGROUND } from './spaceBackground';

export interface EnvironmentLighting {
  readonly sky: THREE.Color;
  readonly ground: THREE.Color;
  readonly intensity: number;
  readonly background: THREE.Color;
  readonly exposure: number;
}

export interface MutableEnvironmentLighting {
  sky: THREE.Color;
  ground: THREE.Color;
  intensity: number;
  background: THREE.Color;
  exposure: number;
}

export interface LandingVisibilityAid {
  readonly intensity: number;
  readonly distance: number;
}

const ATMOSPHERE_SKY_NIGHT = new THREE.Color(0.08, 0.19, 0.42);
const ATMOSPHERE_SKY_DAY = new THREE.Color(0.34, 0.58, 0.9);
const ATMOSPHERE_GROUND_NIGHT = new THREE.Color(0.015, 0.02, 0.025);
const ATMOSPHERE_GROUND_DAY = new THREE.Color(0.18, 0.2, 0.16);

export function createEnvironmentLightingState(): MutableEnvironmentLighting {
  return {
    sky: new THREE.Color(),
    ground: new THREE.Color(),
    intensity: 0,
    background: new THREE.Color(),
    exposure: 1,
  };
}

/** Shared display anchor for orbital, atmospheric, and airless views. */
export function environmentLighting(
  rendererKind: BodyRendererKind | undefined,
  atmosphereHeight: number,
  altitude: number,
  dayness: number,
  solarVisibleFraction: number,
  sunInFrame: boolean,
  out: MutableEnvironmentLighting = createEnvironmentLightingState(),
): EnvironmentLighting {
  const daylight = THREE.MathUtils.clamp(dayness, 0, 1)
    * THREE.MathUtils.clamp(solarVisibleFraction, 0, 1);
  // The clear color is continuous across bodies and altitudes. Atmosphere
  // shells provide the local sky/limb color instead of tinting all of space.
  out.background.set(SPACE_BACKGROUND);
  if (rendererKind === 'terrestrial' && atmosphereHeight > 0) {
    const atmosphereDepth = THREE.MathUtils.clamp(1 - altitude / atmosphereHeight, 0, 1);
    const horizonFill = Math.sqrt(daylight) * atmosphereDepth;
    const nightFill = 0.025 * atmosphereDepth;
    out.sky.copy(ATMOSPHERE_SKY_NIGHT).lerp(ATMOSPHERE_SKY_DAY, horizonFill);
    out.ground.copy(ATMOSPHERE_GROUND_NIGHT).lerp(ATMOSPHERE_GROUND_DAY, horizonFill);
    out.intensity = 0.025 + 0.5 * horizonFill + nightFill;
    out.exposure = sunInFrame ? 0.68 : 0.92 + 0.28 * (1 - daylight);
    return out;
  }
  if (rendererKind === 'airless') {
    out.sky.set('#080a0d'); out.ground.set('#010101'); out.intensity = 0.025;
    out.exposure = sunInFrame ? 0.68 : 1.22;
    return out;
  }
  out.sky.set('#0b1016'); out.ground.set('#020304'); out.intensity = 0.045;
  out.exposure = sunInFrame ? 0.68 : 1.05;
  return out;
}

/**
 * Local terrain readability for terminal approaches on the unlit side of a
 * solid body. This is deliberately altitude- and darkness-gated so orbital
 * views retain a genuinely black night hemisphere.
 */
export function landingVisibilityAid(
  surfaceKind: SurfaceKind,
  altitude: number,
  surfaceSunCosine: number,
  solarVisibleFraction: number,
): LandingVisibilityAid {
  if (surfaceKind !== 'solid') return { intensity: 0, distance: 0 };
  const daylight = THREE.MathUtils.clamp(surfaceSunCosine, 0, 1)
    * THREE.MathUtils.clamp(solarVisibleFraction, 0, 1);
  const darkness = 1 - THREE.MathUtils.smoothstep(daylight, 0.015, 0.18);
  const height = Math.max(0, altitude);
  const approach = 1 - THREE.MathUtils.smoothstep(height, 40_000, 150_000);
  const intensity = 2.2 * darkness * approach;
  return {
    intensity,
    distance: intensity > 0
      ? THREE.MathUtils.clamp(height * 1.6 + 30_000, 30_000, 260_000)
      : 0,
  };
}

/** Wall-clock exponential adaptation with bounded photographic exposure. */
export function adaptExposure(current: number, target: number, wallDeltaSeconds: number): number {
  if (!(wallDeltaSeconds > 0)) return current;
  const boundedTarget = THREE.MathUtils.clamp(target, 0.6, 1.35);
  const rate = boundedTarget < current ? 4.5 : 1.4;
  return THREE.MathUtils.lerp(current, boundedTarget, 1 - Math.exp(-rate * Math.min(wallDeltaSeconds, 0.1)));
}
