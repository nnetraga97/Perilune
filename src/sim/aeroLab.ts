import { Quat } from '../core/quat';
import { Vec3 } from '../core/vec3';
import { buildAeroModel, evaluateAero, type AeroForces, type AeroModel } from './aero';
import type { Body, Universe } from './universe';
import { computeMassProperties, type Craft } from './vessel';
import { evaluateThermalExposure } from './aeroThermalExposure';

export type AeroLabEnvironmentToken =
  | 'earth-sl'
  | 'earth-vac'
  | 'moon'
  | 'veyra-sl'
  | 'veyra-vac'
  | 'palla';

export interface AeroLabEnvironment {
  body: Body;
  altitude: number;
  vacuum: boolean;
}

export interface AeroLabCondition {
  altitude: number;
  mach: number;
  orientationDeg: number;
}

export interface AeroLabReading {
  density: number;
  speed: number;
  mach: number;
  dynamicPressure: number;
  drag: number;
  lift: number;
  liftToDrag: number | null;
  torque: number;
  heatFlux: number;
  modelAoaDeg: number;
  flowAlign: number;
  mass: number;
  comY: number;
  copY: number;
  thermalExposure: ReadonlyMap<number, number>;
  force: Vec3;
}

export function resolveAeroLabEnvironment(
  universe: Universe,
  token: AeroLabEnvironmentToken,
): AeroLabEnvironment {
  const vacuum = token.endsWith('-vac');
  const bodyId = token.startsWith('earth')
    ? 'earth'
    : token.startsWith('veyra') ? 'veyra' : token;
  const body = universe.get(bodyId);
  return {
    body,
    altitude: vacuum ? body.def.atmosphere?.height ?? 0 : 0,
    vacuum,
  };
}

export function evaluateAeroLab(
  craft: Craft,
  body: Body,
  condition: AeroLabCondition,
  model: AeroModel = buildAeroModel(craft),
): AeroLabReading {
  const props = computeMassProperties(craft);
  const density = body.densityAt(condition.altitude);
  const soundSpeed = body.speedOfSoundAt(condition.altitude);
  const speed = condition.mach * soundSpeed;
  const angle = condition.orientationDeg * Math.PI / 180;
  const velocity = new Vec3(Math.sin(angle) * speed, Math.cos(angle) * speed, 0);
  const out: AeroForces = {
    force: new Vec3(),
    torque: new Vec3(),
    dynamicPressure: 0,
    mach: 0,
    aoa: 0,
    heatFlux: 0,
    flowAlign: 1,
  };
  evaluateAero(
    model,
    new Quat(),
    velocity,
    density,
    soundSpeed,
    props.com.y,
    { pitch: 0, yaw: 0, roll: 0 },
    out,
  );
  const direction = speed > 0 ? velocity.clone().scale(1 / speed) : new Vec3(0, 1, 0);
  const drag = Math.max(0, -Vec3.dot(out.force, direction));
  const liftVector = out.force.clone().add(direction.scale(drag));
  const lift = liftVector.length();
  return {
    density,
    speed,
    mach: out.mach,
    dynamicPressure: out.dynamicPressure,
    drag,
    lift,
    liftToDrag: drag > 1e-6 ? lift / drag : null,
    torque: out.torque.length(),
    heatFlux: out.heatFlux,
    modelAoaDeg: out.aoa * 180 / Math.PI,
    flowAlign: out.flowAlign,
    mass: props.mass,
    comY: props.com.y,
    copY: model.copY,
    thermalExposure: evaluateThermalExposure(craft, model, out.flowAlign),
    force: out.force.clone(),
  };
}
