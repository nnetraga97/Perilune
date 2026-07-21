import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import { surfaceVelocity } from '../src/sim/bodyOrientation';
import { PHYSICS_DT } from '../src/sim/state';
import { analyzeCraft } from '../src/sim/vessel';
import {
  ARTEMIS_IV_SOUTH_POLE_TRAINING_ANALOGUE,
  initializeArtemisIvCheckpoint,
} from '../src/missions/artemisIv/checkpoints';
import { vesselForArtemisIvRole } from '../src/missions/artemisIv/mission';

describe('Artemis IV lander route feasibility', () => {
  it('starts powered descent inside a physically stoppable landing corridor', () => {
    const state = initializeArtemisIvCheckpoint(5);
    const lander = vesselForArtemisIvRole(state, 'hls')!;
    const moon = state.game.bodyOf(lander);
    const relativeVelocity = lander.runtime.vel.clone().sub(
      surfaceVelocity(moon, lander.runtime.pos, new Vec3()),
    );
    const radial = lander.runtime.pos.clone().normalize();
    const verticalSpeed = relativeVelocity.dot(radial);
    const horizontalSpeed = relativeVelocity.clone().addScaled(radial, -verticalSpeed).length();
    const analysis = analyzeCraft(
      lander.runtime.craft,
      moon.surfaceGravity,
      0,
      state.game.flightTuning,
    );
    const poweredStage = analysis.stages[0];
    const maximumAcceleration = poweredStage.thrust / lander.runtime.massProps.mass;
    const idealStoppingDistance = horizontalSpeed * horizontalSpeed / (2 * maximumAcceleration);

    expect(horizontalSpeed).toBeCloseTo(70, 6);
    expect(idealStoppingDistance).toBeLessThan(
      ARTEMIS_IV_SOUTH_POLE_TRAINING_ANALOGUE.ellipse.semiMinorMeters,
    );
    const thrustDirection = lander.runtime.att.rotate(new Vec3(0, 1, 0), new Vec3());
    expect(thrustDirection.dot(relativeVelocity.clone().normalize().negate())).toBeGreaterThan(0.999);
    expect(state.game.fireStage(lander)).toBe(true);
    expect(lander.runtime.craft.parts.find((part) => part.defId === 'eng-aspen')?.activated)
      .toBe(true);
  });

  it('keeps surface and ascent checkpoints settled, then exposes ample ascent authority', () => {
    for (const chapter of [6, 7] as const) {
      const state = initializeArtemisIvCheckpoint(chapter);
      const lander = vesselForArtemisIvRole(state, 'hls')!;
      for (let step = 0; step < 1_000; step++) state.game.update(PHYSICS_DT);
      expect(state.game.vessels).toContain(lander);
      expect(lander.runtime.situation).toBe('landed');
      expect(lander.runtime.externalLandingFootprint).toMatchObject({
        contactCount: 4,
        tipped: false,
      });
      expect(lander.runtime.externalLandingFootprint!.stableForMs).toBeGreaterThanOrEqual(1_500);
    }

    const ascent = initializeArtemisIvCheckpoint(7);
    const lander = vesselForArtemisIvRole(ascent, 'hls')!;
    const moon = ascent.game.bodyOf(lander);
    const analysis = analyzeCraft(
      lander.runtime.craft,
      moon.surfaceGravity,
      0,
      ascent.game.flightTuning,
    );
    const circularSpeed = Math.sqrt(moon.mu / (moon.radius + 100_000));
    expect(analysis.stages[0].twrStart).toBeGreaterThan(1);
    expect(analysis.stages[0].deltaV).toBeGreaterThan(circularSpeed * 2);
  });

  it('does not discard the representative manifest during a docked split', () => {
    const state = initializeArtemisIvCheckpoint(9);
    const docked = state.game.active!;
    const joint = state.game.dockedJoints(docked)[0];
    expect(state.game.undock(docked, joint.childKey)).toBe(true);
    expect(state.game.vessels.reduce(
      (total, vessel) => total + vessel.runtime.crew.length,
      0,
    )).toBe(4);
  });
});
