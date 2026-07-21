/** Vehicle capability multipliers. Celestial mechanics remain physically scaled. */
export interface FlightTuning {
  readonly thrustMultiplier: number;
  readonly ispMultiplier: number;
  readonly structuralStrengthMultiplier: number;
  readonly thermalLoadMultiplier: number;
  /** Pod/reaction-wheel authority, used to stop and point without engine thrust. */
  readonly attitudeControlMultiplier: number;
  /** Monopropellant translation and attitude-thruster authority. */
  readonly rcsThrustMultiplier: number;
  /** HUD full-scale and safety-reference dynamic pressure for this vehicle family. */
  readonly nominalMaxQPa: number;
}

export const LEGACY_FLIGHT_TUNING: Readonly<FlightTuning> = Object.freeze({
  thrustMultiplier: 1,
  ispMultiplier: 1,
  structuralStrengthMultiplier: 1,
  thermalLoadMultiplier: 1,
  attitudeControlMultiplier: 1,
  rcsThrustMultiplier: 1,
  nominalMaxQPa: 40_000,
});

/**
 * Sol uses real body scale and orbital velocities, but intentionally generous
 * fictional spacecraft. This leaves margin for steering and first-pass burns.
 */
export const SOL_FLIGHT_TUNING: Readonly<FlightTuning> = Object.freeze({
  thrustMultiplier: 1.6,
  ispMultiplier: 1.9,
  structuralStrengthMultiplier: 6,
  thermalLoadMultiplier: 0.1,
  attitudeControlMultiplier: 40,
  rcsThrustMultiplier: 4,
  nominalMaxQPa: 150_000,
});
