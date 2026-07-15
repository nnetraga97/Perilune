import { Vec3 } from '../core/vec3';
import { bodyFixedToInertial } from './bodyOrientation';
import type { Body } from './universe';

// Broad highland selected from the deterministic terrain field so the pad is
// never clipped by the ocean or a steep procedural coastline.
export const LAUNCH_SITE_LAT = 0.3;
export const LAUNCH_SITE_LON = 2.4584073464102096;
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

/** Cape Skyward surface normal in the rotating body-fixed frame. */
export function launchSiteBodyFixedDirection(out: Vec3): Vec3 {
  return out.set(
    Math.cos(LAUNCH_SITE_LAT) * Math.cos(LAUNCH_SITE_LON),
    Math.cos(LAUNCH_SITE_LAT) * Math.sin(LAUNCH_SITE_LON),
    Math.sin(LAUNCH_SITE_LAT),
  ).normalize();
}

/** Cape Skyward surface normal in the inertial frame at a given time. */
export function launchSiteDirection(body: Body, time: number, out: Vec3): Vec3 {
  launchSiteBodyFixedDirection(out);
  return bodyFixedToInertial(body, time, out, out).normalize();
}
