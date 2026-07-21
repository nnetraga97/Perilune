import { describe, expect, it } from 'vitest';
import { maneuverAutomationCommand } from '../src/sim/maneuverAutomation';

const ready = {
  burnReady: true,
  controlBlocked: false,
  availableThrust: 200_000,
  alignment: 1,
  remainingDeltaV: 800,
  vesselMass: 20_000,
};

describe('maneuver automatic execution policy', () => {
  it('orients before ignition and aborts safely when control is unavailable', () => {
    expect(maneuverAutomationCommand({ ...ready, burnReady: false })).toEqual({
      state: 'pointing', throttle: 0, beginExecution: false,
    });
    expect(maneuverAutomationCommand({ ...ready, controlBlocked: true })).toEqual({
      state: 'aborted', throttle: 0, beginExecution: false,
    });
  });

  it('pauses at an empty stage and resumes only after thrust becomes available', () => {
    expect(maneuverAutomationCommand({ ...ready, availableThrust: 0 })).toEqual({
      state: 'waiting-for-stage', throttle: 0, beginExecution: false,
    });
    expect(maneuverAutomationCommand(ready).state).toBe('burning');
  });

  it('tapers near completion without ever requesting staging', () => {
    expect(maneuverAutomationCommand(ready).throttle).toBe(1);
    expect(maneuverAutomationCommand({ ...ready, remainingDeltaV: 1 }).throttle).toBe(0.08);
    expect(maneuverAutomationCommand({ ...ready, alignment: 0.9 }).throttle).toBe(0);
  });
});
