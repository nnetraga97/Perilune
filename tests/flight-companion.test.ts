import { describe, expect, it } from 'vitest';
import {
  chooseFlightCompanionAdvisory,
  type FlightCompanionSnapshot,
} from '../src/ui/flightCompanion';

const nominal: FlightCompanionSnapshot = {
  vesselId: 'vessel-1',
  situation: 'prelaunch',
  fuelFraction: 1,
  chargeFraction: 1,
  dynamicPressurePa: 0,
  properG: 1,
  commsBlocked: false,
  nodeBurnStartEta: null,
  predictedImpactSpeed: null,
};

describe('flight companion callouts', () => {
  it('welcomes the player with a phase-specific local callout', () => {
    expect(chooseFlightCompanionAdvisory(nominal)).toMatchObject({
      id: 'phase-prelaunch',
      tone: 'info',
    });
  });

  it('prioritizes loss of probe control over routine phase guidance', () => {
    const advisory = chooseFlightCompanionAdvisory({
      ...nominal,
      situation: 'orbit',
      commsBlocked: true,
      fuelFraction: 0.04,
    });
    expect(advisory).toMatchObject({ id: 'alert-comms', tone: 'danger' });
  });

  it('uses simulator measurements in safety callouts', () => {
    const advisory = chooseFlightCompanionAdvisory({
      ...nominal,
      situation: 'flying',
      dynamicPressurePa: 38_450,
    });
    expect(advisory).toMatchObject({ id: 'alert-high-q', tone: 'warning' });
    expect(advisory?.message).toContain('38.5 kPa');
  });

  it('announces the centered maneuver burn window', () => {
    expect(chooseFlightCompanionAdvisory({
      ...nominal,
      situation: 'orbit',
      nodeBurnStartEta: -1,
    })).toMatchObject({ id: 'alert-node-burn', headline: 'Begin the burn' });
  });

  it('keeps null capacities from looking like empty resources', () => {
    expect(chooseFlightCompanionAdvisory({
      ...nominal,
      situation: 'orbit',
      fuelFraction: null,
      chargeFraction: null,
    })).toMatchObject({ id: 'phase-orbit', tone: 'success' });
  });
});
