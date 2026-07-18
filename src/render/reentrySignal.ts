import type { AeroForces } from '../sim/aero';

/**
 * Heat flux (0.5·ρ·v³, W/m²) that saturates the visual signal. Calibrated to
 * this system's entry regime: Veyra LEO decay (~3.2 km/s) peaks near 0.6 and
 * a moon/interplanetary return (~4.5–6 km/s) reaches the full stack, instead
 * of reserving the upper layers for speeds no survivable craft attains.
 */
export const ENTRY_FLUX_REFERENCE = 8.0e7;

export const ENTRY_THRESHOLDS = Object.freeze({
  glow: 0.025,
  trails: 0.16,
  bowshock: 0.34,
  particles: 0.62,
});

export interface ReentrySignal {
  readonly strength: number;
  readonly transonic: number;
}

export interface ReentrySignalInput {
  readonly heatFlux: number;
  readonly mach: number;
  readonly dynamicPressure: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function rawEntryStrength(heatFlux: number, multiplier = 1): number {
  return clamp01((Math.max(0, heatFlux) / ENTRY_FLUX_REFERENCE) * Math.max(0, multiplier));
}

export function transonicStrength(mach: number, dynamicPressure: number, entryStrength: number): number {
  const rise = smoothstep(0.75, 1.05, mach);
  const fall = 1 - smoothstep(1.35, 2.5, mach);
  const pressureGate = smoothstep(350, 4_000, dynamicPressure);
  return clamp01(rise * fall * pressureGate * (1 - clamp01(entryStrength)));
}

/**
 * Render-side response. It uses wall-clock delta so warp changes the physical
 * input, not the visual response time, and accelerates large transitions.
 */
export function stepReentrySignal(
  previous: Readonly<ReentrySignal>,
  input: Readonly<ReentrySignalInput>,
  wallDeltaSeconds: number,
  strengthMultiplier = 1,
): ReentrySignal {
  const target = rawEntryStrength(input.heatFlux, strengthMultiplier);
  const distance = Math.abs(target - previous.strength);
  const response = 3.8 + distance * 8.2;
  const delta = Math.max(0, Math.min(0.25, wallDeltaSeconds));
  const strength = clamp01(previous.strength + (target - previous.strength) * (1 - Math.exp(-response * delta)));
  return {
    strength,
    transonic: transonicStrength(input.mach, input.dynamicPressure, strength),
  };
}

export function signalFromAero(
  previous: Readonly<ReentrySignal>,
  aero: Readonly<Pick<AeroForces, 'heatFlux' | 'mach' | 'dynamicPressure'>>,
  wallDeltaSeconds: number,
  strengthMultiplier = 1,
): ReentrySignal {
  return stepReentrySignal(previous, aero, wallDeltaSeconds, strengthMultiplier);
}
