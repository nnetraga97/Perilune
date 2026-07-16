/**
 * Science experiments — definitions and value calculation.
 * Situation-based: each experiment yields data once per (body, situation).
 */
import type { Situation } from '../sim/flight';
import type { BodyDef, ScienceBiomeDef } from '../sim/universe';

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
  /** Fraction of a freshly collected sample that can be delivered by comms. */
  transmitFraction: number;
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
    transmitFraction: 1,
    validSituations: ['surface', 'ocean', 'flying-low', 'flying-high', 'space-low', 'space-high'],
  },
  {
    id: 'pressure-scan',
    name: 'Pressograph Reading',
    blurb: 'Ambient pressure curve captured.',
    baseValue: 8,
    transmitFraction: 1,
    validSituations: ['surface', 'ocean', 'flying-low', 'flying-high'],
    needsAtmosphere: true,
  },
  {
    id: 'spore-exposure',
    name: 'Spore Exposure Study',
    blurb: 'The moss spores react in fascinating and occasionally alarming ways.',
    baseValue: 14,
    transmitFraction: 0.25,
    validSituations: ['surface', 'ocean', 'flying-low', 'flying-high', 'space-low', 'space-high'],
  },
  {
    id: 'orbital-survey',
    name: 'Starfield Survey',
    blurb: 'High-resolution imagery of the surface and stars beyond.',
    baseValue: 12,
    transmitFraction: 0.65,
    validSituations: ['space-low', 'space-high'],
  },
  {
    id: 'surface-sample',
    name: 'Field Sample',
    blurb: 'A carefully bagged, labeled, and admired piece of another world.',
    baseValue: 22,
    transmitFraction: 0,
    validSituations: ['surface', 'ocean'],
  },
];

export const EXPERIMENT_INDEX: ReadonlyMap<string, ExperimentDef> = new Map(
  EXPERIMENTS.map((e) => [e.id, e]),
);

const SYNTHETIC_GLOBAL: readonly ScienceBiomeDef[] = [{
  id: 'global', name: 'Global', scienceMultiplier: 1,
}];

/** Enumerate only the biome buckets that can actually occur for a situation. */
export function scienceBiomesForSituation(body: BodyDef, situation: ScienceSituation): readonly ScienceBiomeDef[] {
  const authored = body.biomes ?? SYNTHETIC_GLOBAL;
  const global = authored.filter((biome) => biome.id === 'global');
  if (situation === 'surface') {
    if (body.surfaceKind !== 'solid') return [];
    const solid = authored.filter((biome) => !['global', 'ocean', 'upper-atmosphere'].includes(biome.id));
    return solid.length ? solid : global;
  }
  if (situation === 'ocean') {
    if (body.surfaceKind !== 'solid' || body.terrain.oceanLevel <= 0) return [];
    const ocean = authored.filter((biome) => biome.id === 'ocean');
    return ocean.length ? ocean : global;
  }
  if (situation === 'flying-low') {
    if (!body.atmosphere) return [];
    const granular = authored.filter((biome) => biome.id !== 'global');
    return granular.length ? granular : global;
  }
  if (situation === 'flying-high' && !body.atmosphere) return [];
  return global;
}

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

/** Lifetime integer cap for one experiment/body/biome/situation site. */
export function experimentCap(
  exp: ExperimentDef,
  bodyScienceMultiplier: number,
  biomeScienceMultiplier = 1,
): number {
  return Math.max(1, Math.round(exp.baseValue * bodyScienceMultiplier * biomeScienceMultiplier));
}
