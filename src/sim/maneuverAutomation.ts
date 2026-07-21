export type ManeuverAutomationState = 'pointing' | 'waiting-for-stage' | 'burning' | 'aborted';

export interface ManeuverAutomationInput {
  readonly burnReady: boolean;
  readonly controlBlocked: boolean;
  readonly availableThrust: number;
  readonly alignment: number;
  readonly remainingDeltaV: number;
  readonly vesselMass: number;
}

export interface ManeuverAutomationCommand {
  readonly state: ManeuverAutomationState;
  readonly throttle: number;
  readonly beginExecution: boolean;
}

/** Pure policy: orient, burn and taper; never issue a staging command. */
export function maneuverAutomationCommand(
  input: Readonly<ManeuverAutomationInput>,
): ManeuverAutomationCommand {
  if (input.controlBlocked) return { state: 'aborted', throttle: 0, beginExecution: false };
  if (!input.burnReady || input.alignment < 0.985) {
    return { state: 'pointing', throttle: 0, beginExecution: false };
  }
  if (input.availableThrust <= 1) {
    return { state: 'waiting-for-stage', throttle: 0, beginExecution: false };
  }
  const acceleration = input.availableThrust / Math.max(1, input.vesselMass);
  return {
    state: 'burning',
    throttle: Math.max(0.08, Math.min(1, input.remainingDeltaV / Math.max(2, acceleration * 4))),
    beginExecution: true,
  };
}
