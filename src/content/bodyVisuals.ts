export type BodyRendererKind = 'legacy' | 'terrestrial' | 'airless' | 'gas-giant' | 'star';

export interface BodyVisualDef {
  renderer: BodyRendererKind;
  targetArchetype: Exclude<BodyRendererKind, 'legacy'>;
  materialId: string;
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
  veyra: { renderer: 'legacy', targetArchetype: 'terrestrial', materialId: 'veyra-terrestrial' },
  palla: { renderer: 'legacy', targetArchetype: 'airless', materialId: 'palla-airless' },
  wisp: { renderer: 'legacy', targetArchetype: 'airless', materialId: 'wisp-airless' },
  rusk: { renderer: 'legacy', targetArchetype: 'terrestrial', materialId: 'rusk-terrestrial' },
  tyran: { renderer: 'legacy', targetArchetype: 'gas-giant', materialId: 'tyran-gas-giant' },
  brimm: { renderer: 'legacy', targetArchetype: 'airless', materialId: 'brimm-airless' },
  glacia: { renderer: 'legacy', targetArchetype: 'airless', materialId: 'glacia-airless' },
  mote: { renderer: 'legacy', targetArchetype: 'airless', materialId: 'mote-airless' },
  farfall: { renderer: 'legacy', targetArchetype: 'airless', materialId: 'farfall-airless' },
});
