import type { Body } from '../sim/universe';
import { preferredOrbitAltitude } from '../sim/orbitPlacement';

export interface TerrainPresentationBand {
  /** Stream terrain in the background below this altitude. */
  readonly prewarmAltitude: number;
  /** Hand visible ground coverage from the compact globe to terrain below this altitude. */
  readonly visibleAltitude: number;
  /** Reference altitude used by the safe-orbit placement policy. */
  readonly orbitalAltitude: number;
}

const BAND_CACHE = new WeakMap<Body, TerrainPresentationBand>();

/**
 * Keeps ordinary orbits on the compact globe while leaving enough approach
 * distance for streamed terrain to become complete before landing.
 */
export function terrainPresentationBand(body: Body): TerrainPresentationBand {
  const cached = BAND_CACHE.get(body);
  if (cached) return cached;
  const terrainTop = body.def.surfaceKind === 'solid' ? Math.max(0, body.def.terrain.amplitude) : 0;
  const orbitalAltitude = preferredOrbitAltitude(body);
  const landingBuffer = Math.max(1_000, body.radius * 0.002);
  const visibleAltitude = Math.max(terrainTop + landingBuffer, orbitalAltitude * 0.55);
  const prewarmLead = Math.max(1_000, body.radius * 0.005);
  const prewarmAltitude = Math.min(
    orbitalAltitude * 0.9,
    Math.max(orbitalAltitude * 0.8, visibleAltitude + prewarmLead),
  );
  const band = Object.freeze({ prewarmAltitude, visibleAltitude, orbitalAltitude });
  BAND_CACHE.set(body, band);
  return band;
}
