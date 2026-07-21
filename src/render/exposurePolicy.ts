import * as THREE from 'three';
import type { BodyRendererKind } from '../content/bodyVisuals';

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

const ATMOSPHERE_SKY_NIGHT = new THREE.Color(0.08, 0.19, 0.42);
const ATMOSPHERE_SKY_DAY = new THREE.Color(0.34, 0.58, 0.9);
const ATMOSPHERE_GROUND_NIGHT = new THREE.Color(0.015, 0.02, 0.025);
const ATMOSPHERE_GROUND_DAY = new THREE.Color(0.18, 0.2, 0.16);
const ATMOSPHERE_BACKGROUND_NIGHT = new THREE.Color(0.004, 0.008, 0.016);
const ATMOSPHERE_BACKGROUND_DAY = new THREE.Color(0.1, 0.27, 0.52);

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
  if (rendererKind === 'terrestrial' && atmosphereHeight > 0) {
    const atmosphereDepth = THREE.MathUtils.clamp(1 - altitude / atmosphereHeight, 0, 1);
    const horizonFill = Math.sqrt(daylight) * atmosphereDepth;
    const nightFill = 0.025 * atmosphereDepth;
    out.sky.copy(ATMOSPHERE_SKY_NIGHT).lerp(ATMOSPHERE_SKY_DAY, horizonFill);
    out.ground.copy(ATMOSPHERE_GROUND_NIGHT).lerp(ATMOSPHERE_GROUND_DAY, horizonFill);
    out.intensity = 0.025 + 0.5 * horizonFill + nightFill;
    out.background.copy(ATMOSPHERE_BACKGROUND_NIGHT).lerp(ATMOSPHERE_BACKGROUND_DAY, horizonFill);
    out.exposure = sunInFrame ? 0.68 : 0.92 + 0.28 * (1 - daylight);
    return out;
  }
  if (rendererKind === 'airless') {
    out.sky.set('#080a0d'); out.ground.set('#010101'); out.intensity = 0.025;
    out.background.set('#04070a'); out.exposure = sunInFrame ? 0.68 : 1.22;
    return out;
  }
  out.sky.set('#0b1016'); out.ground.set('#020304'); out.intensity = 0.045;
  out.background.set('#04070a'); out.exposure = sunInFrame ? 0.68 : 1.05;
  return out;
}

/** Wall-clock exponential adaptation with bounded photographic exposure. */
export function adaptExposure(current: number, target: number, wallDeltaSeconds: number): number {
  if (!(wallDeltaSeconds > 0)) return current;
  const boundedTarget = THREE.MathUtils.clamp(target, 0.6, 1.35);
  const rate = boundedTarget < current ? 4.5 : 1.4;
  return THREE.MathUtils.lerp(current, boundedTarget, 1 - Math.exp(-rate * Math.min(wallDeltaSeconds, 0.1)));
}
