export type BodyRendererKind = 'legacy' | 'terrestrial' | 'airless' | 'compact-planet' | 'gas-giant' | 'star';
export type BodyTargetArchetype = 'terrestrial' | 'airless' | 'gas-giant' | 'star';

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
  targetArchetype: BodyTargetArchetype;
  materialId: string;
  /** Renderer-only deterministic near-surface detail profile. */
  scatterProfile?: 'veyra' | 'earth-geology' | 'moon-regolith';
  atmosphereVisual?: {
    /** Art-direction color only; physical density and thickness stay in AtmosphereDef. */
    wavelengthTint: readonly [number, number, number];
    strength: number;
  };
  compactPlanetVisual?: {
    limbColor: string;
    limbStrength: number;
    pointColor: string;
  };
  /** Renderer-only atmospheric-entry art direction. Physical heating remains simulation-owned. */
  entryVisual?: EntryVisualDef;
}

export type BodyId =
  | 'sun'
  | 'mercury'
  | 'venus'
  | 'earth'
  | 'moon'
  | 'mars'
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
  sun: { renderer: 'star', targetArchetype: 'star', materialId: 'sol-photosphere' },
  mercury: {
    renderer: 'compact-planet',
    targetArchetype: 'terrestrial',
    materialId: 'mercury-compact',
    compactPlanetVisual: {
      limbColor: '#b6aa9c',
      limbStrength: 0.04,
      pointColor: '#c2b29d',
    },
  },
  venus: {
    renderer: 'compact-planet',
    targetArchetype: 'terrestrial',
    materialId: 'venus-cloud-deck',
    compactPlanetVisual: {
      limbColor: '#ffe4a3',
      limbStrength: 0.42,
      pointColor: '#ffe1a0',
    },
  },
  earth: {
    renderer: 'terrestrial',
    targetArchetype: 'terrestrial',
    materialId: 'earth-terrestrial',
    scatterProfile: 'earth-geology',
    atmosphereVisual: { wavelengthTint: [0.36, 0.62, 1], strength: 1 },
    entryVisual: { ...DEFAULT_ENTRY_VISUAL },
  },
  moon: {
    renderer: 'airless', targetArchetype: 'airless', materialId: 'moon-airless',
    scatterProfile: 'moon-regolith',
  },
  mars: {
    renderer: 'compact-planet',
    targetArchetype: 'terrestrial',
    materialId: 'mars-compact',
    compactPlanetVisual: {
      limbColor: '#d98b68',
      limbStrength: 0.22,
      pointColor: '#e59262',
    },
  },
  auren: { renderer: 'star', targetArchetype: 'star', materialId: 'auren-star' },
  ashen: { renderer: 'legacy', targetArchetype: 'airless', materialId: 'ashen-airless' },
  vess: {
    renderer: 'legacy',
    targetArchetype: 'terrestrial',
    materialId: 'vess-terrestrial',
    entryVisual: {
      ...DEFAULT_ENTRY_VISUAL,
      glow: '#ff8a22',
      glowHot: '#fff2bf',
      trailPrimary: '#ffd05c',
      trailSecondary: '#ff7926',
      trailTertiary: '#8f2515',
      streak: '#fff0a8',
      wrapLayer: '#d95d28',
      shockwave: '#ffe7b0',
      strengthMultiplier: 0.84,
      lengthMultiplier: 0.9,
      opacityMultiplier: 1.12,
      glowMultiplier: 1.18,
      particleThreshold: 0.68,
    },
  },
  veyra: {
    renderer: 'terrestrial',
    targetArchetype: 'terrestrial',
    materialId: 'veyra-terrestrial',
    scatterProfile: 'veyra',
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
  rusk: {
    renderer: 'legacy',
    targetArchetype: 'terrestrial',
    materialId: 'rusk-terrestrial',
    entryVisual: {
      ...DEFAULT_ENTRY_VISUAL,
      glow: '#ff6a38',
      glowHot: '#ffe8cf',
      trailPrimary: '#ff9a55',
      trailSecondary: '#d94a2b',
      trailTertiary: '#6f1e1a',
      streak: '#ffd2a6',
      wrapLayer: '#b93a2b',
      shockwave: '#f3d1c7',
      strengthMultiplier: 1.16,
      lengthMultiplier: 1.18,
      opacityMultiplier: 0.92,
      glowMultiplier: 1.06,
      particleThreshold: 0.58,
    },
  },
  tyran: {
    renderer: 'legacy',
    targetArchetype: 'gas-giant',
    materialId: 'tyran-gas-giant',
    entryVisual: {
      ...DEFAULT_ENTRY_VISUAL,
      glow: '#62d9d2',
      glowHot: '#f4fff4',
      trailPrimary: '#b4f4d8',
      trailSecondary: '#65b8c2',
      trailTertiary: '#795a9f',
      streak: '#eeffe8',
      wrapLayer: '#5e8eb3',
      shockwave: '#ddb8ff',
      strengthMultiplier: 0.78,
      lengthMultiplier: 1.28,
      opacityMultiplier: 0.96,
      glowMultiplier: 1.14,
      particleThreshold: 0.7,
    },
  },
  brimm: { renderer: 'legacy', targetArchetype: 'airless', materialId: 'brimm-airless' },
  glacia: { renderer: 'legacy', targetArchetype: 'airless', materialId: 'glacia-airless' },
  mote: { renderer: 'legacy', targetArchetype: 'airless', materialId: 'mote-airless' },
  farfall: { renderer: 'legacy', targetArchetype: 'airless', materialId: 'farfall-airless' },
});
