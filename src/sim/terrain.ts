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
import {
  LAUNCH_PAD_CONTACT_RADIUS,
  LAUNCH_PAD_DECK_HEIGHT,
  LAUNCH_PAD_FOOTPRINT_RADIUS,
  LAUNCH_PAD_TERRAIN_CLEARANCE,
  launchSiteBodyFixedDirection,
} from './launchSite';
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

/** Natural contact height selected from solid terrain or an existing water surface. */
export function naturalContactSurface(body: Body, dir: Readonly<Vec3>): SurfaceHeightResult {
  const water = waterSurfaceHeight(body, dir);
  return water.kind === 'water' ? water : solidHeight(body, dir);
}

const _launchSiteDirection = new Vec3();
const launchPadEnvelopeCache = new WeakMap<Body, LaunchPadTerrainEnvelope>();

export interface LaunchPadTerrainEnvelope {
  readonly centerHeight: number;
  readonly minimumHeight: number;
  readonly maximumHeight: number;
  readonly deckHeight: number;
}

/**
 * Natural terrain range under Cape Skyward's complete footprint. This is
 * cached per immutable body recipe; contact queries must not resample it every
 * physics tick.
 */
export function launchPadTerrainEnvelope(body: Body): LaunchPadTerrainEnvelope {
  const cached = launchPadEnvelopeCache.get(body);
  if (cached) return cached;
  if (body.id !== 'veyra' || body.def.surfaceKind !== 'solid') {
    throw new Error(`${body.name} has no Cape Skyward launchpad`);
  }
  const site = launchSiteBodyFixedDirection(new Vec3());
  const east = new Vec3(-site.y, site.x, 0).normalize();
  const north = Vec3.cross(site, east, new Vec3()).normalize();
  const direction = new Vec3();
  const sample = (eastMeters: number, northMeters: number): number => {
    direction.copy(site)
      .addScaled(east, eastMeters / body.radius)
      .addScaled(north, northMeters / body.radius)
      .normalize();
    const natural = naturalContactSurface(body, direction);
    if (natural.kind === 'none') throw new Error(`${body.name} has no natural launchpad terrain`);
    return natural.height;
  };

  const centerHeight = sample(0, 0);
  let minimumHeight = centerHeight;
  let maximumHeight = centerHeight;
  // Half-meter sampling is substantially finer than the rendered pad and the
  // final clearance absorbs the residual sub-sample variation.
  const step = 0.5;
  const extent = LAUNCH_PAD_FOOTPRINT_RADIUS;
  for (let northMeters = -extent; northMeters <= extent; northMeters += step) {
    for (let eastMeters = -extent; eastMeters <= extent; eastMeters += step) {
      if (eastMeters * eastMeters + northMeters * northMeters > extent * extent) continue;
      const height = sample(eastMeters, northMeters);
      minimumHeight = Math.min(minimumHeight, height);
      maximumHeight = Math.max(maximumHeight, height);
    }
  }
  const deckHeight = Math.max(
    centerHeight + LAUNCH_PAD_DECK_HEIGHT,
    maximumHeight + LAUNCH_PAD_TERRAIN_CLEARANCE,
  );
  const envelope = Object.freeze({ centerHeight, minimumHeight, maximumHeight, deckHeight });
  launchPadEnvelopeCache.set(body, envelope);
  return envelope;
}

/**
 * Flat launchpad deck expressed as a ray/plane contact surface. The visual pad
 * remains based on natural terrain while physics contacts its top face.
 */
export function launchPadContactSurface(body: Body, dir: Readonly<Vec3>): SurfaceHeightResult {
  if (body.id !== 'veyra' || body.def.surfaceKind !== 'solid') return { kind: 'none' };
  const length = Math.hypot(dir.x, dir.y, dir.z);
  if (!(length > 0)) return { kind: 'none' };
  const site = launchSiteBodyFixedDirection(_launchSiteDirection);
  const dot = (dir.x * site.x + dir.y * site.y + dir.z * site.z) / length;
  if (!(dot > 0)) return { kind: 'none' };

  const deckPlaneRadius = body.radius + launchPadTerrainEnvelope(body).deckHeight;
  const tangentDistance = deckPlaneRadius * Math.sqrt(Math.max(0, 1 - dot * dot)) / dot;
  if (tangentDistance > LAUNCH_PAD_CONTACT_RADIUS) return { kind: 'none' };
  return { kind: 'solid', height: deckPlaneRadius / dot - body.radius };
}

/** Contact height selected from natural terrain/water and authored structures. */
export function contactSurface(body: Body, dir: Readonly<Vec3>): SurfaceHeightResult {
  const natural = naturalContactSurface(body, dir);
  const pad = launchPadContactSurface(body, dir);
  if (pad.kind === 'none') return natural;
  if (natural.kind === 'none' || pad.height > natural.height) return pad;
  return natural;
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

/** Local terrain slope in degrees, sampled in the body-fixed tangent plane. */
export function surfaceSlopeDegrees(body: Body, dir: Readonly<Vec3>, spanMeters = 5): number {
  if (body.def.surfaceKind !== 'solid' || !(spanMeters > 0)) return 0;
  const site = new Vec3(dir.x, dir.y, dir.z).normalize();
  const east = new Vec3(-site.y, site.x, 0);
  if (east.lengthSq() < 1e-12) east.set(1, 0, 0);
  east.normalize();
  const north = Vec3.cross(site, east, new Vec3()).normalize();
  const angularSpan = spanMeters / body.radius;
  const sample = (axis: Readonly<Vec3>, sign: number): number => {
    const sampleDir = site.clone().addScaled(axis, angularSpan * sign).normalize();
    return surfaceHeight(body, sampleDir);
  };
  const riseEast = (sample(east, 1) - sample(east, -1)) / (2 * spanMeters);
  const riseNorth = (sample(north, 1) - sample(north, -1)) / (2 * spanMeters);
  return Math.atan(Math.hypot(riseEast, riseNorth)) * (180 / Math.PI);
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

/** Natural terrain/water radius, excluding authored structures such as launchpads. */
export function naturalGroundRadiusInertial(
  body: Body,
  dirInertial: Readonly<Vec3>,
  t: number,
): number {
  inertialToBodyFixed(body, t, dirInertial, _dir).normalize();
  const surface = naturalContactSurface(body, _dir);
  if (surface.kind === 'none') throw new Error(`${body.name} has no natural contact surface`);
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
