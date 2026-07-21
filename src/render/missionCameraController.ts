import { Quat } from '../core/quat';
import { Vec3 } from '../core/vec3';
import type {
  MissionQuaternionCoordinates,
  MissionRenderableEntity,
  MissionVectorCoordinates,
} from './missionEntityRenderer';

export const MISSION_CAMERA_MODES = [
  'director',
  'gateway-orbit',
  'orion-follow',
  'moon-overview',
  'free',
] as const;

export type MissionCameraMode = (typeof MISSION_CAMERA_MODES)[number];
export type MissionCameraTransition = 'cut' | 'ease';

export type MissionCameraAnchor =
  | { readonly kind: 'body'; readonly bodyId: string }
  | { readonly kind: 'entity'; readonly entityId: string }
  | { readonly kind: 'frame'; readonly frameId: string };

export interface MissionCameraCue {
  readonly id: string;
  readonly anchor: MissionCameraAnchor;
  readonly offset: MissionVectorCoordinates;
  readonly lookAt: MissionCameraAnchor;
  readonly lookAtOffset?: MissionVectorCoordinates;
  readonly up?: MissionVectorCoordinates;
  /** Domain cues use radians; the solved render pose exposes degrees. */
  readonly fieldOfViewRadians: number;
  readonly transition: MissionCameraTransition;
  readonly transitionDurationSeconds?: number;
}

export type MissionCameraFrameDefinition =
  | {
    readonly id: string;
    readonly kind: 'body-centered-inertial';
    readonly bodyId: string;
  }
  | {
    readonly id: string;
    readonly kind: 'entity-local' | 'lvlh';
    readonly entityId: string;
    readonly parentFrameId: string;
  };

/** Render-facing structural subset of EvaluatedMissionFrame. */
export interface MissionCameraFrame {
  readonly timeSeconds: number;
  readonly focusBodyId: string;
  readonly focusBodyRadius: number;
  readonly entities: readonly Readonly<MissionRenderableEntity>[];
  readonly directorCue: Readonly<MissionCameraCue>;
  /** MissionDefinition.frames, supplied once by the integration boundary. */
  readonly frameDefinitions?: readonly Readonly<MissionCameraFrameDefinition>[];
}

export interface MissionCameraPose {
  /** Focus-body-relative inertial metres. */
  readonly position: MissionVectorCoordinates;
  /** Focus-body-relative inertial metres. */
  readonly target: MissionVectorCoordinates;
  readonly up: MissionVectorCoordinates;
  readonly fieldOfViewDegrees: number;
  /** Tells WorldScene to reseed body/exposure history before this pose renders. */
  readonly discontinuity: boolean;
}

export interface MissionCameraUpdateOptions {
  readonly discontinuity?: boolean;
  readonly discontinuityToken?: number;
  readonly reducedMotion?: boolean;
}

interface MutablePose {
  position: Vec3;
  target: Vec3;
  up: Vec3;
  fieldOfViewDegrees: number;
}

interface ResolvedAnchor {
  readonly origin: Vec3;
  readonly orientation: Quat | null;
  readonly basis: LvlhBasis | null;
}

interface LvlhBasis {
  readonly radial: Vec3;
  readonly alongTrack: Vec3;
  readonly normal: Vec3;
}

const DEFAULT_UP = Object.freeze({ x: 0, y: 0, z: 1 });
const DEFAULT_FOV_DEGREES = 52;
const MIN_FOV_DEGREES = 15;
const MAX_FOV_DEGREES = 82;

/**
 * Mission-only camera state. It deliberately shares no enum or mutable state
 * with WorldScene's active-vessel flight camera.
 */
export class MissionCameraController {
  private mode: MissionCameraMode = 'director';
  private rendered: MutablePose | null = null;
  private freePose: MutablePose | null = null;
  private lastMissionTime: number | null = null;
  private lastDiscontinuityToken: number | null = null;
  private lastDirectorCueId: string | null = null;
  private reducedMotion = false;

  cameraMode(): MissionCameraMode { return this.mode; }
  directorActive(): boolean { return this.mode === 'director'; }

  setReducedMotion(reduced: boolean): void { this.reducedMotion = reduced; }

  setMode(mode: MissionCameraMode): void {
    if (!MISSION_CAMERA_MODES.includes(mode)) throw new Error(`Unknown mission camera mode: ${mode}`);
    if (this.mode === mode) return;
    if (mode === 'free' && this.rendered) this.freePose = clonePose(this.rendered);
    this.mode = mode;
  }

  returnToDirector(): void { this.mode = 'director'; }

  /** Any direct manipulation enters free mode and remains there across phases. */
  orbit(deltaYawRadians: number, deltaPitchRadians: number): void {
    this.ensureFreePose();
    const pose = this.freePose;
    if (!pose) return;
    const offset = new Vec3().copy(pose.position).sub(pose.target);
    let radius = offset.length();
    if (!(radius > 1e-6)) {
      radius = 100;
      offset.set(0, -radius, 0);
    }
    let yaw = Math.atan2(offset.y, offset.x) + deltaYawRadians;
    if (!Number.isFinite(yaw)) yaw = 0;
    const horizontal = Math.hypot(offset.x, offset.y);
    const pitch = clamp(
      Math.atan2(offset.z, horizontal) + deltaPitchRadians,
      -Math.PI * 0.49,
      Math.PI * 0.49,
    );
    const planar = Math.cos(pitch) * radius;
    pose.position.set(
      pose.target.x + Math.cos(yaw) * planar,
      pose.target.y + Math.sin(yaw) * planar,
      pose.target.z + Math.sin(pitch) * radius,
    );
    this.mode = 'free';
  }

  pan(delta: Readonly<MissionVectorCoordinates>): void {
    this.ensureFreePose();
    if (!this.freePose) return;
    this.freePose.position.set(
      this.freePose.position.x + delta.x,
      this.freePose.position.y + delta.y,
      this.freePose.position.z + delta.z,
    );
    this.freePose.target.set(
      this.freePose.target.x + delta.x,
      this.freePose.target.y + delta.y,
      this.freePose.target.z + delta.z,
    );
    this.mode = 'free';
  }

  zoom(multiplier: number): void {
    this.ensureFreePose();
    if (!this.freePose || !Number.isFinite(multiplier) || multiplier <= 0) return;
    const offset = new Vec3().copy(this.freePose.position).sub(this.freePose.target);
    const distance = clamp(offset.length() * multiplier, 2, 1e9);
    if (offset.lengthSq() < 1e-12) offset.set(0, -1, 0);
    offset.normalize().scale(distance);
    this.freePose.position.copy(this.freePose.target).add(offset);
    this.mode = 'free';
  }

  setFreePose(pose: Omit<MissionCameraPose, 'discontinuity'>): void {
    this.freePose = mutablePose(pose);
    sanitizePose(this.freePose);
    this.mode = 'free';
  }

  /** Pure desired pose for deterministic seek/fixture tests. */
  desiredPose(frame: Readonly<MissionCameraFrame>): MissionCameraPose {
    const desired = this.evaluateDesired(frame);
    return freezePose(desired, false);
  }

  update(
    frame: Readonly<MissionCameraFrame>,
    wallDeltaSeconds: number,
    options: Readonly<MissionCameraUpdateOptions> = {},
  ): MissionCameraPose {
    const desired = this.evaluateDesired(frame);
    const tokenChanged = options.discontinuityToken !== undefined
      && options.discontinuityToken !== this.lastDiscontinuityToken;
    const backwards = this.lastMissionTime !== null && frame.timeSeconds < this.lastMissionTime - 1e-9;
    const cueChanged = this.lastDirectorCueId !== null
      && this.lastDirectorCueId !== frame.directorCue.id;
    const authoredCut = this.mode === 'director'
      && cueChanged
      && frame.directorCue.transition === 'cut';
    const reducedMotion = options.reducedMotion === true || this.reducedMotion;
    const temporalDiscontinuity = !this.rendered
      || options.discontinuity === true
      || tokenChanged
      || backwards
      || authoredCut
      || (reducedMotion && cueChanged);
    const snap = temporalDiscontinuity || reducedMotion;

    if (snap || !this.rendered) {
      this.rendered = clonePose(desired);
    } else {
      const dt = clamp(Number.isFinite(wallDeltaSeconds) ? wallDeltaSeconds : 0, 0, 0.1);
      const duration = this.mode === 'director'
        ? Math.max(0.05, frame.directorCue.transitionDurationSeconds ?? 0.8)
        : 0.55;
      const blend = dt > 0 ? 1 - Math.exp(-4 * dt / duration) : 0;
      smoothPose(this.rendered, desired, blend);
    }

    this.lastMissionTime = frame.timeSeconds;
    if (options.discontinuityToken !== undefined) this.lastDiscontinuityToken = options.discontinuityToken;
    this.lastDirectorCueId = frame.directorCue.id;
    return freezePose(this.rendered, temporalDiscontinuity);
  }

  /** Explicitly discard smoothing history before entering/re-entering replay. */
  resetTemporalState(): void {
    this.rendered = null;
    this.lastMissionTime = null;
    this.lastDiscontinuityToken = null;
    this.lastDirectorCueId = null;
  }

  reset(): void {
    this.mode = 'director';
    this.freePose = null;
    this.resetTemporalState();
  }

  private ensureFreePose(): void {
    if (!this.freePose && this.rendered) this.freePose = clonePose(this.rendered);
  }

  private evaluateDesired(frame: Readonly<MissionCameraFrame>): MutablePose {
    let pose: MutablePose;
    if (this.mode === 'director') pose = evaluateDirectorCue(frame);
    else if (this.mode === 'gateway-orbit') pose = gatewayOrbitPose(frame);
    else if (this.mode === 'orion-follow') pose = orionFollowPose(frame);
    else if (this.mode === 'moon-overview') pose = moonOverviewPose(frame);
    else {
      if (!this.freePose) this.freePose = evaluateDirectorCue(frame);
      pose = clonePose(this.freePose);
    }
    sanitizePose(pose);
    return pose;
  }
}

export function evaluateDirectorCue(frame: Readonly<MissionCameraFrame>): MutablePose {
  const cue = frame.directorCue;
  const positionAnchor = resolveAnchor(cue.anchor, frame);
  const targetAnchor = resolveAnchor(cue.lookAt, frame);
  const position = transformOffset(cue.offset, positionAnchor);
  const target = transformOffset(cue.lookAtOffset ?? ZERO, targetAnchor);
  const up = transformDirection(cue.up ?? DEFAULT_UP, positionAnchor);
  return {
    position,
    target,
    up,
    fieldOfViewDegrees: clamp(
      cue.fieldOfViewRadians * 180 / Math.PI,
      MIN_FOV_DEGREES,
      MAX_FOV_DEGREES,
    ),
  };
}

function gatewayOrbitPose(frame: Readonly<MissionCameraFrame>): MutablePose {
  const gateway = findEntity(frame.entities, 'gateway', 'station');
  if (!gateway) return moonOverviewPose(frame);
  const radial = normalizedOr(gateway.position, DEFAULT_UP);
  const along = tangentDirection(gateway, radial);
  const target = vec(gateway.position);
  const position = target.clone().addScaled(along, -165).addScaled(radial, 85);
  return { position, target, up: radial, fieldOfViewDegrees: 48 };
}

function orionFollowPose(frame: Readonly<MissionCameraFrame>): MutablePose {
  const orion = findEntity(frame.entities, 'orion', 'spacecraft');
  if (!orion) return gatewayOrbitPose(frame);
  const target = vec(orion.position);
  const forward = normalizedOr(orion.velocity ?? ZERO, { x: 1, y: 0, z: 0 });
  const radial = normalizedOr(orion.position, DEFAULT_UP);
  const position = target.clone().addScaled(forward, -95).addScaled(radial, 32);
  return { position, target, up: radial, fieldOfViewDegrees: 44 };
}

function moonOverviewPose(frame: Readonly<MissionCameraFrame>): MutablePose {
  const radius = Math.max(1, frame.focusBodyRadius);
  return {
    position: new Vec3(radius * 0.35, -radius * 2.75, radius * 1.35),
    target: new Vec3(0, 0, 0),
    up: new Vec3(0, 0, 1),
    fieldOfViewDegrees: 46,
  };
}

function resolveAnchor(
  anchor: Readonly<MissionCameraAnchor>,
  frame: Readonly<MissionCameraFrame>,
): ResolvedAnchor {
  if (anchor.kind === 'body') {
    // This replay renders one body-centred frame. A non-focus-body cue must be
    // transformed by the mission evaluator before reaching this controller.
    if (anchor.bodyId !== frame.focusBodyId) {
      throw new Error(`Camera body anchor ${anchor.bodyId} is outside focus frame ${frame.focusBodyId}`);
    }
    return { origin: new Vec3(), orientation: null, basis: null };
  }
  if (anchor.kind === 'entity') {
    const entity = frame.entities.find((candidate) => candidate.id === anchor.entityId);
    if (!entity) throw new Error(`Camera anchor entity not found: ${anchor.entityId}`);
    return {
      origin: vec(entity.position),
      orientation: quat(entity.attitude),
      basis: null,
    };
  }
  const definition = frame.frameDefinitions?.find((candidate) => candidate.id === anchor.frameId);
  if (!definition) throw new Error(`Camera frame definition not found: ${anchor.frameId}`);
  if (definition.kind === 'body-centered-inertial') {
    if (definition.bodyId !== frame.focusBodyId) {
      throw new Error(`Camera frame ${definition.id} is outside focus frame ${frame.focusBodyId}`);
    }
    return { origin: new Vec3(), orientation: null, basis: null };
  }
  const entity = frame.entities.find((candidate) => candidate.id === definition.entityId);
  if (!entity) throw new Error(`Camera frame entity not found: ${definition.entityId}`);
  if (definition.kind === 'entity-local') {
    return { origin: vec(entity.position), orientation: quat(entity.attitude), basis: null };
  }
  return {
    origin: vec(entity.position),
    orientation: null,
    basis: lvlhBasis(entity.position, entity.velocity ?? ZERO),
  };
}

function transformOffset(offset: Readonly<MissionVectorCoordinates>, anchor: Readonly<ResolvedAnchor>): Vec3 {
  return anchor.origin.clone().add(transformDirection(offset, anchor));
}

function transformDirection(
  direction: Readonly<MissionVectorCoordinates>,
  anchor: Readonly<ResolvedAnchor>,
): Vec3 {
  const result = vec(direction);
  if (anchor.orientation) return anchor.orientation.rotate(result, result);
  if (anchor.basis) {
    return new Vec3()
      .addScaled(anchor.basis.radial, result.x)
      .addScaled(anchor.basis.alongTrack, result.y)
      .addScaled(anchor.basis.normal, result.z);
  }
  return result;
}

/** Domain LVLH convention: +X radial, +Z orbit-normal, +Y along-track. */
export function lvlhBasis(
  position: Readonly<MissionVectorCoordinates>,
  velocity: Readonly<MissionVectorCoordinates>,
): LvlhBasis {
  const radial = normalizedOr(position, { x: 1, y: 0, z: 0 });
  const normal = new Vec3(
    position.y * velocity.z - position.z * velocity.y,
    position.z * velocity.x - position.x * velocity.z,
    position.x * velocity.y - position.y * velocity.x,
  );
  if (normal.lengthSq() < 1e-12) {
    const reference = Math.abs(radial.z) < 0.9 ? DEFAULT_UP : { x: 0, y: 1, z: 0 };
    Vec3.cross(radial, vec(reference), normal);
  }
  normal.normalize();
  const alongTrack = Vec3.cross(normal, radial, new Vec3()).normalize();
  return { radial, alongTrack, normal };
}

function findEntity(
  entities: readonly Readonly<MissionRenderableEntity>[],
  semanticId: string,
  fallbackKind: string,
): Readonly<MissionRenderableEntity> | null {
  const exact = entities.find((entity) => (
    entity.id.toLowerCase().includes(semanticId)
    || entity.label.toLowerCase().includes(semanticId)
    || (typeof entity.visual === 'object'
      ? entity.visual.providerId.toLowerCase().includes(semanticId)
      : String(entity.visual ?? '').toLowerCase().includes(semanticId))
  ));
  return exact ?? entities.find((entity) => entity.kind === fallbackKind) ?? null;
}

function tangentDirection(
  entity: Readonly<MissionRenderableEntity>,
  radial: Readonly<Vec3>,
): Vec3 {
  const velocity = vec(entity.velocity ?? ZERO);
  const tangent = velocity.clone().addScaled(radial, -Vec3.dot(velocity, radial));
  if (tangent.lengthSq() < 1e-12) {
    const reference = Math.abs(radial.z) < 0.9 ? DEFAULT_UP : { x: 0, y: 1, z: 0 };
    Vec3.cross(vec(reference), radial, tangent);
  }
  return tangent.normalize();
}

function smoothPose(current: MutablePose, desired: Readonly<MutablePose>, blend: number): void {
  Vec3.lerp(current.position, desired.position, blend, current.position);
  Vec3.lerp(current.target, desired.target, blend, current.target);
  Vec3.lerp(current.up, desired.up, blend, current.up).normalize();
  current.fieldOfViewDegrees += (desired.fieldOfViewDegrees - current.fieldOfViewDegrees) * blend;
  sanitizePose(current);
}

function mutablePose(pose: Omit<MissionCameraPose, 'discontinuity'>): MutablePose {
  return {
    position: vec(pose.position),
    target: vec(pose.target),
    up: vec(pose.up),
    fieldOfViewDegrees: pose.fieldOfViewDegrees,
  };
}

function clonePose(pose: Readonly<MutablePose>): MutablePose {
  return {
    position: pose.position.clone(),
    target: pose.target.clone(),
    up: pose.up.clone(),
    fieldOfViewDegrees: pose.fieldOfViewDegrees,
  };
}

function freezePose(pose: Readonly<MutablePose>, discontinuity: boolean): MissionCameraPose {
  return Object.freeze({
    position: Object.freeze({ x: pose.position.x, y: pose.position.y, z: pose.position.z }),
    target: Object.freeze({ x: pose.target.x, y: pose.target.y, z: pose.target.z }),
    up: Object.freeze({ x: pose.up.x, y: pose.up.y, z: pose.up.z }),
    fieldOfViewDegrees: pose.fieldOfViewDegrees,
    discontinuity,
  });
}

function sanitizePose(pose: MutablePose): void {
  if (!pose.position.isFinite()) pose.position.set(0, -100, 25);
  if (!pose.target.isFinite()) pose.target.set(0, 0, 0);
  if (!pose.up.isFinite() || pose.up.lengthSq() < 1e-12) pose.up.set(0, 0, 1);
  else pose.up.normalize();
  if (pose.position.distanceTo(pose.target) < 1e-4) pose.position.y -= 1;
  pose.fieldOfViewDegrees = clamp(
    Number.isFinite(pose.fieldOfViewDegrees) ? pose.fieldOfViewDegrees : DEFAULT_FOV_DEGREES,
    MIN_FOV_DEGREES,
    MAX_FOV_DEGREES,
  );
}

function normalizedOr(
  value: Readonly<MissionVectorCoordinates>,
  fallback: Readonly<MissionVectorCoordinates>,
): Vec3 {
  const result = vec(value);
  if (result.lengthSq() < 1e-12 || !result.isFinite()) return vec(fallback).normalize();
  return result.normalize();
}

function quat(value: Readonly<MissionQuaternionCoordinates>): Quat {
  return new Quat(value.x, value.y, value.z, value.w).normalize();
}

function vec(value: Readonly<MissionVectorCoordinates>): Vec3 {
  return new Vec3(value.x, value.y, value.z);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const ZERO = Object.freeze({ x: 0, y: 0, z: 0 });
