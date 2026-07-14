/**
 * Aerodynamics: shape-aware, cached.
 *
 * When craft geometry changes we precompute an AeroModel: projected areas
 * along the craft axes, per-part exposure (nose-shielding), lift surfaces,
 * and a center of pressure. Per-tick evaluation is then O(wings + 1).
 *
 * The model captures the gameplay-relevant physics: drag scales with
 * orientation-dependent projected area and Mach, streamlined stacks beat
 * pancakes, nosecones shield what's behind them, fins at the tail stabilize,
 * lift depends on angle of attack with a stall break.
 */
import { Vec3 } from '../core/vec3';
import { Quat } from '../core/quat';
import { Craft, PartInstance, defOf } from './vessel';

export interface LiftSurface {
  partKey: number;
  /** Position relative craft origin. */
  position: Vec3;
  /** Surface normal in craft frame (panels lift along their normal). */
  normal: Vec3;
  area: number;
  control: boolean;
  maxDeflection: number; // rad
}

export interface AeroModel {
  /** Projected area (m^2) along +Y (nose), and lateral X/Z. */
  areaAxial: number;
  areaLateral: number;
  /** Drag coefficient along nose axis (streamlining) and laterally. */
  cdAxial: number;
  cdLateral: number;
  /** Center of pressure along craft Y (m, craft frame). */
  copY: number;
  liftSurfaces: LiftSurface[];
  /**
   * Per-part axial position 0 (tail) .. 1 (nose). Heating exposure is
   * derived at runtime from this and the actual flow direction, so both
   * nose-first ascent and engine-first re-entry heat the correct end.
   */
  axialFrac: Map<number, number>;
}

function partRadius(p: PartInstance): number {
  const s = defOf(p).shape;
  return Math.max(s.radiusTop ?? 0, s.radiusBottom ?? 0, (s.width ?? 0) / 2, 0.05);
}

/** Build the cached aero model for a craft. Call on geometry change only. */
export function buildAeroModel(craft: Craft): AeroModel {
  const liftSurfaces: LiftSurface[] = [];
  const axialFrac = new Map<number, number>();

  // Axial projected area: treat the craft as stacked discs; the largest
  // radius at each height band contributes. Approximate with the max part
  // radius among "column" parts plus radial extras at reduced weight.
  let maxStackR = 0;
  let lateralArea = 0;
  let noseY = -Infinity;
  let tailY = Infinity;
  let radialAreaSum = 0;

  for (const p of craft.parts) {
    const def = defOf(p);
    const r = partRadius(p);
    const h = def.shape.height;
    noseY = Math.max(noseY, p.position.y + h / 2);
    tailY = Math.min(tailY, p.position.y - h / 2);
    const onAxis = Math.abs(p.position.x) < 0.25 && Math.abs(p.position.z) < 0.25;
    if (onAxis) {
      maxStackR = Math.max(maxStackR, r);
    } else {
      radialAreaSum += Math.PI * r * r;
    }
    lateralArea += 2 * r * h * 0.7; // side silhouette approximation

    if (def.wing) {
      // Panel normal: local +Z rotated by part rotation.
      const q = new Quat(p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w);
      const normal = q.rotate(new Vec3(0, 0, 1), new Vec3());
      liftSurfaces.push({
        partKey: p.key,
        position: new Vec3(p.position.x, p.position.y, p.position.z),
        normal,
        area: def.wing.liftArea,
        control: !!def.wing.control,
        maxDeflection: ((def.wing.maxDeflection ?? 0) * Math.PI) / 180,
      });
    }
  }

  const areaAxial = Math.PI * maxStackR * maxStackR + radialAreaSum * 0.85;

  // Streamlining: does the top of the stack taper (nosecone/pod)?
  let noseCd = 0.75; // blunt default
  let bestNoseY = -Infinity;
  for (const p of craft.parts) {
    const def = defOf(p);
    const topY = p.position.y + def.shape.height / 2;
    if (topY >= bestNoseY - 0.01 && Math.abs(p.position.x) < 0.3 && Math.abs(p.position.z) < 0.3) {
      bestNoseY = Math.max(bestNoseY, topY);
      const rt = def.shape.radiusTop ?? (def.shape.width ?? 0.4) / 2;
      const rb = def.shape.radiusBottom ?? rt;
      if (def.shape.kind === 'cone' && rt < rb * 0.4) noseCd = 0.28;
      else if (def.shape.kind === 'cone' || def.shape.kind === 'dome') noseCd = 0.45;
      else noseCd = 0.7;
    }
  }

  // Center of pressure: area-weighted Y. Fins push it toward the tail.
  let copNum = 0;
  let copDen = 0;
  for (const p of craft.parts) {
    const r = partRadius(p);
    const def = defOf(p);
    let a = 2 * r * def.shape.height;
    if (def.wing) a += def.wing.liftArea * 3.6; // fins dominate lateral flow
    copNum += p.position.y * a;
    copDen += a;
  }
  const copY = copDen > 0 ? copNum / copDen : 0;

  // Axial position of each part along the stack, 0 (tail) .. 1 (nose).
  const span = Math.max(1, noseY - tailY);
  for (const p of craft.parts) {
    const def = defOf(p);
    const topY = p.position.y + def.shape.height / 2;
    axialFrac.set(p.key, Math.min(1, Math.max(0, (topY - tailY) / span)));
  }

  return {
    areaAxial,
    areaLateral: lateralArea,
    cdAxial: noseCd,
    cdLateral: 1.1,
    copY,
    liftSurfaces,
    axialFrac,
  };
}

export interface AeroForces {
  /** Total aero force, world frame (N). */
  force: Vec3;
  /** Torque about CoM, world frame (N·m). */
  torque: Vec3;
  dynamicPressure: number; // Pa
  mach: number;
  aoa: number; // rad
  /** Heating rate proxy (W/m^2-ish scale) for the thermal pass. */
  heatFlux: number;
  /**
   * Signed alignment of the craft nose with the direction of motion through
   * the air: +1 nose-first, −1 tail-first. Drives which end takes heating.
   */
  flowAlign: number;
}

const _vDir = new Vec3();
const _axisWorld = new Vec3();
const _dragF = new Vec3();
const _liftF = new Vec3();
const _lever = new Vec3();
const _tq = new Vec3();
const _sNormal = new Vec3();
const _sPos = new Vec3();

/**
 * Evaluate aero forces for the current state.
 * @param model cached aero model
 * @param att craft attitude (craft→world)
 * @param vAir velocity relative to the air mass, world frame (m/s)
 * @param density atmospheric density (kg/m^3)
 * @param speedOfSound m/s (0 = no atmosphere)
 * @param comY craft CoM height along craft Y (for CP lever arm)
 * @param controls normalized pitch/yaw/roll input (deflects control surfaces)
 * @param out result object (reused)
 */
export function evaluateAero(
  model: AeroModel,
  att: Readonly<Quat>,
  vAir: Readonly<Vec3>,
  density: number,
  speedOfSound: number,
  comY: number,
  controls: { pitch: number; yaw: number; roll: number },
  out: AeroForces,
): void {
  out.force.set(0, 0, 0);
  out.torque.set(0, 0, 0);
  const speed = vAir.length();
  out.dynamicPressure = 0.5 * density * speed * speed;
  out.mach = speedOfSound > 0 ? speed / speedOfSound : 0;
  out.aoa = 0;
  out.heatFlux = 0.5 * density * speed * speed * speed;
  if (density <= 0 || speed < 0.5) {
    out.flowAlign = 1;
    return;
  }

  _vDir.copy(vAir).scale(1 / speed);
  // Craft nose axis in world frame.
  att.rotate(_axisWorld.set(0, 1, 0), _axisWorld);
  const cosA = Math.max(-1, Math.min(1, Vec3.dot(_axisWorld, _vDir)));
  const aoa = Math.acos(Math.abs(cosA));
  out.aoa = aoa;
  out.flowAlign = cosA;

  // Mach drag rise (transonic bump, supersonic taper).
  const m = out.mach;
  let machFactor = 1;
  if (m > 0.8 && m < 1.2) machFactor = 1 + (m - 0.8) * 2.2;
  else if (m >= 1.2) machFactor = 1.9 - Math.min(0.7, (m - 1.2) * 0.12);

  // Blend axial/lateral area+Cd by angle of attack.
  const axialFrac = Math.abs(cosA);
  const area = model.areaAxial * axialFrac + model.areaLateral * (1 - axialFrac);
  const cd = model.cdAxial * axialFrac + model.cdLateral * (1 - axialFrac);
  const dragMag = out.dynamicPressure * area * cd * machFactor;
  _dragF.copy(_vDir).scale(-dragMag);
  out.force.add(_dragF);

  // Drag acts at the center of pressure → restoring (or upsetting) torque.
  // Lever arm from CoM to CP along the craft axis, world frame.
  const cpLever = model.copY - comY;
  _lever.copy(_axisWorld).scale(cpLever);
  Vec3.cross(_lever, _dragF, _tq);
  out.torque.add(_tq);

  // Lift surfaces: force along surface normal ∝ sin(2·local AoA)-ish.
  for (const surf of model.liftSurfaces) {
    att.rotate(_sNormal.copy(surf.normal), _sNormal);
    let sinLocal = -Vec3.dot(_sNormal, _vDir); // flow onto the panel face
    if (surf.control) {
      // Control deflection adds effective incidence.
      const rollMoment = surf.position.z * surf.normal.x - surf.position.x * surf.normal.z;
      const rollSign = Math.abs(rollMoment) > 1e-6 ? Math.sign(rollMoment) : 0;
      const cmd = controls.pitch * surf.normal.z
        + controls.yaw * surf.normal.x
        + controls.roll * rollSign;
      sinLocal += Math.sin(surf.maxDeflection) * Math.max(-1, Math.min(1, cmd));
    }
    // Stall: effectiveness collapses beyond ~20° incidence.
    const stall = Math.abs(sinLocal) > 0.35 ? 0.35 / Math.abs(sinLocal) : 1;
    const liftMag = out.dynamicPressure * surf.area * 1.35 * sinLocal * stall;
    _liftF.copy(_sNormal).scale(liftMag);
    out.force.add(_liftF);
    att.rotate(_sPos.set(surf.position.x, surf.position.y - comY, surf.position.z), _sPos);
    Vec3.cross(_sPos, _liftF, _tq);
    out.torque.add(_tq);
  }
}

export function newAeroForces(): AeroForces {
  return {
    force: new Vec3(),
    torque: new Vec3(),
    dynamicPressure: 0,
    mach: 0,
    aoa: 0,
    heatFlux: 0,
    flowAlign: 1,
  };
}
