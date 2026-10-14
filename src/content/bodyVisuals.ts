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

/** Thin scattering layer drawn above a compact globe (metres, per-metre coefficients). */
export interface CompactAtmosphereVisual {
  readonly height: number;
  readonly scaleHeight: number;
  readonly rayleigh: readonly [number, number, number];
  readonly mieScattering: readonly [number, number, number];
  readonly mieExtinction: readonly [number, number, number];
  readonly mieG: number;
  readonly multipleScattering: number;
}

export interface CompactPlanetVisualDef {
  limbColor: string;
  limbStrength: number;
  pointColor: string;
  /**
   * Disk-resolved reflectance model: Lunar-Lambert regolith, Mars-like dusty
   * rock, an opaque cloud deck, or a limb-darkened gas giant.
   */
  photometry?: 'airless' | 'rocky' | 'cloud-deck' | 'gas-giant';
  /** Relief recovered from albedo gradients; 0 keeps the sphere smooth. */
  relief?: number;
  /** Linear albedo gain applied after decoding the source mosaic. */
  gain?: number;
  /** Saturation multiplier for over-processed source colour. */
  saturation?: number;
  atmosphere?: CompactAtmosphereVisual;
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
  compactPlanetVisual?: CompactPlanetVisualDef;
  gasGiantVisual?: CompactPlanetVisualDef;
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
  | 'jupiter'
  | 'callisto'
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
      photometry: 'airless',
      relief: 0.6,
      gain: 1.2,
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
      photometry: 'cloud-deck',
      gain: 0.7,
      saturation: 1.2,
      // Sulfuric-acid haze above the cloud tops: a bright, soft limb and a
      // terminator that wraps well past the geometric edge.
      atmosphere: {
        height: 110_000,
        scaleHeight: 6_000,
        rayleigh: [2.9e-6, 6.8e-6, 16.6e-6],
        mieScattering: [2.6e-5, 2.45e-5, 2.0e-5],
        mieExtinction: [2.8e-5, 2.75e-5, 2.6e-5],
        mieG: 0.7,
        multipleScattering: 1.4,
      },
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
      photometry: 'rocky',
      relief: 0.4,
      gain: 1.3,
      // Thin CO2 with suspended dust: butterscotch daylight haze and a pale
      // limb, with Rayleigh only a few percent of Earth's.
      atmosphere: {
        height: 90_000,
        scaleHeight: 11_100,
        rayleigh: [2.3e-7, 5.4e-7, 1.32e-6],
        mieScattering: [1.9e-5, 1.45e-5, 0.95e-5],
        mieExtinction: [2.1e-5, 1.95e-5, 1.75e-5],
        mieG: 0.65,
        multipleScattering: 0.8,
      },
    },
  },
  jupiter: {
    renderer: 'gas-giant',
    targetArchetype: 'gas-giant',
    materialId: 'jupiter-cloud-bands',
    gasGiantVisual: {
      limbColor: '#d8c4a4',
      limbStrength: 0.34,
      pointColor: '#dfc69f',
      photometry: 'gas-giant',
      gain: 1.1,
      saturation: 0.82,
    },
  },
  callisto: {
    renderer: 'compact-planet',
    targetArchetype: 'airless',
    materialId: 'callisto-compact',
    compactPlanetVisual: {
      limbColor: '#8d8175',
      limbStrength: 0.035,
      pointColor: '#a99c8f',
      photometry: 'airless',
      relief: 0.5,
      gain: 1.45,
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
