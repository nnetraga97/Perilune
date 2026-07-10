/**
 * Science experiments — definitions and value calculation.
 * Situation-based: each experiment yields data once per (body, situation).
 */
import type { Situation } from '../sim/flight';

export type ScienceSituation =
  | 'surface'
  | 'ocean'
  | 'flying-low'
  | 'flying-high'
  | 'space-low'
  | 'space-high';

export interface ExperimentDef {
  id: string;
  name: string;
  /** Player-facing flavor per result (generic fallback used otherwise). */
  blurb: string;
  baseValue: number;
  validSituations: ScienceSituation[];
  /** Needs an atmosphere to be meaningful. */
  needsAtmosphere?: boolean;
}

export const EXPERIMENTS: ExperimentDef[] = [
  {
    id: 'thermal-scan',
    name: 'Thermoscope Reading',
    blurb: 'Local temperature profile recorded.',
    baseValue: 8,
    validSituations: ['surface', 'ocean', 'flying-low', 'flying-high', 'space-low', 'space-high'],
  },
  {
    id: 'pressure-scan',
    name: 'Pressograph Reading',
    blurb: 'Ambient pressure curve captured.',
    baseValue: 8,
    validSituations: ['surface', 'ocean', 'flying-low', 'flying-high'],
    needsAtmosphere: true,
  },
  {
    id: 'spore-exposure',
    name: 'Spore Exposure Study',
    blurb: 'The moss spores react in fascinating and occasionally alarming ways.',
    baseValue: 14,
    validSituations: ['surface', 'ocean', 'flying-low', 'flying-high', 'space-low', 'space-high'],
  },
  {
    id: 'orbital-survey',
    name: 'Starfield Survey',
    blurb: 'High-resolution imagery of the surface and stars beyond.',
    baseValue: 12,
    validSituations: ['space-low', 'space-high'],
  },
  {
    id: 'surface-sample',
    name: 'Field Sample',
    blurb: 'A carefully bagged, labeled, and admired piece of another world.',
    baseValue: 22,
    validSituations: ['surface', 'ocean'],
  },
];

export const EXPERIMENT_INDEX: ReadonlyMap<string, ExperimentDef> = new Map(
  EXPERIMENTS.map((e) => [e.id, e]),
);

/** Map a vessel situation + altitude to a science situation. */
export function scienceSituation(
  situation: Situation,
  altitude: number,
  bodyRadius: number,
  atmoHeight: number,
): ScienceSituation | null {
  switch (situation) {
    case 'landed':
    case 'prelaunch':
      return 'surface';
    case 'splashed':
      return 'ocean';
    case 'flying':
      return altitude < Math.max(12_000, atmoHeight * 0.3) ? 'flying-low' : 'flying-high';
    case 'suborbital':
    case 'orbit':
    case 'escaping':
      return altitude < bodyRadius * 0.5 ? 'space-low' : 'space-high';
    default:
      return null;
  }
}

export function experimentKey(expId: string, bodyId: string, situation: ScienceSituation): string {
  return `${expId}@${bodyId}-${situation}`;
}

/** Value of a fresh experiment result. */
export function experimentValue(exp: ExperimentDef, bodyScienceMultiplier: number): number {
  return Math.round(exp.baseValue * bodyScienceMultiplier);
}
