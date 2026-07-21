import { Quat } from '../core/quat';
import { Vec3 } from '../core/vec3';
import { evaluateAttitudeTrack, evaluatePositionVelocityTrack } from './interpolate';
import type {
  AttitudeTrackDefinition,
  EvaluatedMissionDocking,
  EvaluatedMissionEntity,
  EvaluatedMissionFrame,
  EvaluatedMissionTelemetry,
  MissionCameraCueDefinition,
  MissionDefinition,
  MissionDockingDefinition,
  MissionEntityDefinition,
  MissionEventDefinition,
  MissionFrameDefinition,
  MissionPhaseDefinition,
  MissionQuaternion,
  MissionTelemetryChannelDefinition,
  MissionTrackDefinition,
  MissionVector3,
  PositionVelocityTrackDefinition,
} from './types';
import { validateMissionDefinition } from './validate';

interface MutablePose {
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly acceleration: Vec3;
  readonly attitude: Quat;
  readonly attachedToEntityId: string | null;
}

interface FrameTransform {
  readonly originPosition: Vec3;
  readonly originVelocity: Vec3;
  readonly originAcceleration: Vec3;
  readonly rotation: Quat;
  readonly angularVelocity: Vec3;
}

export class MissionEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissionEvaluationError';
  }
}

function vectorSnapshot(value: Readonly<Vec3>): MissionVector3 {
  return { x: value.x, y: value.y, z: value.z };
}

function quaternionSnapshot(value: Readonly<Quat>): MissionQuaternion {
  return { x: value.x, y: value.y, z: value.z, w: value.w };
}

export function quaternionFromBasis(xAxis: Readonly<Vec3>, yAxis: Readonly<Vec3>, zAxis: Readonly<Vec3>): Quat {
  const m00 = xAxis.x, m01 = yAxis.x, m02 = zAxis.x;
  const m10 = xAxis.y, m11 = yAxis.y, m12 = zAxis.y;
  const m20 = xAxis.z, m21 = yAxis.z, m22 = zAxis.z;
  const result = new Quat();
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const scale = 0.5 / Math.sqrt(trace + 1);
    result.set((m21 - m12) * scale, (m02 - m20) * scale, (m10 - m01) * scale, 0.25 / scale);
  } else if (m00 > m11 && m00 > m22) {
    const scale = 2 * Math.sqrt(1 + m00 - m11 - m22);
    result.set(0.25 * scale, (m01 + m10) / scale, (m02 + m20) / scale, (m21 - m12) / scale);
  } else if (m11 > m22) {
    const scale = 2 * Math.sqrt(1 + m11 - m00 - m22);
    result.set((m01 + m10) / scale, 0.25 * scale, (m12 + m21) / scale, (m02 - m20) / scale);
  } else {
    const scale = 2 * Math.sqrt(1 + m22 - m00 - m11);
    result.set((m02 + m20) / scale, (m12 + m21) / scale, 0.25 * scale, (m10 - m01) / scale);
  }
  return result.normalize();
}

function composeAttitude(parent: Readonly<Quat>, local: MissionQuaternion | Readonly<Quat>): Quat {
  return new Quat(parent.x, parent.y, parent.z, parent.w)
    .multiply(new Quat(local.x, local.y, local.z, local.w))
    .normalize();
}

export function clampMissionTime(definition: Pick<MissionDefinition, 'startTimeSeconds' | 'endTimeSeconds'>, timeSeconds: number): number {
  if (!Number.isFinite(timeSeconds)) throw new RangeError('Mission evaluation time must be finite');
  return Math.max(definition.startTimeSeconds, Math.min(definition.endTimeSeconds, timeSeconds));
}

export function findMissionPhase(
  phases: readonly MissionPhaseDefinition[],
  timeSeconds: number,
): MissionPhaseDefinition {
  if (phases.length === 0) throw new MissionEvaluationError('Cannot evaluate a mission with no phases');
  if (timeSeconds >= phases[phases.length - 1].endTimeSeconds) return phases[phases.length - 1];
  let low = 0;
  let high = phases.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const phase = phases[middle];
    if (timeSeconds < phase.startTimeSeconds) high = middle - 1;
    else if (timeSeconds >= phase.endTimeSeconds) low = middle + 1;
    else return phase;
  }
  throw new MissionEvaluationError(`No mission phase contains t=${timeSeconds}s`);
}

export function eventsAtMissionTime(
  events: readonly MissionEventDefinition[],
  timeSeconds: number,
): readonly MissionEventDefinition[] {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (events[middle].timeSeconds <= timeSeconds) low = middle + 1;
    else high = middle;
  }
  return events.slice(0, low);
}

/** Validates once, then evaluates complete immutable snapshots directly from time. */
export class MissionPlaybackState {
  readonly definition: MissionDefinition;

  private readonly entityById: ReadonlyMap<string, MissionEntityDefinition>;
  private readonly frameById: ReadonlyMap<string, MissionFrameDefinition>;
  private readonly trackById: ReadonlyMap<string, MissionTrackDefinition>;
  private readonly eventById: ReadonlyMap<string, MissionEventDefinition>;
  private readonly cueById: ReadonlyMap<string, MissionCameraCueDefinition>;
  private readonly dockingByChildId: ReadonlyMap<string, MissionDockingDefinition>;

  constructor(definition: unknown) {
    this.definition = validateMissionDefinition(definition);
    this.entityById = new Map(this.definition.entities.map((entity) => [entity.id, entity]));
    this.frameById = new Map(this.definition.frames.map((frame) => [frame.id, frame]));
    this.trackById = new Map(this.definition.tracks.map((track) => [track.id, track]));
    this.eventById = new Map(this.definition.events.map((event) => [event.id, event]));
    this.cueById = new Map(this.definition.cameraCues.map((cue) => [cue.id, cue]));
    this.dockingByChildId = new Map(this.definition.dockings.map((docking) => [docking.childEntityId, docking]));
  }

  evaluate(requestedTimeSeconds: number): EvaluatedMissionFrame {
    const timeSeconds = clampMissionTime(this.definition, requestedTimeSeconds);
    const phase = findMissionPhase(this.definition.phases, timeSeconds);
    const basePoses = new Map<string, MutablePose>();
    const baseResolving = new Set<string>();

    const resolveFrame = (frameId: string): FrameTransform => {
      const frame = this.frameById.get(frameId);
      if (frame === undefined) throw new MissionEvaluationError(`Unknown mission frame '${frameId}'`);
      if (frame.kind === 'body-centered-inertial') {
        if (frame.bodyId !== this.definition.focusBodyId) {
          throw new MissionEvaluationError(
            `Frame '${frame.id}' is centred on '${frame.bodyId}', not focus body '${this.definition.focusBodyId}'`,
          );
        }
        return {
          originPosition: new Vec3(),
          originVelocity: new Vec3(),
          originAcceleration: new Vec3(),
          rotation: new Quat(),
          angularVelocity: new Vec3(),
        };
      }

      const origin = resolveBasePose(frame.entityId);
      if (frame.kind === 'entity-local') {
        return {
          originPosition: origin.position.clone(),
          originVelocity: origin.velocity.clone(),
          originAcceleration: origin.acceleration.clone(),
          rotation: origin.attitude.clone(),
          // Entity angular-rate tracks are intentionally not part of this slice.
          angularVelocity: new Vec3(),
        };
      }

      const radiusSquared = origin.position.lengthSq();
      const angularMomentum = Vec3.cross(origin.position, origin.velocity, new Vec3());
      if (radiusSquared <= 1e-12 || angularMomentum.lengthSq() <= 1e-12) {
        throw new MissionEvaluationError(`Cannot construct LVLH frame '${frame.id}' from degenerate position/velocity`);
      }
      const radial = origin.position.clone().normalize();
      const normal = angularMomentum.clone().normalize();
      const alongTrack = Vec3.cross(normal, radial, new Vec3()).normalize();
      const rotation = quaternionFromBasis(radial, alongTrack, normal);

      // Derive the actual triad rate from r, v, and the Hermite acceleration.
      // This deliberately avoids the two-body h/r^2 shortcut: the Gateway
      // reference is a multi-body NRHO whose orbit normal also evolves.
      const radius = Math.sqrt(radiusSquared);
      const radialRate = radial.dot(origin.velocity);
      const radialDerivative = origin.velocity.clone().addScaled(radial, -radialRate).scale(1 / radius);
      const momentumDerivative = Vec3.cross(origin.position, origin.acceleration, new Vec3());
      const normalDerivative = momentumDerivative
        .clone()
        .addScaled(normal, -normal.dot(momentumDerivative))
        .scale(1 / angularMomentum.length());
      const alongDerivative = Vec3.cross(normalDerivative, radial, new Vec3())
        .add(Vec3.cross(normal, radialDerivative, new Vec3()));
      const angularVelocity = Vec3.cross(radial, radialDerivative, new Vec3())
        .add(Vec3.cross(alongTrack, alongDerivative, new Vec3()))
        .add(Vec3.cross(normal, normalDerivative, new Vec3()))
        .scale(0.5);
      return {
        originPosition: origin.position.clone(),
        originVelocity: origin.velocity.clone(),
        originAcceleration: origin.acceleration.clone(),
        rotation,
        angularVelocity,
      };
    };

    const resolveBasePose = (entityId: string): MutablePose => {
      const cached = basePoses.get(entityId);
      if (cached !== undefined) return cached;
      if (baseResolving.has(entityId)) throw new MissionEvaluationError(`Entity evaluation cycle reached '${entityId}'`);
      const entity = this.entityById.get(entityId);
      if (entity === undefined) throw new MissionEvaluationError(`Unknown mission entity '${entityId}'`);
      baseResolving.add(entityId);
      try {
        const positionTrack = this.requiredPositionTrack(entity.positionTrackId);
        const localState = evaluatePositionVelocityTrack(positionTrack, timeSeconds);
        const positionFrame = resolveFrame(positionTrack.frameId);
        const rotatedPosition = positionFrame.rotation.rotate(localState.position, new Vec3());
        const rotatedVelocity = positionFrame.rotation.rotate(localState.velocity, new Vec3());
        const rotatedAcceleration = positionFrame.rotation.rotate(localState.acceleration, new Vec3());
        const transportVelocity = Vec3.cross(positionFrame.angularVelocity, rotatedPosition, new Vec3());
        const position = positionFrame.originPosition.clone().add(rotatedPosition);
        const velocity = positionFrame.originVelocity.clone().add(rotatedVelocity).add(transportVelocity);
        const coriolisAcceleration = Vec3.cross(positionFrame.angularVelocity, rotatedVelocity, new Vec3()).scale(2);
        const centripetalAcceleration = Vec3.cross(
          positionFrame.angularVelocity,
          Vec3.cross(positionFrame.angularVelocity, rotatedPosition, new Vec3()),
          new Vec3(),
        );
        const acceleration = positionFrame.originAcceleration
          .clone()
          .add(rotatedAcceleration)
          .add(coriolisAcceleration)
          .add(centripetalAcceleration);

        let attitude = positionFrame.rotation.clone();
        if (entity.attitudeTrackId !== undefined) {
          const attitudeTrack = this.requiredAttitudeTrack(entity.attitudeTrackId);
          const localAttitude = evaluateAttitudeTrack(attitudeTrack, timeSeconds);
          const attitudeFrame = resolveFrame(attitudeTrack.frameId);
          attitude = composeAttitude(attitudeFrame.rotation, localAttitude);
        }
        const result: MutablePose = { position, velocity, acceleration, attitude, attachedToEntityId: null };
        basePoses.set(entityId, result);
        return result;
      } finally {
        baseResolving.delete(entityId);
      }
    };

    for (const entity of this.definition.entities) resolveBasePose(entity.id);

    const dockingStates = this.definition.dockings.map((docking): EvaluatedMissionDocking => {
      const softTime = this.requiredEvent(docking.softCaptureEventId).timeSeconds;
      const hardTime = this.requiredEvent(docking.hardDockEventId).timeSeconds;
      return {
        id: docking.id,
        childEntityId: docking.childEntityId,
        targetEntityId: docking.targetEntityId,
        status: timeSeconds >= hardTime ? 'hard-docked' : timeSeconds >= softTime ? 'soft-captured' : 'independent',
      };
    });
    const statusByDockingId = new Map(dockingStates.map((state) => [state.id, state.status]));
    const finalPoses = new Map<string, MutablePose>();
    const finalResolving = new Set<string>();
    const resolveFinalPose = (entityId: string): MutablePose => {
      const cached = finalPoses.get(entityId);
      if (cached !== undefined) return cached;
      if (finalResolving.has(entityId)) throw new MissionEvaluationError(`Docking evaluation cycle reached '${entityId}'`);
      finalResolving.add(entityId);
      try {
        const docking = this.dockingByChildId.get(entityId);
        if (docking !== undefined && statusByDockingId.get(docking.id) === 'hard-docked') {
          const target = resolveFinalPose(docking.targetEntityId);
          const dockedOffset = new Vec3(
            docking.dockedPosition.x,
            docking.dockedPosition.y,
            docking.dockedPosition.z,
          );
          const rotatedOffset = target.attitude.rotate(dockedOffset, new Vec3());
          const pose: MutablePose = {
            position: target.position.clone().add(rotatedOffset),
            // Angular transport across the small docking offset is outside this
            // content model; attached entities share station translational velocity.
            velocity: target.velocity.clone(),
            acceleration: target.acceleration.clone(),
            attitude: composeAttitude(target.attitude, docking.dockedAttitude),
            attachedToEntityId: docking.targetEntityId,
          };
          finalPoses.set(entityId, pose);
          return pose;
        }
        const base = basePoses.get(entityId);
        if (base === undefined) throw new MissionEvaluationError(`Missing base pose for entity '${entityId}'`);
        const pose: MutablePose = {
          position: base.position.clone(),
          velocity: base.velocity.clone(),
          acceleration: base.acceleration.clone(),
          attitude: base.attitude.clone(),
          attachedToEntityId: null,
        };
        finalPoses.set(entityId, pose);
        return pose;
      } finally {
        finalResolving.delete(entityId);
      }
    };

    const entities = this.definition.entities.map((definition): EvaluatedMissionEntity => {
      const pose = resolveFinalPose(definition.id);
      return {
        id: definition.id,
        kind: definition.kind,
        label: definition.label,
        bodyId: definition.bodyId,
        position: vectorSnapshot(pose.position),
        velocity: vectorSnapshot(pose.velocity),
        attitude: quaternionSnapshot(pose.attitude),
        visual: definition.visual,
        fidelity: definition.fidelity,
        attachedToEntityId: pose.attachedToEntityId,
      };
    });
    const entitiesById: Readonly<Record<string, EvaluatedMissionEntity>> = Object.fromEntries(
      entities.map((entity) => [entity.id, entity]),
    );
    const telemetry = this.definition.telemetryChannels.map((channel) =>
      this.evaluateTelemetry(channel, timeSeconds, entitiesById));
    const telemetryById: Readonly<Record<string, EvaluatedMissionTelemetry>> = Object.fromEntries(
      telemetry.map((channel) => [channel.id, channel]),
    );
    const occurredEvents = eventsAtMissionTime(this.definition.events, timeSeconds);

    return {
      missionId: this.definition.id,
      focusBodyId: this.definition.focusBodyId,
      timeSeconds,
      universeTimeSeconds: this.definition.referenceEpochJ2000Seconds + timeSeconds,
      phase,
      events: occurredEvents,
      latestEvent: occurredEvents[occurredEvents.length - 1] ?? null,
      entities,
      entitiesById,
      dockings: dockingStates,
      telemetry,
      telemetryById,
      directorCue: this.resolveCameraCue(phase, timeSeconds),
    };
  }

  private requiredPositionTrack(id: string): PositionVelocityTrackDefinition {
    const track = this.trackById.get(id);
    if (track?.kind !== 'position-velocity') throw new MissionEvaluationError(`Missing position track '${id}'`);
    return track;
  }

  private requiredAttitudeTrack(id: string): AttitudeTrackDefinition {
    const track = this.trackById.get(id);
    if (track?.kind !== 'attitude') throw new MissionEvaluationError(`Missing attitude track '${id}'`);
    return track;
  }

  private requiredEvent(id: string): MissionEventDefinition {
    const event = this.eventById.get(id);
    if (event === undefined) throw new MissionEvaluationError(`Missing mission event '${id}'`);
    return event;
  }

  private resolveCameraCue(phase: MissionPhaseDefinition, timeSeconds: number): MissionCameraCueDefinition {
    let timedCue: MissionCameraCueDefinition | null = null;
    for (const cue of this.definition.cameraCues) {
      if (cue.startTimeSeconds === undefined || cue.endTimeSeconds === undefined) continue;
      const contains = timeSeconds >= cue.startTimeSeconds
        && (timeSeconds < cue.endTimeSeconds
          || (timeSeconds === this.definition.endTimeSeconds
            && cue.endTimeSeconds === this.definition.endTimeSeconds));
      if (contains && (timedCue === null || cue.startTimeSeconds >= (timedCue.startTimeSeconds ?? -Infinity))) timedCue = cue;
    }
    if (timedCue !== null) return timedCue;
    const phaseCue = this.cueById.get(phase.defaultCameraCueId);
    if (phaseCue === undefined) throw new MissionEvaluationError(`Missing phase camera cue '${phase.defaultCameraCueId}'`);
    return phaseCue;
  }

  private evaluateTelemetry(
    channel: MissionTelemetryChannelDefinition,
    timeSeconds: number,
    entities: Readonly<Record<string, EvaluatedMissionEntity>>,
  ): EvaluatedMissionTelemetry {
    let value: number;
    if (channel.kind === 'elapsed-time') {
      value = timeSeconds - this.definition.startTimeSeconds;
    } else {
      const entity = channel.entityId === undefined ? undefined : entities[channel.entityId];
      const target = channel.relativeToEntityId === undefined ? undefined : entities[channel.relativeToEntityId];
      if (entity === undefined || target === undefined) {
        throw new MissionEvaluationError(`Telemetry channel '${channel.id}' references a missing entity`);
      }
      const relativePosition = new Vec3(
        entity.position.x - target.position.x,
        entity.position.y - target.position.y,
        entity.position.z - target.position.z,
      );
      const relativeVelocity = new Vec3(
        entity.velocity.x - target.velocity.x,
        entity.velocity.y - target.velocity.y,
        entity.velocity.z - target.velocity.z,
      );
      if (channel.kind === 'range') value = relativePosition.length();
      else if (channel.kind === 'relative-speed') value = relativeVelocity.length();
      else {
        const range = relativePosition.length();
        value = range <= 1e-12 ? 0 : -relativePosition.dot(relativeVelocity) / range;
      }
    }
    return {
      id: channel.id,
      label: channel.label,
      kind: channel.kind,
      unit: channel.unit,
      value,
      fidelity: channel.fidelity,
    };
  }
}

export function evaluateMissionDefinition(definition: unknown, timeSeconds: number): EvaluatedMissionFrame {
  return new MissionPlaybackState(definition).evaluate(timeSeconds);
}
