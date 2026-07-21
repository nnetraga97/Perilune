import { describe, expect, it } from 'vitest';
import {
  ARTEMIS_IV_GUIDE_CONFIRMATION_MS,
  createArtemisIvGuideProgress,
  updateArtemisIvGuide,
} from '../src/missions/artemisIv/guide';
import {
  ARTEMIS_IV_PREPARED,
  initializeArtemisIvCheckpoint,
} from '../src/missions/artemisIv/checkpoints';
import {
  artemisIvRolesShareVessel,
  bindArtemisIvRole,
  setActiveArtemisIvRole,
} from '../src/missions/artemisIv/mission';
import { syncArtemisIvLiveTelemetry } from '../src/missions/artemisIv/runtime';
import { PHYSICS_DT } from '../src/sim/state';
import { defOf } from '../src/sim/vessel';

function recoveryDistanceDegrees(
  latitudeDegrees: number,
  longitudeDegrees: number,
): number {
  const region = ARTEMIS_IV_PREPARED.entry.recoveryRegion;
  const latDelta = latitudeDegrees - region.centerLatitudeDegrees;
  let lonDelta = longitudeDegrees - region.centerLongitudeDegrees;
  while (lonDelta > 180) lonDelta -= 360;
  while (lonDelta < -180) lonDelta += 360;
  lonDelta *= Math.cos(region.centerLatitudeDegrees * Math.PI / 180);
  return Math.hypot(latDelta, lonDelta);
}

describe('Artemis IV entry and recovery route', () => {
  it('separates the ESM, deploys the real chutes, and splashes down inside the recovery area', () => {
    const state = initializeArtemisIvCheckpoint(10);
    const { game } = state;
    const entryStack = game.active!;

    expect(entryStack.runtime.currentStage).toBe(1);
    expect(artemisIvRolesShareVessel(state, 'orion-cm', 'orion-esm')).toBe(true);
    expect(game.fireStage(entryStack)).toBe(true);

    const crewModule = game.vessels.find((vessel) => vessel.runtime.craft.parts.some(
      (part) => part.defId === 'pod-voyager',
    ));
    const serviceModule = game.vessels.find((vessel) => vessel.runtime.craft.parts.some(
      (part) => part.defId === 'eng-ember',
    ));
    expect(crewModule).toBeDefined();
    expect(serviceModule).toBeDefined();
    expect(crewModule!.runtime.craft.parts.some((part) => part.defId === 'eng-ember')).toBe(false);
    expect(serviceModule!.runtime.craft.parts.some((part) => part.defId === 'pod-voyager')).toBe(false);
    expect(serviceModule!.runtime.isDebris).toBe(true);
    expect(crewModule!.runtime.crew).toHaveLength(4);

    // Mirror the mission topology synchronization performed after each stage.
    bindArtemisIvRole(state, 'orion-cm', crewModule!.runtime.id);
    bindArtemisIvRole(state, 'orion-esm', serviceModule!.runtime.id);
    setActiveArtemisIvRole(state, 'orion-cm');
    expect(artemisIvRolesShareVessel(state, 'orion-cm', 'orion-esm')).toBe(false);

    let guide = createArtemisIvGuideProgress(10);
    let guideUpdate = updateArtemisIvGuide(guide, state, 0);
    expect(guideUpdate.signal).toBe('confirming');
    guideUpdate = updateArtemisIvGuide(
      guideUpdate.progress,
      state,
      ARTEMIS_IV_GUIDE_CONFIRMATION_MS,
    );
    expect(guideUpdate.signal).toBe('advanced');
    guide = guideUpdate.progress;

    expect(crewModule!.runtime.currentStage).toBe(0);
    expect(game.fireStage(crewModule!)).toBe(true);
    expect(crewModule!.runtime.craft.parts
      .filter((part) => defOf(part).parachute)
      .every((part) => part.activated === true)).toBe(true);
    crewModule!.runtime.sas = 'retrograde';

    const maximumSteps = 50_000;
    let steps = 0;
    while (
      steps < maximumSteps
      && game.vessels.includes(crewModule!)
      && crewModule!.runtime.situation !== 'splashed'
      && crewModule!.runtime.situation !== 'landed'
    ) {
      game.update(PHYSICS_DT);
      steps++;
    }

    expect(game.vessels.includes(crewModule!), 'crew module was destroyed during entry').toBe(true);
    expect(steps, 'entry did not reach the surface before the deterministic timeout')
      .toBeLessThan(maximumSteps);
    expect(crewModule!.runtime.situation).toBe('splashed');
    expect(crewModule!.runtime.craft.parts.some((part) => part.defId === 'shield-s')).toBe(true);

    syncArtemisIvLiveTelemetry(state, null, 0);
    expect(state.telemetry.parachutesDeployed).toBe(true);
    expect(state.telemetry.recoveryLatitudeDegrees).not.toBeNull();
    expect(state.telemetry.recoveryLongitudeDegrees).not.toBeNull();
    expect(recoveryDistanceDegrees(
      state.telemetry.recoveryLatitudeDegrees!,
      state.telemetry.recoveryLongitudeDegrees!,
    )).toBeLessThanOrEqual(ARTEMIS_IV_PREPARED.entry.recoveryRegion.radiusDegrees);

    guideUpdate = updateArtemisIvGuide(guide, state, 1_000);
    expect(guideUpdate.signal).toBe('confirming');
    guideUpdate = updateArtemisIvGuide(
      guideUpdate.progress,
      state,
      1_000 + ARTEMIS_IV_GUIDE_CONFIRMATION_MS,
    );
    expect(guideUpdate.signal).toBe('chapter-complete');
  }, 30_000);
});
