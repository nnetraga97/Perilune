import { BODY_VISUALS } from '../content/bodyVisuals';
import type { BodyId, BodyRendererKind, BodyVisualDef } from '../content/bodyVisuals';
import type { Body, BodyDef, SurfaceKind } from '../sim/universe';

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

type Direction = Readonly<{ x: number; y: number; z: number }>;

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

/** Equirectangular UVs in the body-fixed frame: +Z north, atan2(y, x) longitude. */
export function bodyFixedUv(direction: Direction): { u: number; v: number } {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  const normalizedZ = length === 0 ? 0 : Math.max(-1, Math.min(1, direction.z / length));
  const longitude = Math.atan2(direction.y, direction.x) / (Math.PI * 2);

  return {
    u: longitude < 0 ? longitude + 1 : longitude,
    v: Math.asin(normalizedZ) / Math.PI + 0.5,
  };
}
