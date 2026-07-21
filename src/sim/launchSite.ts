import { Vec3 } from '../core/vec3';
import { bodyFixedToInertial } from './bodyOrientation';
import type { Body, Universe } from './universe';

const DEG = Math.PI / 180;

/** Artemis launch site: Launch Complex 39B at Kennedy Space Center. */
export const LAUNCH_SITE_LAT = 28.6272 * DEG;
export const LAUNCH_SITE_LON = -80.6209 * DEG;
/** Launches wait until the Sun is visibly above the KSC horizon. */
export const LAUNCH_SITE_MINIMUM_SOLAR_ELEVATION = 25 * DEG;
/** The 512x256 global height authority blurs this low coastline below datum. */
export const LAUNCH_SITE_MINIMUM_GROUND_HEIGHT = 3;
export const LAUNCH_PAD_DECK_HEIGHT = 2;
/** Flat physical deck radius. The visual pad narrows to this radius at its top. */
export const LAUNCH_PAD_CONTACT_RADIUS = 9;
/** Complete visible foundation radius used when clearing underlying terrain. */
export const LAUNCH_PAD_FOOTPRINT_RADIUS = 9.8;
/** Separation kept between the deck and the highest terrain in its footprint. */
export const LAUNCH_PAD_TERRAIN_CLEARANCE = 0.25;
/** Flat authored terrain around the pad, with a broad graded approach. */
export const LAUNCH_PAD_TERRAIN_FLAT_RADIUS = 80;
export const LAUNCH_PAD_TERRAIN_BLEND_RADIUS = 450;
/** Radius around the pad prioritized for resolution-appropriate terrain detail. */
export const LAUNCH_PAD_MAX_LOD_RADIUS = 40;
/** Maximum camera-to-site distance that reserves prioritized terrain detail for the pad. */
export const LAUNCH_PAD_MAX_LOD_STREAM_DISTANCE = 20_000;

/** LC-39B surface normal in the rotating body-fixed frame. */
export function launchSiteBodyFixedDirection(out: Vec3): Vec3 {
  return out.set(
    Math.cos(LAUNCH_SITE_LAT) * Math.cos(LAUNCH_SITE_LON),
    Math.cos(LAUNCH_SITE_LAT) * Math.sin(LAUNCH_SITE_LON),
    Math.sin(LAUNCH_SITE_LAT),
  ).normalize();
}

/** LC-39B surface normal in the inertial frame at a given time. */
export function launchSiteDirection(body: Body, time: number, out: Vec3): Vec3 {
  launchSiteBodyFixedDirection(out);
  return bodyFixedToInertial(body, time, out, out).normalize();
}

const _siteInertial = new Vec3();
const _sunFromSite = new Vec3();

/** Solar elevation at LC-39B using the same body rotation and orbit as rendering. */
export function launchSiteSolarElevation(
  universe: Universe,
  body: Body,
  time: number,
): number {
  if (!Number.isFinite(time)) throw new Error('Launch-site solar time must be finite');
  launchSiteDirection(body, time, _siteInertial);
  universe.relativePosition(universe.root, body, time, _sunFromSite);
  if (!(_sunFromSite.lengthSq() > 0)) throw new Error(`${body.name} has no solar direction`);
  _sunFromSite.normalize();
  return Math.asin(Math.max(-1, Math.min(1, _siteInertial.dot(_sunFromSite))));
}

/** Earliest time at or after `startTime` when KSC reaches the daylight target. */
export function nextLaunchSiteDaylightTime(
  universe: Universe,
  body: Body,
  startTime: number,
  minimumSolarElevation = LAUNCH_SITE_MINIMUM_SOLAR_ELEVATION,
): number {
  if (!body.def.launchSite) throw new Error(`${body.name} has no launch site`);
  if (!Number.isFinite(startTime) || !Number.isFinite(minimumSolarElevation)) {
    throw new Error('Launch daylight search requires finite inputs');
  }
  const valueAt = (time: number): number => (
    launchSiteSolarElevation(universe, body, time) - minimumSolarElevation
  );
  if (valueAt(startTime) >= 0) return startTime;

  const rotationPeriod = Math.abs(body.def.rotationPeriod);
  if (!(rotationPeriod > 0)) throw new Error(`${body.name} cannot rotate its launch site into daylight`);
  const step = Math.max(30, Math.min(600, rotationPeriod / 288));
  const deadline = startTime + rotationPeriod * 2;
  let lower = startTime;
  for (let upper = startTime + step; upper <= deadline + step * 0.5; upper += step) {
    if (valueAt(upper) < 0) {
      lower = upper;
      continue;
    }
    // Find the morning threshold rather than advancing to a coarse sample.
    let high = upper;
    for (let iteration = 0; iteration < 48; iteration++) {
      const middle = (lower + high) / 2;
      if (valueAt(middle) >= 0) high = middle;
      else lower = middle;
    }
    return high;
  }
  throw new Error(`${body.name} launch site did not reach the daylight target`);
}
