export type BodyRendererKind = 'legacy' | 'terrestrial' | 'airless' | 'gas-giant' | 'star';

export interface BodyVisualDef {
  renderer: BodyRendererKind;
  targetArchetype: Exclude<BodyRendererKind, 'legacy'>;
  materialId: string;
  atmosphereVisual?: {
    /** Art-direction color only; physical density and thickness stay in AtmosphereDef. */
    wavelengthTint: readonly [number, number, number];
    strength: number;
  };
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
