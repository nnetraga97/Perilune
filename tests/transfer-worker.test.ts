import { describe, expect, it } from 'vitest';
import { createOdysseyOrbiter } from '../src/content/crafts';
import { GAMEPLAY_PROFILES } from '../src/content/gameplayProfiles';
import { GameState } from '../src/sim/state';
import {
  calculateTransferWorkerRequest,
  type TransferWorkerRequest,
} from '../src/sim/transferWorker';

describe('transfer verification worker', () => {
  it('reconstructs serialized Sol state and returns a verified planet intercept', () => {
    const game = new GameState('sandbox', GAMEPLAY_PROFILES.sol);
    const vessel = game.spawnInOrbit(createOdysseyOrbiter(), 'Odyssey', 'earth', 200_000);
    const request: TransferWorkerRequest = structuredClone({
      requestId: 17,
      universe: [...game.universe.bodies.values()].map((body) => body.def),
      homeBodyId: game.universe.homeBodyId,
      time: game.time,
      fromId: 'earth',
      targetId: 'mercury',
      options: {
        parkRadius: vessel.runtime.pos.length(),
        vesselAngle: Math.atan2(vessel.runtime.pos.y, vessel.runtime.pos.x),
        parkingOrbitDirection: 1,
        vesselPosition: {
          x: vessel.runtime.pos.x,
          y: vessel.runtime.pos.y,
          z: vessel.runtime.pos.z,
        },
        vesselVelocity: {
          x: vessel.runtime.vel.x,
          y: vessel.runtime.vel.y,
          z: vessel.runtime.vel.z,
        },
      },
    } satisfies TransferWorkerRequest);
    let clock = 40;
    const result = calculateTransferWorkerRequest(request, () => clock++);

    expect(result.requestId).toBe(17);
    expect(result.targetId).toBe('mercury');
    expect(result.error).toBeUndefined();
    expect(result.elapsedMs).toBe(1);
    expect(result.plan?.accuracy).toBe('refined-intercept');
    expect(result.plan?.approachAltitude).toBeGreaterThan(0);
  }, 15_000);
});
