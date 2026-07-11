/**
 * Terrain height sampling — the single source of truth for ground level,
 * shared by physics (landing contact) and rendering (mesh building).
 *
 * Height is a deterministic function of (body, unit direction), so the two
 * sides can never disagree.
 */
import { Vec3 } from '../core/vec3';
import type { Body } from './universe';
import { inertialToBodyFixed } from './bodyOrientation';
import { evaluateRecipeHeight, recipeForBody } from './terrainRecipe';

export type SurfaceHeightResult =
  | { kind: 'solid' | 'water'; height: number }
  | { kind: 'none' };

/** Raw land or seafloor height from the versioned recipe. */
export function solidHeight(body: Body, dir: Readonly<Vec3>): SurfaceHeightResult {
  if (body.def.surfaceKind !== 'solid') return { kind: 'none' };
  return { kind: 'solid', height: evaluateRecipeHeight(recipeForBody(body), dir) };
}

/** Water datum where the raw solid surface lies below an ocean. */
export function waterSurfaceHeight(body: Body, dir: Readonly<Vec3>): SurfaceHeightResult {
  const solid = solidHeight(body, dir);
  if (
    solid.kind === 'solid' &&
    body.def.terrain.oceanLevel > 0 &&
    solid.height < 0
  ) {
    return { kind: 'water', height: 0 };
  }
  return { kind: 'none' };
}

/** Contact height selected from solid terrain or an existing water surface. */
export function contactSurface(body: Body, dir: Readonly<Vec3>): SurfaceHeightResult {
  const water = waterSurfaceHeight(body, dir);
  return water.kind === 'water' ? water : solidHeight(body, dir);
}

/**
 * Terrain height (m) above the body's reference sphere for a unit direction
 * in the body's rotating (surface-fixed) frame. Negative values are below
 * datum (ocean floor on worlds with oceans).
 */
export function terrainHeight(body: Body, dir: Readonly<Vec3>): number {
  const result = solidHeight(body, dir);
  return result.kind === 'solid' ? result.height : 0;
}

/** Height clamped to sea level where the body has oceans (for landing/splash logic). */
export function surfaceHeight(body: Body, dir: Readonly<Vec3>): number {
  const result = contactSurface(body, dir);
  return result.kind === 'none' ? 0 : result.height;
}

/** True if the point is over ocean. */
export function isOcean(body: Body, dir: Readonly<Vec3>): boolean {
  return waterSurfaceHeight(body, dir).kind === 'water';
}

const _dir = new Vec3();

/**
 * Ground distance from body center (m) along a direction given in the
 * body's INERTIAL frame at time t (accounts for body rotation).
 */
export function groundRadiusInertial(body: Body, dirInertial: Readonly<Vec3>, t: number): number {
  inertialToBodyFixed(body, t, dirInertial, _dir).normalize();
  const surface = contactSurface(body, _dir);
  if (surface.kind === 'none') throw new Error(`${body.name} has no contact surface`);
  return body.radius + surface.height;
}

/** Raw solid radius without water clamping. */
export function solidRadiusInertial(
  body: Body,
  dirInertial: Readonly<Vec3>,
  t: number,
): number {
  inertialToBodyFixed(body, t, dirInertial, _dir).normalize();
  const surface = solidHeight(body, _dir);
  if (surface.kind !== 'solid') throw new Error(`${body.name} has no solid surface`);
  return body.radius + surface.height;
}
