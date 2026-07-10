/**
 * Terrain height sampling — the single source of truth for ground level,
 * shared by physics (landing contact) and rendering (mesh building).
 *
 * Height is a deterministic function of (body, unit direction), so the two
 * sides can never disagree.
 */
import { Vec3 } from '../core/vec3';
import { fbm3, ridged3, noise3 } from '../core/noise';
import type { Body } from './universe';

/**
 * Terrain height (m) above the body's reference sphere for a unit direction
 * in the body's rotating (surface-fixed) frame. Negative values are below
 * datum (ocean floor on worlds with oceans).
 */
export function terrainHeight(body: Body, dir: Readonly<Vec3>): number {
  const t = body.def.terrain;
  if (t.amplitude === 0) return 0; // gas giants / star
  const f = t.frequency;
  const s = t.seed;

  // Continental base: low-frequency fBm.
  const continents = fbm3(dir.x * f, dir.y * f, dir.z * f, s, Math.min(4, t.octaves));

  // Mountain detail: ridged noise masked by continent height so ranges
  // cluster on "land" rather than everywhere.
  const detailF = f * 5;
  const ridges = ridged3(dir.x * detailF, dir.y * detailF, dir.z * detailF, s + 7, Math.max(2, t.octaves - 3));
  const mask = Math.max(0, continents + 0.35);

  // Fine roughness so close-up ground isn't glassy.
  const roughF = f * 40;
  const rough = noise3(dir.x * roughF, dir.y * roughF, dir.z * roughF, s + 31) * 0.02;

  let h = continents * 0.55 + ridges * mask * 0.6 + rough;

  if (t.oceanLevel > 0) {
    // Shift so `oceanLevel` fraction of the surface sits below 0.
    h -= (t.oceanLevel - 0.5) * 1.1;
  }
  return h * t.amplitude;
}

/** Height clamped to sea level where the body has oceans (for landing/splash logic). */
export function surfaceHeight(body: Body, dir: Readonly<Vec3>): number {
  const h = terrainHeight(body, dir);
  if (body.def.terrain.oceanLevel > 0 && h < 0) return 0;
  return h;
}

/** True if the point is over ocean. */
export function isOcean(body: Body, dir: Readonly<Vec3>): boolean {
  return body.def.terrain.oceanLevel > 0 && terrainHeight(body, dir) < 0;
}

const _dir = new Vec3();

/**
 * Ground distance from body center (m) along a direction given in the
 * body's INERTIAL frame at time t (accounts for body rotation).
 */
export function groundRadiusInertial(body: Body, dirInertial: Readonly<Vec3>, t: number): number {
  // Rotate inertial direction into the surface-fixed frame: rotate by -angle
  // about +Z (bodies spin about their local Z axis in this model).
  const ang = -body.rotationAngle(t);
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  _dir.set(
    dirInertial.x * c - dirInertial.y * s,
    dirInertial.x * s + dirInertial.y * c,
    dirInertial.z,
  ).normalize();
  return body.radius + surfaceHeight(body, _dir);
}
