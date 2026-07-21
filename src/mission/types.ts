import type { QuatLike } from '../core/quat';
import type { Vec3Like } from '../core/vec3';

/** How closely a datum represents an official mission or physical asset. */
export type MissionFidelity =
  | 'verified-source'
  | 'reference-trajectory'
  | 'representative'
  | 'proxy-visual';

export const MISSION_PLAYBACK_RATES = [0.25, 1, 10, 100, 1000] as const;
export type MissionPlaybackRate = (typeof MISSION_PLAYBACK_RATES)[number];

export type MissionVector3 = Readonly<Vec3Like>;
export type MissionQuaternion = Readonly<QuatLike>;

export interface MissionSourceRecord {
  readonly id: string;
  readonly title: string;
  readonly publisher: string;
  readonly url: string;
  /** ISO 8601 calendar date (`YYYY-MM-DD`). */
  readonly retrievedAt: string;
  /** A narrowly scoped statement this source supports. */
  readonly supportedClaim: string;
  readonly fidelity: MissionFidelity;
}

export interface MissionClaimDefinition {
  readonly id: string;
  readonly text: string;
  readonly fidelity: MissionFidelity;
  readonly sourceIds: readonly string[];
}

/**
 * The trajectory root used by the renderer. Positions in this frame are
 * body-centred and inertial, in SI units.
 */
export interface BodyCenteredInertialFrameDefinition {
  readonly id: string;
  readonly kind: 'body-centered-inertial';
  readonly bodyId: string;
}

/**
 * Right-handed local vertical/local horizontal frame. +X is radial-out, +Z
 * follows r x v (orbit normal), and +Y completes the basis along-track.
 */
export interface LvlhFrameDefinition {
  readonly id: string;
  readonly kind: 'lvlh';
  readonly entityId: string;
  readonly parentFrameId: string;
}

/** A frame whose origin and orientation follow another mission entity. */
export interface EntityLocalFrameDefinition {
  readonly id: string;
  readonly kind: 'entity-local';
  readonly entityId: string;
  readonly parentFrameId: string;
}

export type MissionFrameDefinition =
  | BodyCenteredInertialFrameDefinition
  | LvlhFrameDefinition
  | EntityLocalFrameDefinition;

export interface MissionVisualDefinition {
  readonly providerId: string;
  readonly fidelity: MissionFidelity;
  readonly scalePolicy: 'physical' | 'minimum-pixel-size';
  readonly minimumPixels?: number;
}

export type MissionEntityKind = 'station' | 'spacecraft' | 'module' | 'marker';

export interface MissionEntityDefinition {
  readonly id: string;
  readonly kind: MissionEntityKind;
  readonly label: string;
  readonly bodyId: string;
  readonly positionTrackId: string;
  readonly attitudeTrackId?: string;
  readonly visual: MissionVisualDefinition;
  readonly fidelity: MissionFidelity;
  readonly sourceIds: readonly string[];
}

export interface PositionVelocitySample {
  readonly timeSeconds: number;
  readonly position: MissionVector3;
  readonly velocity: MissionVector3;
}

export interface PositionVelocityTrackDefinition {
  readonly id: string;
  readonly kind: 'position-velocity';
  readonly frameId: string;
  readonly interpolation: 'cubic-hermite';
  readonly extrapolation: 'clamp' | 'loop';
  readonly timeUnit: 's';
  readonly positionUnit: 'm';
  readonly velocityUnit: 'm/s';
  readonly fidelity: MissionFidelity;
  readonly sourceIds: readonly string[];
  readonly samples: readonly PositionVelocitySample[];
}

export interface AttitudeSample {
  readonly timeSeconds: number;
  /** Local-to-track-frame attitude quaternion. */
  readonly attitude: MissionQuaternion;
}

export interface AttitudeTrackDefinition {
  readonly id: string;
  readonly kind: 'attitude';
  readonly frameId: string;
  readonly interpolation: 'shortest-path-slerp';
  readonly extrapolation: 'clamp' | 'loop';
  readonly timeUnit: 's';
  readonly fidelity: MissionFidelity;
  readonly sourceIds: readonly string[];
  readonly samples: readonly AttitudeSample[];
}

export type MissionTrackDefinition = PositionVelocityTrackDefinition | AttitudeTrackDefinition;

export type MissionEventKind =
  | 'phase-marker'
  | 'lunar-arrival'
  | 'rendezvous'
  | 'hold-point-arrival'
  | 'corridor-entry'
  | 'soft-capture'
  | 'hard-dock'
  | 'activation';

export interface MissionEventDefinition {
  readonly id: string;
  readonly kind: MissionEventKind;
  readonly timeSeconds: number;
  readonly title: string;
  readonly narrative?: string;
  readonly entityIds: readonly string[];
  readonly fidelity: MissionFidelity;
  readonly sourceIds: readonly string[];
}

export interface MissionDockingDefinition {
  readonly id: string;
  readonly childEntityId: string;
  readonly targetEntityId: string;
  readonly softCaptureEventId: string;
  readonly hardDockEventId: string;
  /** Child origin in the target entity's local frame after hard dock. */
  readonly dockedPosition: MissionVector3;
  /** Child local frame relative to the target entity after hard dock. */
  readonly dockedAttitude: MissionQuaternion;
}

export type MissionCameraAnchor =
  | { readonly kind: 'body'; readonly bodyId: string }
  | { readonly kind: 'entity'; readonly entityId: string }
  | { readonly kind: 'frame'; readonly frameId: string };

export interface MissionCameraCueDefinition {
  readonly id: string;
  readonly label: string;
  /** Omit both bounds when the cue is selected only as a phase default. */
  readonly startTimeSeconds?: number;
  readonly endTimeSeconds?: number;
  readonly anchor: MissionCameraAnchor;
  readonly offset: MissionVector3;
  readonly lookAt: MissionCameraAnchor;
  readonly lookAtOffset?: MissionVector3;
  readonly up?: MissionVector3;
  readonly fieldOfViewRadians: number;
  readonly transition: 'cut' | 'ease';
  readonly transitionDurationSeconds?: number;
  readonly fidelity: MissionFidelity;
  readonly sourceIds: readonly string[];
}

export interface MissionPhaseDefinition {
  readonly id: string;
  readonly title: string;
  readonly narrative: string;
  /** Half-open range [start, end), except that the final end is seekable. */
  readonly startTimeSeconds: number;
  readonly endTimeSeconds: number;
  readonly contextOnly: boolean;
  readonly defaultCameraCueId: string;
  readonly suggestedRate: MissionPlaybackRate;
  readonly claimIds: readonly string[];
}

export interface MissionLayerDefinition {
  readonly id: string;
  readonly label: string;
  readonly defaultVisible: boolean;
  readonly fidelity: MissionFidelity;
  readonly sourceIds: readonly string[];
}

export type MissionTelemetryKind = 'elapsed-time' | 'range' | 'closing-rate' | 'relative-speed';
export type MissionTelemetryUnit = 's' | 'm' | 'm/s';

export interface MissionTelemetryChannelDefinition {
  readonly id: string;
  readonly label: string;
  readonly kind: MissionTelemetryKind;
  readonly unit: MissionTelemetryUnit;
  /** Required for relative channels; omitted for elapsed time. */
  readonly entityId?: string;
  /** Required for relative channels; omitted for elapsed time. */
  readonly relativeToEntityId?: string;
  readonly fidelity: MissionFidelity;
  readonly sourceIds: readonly string[];
}

export interface MissionDefinition {
  readonly id: string;
  readonly title: string;
  readonly revision: string;
  /** ISO 8601 calendar date (`YYYY-MM-DD`). */
  readonly retrievedAt: string;
  readonly summary: string;
  readonly objective: string;
  readonly disclaimer: string;
  readonly focusBodyId: string;
  /** SPICE ephemeris time relative to J2000 used to align Perilune bodies. */
  readonly referenceEpochJ2000Seconds: number;
  readonly startTimeSeconds: number;
  readonly endTimeSeconds: number;
  readonly sources: readonly MissionSourceRecord[];
  readonly claims: readonly MissionClaimDefinition[];
  readonly frames: readonly MissionFrameDefinition[];
  readonly entities: readonly MissionEntityDefinition[];
  readonly phases: readonly MissionPhaseDefinition[];
  readonly tracks: readonly MissionTrackDefinition[];
  readonly events: readonly MissionEventDefinition[];
  readonly dockings: readonly MissionDockingDefinition[];
  readonly cameraCues: readonly MissionCameraCueDefinition[];
  readonly layers: readonly MissionLayerDefinition[];
  readonly telemetryChannels: readonly MissionTelemetryChannelDefinition[];
}

export interface EvaluatedMissionEntity {
  readonly id: string;
  readonly kind: MissionEntityKind;
  readonly label: string;
  readonly bodyId: string;
  /** Focus-body-relative position, metres. */
  readonly position: MissionVector3;
  /** Focus-body-relative inertial velocity, metres per second. */
  readonly velocity: MissionVector3;
  /** Entity-local to focus-body inertial attitude. */
  readonly attitude: MissionQuaternion;
  readonly visual: MissionVisualDefinition;
  readonly fidelity: MissionFidelity;
  readonly attachedToEntityId: string | null;
}

export type MissionDockingStatus = 'independent' | 'soft-captured' | 'hard-docked';

export interface EvaluatedMissionDocking {
  readonly id: string;
  readonly childEntityId: string;
  readonly targetEntityId: string;
  readonly status: MissionDockingStatus;
}

export interface EvaluatedMissionTelemetry {
  readonly id: string;
  readonly label: string;
  readonly kind: MissionTelemetryKind;
  readonly unit: MissionTelemetryUnit;
  /** Positive closing rate means range is decreasing. */
  readonly value: number;
  readonly fidelity: MissionFidelity;
}

export interface EvaluatedMissionFrame {
  readonly missionId: string;
  readonly focusBodyId: string;
  readonly timeSeconds: number;
  readonly universeTimeSeconds: number;
  readonly phase: MissionPhaseDefinition;
  /** All discrete events whose timestamp is at or before this frame. */
  readonly events: readonly MissionEventDefinition[];
  readonly latestEvent: MissionEventDefinition | null;
  readonly entities: readonly EvaluatedMissionEntity[];
  readonly entitiesById: Readonly<Record<string, EvaluatedMissionEntity>>;
  readonly dockings: readonly EvaluatedMissionDocking[];
  readonly telemetry: readonly EvaluatedMissionTelemetry[];
  readonly telemetryById: Readonly<Record<string, EvaluatedMissionTelemetry>>;
  readonly directorCue: MissionCameraCueDefinition;
}

export type MissionTimeChangeKind =
  | 'initial'
  | 'advance'
  | 'seek'
  | 'phase-jump'
  | 'phase-restart';

export interface MissionClockChange {
  readonly kind: MissionTimeChangeKind;
  readonly previousTimeSeconds: number;
  readonly timeSeconds: number;
  /** Camera/body temporal history must be reseeded when true. */
  readonly discontinuity: boolean;
  readonly discontinuityToken: number;
}

export interface MissionClockSnapshot {
  readonly timeSeconds: number;
  readonly isPlaying: boolean;
  readonly rate: MissionPlaybackRate;
  readonly startTimeSeconds: number;
  readonly endTimeSeconds: number;
  readonly lastChange: MissionClockChange;
}
