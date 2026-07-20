import * as THREE from 'three';
import type { BodyRendererKind } from '../content/bodyVisuals';

export interface EnvironmentLighting {
  readonly sky: THREE.ColorRepresentation;
  readonly ground: THREE.ColorRepresentation;
  readonly intensity: number;
  readonly background: THREE.ColorRepresentation;
  readonly exposure: number;
}

/** Shared display anchor for orbital, atmospheric, and airless views. */
export function environmentLighting(
  rendererKind: BodyRendererKind | undefined,
  atmosphereHeight: number,
  altitude: number,
  dayness: number,
  solarVisibleFraction: number,
  sunInFrame: boolean,
): EnvironmentLighting {
  const daylight = THREE.MathUtils.clamp(dayness, 0, 1)
    * THREE.MathUtils.clamp(solarVisibleFraction, 0, 1);
  if (rendererKind === 'terrestrial' && atmosphereHeight > 0) {
    const atmosphereDepth = THREE.MathUtils.clamp(1 - altitude / atmosphereHeight, 0, 1);
    const horizonFill = Math.sqrt(daylight) * atmosphereDepth;
    const nightFill = 0.025 * atmosphereDepth;
    return Object.freeze({
      sky: new THREE.Color(0.08, 0.19, 0.42).lerp(new THREE.Color(0.34, 0.58, 0.9), horizonFill),
      ground: new THREE.Color(0.015, 0.02, 0.025).lerp(new THREE.Color(0.18, 0.2, 0.16), horizonFill),
      intensity: 0.025 + 0.5 * horizonFill + nightFill,
      background: new THREE.Color(0.004, 0.008, 0.016).lerp(new THREE.Color(0.1, 0.27, 0.52), horizonFill),
      exposure: sunInFrame ? 0.68 : 0.92 + 0.28 * (1 - daylight),
    });
  }
  if (rendererKind === 'airless') {
    return Object.freeze({
      sky: '#080a0d', ground: '#010101', intensity: 0.025,
      background: '#04070a', exposure: sunInFrame ? 0.68 : 1.22,
    });
  }
  return Object.freeze({
    sky: '#0b1016', ground: '#020304', intensity: 0.045,
    background: '#04070a', exposure: sunInFrame ? 0.68 : 1.05,
  });
}

/** Wall-clock exponential adaptation with bounded photographic exposure. */
export function adaptExposure(current: number, target: number, wallDeltaSeconds: number): number {
  if (!(wallDeltaSeconds > 0)) return current;
  const boundedTarget = THREE.MathUtils.clamp(target, 0.6, 1.35);
  const rate = boundedTarget < current ? 4.5 : 1.4;
  return THREE.MathUtils.lerp(current, boundedTarget, 1 - Math.exp(-rate * Math.min(wallDeltaSeconds, 0.1)));
}
