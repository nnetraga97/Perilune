import { BODY_VISUALS } from '../content/bodyVisuals';
import type { BodyId, BodyRendererKind, BodyVisualDef } from '../content/bodyVisuals';
import type { Body, BodyDef, SurfaceKind } from '../sim/universe';
export { bodyFixedUv } from './terrestrial/globalCoordinates';

export interface BodyMaterialDescriptor {
  bodyId: string;
  renderer: BodyRendererKind;
  identity: SurfaceKind;
  albedo: {
    low: string;
    mid: string;
    high: string;
    ocean: string | null;
  };
  orientationConvention: 'body-fixed-z-up-atan2-y-x';
}

function bodyDef(body: Body | BodyDef): BodyDef {
  return 'def' in body ? body.def : body;
}

export function bodyMaterialDescriptor(
  body: Body | BodyDef,
  visual?: Readonly<BodyVisualDef>,
): BodyMaterialDescriptor {
  const def = bodyDef(body);
  const assignment = visual ?? BODY_VISUALS[def.id as BodyId];
  if (!assignment) throw new Error(`Missing body visual assignment for ${def.id}`);

  return {
    bodyId: def.id,
    renderer: assignment.renderer,
    identity: def.surfaceKind,
    albedo: {
      low: def.terrain.colorLow,
      mid: def.terrain.colorMid,
      high: def.terrain.colorHigh,
      ocean: def.terrain.colorOcean ?? null,
    },
    orientationConvention: 'body-fixed-z-up-atan2-y-x',
  };
}
