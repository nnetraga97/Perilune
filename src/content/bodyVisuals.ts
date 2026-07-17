export type BodyRendererKind = 'legacy' | 'terrestrial' | 'airless' | 'gas-giant' | 'star';

export interface EntryVisualDef {
  glow: string;
  glowHot: string;
  trailPrimary: string;
  trailSecondary: string;
  trailTertiary: string;
  streak: string;
  wrapLayer: string;
  shockwave: string;
  strengthMultiplier: number;
  lengthMultiplier: number;
  opacityMultiplier: number;
  glowMultiplier: number;
  streakProbability: number;
  particleThreshold: number;
}

/** Original SDR palette used by atmosphere-bearing bodies without an override. */
export const DEFAULT_ENTRY_VISUAL: Readonly<EntryVisualDef> = Object.freeze({
  glow: '#ff7a24',
  glowHot: '#fff5d7',
  trailPrimary: '#ffb23f',
  trailSecondary: '#ff5a1f',
  trailTertiary: '#a91d10',
  streak: '#fff0bd',
  wrapLayer: '#ff6b32',
  shockwave: '#f8fbff',
  strengthMultiplier: 1,
  lengthMultiplier: 1,
  opacityMultiplier: 1,
  glowMultiplier: 1,
  streakProbability: 0,
  particleThreshold: 0.62,
});

export function validateEntryVisual(value: Readonly<EntryVisualDef>): string[] {
  const errors: string[] = [];
  const colors = ['glow', 'glowHot', 'trailPrimary', 'trailSecondary', 'trailTertiary', 'streak', 'wrapLayer', 'shockwave'] as const;
  for (const key of colors) {
    if (!/^#[0-9a-f]{6}$/i.test(value[key])) errors.push(`${key} must be a six-digit hex color`);
  }
  const positive = ['strengthMultiplier', 'lengthMultiplier', 'opacityMultiplier', 'glowMultiplier'] as const;
  for (const key of positive) {
    if (!Number.isFinite(value[key]) || value[key] <= 0) errors.push(`${key} must be finite and positive`);
  }
  if (!Number.isFinite(value.streakProbability) || value.streakProbability < 0 || value.streakProbability > 1) {
    errors.push('streakProbability must be within [0, 1]');
  }
  if (!Number.isFinite(value.particleThreshold) || value.particleThreshold < 0 || value.particleThreshold > 1) {
    errors.push('particleThreshold must be within [0, 1]');
  }
  return errors;
}

export interface BodyVisualDef {
  renderer: BodyRendererKind;
  targetArchetype: Exclude<BodyRendererKind, 'legacy'>;
  materialId: string;
  atmosphereVisual?: {
    /** Art-direction color only; physical density and thickness stay in AtmosphereDef. */
    wavelengthTint: readonly [number, number, number];
    strength: number;
  };
  /** Renderer-only atmospheric-entry art direction. Physical heating remains simulation-owned. */
  entryVisual?: EntryVisualDef;
}

export type BodyId =
  | 'auren'
  | 'ashen'
  | 'vess'
  | 'veyra'
  | 'palla'
  | 'wisp'
  | 'rusk'
  | 'tyran'
  | 'brimm'
  | 'glacia'
  | 'mote'
  | 'farfall';

/** Renderer-owned visual assignments, deliberately separate from simulation body definitions. */
export const BODY_VISUALS: Readonly<Record<BodyId, BodyVisualDef>> = Object.freeze({
  auren: { renderer: 'star', targetArchetype: 'star', materialId: 'auren-star' },
  ashen: { renderer: 'legacy', targetArchetype: 'airless', materialId: 'ashen-airless' },
  vess: { renderer: 'legacy', targetArchetype: 'terrestrial', materialId: 'vess-terrestrial' },
  veyra: {
    renderer: 'terrestrial',
    targetArchetype: 'terrestrial',
    materialId: 'veyra-terrestrial',
    atmosphereVisual: { wavelengthTint: [0.42, 0.68, 1], strength: 1 },
    entryVisual: {
      ...DEFAULT_ENTRY_VISUAL,
      glow: '#ff6724',
      glowHot: '#fff7df',
      trailPrimary: '#ffb642',
      trailSecondary: '#f1491b',
      trailTertiary: '#7a160d',
      wrapLayer: '#ed4e21',
      shockwave: '#eaf8ff',
      lengthMultiplier: 1.08,
      glowMultiplier: 1.12,
    },
  },
  palla: { renderer: 'legacy', targetArchetype: 'airless', materialId: 'palla-airless' },
  wisp: { renderer: 'legacy', targetArchetype: 'airless', materialId: 'wisp-airless' },
  rusk: { renderer: 'legacy', targetArchetype: 'terrestrial', materialId: 'rusk-terrestrial' },
  tyran: { renderer: 'legacy', targetArchetype: 'gas-giant', materialId: 'tyran-gas-giant' },
  brimm: { renderer: 'legacy', targetArchetype: 'airless', materialId: 'brimm-airless' },
  glacia: { renderer: 'legacy', targetArchetype: 'airless', materialId: 'glacia-airless' },
  mote: { renderer: 'legacy', targetArchetype: 'airless', materialId: 'mote-airless' },
  farfall: { renderer: 'legacy', targetArchetype: 'airless', materialId: 'farfall-airless' },
});
