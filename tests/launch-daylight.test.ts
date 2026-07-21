import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import { inertialToBodyFixed } from '../src/sim/bodyOrientation';
import {
  LAUNCH_SITE_MINIMUM_SOLAR_ELEVATION,
  launchSiteBodyFixedDirection,
  launchSiteDirection,
  launchSiteSolarElevation,
  nextLaunchSiteDaylightTime,
} from '../src/sim/launchSite';
import { GameState } from '../src/sim/state';

describe('KSC daylight launch window', () => {
  it('advances preflight to the next visible daylight window', () => {
    const game = new GameState();
    const earth = game.universe.get('earth');
    const launchTime = game.warpToLaunchDaylight(earth);

    expect(launchTime).toBeGreaterThanOrEqual(0);
    expect(launchTime).toBeLessThan(earth.def.rotationPeriod * 2);
    expect(launchSiteSolarElevation(game.universe, earth, launchTime))
      .toBeCloseTo(LAUNCH_SITE_MINIMUM_SOLAR_ELEVATION, 10);
    expect(game.time).toBe(launchTime);
    expect(game.warpRate).toBe(1);
  });

  it('keeps the pad and shader solar direction in the rotating body frame', () => {
    const game = new GameState();
    const earth = game.universe.get('earth');
    const launchTime = nextLaunchSiteDaylightTime(game.universe, earth, 0);
    const siteAtStart = launchSiteDirection(earth, 0, new Vec3());
    const siteAtLaunch = launchSiteDirection(earth, launchTime, new Vec3());
    expect(siteAtStart.distanceTo(siteAtLaunch)).toBeGreaterThan(0.1);

    const sunInertial = new Vec3();
    game.universe.relativePosition(game.universe.root, earth, launchTime, sunInertial);
    const sunBodyFixed = inertialToBodyFixed(
      earth,
      launchTime,
      sunInertial,
      new Vec3(),
    ).normalize();
    const siteBodyFixed = launchSiteBodyFixedDirection(new Vec3());
    expect(siteBodyFixed.dot(sunBodyFixed))
      .toBeCloseTo(Math.sin(LAUNCH_SITE_MINIMUM_SOLAR_ELEVATION), 10);
  });
});
