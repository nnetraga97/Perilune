import referenceTrack from '../../generated/artemis-iv-reference-track.json';
import { Vec3 } from '../../core/vec3';
import { evaluatePositionVelocityTrack } from '../../mission/interpolate';
import { quaternionFromBasis } from '../../mission/playbackState';
import type {
  AttitudeSample,
  MissionDefinition,
  MissionSourceRecord,
  MissionVector3,
  PositionVelocitySample,
  PositionVelocityTrackDefinition,
} from '../../mission/types';

interface ArtemisReferenceArtifact {
  readonly referenceEpochJ2000Seconds: number;
  readonly durationSeconds: number;
  readonly samples: readonly {
    readonly tSeconds: number;
    readonly positionM: readonly number[];
    readonly velocityMps: readonly number[];
  }[];
}

const reference = referenceTrack as ArtemisReferenceArtifact;
const END = reference.durationSeconds;
const DEPARTURE_END = 21_600;
const LUNAR_ARRIVAL_END = 345_600;
const APPROACH_START = END - 14_400;
const CORRIDOR_ENTRY = END - 7_200;
const CLOSE_APPROACH = END - 3_600;
const SOFT_CAPTURE = END - 1_800;
const HARD_DOCK = END - 900;
const ACTIVATION = END - 300;

const identity = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });
const zero = Object.freeze({ x: 0, y: 0, z: 0 });

function vector(values: readonly number[]): MissionVector3 {
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) {
    throw new Error('Artemis reference track vectors must contain three finite SI components');
  }
  return { x: values[0], y: values[1], z: values[2] };
}

const gatewaySamples: readonly PositionVelocitySample[] = reference.samples.map((sample) => ({
  timeSeconds: sample.tSeconds,
  position: vector(sample.positionM),
  velocity: vector(sample.velocityMps),
}));

export const ARTEMIS_IV_REFERENCE_ORBIT_POINTS: readonly MissionVector3[] = Object.freeze(
  reference.samples.map((sample) => Object.freeze(vector(sample.positionM))),
);

/** Representative Orion approach keyframes in Gateway LVLH (+Y along-track). */
export const ARTEMIS_IV_APPROACH_LVLH_SAMPLES: readonly PositionVelocitySample[] = Object.freeze([
  { timeSeconds: 0, position: { x: 4_000, y: -250_000, z: 20_000 }, velocity: zero },
  { timeSeconds: DEPARTURE_END, position: { x: 4_000, y: -250_000, z: 20_000 }, velocity: zero },
  { timeSeconds: LUNAR_ARRIVAL_END, position: { x: 1_500, y: -100_000, z: 5_000 }, velocity: zero },
  { timeSeconds: APPROACH_START, position: { x: 350, y: -20_000, z: 900 }, velocity: zero },
  { timeSeconds: CORRIDOR_ENTRY, position: { x: 100, y: -5_000, z: 180 }, velocity: zero },
  { timeSeconds: CLOSE_APPROACH, position: { x: 20, y: -1_000, z: 30 }, velocity: zero },
  { timeSeconds: SOFT_CAPTURE, position: { x: 21, y: -0.75, z: 0 }, velocity: zero },
  { timeSeconds: HARD_DOCK, position: { x: 21, y: 0, z: 0 }, velocity: zero },
  { timeSeconds: END, position: { x: 21, y: 0, z: 0 }, velocity: zero },
]);

const gatewayPositionTrack: PositionVelocityTrackDefinition = {
  id: 'gateway-reference-nrho',
  kind: 'position-velocity',
  frameId: 'moon-j2000',
  interpolation: 'cubic-hermite',
  extrapolation: 'clamp',
  timeUnit: 's',
  positionUnit: 'm',
  velocityUnit: 'm/s',
  fidelity: 'reference-trajectory',
  sourceIds: ['ntrs-nrho-reference', 'naif-dsg-reference-spk'],
  samples: gatewaySamples,
};

/** Keep Gateway local axes aligned with the same evaluated LVLH basis used by rendezvous. */
const gatewayAttitudeSamples: readonly AttitudeSample[] = Object.freeze(
  [...new Set([
    ...reference.samples.map((sample) => sample.tSeconds),
    DEPARTURE_END,
    LUNAR_ARRIVAL_END,
    APPROACH_START,
    CORRIDOR_ENTRY,
    CLOSE_APPROACH,
    SOFT_CAPTURE,
    HARD_DOCK,
    ACTIVATION,
    END,
  ])]
    .sort((left, right) => left - right)
    .map((timeSeconds) => {
      const state = evaluatePositionVelocityTrack(gatewayPositionTrack, timeSeconds);
      const radial = state.position.clone().normalize();
      const normal = Vec3.cross(state.position, state.velocity, new Vec3()).normalize();
      const alongTrack = Vec3.cross(normal, radial, new Vec3()).normalize();
      const attitude = quaternionFromBasis(radial, alongTrack, normal);
      return {
        timeSeconds,
        attitude: { x: attitude.x, y: attitude.y, z: attitude.z, w: attitude.w },
      };
    }),
);

const sources: readonly MissionSourceRecord[] = [
  {
    id: 'nasa-artemis-iv-mission',
    title: 'Artemis IV',
    publisher: 'NASA',
    url: 'https://www.nasa.gov/mission/artemis-iv/',
    retrievedAt: '2026-07-21',
    supportedClaim: 'Artemis IV is planned as the first Artemis mission to Gateway.',
    fidelity: 'verified-source',
  },
  {
    id: 'nasa-gateway-about',
    title: 'Gateway: About',
    publisher: 'NASA',
    url: 'https://www.nasa.gov/reference/gateway-about/',
    retrievedAt: '2026-07-21',
    supportedClaim: 'Orion is planned to deliver Lunar I-Hab to Gateway during Artemis IV.',
    fidelity: 'verified-source',
  },
  {
    id: 'nasa-gateway-assembly',
    title: "NASA's Artemis IV: Building First Lunar Space Station",
    publisher: 'NASA',
    url: 'https://www.nasa.gov/general/nasas-artemis-iv-building-first-lunar-space-station/',
    retrievedAt: '2026-07-21',
    supportedClaim: 'Orion acts as the I-Hab tug before the crew docks and activates the expanded Gateway.',
    fidelity: 'verified-source',
  },
  {
    id: 'ntrs-nrho-reference',
    title: 'A 15-Year Near-Rectilinear Halo Orbit Reference Trajectory',
    publisher: 'NASA Technical Reports Server',
    url: 'https://ntrs.nasa.gov/citations/20190030294',
    retrievedAt: '2026-07-21',
    supportedClaim: 'The engineering reference is a generic southern L2 9:2 NRHO, not an Artemis IV ephemeris.',
    fidelity: 'reference-trajectory',
  },
  {
    id: 'naif-dsg-reference-spk',
    title: '15-year Deep Space Gateway NRHO reference SPK',
    publisher: 'NASA/JPL Navigation and Ancillary Information Facility',
    url: 'https://naif.jpl.nasa.gov/pub/naif/misc/MORE_PROJECTS/DSG/receding_horiz_3189_1burnApo_DiffCorr_15yr.bsp',
    retrievedAt: '2026-07-21',
    supportedClaim: 'Supplies the generic Gateway reference-platform states sampled into the checked runtime artifact.',
    fidelity: 'reference-trajectory',
  },
  {
    id: 'ntrs-rendezvous',
    title: 'A Robust Navigation Design for NRHO Rendezvous',
    publisher: 'NASA Technical Reports Server',
    url: 'https://ntrs.nasa.gov/citations/20230000757',
    retrievedAt: '2026-07-21',
    supportedClaim: 'Supports LVLH rendezvous concepts but does not publish an exact Artemis IV approach ephemeris.',
    fidelity: 'verified-source',
  },
] as const;

export const ARTEMIS_IV_MISSION: MissionDefinition = {
  id: 'artemis-iv',
  title: 'Artemis IV Concept Replay',
  revision: '2026-07-21.1',
  retrievedAt: '2026-07-21',
  summary: 'Orion carries Lunar I-Hab to Gateway, completes final approach, docks, and begins activation.',
  objective: 'Deliver Lunar I-Hab to Gateway and activate the expanded lunar station.',
  disclaimer: 'Concept replay. Mission facts and the Gateway reference orbit are source-backed. Spacecraft approach timing and temporary vehicle visuals are representative, not an Artemis IV flight prediction.',
  focusBodyId: 'moon',
  referenceEpochJ2000Seconds: reference.referenceEpochJ2000Seconds,
  startTimeSeconds: 0,
  endTimeSeconds: END,
  sources,
  claims: [
    {
      id: 'claim-gateway-first',
      text: 'Artemis IV is planned as the first Artemis mission to Gateway.',
      fidelity: 'verified-source',
      sourceIds: ['nasa-artemis-iv-mission'],
    },
    {
      id: 'claim-deliver-ihab',
      text: 'Orion transports Lunar I-Hab to lunar orbit and the crew docks it to Gateway.',
      fidelity: 'verified-source',
      sourceIds: ['nasa-gateway-about', 'nasa-gateway-assembly'],
    },
    {
      id: 'claim-reference-nrho',
      text: 'The displayed Gateway path is an official idealized NRHO reference, not an Artemis IV flight ephemeris.',
      fidelity: 'reference-trajectory',
      sourceIds: ['ntrs-nrho-reference', 'naif-dsg-reference-spk'],
    },
    {
      id: 'claim-representative-rpod',
      text: 'The relative approach, hold points, and event timing are representative choreography.',
      fidelity: 'representative',
      sourceIds: ['ntrs-rendezvous'],
    },
  ],
  frames: [
    { id: 'moon-j2000', kind: 'body-centered-inertial', bodyId: 'moon' },
    { id: 'gateway-lvlh', kind: 'lvlh', entityId: 'gateway', parentFrameId: 'moon-j2000' },
    { id: 'orion-local', kind: 'entity-local', entityId: 'orion', parentFrameId: 'gateway-lvlh' },
  ],
  entities: [
    {
      id: 'gateway',
      kind: 'station',
      label: 'Gateway (HALO/PPE)',
      bodyId: 'moon',
      positionTrackId: 'gateway-reference-nrho',
      attitudeTrackId: 'gateway-attitude',
      visual: { providerId: 'gateway', fidelity: 'proxy-visual', scalePolicy: 'minimum-pixel-size', minimumPixels: 18 },
      fidelity: 'reference-trajectory',
      sourceIds: ['ntrs-nrho-reference', 'naif-dsg-reference-spk'],
    },
    {
      id: 'orion',
      kind: 'spacecraft',
      label: 'Orion',
      bodyId: 'moon',
      positionTrackId: 'orion-representative-approach',
      attitudeTrackId: 'orion-attitude',
      visual: { providerId: 'orion', fidelity: 'proxy-visual', scalePolicy: 'minimum-pixel-size', minimumPixels: 15 },
      fidelity: 'representative',
      sourceIds: ['nasa-gateway-about', 'ntrs-rendezvous'],
    },
    {
      id: 'i-hab',
      kind: 'module',
      label: 'Lunar I-Hab',
      bodyId: 'moon',
      positionTrackId: 'ihab-on-orion',
      attitudeTrackId: 'ihab-attitude',
      visual: { providerId: 'i-hab', fidelity: 'proxy-visual', scalePolicy: 'minimum-pixel-size', minimumPixels: 14 },
      fidelity: 'representative',
      sourceIds: ['nasa-gateway-about', 'nasa-gateway-assembly'],
    },
  ],
  phases: [
    {
      id: 'departure-context',
      title: 'Departure',
      narrative: 'Orion departs Earth carrying Lunar I-Hab. This overview establishes mission context; it is not a simulated launch trajectory.',
      startTimeSeconds: 0,
      endTimeSeconds: DEPARTURE_END,
      contextOnly: true,
      defaultCameraCueId: 'camera-departure-overview',
      suggestedRate: 1000,
      claimIds: ['claim-deliver-ihab'],
    },
    {
      id: 'lunar-arrival',
      title: 'Lunar Arrival',
      narrative: 'The stack reaches lunar space while Gateway continues along the published reference NRHO segment.',
      startTimeSeconds: DEPARTURE_END,
      endTimeSeconds: LUNAR_ARRIVAL_END,
      contextOnly: true,
      defaultCameraCueId: 'camera-lunar-overview',
      suggestedRate: 1000,
      claimIds: ['claim-reference-nrho'],
    },
    {
      id: 'nrho-rendezvous',
      title: 'NRHO Rendezvous',
      narrative: 'Orion and I-Hab phase toward Gateway. The station follows the official reference orbit; Orion choreography is representative.',
      startTimeSeconds: LUNAR_ARRIVAL_END,
      endTimeSeconds: APPROACH_START,
      contextOnly: false,
      defaultCameraCueId: 'camera-gateway-rendezvous',
      suggestedRate: 100,
      claimIds: ['claim-reference-nrho', 'claim-representative-rpod'],
    },
    {
      id: 'final-approach',
      title: 'Final Approach',
      narrative: 'The stack enters the Gateway-relative approach corridor and closes through authored hold points.',
      startTimeSeconds: APPROACH_START,
      endTimeSeconds: SOFT_CAPTURE,
      contextOnly: false,
      defaultCameraCueId: 'camera-final-approach',
      suggestedRate: 10,
      claimIds: ['claim-representative-rpod'],
    },
    {
      id: 'soft-capture',
      title: 'Soft Capture',
      narrative: 'Initial contact aligns and damps the visiting stack. The capture timing and motion are representative.',
      startTimeSeconds: SOFT_CAPTURE,
      endTimeSeconds: HARD_DOCK,
      contextOnly: false,
      defaultCameraCueId: 'camera-soft-capture',
      suggestedRate: 1,
      claimIds: ['claim-representative-rpod'],
    },
    {
      id: 'hard-dock',
      title: 'Hard Dock',
      narrative: 'The docking state becomes rigid and the Orion/I-Hab stack is evaluated directly from Gateway on every frame.',
      startTimeSeconds: HARD_DOCK,
      endTimeSeconds: ACTIVATION,
      contextOnly: false,
      defaultCameraCueId: 'camera-hard-dock',
      suggestedRate: 1,
      claimIds: ['claim-deliver-ihab', 'claim-representative-rpod'],
    },
    {
      id: 'activation',
      title: 'Gateway Activation',
      narrative: 'With Lunar I-Hab secured, the crew begins activation of the expanded Gateway configuration.',
      startTimeSeconds: ACTIVATION,
      endTimeSeconds: END,
      contextOnly: false,
      defaultCameraCueId: 'camera-activation',
      suggestedRate: 10,
      claimIds: ['claim-deliver-ihab'],
    },
  ],
  tracks: [
    gatewayPositionTrack,
    {
      id: 'orion-representative-approach',
      kind: 'position-velocity',
      frameId: 'gateway-lvlh',
      interpolation: 'cubic-hermite',
      extrapolation: 'clamp',
      timeUnit: 's',
      positionUnit: 'm',
      velocityUnit: 'm/s',
      fidelity: 'representative',
      sourceIds: ['ntrs-rendezvous'],
      samples: ARTEMIS_IV_APPROACH_LVLH_SAMPLES,
    },
    {
      id: 'ihab-on-orion',
      kind: 'position-velocity',
      frameId: 'orion-local',
      interpolation: 'cubic-hermite',
      extrapolation: 'clamp',
      timeUnit: 's',
      positionUnit: 'm',
      velocityUnit: 'm/s',
      fidelity: 'representative',
      sourceIds: ['nasa-gateway-about'],
      samples: [
        { timeSeconds: 0, position: { x: -9, y: 0, z: 0 }, velocity: zero },
        { timeSeconds: END, position: { x: -9, y: 0, z: 0 }, velocity: zero },
      ],
    },
    {
      id: 'gateway-attitude',
      kind: 'attitude',
      frameId: 'moon-j2000',
      interpolation: 'shortest-path-slerp',
      extrapolation: 'clamp',
      timeUnit: 's',
      fidelity: 'representative',
      sourceIds: ['ntrs-nrho-reference'],
      samples: gatewayAttitudeSamples,
    },
    {
      id: 'orion-attitude',
      kind: 'attitude',
      frameId: 'gateway-lvlh',
      interpolation: 'shortest-path-slerp',
      extrapolation: 'clamp',
      timeUnit: 's',
      fidelity: 'representative',
      sourceIds: ['ntrs-rendezvous'],
      samples: [{ timeSeconds: 0, attitude: identity }],
    },
    {
      id: 'ihab-attitude',
      kind: 'attitude',
      frameId: 'orion-local',
      interpolation: 'shortest-path-slerp',
      extrapolation: 'clamp',
      timeUnit: 's',
      fidelity: 'representative',
      sourceIds: ['nasa-gateway-about'],
      samples: [{ timeSeconds: 0, attitude: identity }],
    },
  ],
  events: [
    { id: 'departure-event', kind: 'phase-marker', timeSeconds: 0, title: 'Departure context', entityIds: ['orion', 'i-hab'], fidelity: 'verified-source', sourceIds: ['nasa-gateway-about'] },
    { id: 'lunar-arrival-event', kind: 'lunar-arrival', timeSeconds: DEPARTURE_END, title: 'Lunar arrival context', entityIds: ['orion', 'i-hab'], fidelity: 'representative', sourceIds: ['nasa-artemis-iv-mission'] },
    { id: 'rendezvous-event', kind: 'rendezvous', timeSeconds: LUNAR_ARRIVAL_END, title: 'Gateway rendezvous begins', entityIds: ['gateway', 'orion'], fidelity: 'representative', sourceIds: ['ntrs-rendezvous'] },
    { id: 'hold-event', kind: 'hold-point-arrival', timeSeconds: APPROACH_START, title: 'Representative approach hold', entityIds: ['gateway', 'orion'], fidelity: 'representative', sourceIds: ['ntrs-rendezvous'] },
    { id: 'corridor-event', kind: 'corridor-entry', timeSeconds: CORRIDOR_ENTRY, title: 'Representative approach corridor', entityIds: ['gateway', 'orion'], fidelity: 'representative', sourceIds: ['ntrs-rendezvous'] },
    { id: 'close-approach-event', kind: 'hold-point-arrival', timeSeconds: CLOSE_APPROACH, title: 'Close approach', entityIds: ['gateway', 'orion'], fidelity: 'representative', sourceIds: ['ntrs-rendezvous'] },
    { id: 'soft-capture-event', kind: 'soft-capture', timeSeconds: SOFT_CAPTURE, title: 'Soft capture', entityIds: ['gateway', 'orion', 'i-hab'], fidelity: 'representative', sourceIds: ['ntrs-rendezvous'] },
    { id: 'hard-dock-event', kind: 'hard-dock', timeSeconds: HARD_DOCK, title: 'Hard dock', entityIds: ['gateway', 'orion', 'i-hab'], fidelity: 'representative', sourceIds: ['ntrs-rendezvous'] },
    { id: 'activation-event', kind: 'activation', timeSeconds: ACTIVATION, title: 'Gateway activation begins', entityIds: ['gateway', 'i-hab'], fidelity: 'representative', sourceIds: ['nasa-gateway-assembly'] },
  ],
  dockings: [
    {
      id: 'orion-gateway-docking',
      childEntityId: 'orion',
      targetEntityId: 'gateway',
      softCaptureEventId: 'soft-capture-event',
      hardDockEventId: 'hard-dock-event',
      dockedPosition: { x: 21, y: 0, z: 0 },
      dockedAttitude: identity,
    },
    {
      id: 'ihab-gateway-docking',
      childEntityId: 'i-hab',
      targetEntityId: 'gateway',
      softCaptureEventId: 'soft-capture-event',
      hardDockEventId: 'hard-dock-event',
      dockedPosition: { x: 12, y: 0, z: 0 },
      dockedAttitude: identity,
    },
  ],
  cameraCues: [
    {
      id: 'camera-departure-overview', label: 'Departure overview', anchor: { kind: 'body', bodyId: 'moon' },
      offset: { x: 650_000, y: -5_200_000, z: 2_400_000 }, lookAt: { kind: 'body', bodyId: 'moon' },
      up: { x: 0, y: 0, z: 1 }, fieldOfViewRadians: 0.8, transition: 'cut', fidelity: 'representative', sourceIds: ['nasa-gateway-about'],
    },
    {
      id: 'camera-lunar-overview', label: 'Lunar overview', anchor: { kind: 'body', bodyId: 'moon' },
      offset: { x: 400_000, y: -4_800_000, z: 2_100_000 }, lookAt: { kind: 'body', bodyId: 'moon' },
      up: { x: 0, y: 0, z: 1 }, fieldOfViewRadians: 0.78, transition: 'ease', transitionDurationSeconds: 1.2, fidelity: 'representative', sourceIds: ['ntrs-nrho-reference'],
    },
    {
      id: 'camera-gateway-rendezvous', label: 'Gateway rendezvous', anchor: { kind: 'frame', frameId: 'gateway-lvlh' },
      offset: { x: 1_000, y: -7_000, z: 2_000 }, lookAt: { kind: 'entity', entityId: 'gateway' },
      up: { x: 1, y: 0, z: 0 }, fieldOfViewRadians: 0.72, transition: 'ease', transitionDurationSeconds: 1, fidelity: 'representative', sourceIds: ['ntrs-rendezvous'],
    },
    {
      id: 'camera-final-approach', label: 'Final approach', anchor: { kind: 'frame', frameId: 'gateway-lvlh' },
      offset: { x: 350, y: -3_000, z: 700 }, lookAt: { kind: 'entity', entityId: 'orion' },
      up: { x: 1, y: 0, z: 0 }, fieldOfViewRadians: 0.68, transition: 'ease', transitionDurationSeconds: 0.8, fidelity: 'representative', sourceIds: ['ntrs-rendezvous'],
    },
    {
      id: 'camera-soft-capture', label: 'Soft capture', anchor: { kind: 'frame', frameId: 'gateway-lvlh' },
      offset: { x: 80, y: -95, z: 45 }, lookAt: { kind: 'entity', entityId: 'orion' },
      up: { x: 1, y: 0, z: 0 }, fieldOfViewRadians: 0.66, transition: 'ease', transitionDurationSeconds: 0.45, fidelity: 'representative', sourceIds: ['ntrs-rendezvous'],
    },
    {
      id: 'camera-hard-dock', label: 'Hard dock', anchor: { kind: 'entity', entityId: 'gateway' },
      offset: { x: 70, y: -100, z: 50 }, lookAt: { kind: 'entity', entityId: 'gateway' },
      up: { x: 0, y: 0, z: 1 }, fieldOfViewRadians: 0.72, transition: 'cut', fidelity: 'representative', sourceIds: ['ntrs-rendezvous'],
    },
    {
      id: 'camera-activation', label: 'Activation overview', anchor: { kind: 'entity', entityId: 'gateway' },
      offset: { x: 130, y: -180, z: 85 }, lookAt: { kind: 'entity', entityId: 'gateway' },
      up: { x: 0, y: 0, z: 1 }, fieldOfViewRadians: 0.75, transition: 'ease', transitionDurationSeconds: 1, fidelity: 'representative', sourceIds: ['nasa-gateway-assembly'],
    },
  ],
  layers: [
    { id: 'reference-orbit', label: 'Reference orbit', defaultVisible: true, fidelity: 'reference-trajectory', sourceIds: ['ntrs-nrho-reference', 'naif-dsg-reference-spk'] },
    { id: 'approach-corridor', label: 'Approach corridor', defaultVisible: true, fidelity: 'representative', sourceIds: ['ntrs-rendezvous'] },
    { id: 'labels', label: 'Entity labels', defaultVisible: true, fidelity: 'proxy-visual', sourceIds: ['nasa-gateway-about'] },
    { id: 'telemetry', label: 'Telemetry', defaultVisible: true, fidelity: 'representative', sourceIds: ['ntrs-rendezvous'] },
    { id: 'source-notes', label: 'Source notes', defaultVisible: false, fidelity: 'verified-source', sourceIds: ['nasa-artemis-iv-mission'] },
  ],
  telemetryChannels: [
    { id: 'elapsed', label: 'Mission time', kind: 'elapsed-time', unit: 's', fidelity: 'representative', sourceIds: ['nasa-artemis-iv-mission'] },
    { id: 'range-to-gateway', label: 'Range', kind: 'range', unit: 'm', entityId: 'orion', relativeToEntityId: 'gateway', fidelity: 'representative', sourceIds: ['ntrs-rendezvous'] },
    { id: 'closing-rate', label: 'Closing rate', kind: 'closing-rate', unit: 'm/s', entityId: 'orion', relativeToEntityId: 'gateway', fidelity: 'representative', sourceIds: ['ntrs-rendezvous'] },
    { id: 'relative-speed', label: 'Relative speed', kind: 'relative-speed', unit: 'm/s', entityId: 'orion', relativeToEntityId: 'gateway', fidelity: 'representative', sourceIds: ['ntrs-rendezvous'] },
  ],
};

export const ARTEMIS_IV_TIMELINE = Object.freeze({
  departureEnd: DEPARTURE_END,
  lunarArrivalEnd: LUNAR_ARRIVAL_END,
  approachStart: APPROACH_START,
  corridorEntry: CORRIDOR_ENTRY,
  closeApproach: CLOSE_APPROACH,
  softCapture: SOFT_CAPTURE,
  hardDock: HARD_DOCK,
  activation: ACTIVATION,
  end: END,
});
