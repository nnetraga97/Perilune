/**
 * Active-regime flight dynamics: 6-DOF rigid vessel around one primary body.
 *
 * State is stored relative to the SOI parent in that body's non-rotating
 * (inertial) frame, f64 throughout. Fixed timestep (ADR-005). Forces:
 * gravity, engine thrust (with gimbal), aerodynamics (cached model),
 * parachutes, RCS, reaction wheels, ground contact. Includes convective
 * heating with ablative shields and per-part temperature limits.
 */
import { Vec3 } from '../core/vec3';
import { Quat } from '../core/quat';
import {
  Craft,
  PartInstance,
  computeMassProperties,
  crossfeedComponent,
  defOf,
  G0,
  MassProperties,
  partWetMass,
} from './vessel';
import { AeroModel, buildAeroModel, evaluateAero, newAeroForces, AeroForces } from './aero';
import type { Body } from './universe';
import { groundRadiusInertial } from './terrain';
import { RESOURCE_DENSITY } from '../content/parts';

export type SasMode =
  | 'off'
  | 'stability'
  | 'prograde'
  | 'retrograde'
  | 'normal'
  | 'antinormal'
  | 'radial-out'
  | 'radial-in'
  | 'node'
  | 'custom';

export type Situation =
  | 'prelaunch'
  | 'landed'
  | 'splashed'
  | 'flying'
  | 'suborbital'
  | 'orbit'
  | 'escaping'
  | 'destroyed';

export interface ControlInputs {
  pitch: number; // -1..1
  yaw: number;
  roll: number;
  throttle: number; // 0..1
  rcs: boolean;
  translate: Vec3; // RCS translation, craft frame -1..1
}

export interface FlightEvent {
  time: number;
  text: string;
  severity: 'info' | 'warning' | 'danger';
}

export interface VesselRuntime {
  id: string;
  name: string;
  craft: Craft;
  bodyId: string;
  /** Position/velocity relative to the body, inertial frame (f64, m). */
  pos: Vec3;
  vel: Vec3;
  /** Craft→world attitude. */
  att: Quat;
  /** Angular velocity, craft frame (rad/s). */
  angVel: Vec3;
  situation: Situation;
  sas: SasMode;
  controls: ControlInputs;
  /** Next stage index to fire. */
  currentStage: number;
  /** Cached models, rebuilt on geometry change. */
  aeroModel: AeroModel;
  massProps: MassProperties;
  massDirtyCounter: number;
  /** Latest evaluated aero for HUD/structure. */
  aero: AeroForces;
  events: FlightEvent[];
  /** Set when the vessel is uncontrollable debris. */
  isDebris: boolean;
  /** Accumulated science data by experiment+situation key. */
  scienceData: Map<string, number>;
  /** Crew names aboard. */
  crew: string[];
  charge: { amount: number; capacity: number };
  landedBodyFixed: Vec3 | null;
  /** Proper acceleration magnitude (for g-force display + structure). */
  properAccel: number;
  /** Target direction (world frame) for SAS mode 'custom' and 'node'. */
  sasCustomDir: Vec3;
}

export function refreshDerived(v: VesselRuntime): void {
  v.aeroModel = buildAeroModel(v.craft);
  v.massProps = computeMassProperties(v.craft);
  let cap = 0;
  for (const p of v.craft.parts) {
    const b = defOf(p).battery;
    if (b) cap += b.capacity;
    const pod = defOf(p).pod;
    if (pod) cap += 50;
    if (defOf(p).probe) cap += 30;
  }
  v.charge.capacity = cap;
  v.charge.amount = Math.min(v.charge.amount, cap);
}

export function createVesselRuntime(
  id: string,
  name: string,
  craft: Craft,
  bodyId: string,
): VesselRuntime {
  const v: VesselRuntime = {
    id,
    name,
    craft,
    bodyId,
    pos: new Vec3(),
    vel: new Vec3(),
    att: new Quat(),
    angVel: new Vec3(),
    situation: 'prelaunch',
    sas: 'stability',
    controls: { pitch: 0, yaw: 0, roll: 0, throttle: 0, rcs: false, translate: new Vec3() },
    currentStage: 0,
    aeroModel: buildAeroModel(craft),
    massProps: computeMassProperties(craft),
    massDirtyCounter: 0,
    aero: newAeroForces(),
    events: [],
    isDebris: false,
    scienceData: new Map(),
    crew: [],
    charge: { amount: 0, capacity: 0 },
    landedBodyFixed: null,
    properAccel: 0,
    sasCustomDir: new Vec3(0, 1, 0),
  };
  refreshDerived(v);
  v.charge.amount = v.charge.capacity;
  return v;
}

export function logEvent(v: VesselRuntime, time: number, text: string, severity: FlightEvent['severity'] = 'info'): void {
  v.events.push({ time, text, severity });
  if (v.events.length > 200) v.events.shift();
}

// --- scratch vectors (module-level, no allocation in the tick) -------------
const _up = new Vec3();
const _grav = new Vec3();
const _thrust = new Vec3();
const _force = new Vec3();
const _torqueW = new Vec3();
const _torqueC = new Vec3();
const _axis = new Vec3();
const _vAir = new Vec3();
const _wind = new Vec3();
const _tmp = new Vec3();
const _tmp2 = new Vec3();
const _err = new Vec3();
const _bottom = new Vec3();
const _cmdTorque = new Vec3();
const _attInv = new Quat();
const _target = new Quat();
const _lever = new Vec3();
const _chuteF = new Vec3();
const _vRel = new Vec3();
const _refVel = new Vec3();

export interface StepContext {
  body: Body;
  time: number; // absolute sim time
  /** Sun direction (unit) in body-inertial frame for solar charging. */
  sunDir: Vec3;
}

export interface StepResult {
  /** Parts destroyed this tick (overheat/impact), for effects + splitting. */
  destroyedParts: number[];
  crashed: boolean;
  crashSpeed: number;
}

const stepResult: StepResult = { destroyedParts: [], crashed: false, crashSpeed: 0 };

/** True if the engine part can currently produce thrust. */
export function engineHasFuel(craft: Craft, part: PartInstance): boolean {
  const eng = defOf(part).engine!;
  if (eng.propellant === 'solidFuel') return (part.resources.solidFuel ?? 0) > 0;
  for (const key of crossfeedComponent(craft, part.key)) {
    const p = craft.parts.find((q) => q.key === key);
    if (p && (p.resources.propellant ?? 0) > 1e-9) return true;
  }
  return false;
}

/** Total available thrust (N) at current throttle=1 in current atmosphere. */
export function maxThrust(v: VesselRuntime, pressure: number): number {
  let total = 0;
  for (const p of v.craft.parts) {
    const eng = defOf(p).engine;
    if (!eng || !p.activated) continue;
    if (!engineHasFuel(v.craft, p)) continue;
    const frac = Math.min(1, pressure / 101_325);
    const isp = eng.ispVac + (eng.ispSea - eng.ispVac) * frac;
    total += eng.thrustVac * (isp / eng.ispVac);
  }
  return total;
}

/**
 * Advance the vessel by dt. Mutates vessel state in place.
 */
export function stepVessel(
  v: VesselRuntime,
  ctx: StepContext,
  dt: number,
): StepResult {
  stepResult.destroyedParts.length = 0;
  stepResult.crashed = false;
  stepResult.crashSpeed = 0;
  const { body, time } = ctx;

  // Periodic recompute of mass properties (fuel drain shifts CoM slowly).
  if (++v.massDirtyCounter >= 25) {
    v.massDirtyCounter = 0;
    v.massProps = computeMassProperties(v.craft);
  }
  const mass = v.massProps.mass;
  const com = v.massProps.com;

  const r = v.pos.length();
  const altitude = r - body.radius;
  _up.copy(v.pos).scale(1 / r);

  // ---------------------------------------------------------------- gravity
  const gMag = body.mu / (r * r);
  _grav.copy(_up).scale(-gMag * mass);
  _force.copy(_grav);
  _torqueW.set(0, 0, 0);

  // ------------------------------------------------------------- atmosphere
  const pressure = body.pressureAt(altitude);
  const density = body.densityAt(altitude);
  const sos = body.speedOfSoundAt(altitude);
  // Air co-rotates with the planet: v_wind = ω × r.
  const omega = body.def.rotationPeriod !== 0 ? (Math.PI * 2) / body.def.rotationPeriod : 0;
  _wind.set(-omega * v.pos.y, omega * v.pos.x, 0);
  Vec3.sub(v.vel, _wind, _vAir);

  // ------------------------------------------------------------ attitude control
  // Desired torque from SAS or manual input, craft frame.
  computeCommandTorque(v, body, _cmdTorque, dt);

  // Control authority: reaction wheels + pods (+ RCS below, + gimbal below).
  let wheelTorque = 0;
  for (const p of v.craft.parts) {
    const def = defOf(p);
    if (def.reactionWheel) wheelTorque += def.reactionWheel.torque;
    if (def.pod) wheelTorque += def.pod.torque;
    if (def.probe) wheelTorque += def.probe.torque;
  }
  const hasCharge = v.charge.amount > 0.01;
  if (!hasCharge) wheelTorque *= 0.05;
  _torqueC.set(
    clamp(_cmdTorque.x, -wheelTorque, wheelTorque),
    clamp(_cmdTorque.y, -wheelTorque * 0.6, wheelTorque * 0.6),
    clamp(_cmdTorque.z, -wheelTorque, wheelTorque),
  );

  // ---------------------------------------------------------------- engines
  let thrustMag = 0;
  const throttle = v.controls.throttle;
  let gimbalDemandPitch = clamp(_cmdTorque.x / Math.max(1, wheelTorque * 2 + 1e5), -1, 1);
  let gimbalDemandYaw = clamp(_cmdTorque.z / Math.max(1, wheelTorque * 2 + 1e5), -1, 1);
  for (const p of v.craft.parts) {
    const eng = defOf(p).engine;
    if (!eng || !p.activated) continue;
    const isSolid = eng.propellant === 'solidFuel';
    const effThrottle = isSolid ? 1 : throttle;
    if (effThrottle <= 0) continue;
    if (!engineHasFuel(v.craft, p)) continue;

    const frac = Math.min(1, pressure / 101_325);
    const isp = eng.ispVac + (eng.ispSea - eng.ispVac) * frac;
    const thrust = eng.thrustVac * (isp / eng.ispVac) * effThrottle;
    const flow = thrust / (isp * G0); // kg/s

    // Drain propellant.
    if (isSolid) {
      const units = (flow * dt) / RESOURCE_DENSITY.solidFuel;
      p.resources.solidFuel = Math.max(0, (p.resources.solidFuel ?? 0) - units);
    } else {
      drainPropellant(v.craft, p, (flow * dt) / RESOURCE_DENSITY.propellant);
    }

    // Thrust direction: craft +Y with gimbal deflection. Axis mapping: the
    // engine hangs below the CoM (lever ≈ −Y), so deflecting thrust along
    // −Z yields +X (pitch) torque and deflecting along +X yields +Z (yaw)
    // torque: (0,−d,0) × (0,0,F) = (−dF,0,0); (0,−d,0) × (F,0,0) = (0,0,dF).
    const gRad = (eng.gimbalDeg * Math.PI) / 180;
    _tmp.set(
      Math.sin(gRad * gimbalDemandYaw),
      1,
      -Math.sin(gRad * gimbalDemandPitch),
    ).normalize();
    v.att.rotate(_tmp, _thrust);
    _thrust.scale(thrust);
    _force.add(_thrust);
    thrustMag += thrust;

    // Torque from gimbal: engine position lever × thrust.
    _lever.set(p.position.x - com.x, p.position.y - com.y, p.position.z - com.z);
    v.att.rotate(_lever, _lever);
    Vec3.cross(_lever, _thrust, _tmp2);
    _torqueW.add(_tmp2);
  }

  // -------------------------------------------------------------------- RCS
  if (v.controls.rcs && hasCharge) {
    let rcsThrust = 0;
    for (const p of v.craft.parts) {
      const rcs = defOf(p).rcs;
      if (rcs && (findMonoprop(v.craft) > 0)) rcsThrust += rcs.thrust;
    }
    if (rcsThrust > 0) {
      // Translation
      const t = v.controls.translate;
      if (t.lengthSq() > 1e-6) {
        _tmp.copy(t).normalize().scale(rcsThrust);
        v.att.rotate(_tmp, _tmp);
        _force.add(_tmp);
        drainMonoprop(v.craft, (rcsThrust / (240 * G0)) * dt / RESOURCE_DENSITY.monoprop);
      }
      // Attitude assist
      const rcsTorque = rcsThrust * 2.2; // lever approximation
      _torqueC.x = clamp(_torqueC.x + clamp(_cmdTorque.x, -rcsTorque, rcsTorque) * 0.5, -wheelTorque - rcsTorque, wheelTorque + rcsTorque);
      _torqueC.z = clamp(_torqueC.z + clamp(_cmdTorque.z, -rcsTorque, rcsTorque) * 0.5, -wheelTorque - rcsTorque, wheelTorque + rcsTorque);
    }
  }

  // ------------------------------------------------------------------- aero
  evaluateAero(
    v.aeroModel,
    v.att,
    _vAir,
    density,
    sos,
    com.y,
    { pitch: v.controls.pitch, yaw: v.controls.yaw, roll: v.controls.roll },
    v.aero,
  );
  _force.add(v.aero.force);
  _torqueW.add(v.aero.torque);

  // ------------------------------------------------------------- parachutes
  for (const p of v.craft.parts) {
    const chute = defOf(p).parachute;
    if (!chute || !p.activated) continue;
    const terrainR = groundRadiusInertial(body, _up, time);
    const aglAlt = r - terrainR;
    let deployFrac = 0;
    if (p.deployed) deployFrac = 1;
    else if (pressure > 1000 && aglAlt < chute.semiDeployAlt) {
      if (aglAlt < chute.deployAlt) {
        p.deployed = true;
        deployFrac = 1;
        logEvent(v, time, `${defOf(p).name} fully deployed`);
      } else {
        deployFrac = 0.15; // semi-deployed
      }
    }
    if (deployFrac > 0) {
      const speed = _vAir.length();
      if (speed > 1) {
        const dragMag = 0.5 * density * speed * speed * chute.dragArea * deployFrac;
        // Cap so a snap deployment can't explode the integrator.
        const capped = Math.min(dragMag, mass * 120);
        _chuteF.copy(_vAir).scale(-capped / speed);
        _force.add(_chuteF);
        // Chutes stabilize: apply at part position.
        _lever.set(p.position.x - com.x, p.position.y - com.y, p.position.z - com.z);
        v.att.rotate(_lever, _lever);
        Vec3.cross(_lever, _chuteF, _tmp2);
        _torqueW.add(_tmp2);
      }
    }
  }

  // ------------------------------------------------------------ electricity
  stepElectricity(v, ctx, dt);

  // ---------------------------------------------------------------- heating
  stepThermal(v, ctx, density, dt);

  // ----------------------------------------------------------- ground contact
  const terrainR = groundRadiusInertial(body, _up, time);
  // Vessel bottom extent along craft -Y from CoM.
  let minY = Infinity;
  for (const p of v.craft.parts) {
    const def = defOf(p);
    let bottom = p.position.y - def.shape.height / 2;
    if (def.leg) bottom -= def.leg.length;
    minY = Math.min(minY, bottom);
  }
  const bottomOffset = com.y - minY;
  // World position of the bottom point.
  v.att.rotate(_tmp.set(0, -bottomOffset, 0), _bottom);
  _bottom.add(v.pos);
  const bottomR = _bottom.length();
  const penetration = terrainR - bottomR;

  const isOverOcean = body.def.terrain.oceanLevel > 0 && terrainR <= body.radius + 0.01;

  if (penetration > 0) {
    // All contact logic uses GROUND-RELATIVE velocity (the surface rotates
    // with the planet at hundreds of m/s in the inertial frame).
    _vRel.copy(v.vel).sub(_wind);
    const vRad = Vec3.dot(_vRel, _up);
    const vHoriz = _tmp2.copy(_vRel).addScaled(_up, -vRad).length();
    const impactSpeed = Math.max(-vRad, vHoriz * 0.4);

    // Crash check on first contact.
    if (v.situation !== 'landed' && v.situation !== 'splashed' && v.situation !== 'prelaunch') {
      const tolerance = crashToleranceOfLowestPart(v.craft);
      if (impactSpeed > tolerance) {
        stepResult.crashed = true;
        stepResult.crashSpeed = impactSpeed;
        return stepResult;
      }
    }

    // Spring-damper ground reaction (water is softer).
    const k = isOverOcean ? mass * 8 : mass * 40;
    const c = isOverOcean ? mass * 4 : mass * 9;
    const fN = Math.max(0, k * penetration - c * vRad);
    _tmp.copy(_up).scale(fN);
    _force.add(_tmp);
    // Friction: oppose horizontal motion relative to the ground.
    _tmp2.copy(_vRel).addScaled(_up, -vRad);
    const hSpeed = _tmp2.length();
    if (hSpeed > 0.01) {
      const fric = Math.min(fN * (isOverOcean ? 0.3 : 0.75), (hSpeed * mass) / dt);
      _tmp2.scale(-fric / hSpeed);
      _force.add(_tmp2);
    }
    // Contact torque: reaction applied at the bottom point rights/tips the craft.
    Vec3.sub(_bottom, v.pos, _lever);
    _tmp.copy(_up).scale(fN * 0.6);
    Vec3.cross(_lever, _tmp, _tmp2);
    _torqueW.add(_tmp2);
    // Strong angular damping in contact (legs absorb wobble).
    v.angVel.scale(Math.max(0, 1 - dt * 3));
  }

  // -------------------------------------------------------------- integrate
  const invMass = 1 / mass;
  v.properAccel = _tmp.copy(_force).sub(_grav).length() * invMass;
  v.vel.addScaled(_force, invMass * dt);
  v.pos.addScaled(v.vel, dt);

  // Rotation: world torque → craft frame, integrate with diagonal inertia.
  _attInv.copy(v.att).conjugate();
  _attInv.rotate(_torqueW, _tmp);
  _tmp.add(_torqueC);
  const I = v.massProps.inertia;
  v.angVel.x += (_tmp.x / I.x) * dt;
  v.angVel.y += (_tmp.y / I.y) * dt;
  v.angVel.z += (_tmp.z / I.z) * dt;
  // Rotational damping from air (prevents endless spin in atmosphere).
  if (density > 0.001) {
    const damp = Math.max(0, 1 - dt * density * 0.6);
    v.angVel.scale(damp);
  }
  v.att.integrate(v.angVel, dt);

  // --------------------------------------------------------- situation update
  updateSituation(v, ctx, penetration > -0.5, isOverOcean);

  return stepResult;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function crashToleranceOfLowestPart(craft: Craft): number {
  let minY = Infinity;
  let tol = 8;
  for (const p of craft.parts) {
    const def = defOf(p);
    let bottom = p.position.y - def.shape.height / 2;
    if (def.leg) bottom -= def.leg.length;
    if (bottom < minY) {
      minY = bottom;
      tol = def.leg ? def.crashTolerance : def.crashTolerance;
    }
  }
  return tol;
}

function findMonoprop(craft: Craft): number {
  let total = 0;
  for (const p of craft.parts) total += p.resources.monoprop ?? 0;
  return total;
}

function drainMonoprop(craft: Craft, units: number): void {
  for (const p of craft.parts) {
    const have = p.resources.monoprop ?? 0;
    if (have <= 0) continue;
    const take = Math.min(have, units);
    p.resources.monoprop = have - take;
    units -= take;
    if (units <= 0) return;
  }
}

function drainPropellant(craft: Craft, engine: PartInstance, units: number): void {
  // Drain evenly from tanks in the crossfeed pool (bottom tanks first would
  // be more realistic; even drain keeps CoM steadier and is kinder).
  const pool: PartInstance[] = [];
  for (const key of crossfeedComponent(craft, engine.key)) {
    const p = craft.parts.find((q) => q.key === key);
    if (p && (p.resources.propellant ?? 0) > 0) pool.push(p);
  }
  if (!pool.length) return;
  let remaining = units;
  // Two passes: proportional, then sweep leftovers.
  const total = pool.reduce((s, p) => s + (p.resources.propellant ?? 0), 0);
  for (const p of pool) {
    const share = ((p.resources.propellant ?? 0) / total) * units;
    const take = Math.min(p.resources.propellant ?? 0, share);
    p.resources.propellant = (p.resources.propellant ?? 0) - take;
    remaining -= take;
  }
  if (remaining > 1e-12) {
    for (const p of pool) {
      const take = Math.min(p.resources.propellant ?? 0, remaining);
      p.resources.propellant = (p.resources.propellant ?? 0) - take;
      remaining -= take;
      if (remaining <= 1e-12) break;
    }
  }
}

function stepElectricity(v: VesselRuntime, ctx: StepContext, dt: number): void {
  let net = 0;
  for (const p of v.craft.parts) {
    const def = defOf(p);
    if (def.solar) {
      // Facing factor: panels ignore orientation for M1 simplicity, but
      // eclipse matters: body shadow when sun is behind the planet.
      const rDir = _tmp.copy(v.pos).normalize();
      const behind = Vec3.dot(rDir, ctx.sunDir) < -0.15 && v.pos.length() < ctx.body.soiRadius;
      const lit = !behind;
      if (lit) net += def.solar.chargeRate;
    }
    if (def.probe) net -= 0.35;
    if (def.pod) net -= 0.15;
  }
  if (v.sas !== 'off') net -= 0.4;
  v.charge.amount = clamp(v.charge.amount + net * dt, 0, v.charge.capacity);
}

function stepThermal(v: VesselRuntime, ctx: StepContext, density: number, dt: number): void {
  const flux = v.aero.heatFlux; // 0.5 ρ v³
  if (flux < 100 && density < 1e-7) {
    // Cheap cooling pass only when nothing is hot.
    for (const p of v.craft.parts) {
      if (p.temperature && p.temperature > 260) {
        p.temperature = Math.max(250, p.temperature - dt * 30);
      }
    }
    return;
  }
  // Which end of the craft faces the airflow decides who gets hot.
  const w = (1 + v.aero.flowAlign) / 2; // 1 = nose-first, 0 = tail-first
  for (const p of v.craft.parts) {
    const def = defOf(p);
    const frac = v.aeroModel.axialFrac.get(p.key) ?? 0.5;
    const exposure =
      0.15 + 0.85 * (w * frac * frac + (1 - w) * (1 - frac) * (1 - frac));
    let temp = p.temperature ?? 280;
    // Heat shields facing the flow soak heat into ablator instead.
    // Scale tuned so subsonic flight is warm at most and re-entry at
    // ~2.8 km/s demands a heat shield (see ascent integration test).
    const heatIn = (flux * exposure) / 6.0e6;
    if (def.heatShield && (p.resources.ablator ?? 0) > 0 && heatIn > 2) {
      const ablate = Math.min(p.resources.ablator ?? 0, heatIn * dt * 0.09);
      p.resources.ablator = (p.resources.ablator ?? 0) - ablate;
      temp += heatIn * dt * 0.12; // shield still warms, slowly
    } else {
      temp += heatIn * dt;
    }
    // Radiative + convective cooling.
    const cooling = (temp - 270) * (0.02 + density * 0.06) + Math.pow(temp / 1000, 4) * 6;
    temp -= cooling * dt;
    p.temperature = Math.max(200, temp);
    if (temp > def.maxTemp) {
      stepResult.destroyedParts.push(p.key);
    }
  }
}

// PID-ish attitude controller state is folded into angVel damping; the SAS
// computes a commanded torque from attitude error and angular velocity.
function computeCommandTorque(v: VesselRuntime, body: Body, out: Vec3, dt: number): void {
  out.set(0, 0, 0);
  const manual =
    Math.abs(v.controls.pitch) > 0.01 ||
    Math.abs(v.controls.yaw) > 0.01 ||
    Math.abs(v.controls.roll) > 0.01;

  const I = v.massProps.inertia;
  if (manual) {
    const rate = 0.9; // target rad/s at full stick
    out.x = (v.controls.pitch * rate - v.angVel.x) * I.x * 2.5;
    out.z = (v.controls.yaw * rate - v.angVel.z) * I.z * 2.5;
    out.y = (v.controls.roll * rate * 1.4 - v.angVel.y) * I.y * 2.5;
    return;
  }

  if (v.sas === 'off') return;

  if (v.sas === 'stability') {
    // Kill rotation.
    out.set(-v.angVel.x * I.x * 3.2, -v.angVel.y * I.y * 3.2, -v.angVel.z * I.z * 3.2);
    return;
  }

  // Directional modes: aim craft +Y at the target direction.
  // Prograde/retrograde are SURFACE-relative in the atmosphere (and close to
  // airless ground) and orbital above — matching what a pilot needs during
  // ascent, entry, and landing burns.
  const rNow = v.pos.length();
  const altNow = rNow - body.radius;
  const surfaceRef =
    altNow < (body.def.atmosphere?.height ?? Math.max(10_000, body.radius * 0.08));
  const om = body.def.rotationPeriod !== 0 ? (Math.PI * 2) / body.def.rotationPeriod : 0;
  _refVel.copy(v.vel);
  if (surfaceRef && om !== 0) {
    _refVel.x += om * v.pos.y;
    _refVel.y -= om * v.pos.x;
  }
  const dir = _err;
  switch (v.sas) {
    case 'prograde':
      dir.copy(_refVel).normalize();
      break;
    case 'retrograde':
      dir.copy(_refVel).normalize().negate();
      break;
    case 'normal': {
      Vec3.cross(v.pos, v.vel, dir).normalize();
      break;
    }
    case 'antinormal': {
      Vec3.cross(v.pos, v.vel, dir).normalize().negate();
      break;
    }
    case 'radial-out':
      dir.copy(v.pos).normalize();
      break;
    case 'radial-in':
      dir.copy(v.pos).normalize().negate();
      break;
    case 'custom':
    case 'node':
      dir.copy(v.sasCustomDir).normalize();
      break;
    default:
      dir.copy(v.vel).normalize();
  }

  // Error quaternion between current +Y and target dir.
  v.att.rotate(_tmp.set(0, 1, 0), _tmp);
  const cross = Vec3.cross(_tmp, dir, _tmp2);
  const dot = clamp(Vec3.dot(_tmp, dir), -1, 1);
  const angle = Math.acos(dot);
  if (angle < 1e-4) {
    out.set(-v.angVel.x * I.x * 3, -v.angVel.y * I.y * 3, -v.angVel.z * I.z * 3);
    return;
  }
  cross.normalize();
  // Convert world-frame rotation axis into craft frame.
  _attInv.copy(v.att).conjugate();
  _attInv.rotate(cross, cross);
  // PD: proportional on angle, derivative on angular rate.
  const kp = 4.2;
  const kd = 3.4;
  out.x = cross.x * angle * kp * I.x - v.angVel.x * kd * I.x;
  out.y = cross.y * angle * kp * I.y - v.angVel.y * kd * I.y;
  out.z = cross.z * angle * kp * I.z - v.angVel.z * kd * I.z;
}

function updateSituation(
  v: VesselRuntime,
  ctx: StepContext,
  inContact: boolean,
  overOcean: boolean,
): void {
  const body = ctx.body;
  const r = v.pos.length();
  const altitude = r - body.radius;
  const speed = v.vel.length();
  const atmoTop = body.def.atmosphere?.height ?? 0;

  if (inContact) {
    // Surface speed relative to rotating ground.
    const omega = body.def.rotationPeriod !== 0 ? (Math.PI * 2) / body.def.rotationPeriod : 0;
    _wind.set(-omega * v.pos.y, omega * v.pos.x, 0);
    const groundSpeed = _tmp.copy(v.vel).sub(_wind).length();
    if (groundSpeed < 0.6) {
      if (v.situation !== 'landed' && v.situation !== 'splashed' && v.situation !== 'prelaunch') {
        logEvent(v, ctx.time, overOcean ? `Splashed down on ${body.name}` : `Landed on ${body.name}`);
      }
      if (v.situation !== 'prelaunch' || speed > 1) {
        v.situation = overOcean ? 'splashed' : 'landed';
      }
      return;
    }
    v.situation = 'flying';
    return;
  }

  if (altitude < atmoTop) {
    v.situation = 'flying';
    return;
  }
  // Above atmosphere: orbit vs suborbital vs escaping by specific energy.
  const energy = (speed * speed) / 2 - body.mu / r;
  if (energy >= 0) {
    v.situation = 'escaping';
    return;
  }
  const a = -body.mu / (2 * energy);
  const h = Vec3.cross(v.pos, v.vel, _tmp).length();
  const e = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (body.mu * body.mu)));
  const periapsis = a * (1 - e);
  v.situation = periapsis > body.radius + atmoTop ? 'orbit' : 'suborbital';
}
