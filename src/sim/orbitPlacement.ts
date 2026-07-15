import type { Body } from './universe';

/** Preferred circular-orbit altitude before the body's SOI safety cap. */
export function preferredOrbitAltitude(body: Readonly<Body>): number {
  const atmosphereTop = body.def.atmosphere?.height ?? 0;
  const terrainTop = body.def.surfaceKind === 'solid' ? body.def.terrain.amplitude : 0;
  const clearance = Math.max(atmosphereTop, terrainTop);
  const margin = Math.max(10_000, body.radius * 0.02);
  return Math.max(body.radius * 0.1, clearance + margin);
}
