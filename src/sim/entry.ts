/**
 * Pure atmospheric-entry and terrain-impact prediction.
 *
 * The predictor integrates disposable state copies. It intentionally uses a
 * simple ballistic attitude (axial drag area) so it is useful for planning
 * without pretending to reproduce player guidance or control inputs.
 */
import { periapsisOf, periodOf, stateToElements } from '../core/orbit';
import { Vec3 } from '../core/vec3';
import type { AeroModel } from './aero';
import { groundRadiusInertial } from './terrain';
import type { Body } from './universe';
import { inertialToBodyFixed, surfaceVelocity } from './bodyOrientation';
import { G0 } from './vessel';

export interface EntryPrediction {
  willEnter: boolean;
  lands: boolean;
  landingDirBF: Vec3 | null;
  landingTime: number;
  /** First atmospheric-interface crossing time, or 0 when no atmosphere is reached. */
  entryTime: number;
  impactSpeed: number;
  peakHeatFlux: number;
  peakG: number;
  samples: Vec3[];
}

const MAX_PREDICTION_SECONDS = 21_600;
const MAX_ITERATIONS = 100_000;
const MAX_SAMPLES = 2_048;

function emptyPrediction(samples: Vec3[] = []): EntryPrediction {
  return {
    willEnter: false,
    lands: false,
    landingDirBF: null,
    landingTime: 0,
    entryTime: 0,
    impactSpeed: 0,
    peakHeatFlux: 0,
    peakG: 0,
    samples,
  };
}

function clearance(body: Body, position: Readonly<Vec3>, time: number): number {
  const direction = new Vec3(position.x, position.y, position.z).normalize();
  return position.length() - groundRadiusInertial(body, direction, time);
}

function inertialDirectionToBodyFixed(
  body: Body,
  position: Readonly<Vec3>,
  time: number,
): Vec3 {
  return inertialToBodyFixed(body, time, position, new Vec3()).normalize();
}

function gasTerminalReason(body: Body, altitude: number): string | null {
  if (body.def.surfaceKind !== 'gas') return null;
  if (body.pressureAt(altitude) >= (body.def.terminalPressurePa ?? Infinity)) {
    return 'pressure';
  }
  if (altitude <= -(body.def.terminalDepthMeters ?? Infinity)) return 'depth';
  return null;
}

function canReachEntryBoundary(
  body: Body,
  position: Readonly<Vec3>,
  velocity: Readonly<Vec3>,
  startTime: number,
): { reaches: boolean; period: number } {
  const atmosphereTop = body.def.atmosphere?.height ?? 0;
  const relief = body.def.terrain.amplitude;
  const outerRadius = body.radius + Math.max(atmosphereTop, relief);
  if (position.length() <= outerRadius) return { reaches: true, period: Infinity };

  const angularMomentum = Vec3.cross(position, velocity, new Vec3()).length();
  const radialMotion = Vec3.dot(position, velocity);
  if (angularMomentum < 1e-6) {
    return { reaches: radialMotion < 0, period: Infinity };
  }

  const elements = stateToElements(body.mu, position, velocity, startTime);
  const periapsis = periapsisOf(elements);
  const inboundOrClosed = elements.e < 1 || radialMotion < 0;
  return {
    reaches: inboundOrClosed && Number.isFinite(periapsis) && periapsis <= outerRadius,
    period: periodOf(elements),
  };
}

/**
 * Predict the current ballistic trajectory until terrain contact or a bounded
 * horizon. Inputs are never mutated.
 */
export function predictEntry(
  body: Body,
  model: AeroModel,
  mass: number,
  position: Readonly<Vec3>,
  velocity: Readonly<Vec3>,
  startTime: number,
): EntryPrediction {
  if (!(mass > 0) || !Number.isFinite(mass)) {
    throw new Error('Entry prediction requires a finite positive mass');
  }
  if (!position.isFinite() || !velocity.isFinite() || !Number.isFinite(startTime)) {
    throw new Error('Entry prediction requires finite state vectors and time');
  }

  const reach = canReachEntryBoundary(body, position, velocity, startTime);
  const initialSample = new Vec3(position.x, position.y, position.z);
  if (!reach.reaches) return emptyPrediction([initialSample]);

  const r = initialSample.clone();
  const v = new Vec3(velocity.x, velocity.y, velocity.z);
  const previousR = r.clone();
  const previousV = v.clone();
  const samples = [initialSample];
  const horizon = Math.min(
    Number.isFinite(reach.period) ? reach.period * 2 : MAX_PREDICTION_SECONDS,
    MAX_PREDICTION_SECONDS,
  );
  const endTime = startTime + Math.max(1, horizon);
  const atmosphereTop = body.def.atmosphere?.height ?? 0;
  const cdA = Math.max(0, model.areaAxial * model.cdAxial);
  const rotatingSurfaceVelocity = new Vec3();
  let time = startTime;
  let entered = false;
  let entryTime = 0;
  let peakHeatFlux = 0;
  let peakG = 0;
  let previousTime = time;
  let previousClearance = body.def.surfaceKind === 'solid' ? clearance(body, r, time) : Infinity;

  for (let iteration = 0; iteration < MAX_ITERATIONS && time < endTime; iteration++) {
    const radius = r.length();
    const altitude = radius - body.radius;
    const atmospheric = !!body.def.atmosphere && altitude < atmosphereTop;
    if (atmospheric && !entered) entryTime = time;
    entered ||= atmospheric;
    const dt = Math.min(atmospheric ? 0.25 : 2, endTime - time);

    previousR.copy(r);
    previousV.copy(v);
    previousTime = time;
    if (body.def.surfaceKind === 'solid') {
      previousClearance = clearance(body, r, time);
    }

    const acceleration = new Vec3(r.x, r.y, r.z).scale(
      -body.mu / (radius * radius * radius),
    );
    let dragDensity = 0;
    if (atmospheric) {
      const airVelocity = new Vec3(v.x, v.y, v.z).sub(
        surfaceVelocity(body, r, rotatingSurfaceVelocity),
      );
      const speed = airVelocity.length();
      dragDensity = body.densityAt(altitude);
      if (speed > 0 && dragDensity > 0) {
        peakHeatFlux = Math.max(
          peakHeatFlux,
          0.5 * dragDensity * speed * speed * speed,
        );
      }
    }

    v.addScaled(acceleration, dt);
    if (atmospheric && dragDensity > 0 && cdA > 0) {
      const surface = surfaceVelocity(body, r, rotatingSurfaceVelocity);
      const airVelocity = new Vec3(v.x, v.y, v.z).sub(surface);
      const speed = airVelocity.length();
      if (speed > 0) {
        const dragK = (0.5 * dragDensity * cdA) / mass;
        peakG = Math.max(peakG, dragK * speed * speed / G0);
        const nextSpeed = speed / (1 + dragK * speed * dt);
        v.addScaled(airVelocity, nextSpeed / speed - 1);
      }
    }
    r.addScaled(v, dt);
    time += dt;

    if (samples.length < MAX_SAMPLES && (iteration % 8 === 0 || atmospheric)) {
      samples.push(r.clone());
    }

    const terminalReason = gasTerminalReason(body, r.length() - body.radius);
    if (terminalReason) {
      const relativeVelocity = v.clone().sub(
        surfaceVelocity(body, r, rotatingSurfaceVelocity),
      );
      return {
        willEnter: true,
        lands: false,
        landingDirBF: null,
        landingTime: time,
        entryTime,
        impactSpeed: relativeVelocity.length(),
        peakHeatFlux,
        peakG,
        samples,
      };
    }

    const currentClearance = body.def.surfaceKind === 'solid' ? clearance(body, r, time) : Infinity;
    if (body.def.surfaceKind === 'solid' && currentClearance <= 0) {
      const denominator = previousClearance - currentClearance;
      const fraction = denominator > 0 ? Math.min(1, Math.max(0, previousClearance / denominator)) : 1;
      const landingPosition = Vec3.lerp(previousR, r, fraction, new Vec3());
      const landingVelocity = Vec3.lerp(previousV, v, fraction, new Vec3());
      const landingTime = previousTime + dt * fraction;
      const impactSpeed = landingVelocity
        .sub(surfaceVelocity(body, landingPosition, rotatingSurfaceVelocity))
        .length();
      return {
        willEnter: true,
        lands: true,
        landingDirBF: inertialDirectionToBodyFixed(body, landingPosition, landingTime),
        landingTime,
        entryTime,
        impactSpeed,
        peakHeatFlux,
        peakG,
        samples,
      };
    }
  }

  return {
    willEnter: entered || reach.reaches,
    lands: false,
    landingDirBF: null,
    landingTime: 0,
    entryTime,
    impactSpeed: 0,
    peakHeatFlux,
    peakG,
    samples,
  };
}
