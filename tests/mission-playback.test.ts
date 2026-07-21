import { describe, expect, it } from 'vitest';
import { Quat } from '../src/core/quat';
import { Vec3 } from '../src/core/vec3';
import {
  evaluateAttitudeTrack,
  evaluatePositionVelocityTrack,
  interpolateHermite,
  shortestPathSlerp,
} from '../src/mission/interpolate';
import { MissionPlaybackClock } from '../src/mission/playbackClock';
import {
  evaluateMissionDefinition,
  findMissionPhase,
  MissionPlaybackState,
} from '../src/mission/playbackState';
import type {
  AttitudeTrackDefinition,
  MissionDefinition,
  MissionPlaybackRate,
  PositionVelocityTrackDefinition,
} from '../src/mission/types';

function createPlaybackDefinition(): MissionDefinition {
  const sourceIds = ['source'];
  const positionTrack = (
    id: string,
    frameId: string,
    startPosition: { x: number; y: number; z: number },
    endPosition: { x: number; y: number; z: number },
    velocity: { x: number; y: number; z: number },
  ): PositionVelocityTrackDefinition => ({
    id,
    kind: 'position-velocity',
    frameId,
    interpolation: 'cubic-hermite',
    extrapolation: 'clamp',
    timeUnit: 's',
    positionUnit: 'm',
    velocityUnit: 'm/s',
    fidelity: id.startsWith('gateway') ? 'reference-trajectory' : 'representative',
    sourceIds,
    samples: [
      { timeSeconds: 0, position: startPosition, velocity },
      { timeSeconds: 10, position: endPosition, velocity },
    ],
  });
  const attitudeTrack = (id: string, frameId: string): AttitudeTrackDefinition => ({
    id,
    kind: 'attitude',
    frameId,
    interpolation: 'shortest-path-slerp',
    extrapolation: 'clamp',
    timeUnit: 's',
    fidelity: 'representative',
    sourceIds,
    samples: [{ timeSeconds: 0, attitude: { x: 0, y: 0, z: 0, w: 1 } }],
  });
  return {
    id: 'test-artemis',
    title: 'Test Artemis Replay',
    revision: 'test-1',
    retrievedAt: '2026-07-21',
    summary: 'A deterministic rendezvous test fixture.',
    objective: 'Deliver the test module.',
    disclaimer: 'Representative test data.',
    focusBodyId: 'moon',
    referenceEpochJ2000Seconds: 1_000,
    startTimeSeconds: 0,
    endTimeSeconds: 10,
    sources: [{
      id: 'source',
      title: 'Test source',
      publisher: 'Test publisher',
      url: 'https://example.test/source',
      retrievedAt: '2026-07-21',
      supportedClaim: 'The fixture has a target.',
      fidelity: 'representative',
    }],
    claims: [{
      id: 'target-claim',
      text: 'The fixture has a target.',
      fidelity: 'representative',
      sourceIds,
    }],
    frames: [
      { id: 'moon-j2000', kind: 'body-centered-inertial', bodyId: 'moon' },
      { id: 'gateway-lvlh', kind: 'lvlh', entityId: 'gateway', parentFrameId: 'moon-j2000' },
    ],
    entities: [
      {
        id: 'gateway',
        kind: 'station',
        label: 'Gateway',
        bodyId: 'moon',
        positionTrackId: 'gateway-position',
        attitudeTrackId: 'gateway-attitude',
        visual: { providerId: 'gateway-proxy', fidelity: 'proxy-visual', scalePolicy: 'physical' },
        fidelity: 'proxy-visual',
        sourceIds,
      },
      {
        id: 'orion',
        kind: 'spacecraft',
        label: 'Orion / I-Hab',
        bodyId: 'moon',
        positionTrackId: 'orion-position',
        attitudeTrackId: 'orion-attitude',
        visual: { providerId: 'orion-proxy', fidelity: 'proxy-visual', scalePolicy: 'minimum-pixel-size', minimumPixels: 8 },
        fidelity: 'proxy-visual',
        sourceIds,
      },
    ],
    phases: [
      {
        id: 'approach', title: 'Approach', narrative: 'Approach the station.',
        startTimeSeconds: 0, endTimeSeconds: 5, contextOnly: false,
        defaultCameraCueId: 'wide', suggestedRate: 10, claimIds: ['target-claim'],
      },
      {
        id: 'capture', title: 'Capture', narrative: 'Capture and dock.',
        startTimeSeconds: 5, endTimeSeconds: 10, contextOnly: false,
        defaultCameraCueId: 'close', suggestedRate: 1, claimIds: ['target-claim'],
      },
    ],
    tracks: [
      positionTrack('gateway-position', 'moon-j2000', { x: 100, y: 0, z: 0 }, { x: 100, y: 10, z: 0 }, { x: 0, y: 1, z: 0 }),
      positionTrack('orion-position', 'gateway-lvlh', { x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }),
      attitudeTrack('gateway-attitude', 'moon-j2000'),
      attitudeTrack('orion-attitude', 'gateway-lvlh'),
    ],
    events: [
      { id: 'soft', kind: 'soft-capture', timeSeconds: 6, title: 'Soft capture', entityIds: ['gateway', 'orion'], fidelity: 'representative', sourceIds },
      { id: 'hard', kind: 'hard-dock', timeSeconds: 8, title: 'Hard dock', entityIds: ['gateway', 'orion'], fidelity: 'representative', sourceIds },
    ],
    dockings: [{
      id: 'orion-gateway-docking', childEntityId: 'orion', targetEntityId: 'gateway',
      softCaptureEventId: 'soft', hardDockEventId: 'hard', dockedPosition: { x: 0, y: 2, z: 0 },
      dockedAttitude: { x: 0, y: 0, z: 0, w: 1 },
    }],
    cameraCues: [
      {
        id: 'wide', label: 'Wide', anchor: { kind: 'body', bodyId: 'moon' },
        offset: { x: 0, y: -1_000, z: 500 }, lookAt: { kind: 'entity', entityId: 'gateway' },
        fieldOfViewRadians: 0.8, transition: 'cut', fidelity: 'representative', sourceIds,
      },
      {
        id: 'close', label: 'Close', startTimeSeconds: 5, endTimeSeconds: 10,
        anchor: { kind: 'frame', frameId: 'gateway-lvlh' }, offset: { x: 20, y: -30, z: 10 },
        lookAt: { kind: 'entity', entityId: 'orion' }, fieldOfViewRadians: 0.6,
        transition: 'ease', transitionDurationSeconds: 1, fidelity: 'representative', sourceIds,
      },
    ],
    layers: [],
    telemetryChannels: [
      { id: 'elapsed', label: 'Elapsed', kind: 'elapsed-time', unit: 's', fidelity: 'representative', sourceIds: [] },
      { id: 'range', label: 'Range', kind: 'range', unit: 'm', entityId: 'orion', relativeToEntityId: 'gateway', fidelity: 'representative', sourceIds },
      { id: 'closing', label: 'Closing rate', kind: 'closing-rate', unit: 'm/s', entityId: 'orion', relativeToEntityId: 'gateway', fidelity: 'representative', sourceIds },
      { id: 'speed', label: 'Relative speed', kind: 'relative-speed', unit: 'm/s', entityId: 'orion', relativeToEntityId: 'gateway', fidelity: 'representative', sourceIds },
    ],
  };
}

describe('mission track interpolation', () => {
  it('uses the supplied endpoint derivatives for cubic Hermite position and velocity', () => {
    const from = {
      timeSeconds: 0,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    };
    const to = {
      timeSeconds: 10,
      position: { x: 10, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
    };

    expect(interpolateHermite(from, to, 0).position.x).toBe(0);
    expect(interpolateHermite(from, to, 0).velocity.x).toBe(0);
    expect(interpolateHermite(from, to, 10).position.x).toBe(10);
    expect(interpolateHermite(from, to, 10).velocity.x).toBe(0);

    const midpoint = interpolateHermite(from, to, 5);
    expect(midpoint.position.x).toBeCloseTo(5, 12);
    expect(midpoint.velocity.x).toBeCloseTo(1.5, 12);
    const epsilon = 1e-4;
    const before = interpolateHermite(from, to, 5 - epsilon).position.x;
    const after = interpolateHermite(from, to, 5 + epsilon).position.x;
    expect((after - before) / (2 * epsilon)).toBeCloseTo(midpoint.velocity.x, 6);
  });

  it('clamps track ends and handles looping boundaries explicitly', () => {
    const track: PositionVelocityTrackDefinition = {
      id: 'track',
      kind: 'position-velocity',
      frameId: 'frame',
      interpolation: 'cubic-hermite',
      extrapolation: 'clamp',
      timeUnit: 's',
      positionUnit: 'm',
      velocityUnit: 'm/s',
      fidelity: 'representative',
      sourceIds: [],
      samples: [
        { timeSeconds: 2, position: { x: 2, y: 0, z: 0 }, velocity: { x: 1, y: 0, z: 0 } },
        { timeSeconds: 4, position: { x: 4, y: 0, z: 0 }, velocity: { x: 1, y: 0, z: 0 } },
      ],
    };
    expect(evaluatePositionVelocityTrack(track, -100).position.x).toBe(2);
    expect(evaluatePositionVelocityTrack(track, 100).position.x).toBe(4);

    const loop = { ...track, extrapolation: 'loop' as const };
    expect(evaluatePositionVelocityTrack(loop, 4).position.x).toBe(4);
    expect(evaluatePositionVelocityTrack(loop, 5).position.x).toBeCloseTo(3, 12);
    expect(evaluatePositionVelocityTrack(loop, 1).position.x).toBeCloseTo(3, 12);
  });

  it('takes the shortest quaternion path and never mutates source quaternions', () => {
    const identity = { x: 0, y: 0, z: 0, w: 1 };
    const equivalentNegative = { x: 0, y: 0, z: 0, w: -1 };
    expect(shortestPathSlerp(identity, equivalentNegative, 0.5)).toEqual(new Quat(0, 0, 0, 1));
    expect(identity).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(equivalentNegative).toEqual({ x: 0, y: 0, z: 0, w: -1 });

    const halfTurn = { x: 0, y: 0, z: 1, w: 0 };
    const quarterTurn = shortestPathSlerp(identity, halfTurn, 0.5);
    const rotated = quarterTurn.rotate(new Vec3(1, 0, 0), new Vec3());
    expect(rotated.x).toBeCloseTo(0, 12);
    expect(rotated.y).toBeCloseTo(1, 12);
    expect(Math.hypot(quarterTurn.x, quarterTurn.y, quarterTurn.z, quarterTurn.w)).toBeCloseTo(1, 12);
  });

  it('evaluates attitude tracks deterministically at endpoints and between samples', () => {
    const track: AttitudeTrackDefinition = {
      id: 'attitude',
      kind: 'attitude',
      frameId: 'frame',
      interpolation: 'shortest-path-slerp',
      extrapolation: 'clamp',
      timeUnit: 's',
      fidelity: 'representative',
      sourceIds: [],
      samples: [
        { timeSeconds: 0, attitude: { x: 0, y: 0, z: 0, w: 1 } },
        { timeSeconds: 2, attitude: { x: 0, y: 0, z: 1, w: 0 } },
      ],
    };
    expect(evaluateAttitudeTrack(track, -1)).toEqual(new Quat(0, 0, 0, 1));
    const midpoint = evaluateAttitudeTrack(track, 1);
    expect(midpoint.z).toBeCloseTo(Math.SQRT1_2, 12);
    expect(midpoint.w).toBeCloseTo(Math.SQRT1_2, 12);
    expect(evaluateAttitudeTrack(track, 3)).toEqual(new Quat(0, 0, 1, 0));
  });
});

describe('mission playback clock', () => {
  it.each([0.25, 1, 10, 100, 1000] satisfies MissionPlaybackRate[])(
    'advances wall time at %sx',
    (rate) => {
      const clock = new MissionPlaybackClock(
        { startTimeSeconds: 0, endTimeSeconds: 10_000 },
        { initialRate: rate, initiallyPlaying: true },
      );
      expect(clock.advance(2).timeSeconds).toBe(2 * rate);
      expect(clock.lastChange.discontinuity).toBe(false);
    },
  );

  it('pauses, clamps at the story end, and rejects invalid wall time', () => {
    const clock = new MissionPlaybackClock(
      { startTimeSeconds: 2, endTimeSeconds: 5 },
      { initiallyPlaying: true },
    );
    clock.pause();
    expect(clock.advance(2).timeSeconds).toBe(2);
    clock.play();
    const ended = clock.advance(10);
    expect(ended.timeSeconds).toBe(5);
    expect(ended.isPlaying).toBe(false);
    expect(() => clock.advance(-1)).toThrow(/non-negative/);
  });

  it('marks seeks, phase jumps, and restarts with a monotonic discontinuity token', () => {
    const definition = createPlaybackDefinition();
    const clock = new MissionPlaybackClock(definition, { initialRate: 100, initiallyPlaying: true });
    expect(clock.snapshot().lastChange.discontinuity).toBe(true);

    const sought = clock.seek(7);
    expect(sought.lastChange).toMatchObject({
      kind: 'seek',
      previousTimeSeconds: 0,
      timeSeconds: 7,
      discontinuity: true,
      discontinuityToken: 1,
    });
    const phase = definition.phases[1];
    const jumped = clock.jumpToPhase(phase);
    expect(jumped.timeSeconds).toBe(5);
    expect(jumped.rate).toBe(100);
    expect(jumped.lastChange.discontinuityToken).toBe(2);
    const authoredJump = clock.jumpToPhase(phase, { applySuggestedRate: true });
    expect(authoredJump.rate).toBe(1);
    expect(authoredJump.lastChange.discontinuityToken).toBe(3);
    const restarted = clock.restartPhase(definition.phases[0]);
    expect(restarted.timeSeconds).toBe(0);
    expect(restarted.lastChange.kind).toBe('phase-restart');
    expect(restarted.lastChange.discontinuityToken).toBe(4);
  });
});

describe('direct-time mission evaluation', () => {
  it('selects half-open phases, timed camera cues, and all events reached by the frame', () => {
    const definition = createPlaybackDefinition();
    const state = new MissionPlaybackState(definition);
    expect(findMissionPhase(definition.phases, 4.999).id).toBe('approach');
    expect(findMissionPhase(definition.phases, 5).id).toBe('capture');
    expect(findMissionPhase(definition.phases, 10).id).toBe('capture');
    expect(state.evaluate(4).directorCue.id).toBe('wide');
    expect(state.evaluate(5).directorCue.id).toBe('close');
    expect(state.evaluate(6).events.map((event) => event.id)).toEqual(['soft']);
    expect(state.evaluate(8).events.map((event) => event.id)).toEqual(['soft', 'hard']);
    expect(state.evaluate(8).latestEvent?.id).toBe('hard');
  });

  it('transforms representative LVLH state into the focus-body inertial frame', () => {
    const frame = new MissionPlaybackState(createPlaybackDefinition()).evaluate(0);
    const gateway = frame.entitiesById.gateway;
    const orion = frame.entitiesById.orion;
    expect(gateway.position).toEqual({ x: 100, y: 0, z: 0 });
    expect(orion.position).toEqual({ x: 110, y: 0, z: 0 });
    expect(orion.velocity.x).toBeCloseTo(-1, 12);
    // 1 m/s target translation plus 0.1 m/s LVLH transport.
    expect(orion.velocity.y).toBeCloseTo(1.1, 12);
    expect(orion.velocity.z).toBeCloseTo(0, 12);
    expect(frame.universeTimeSeconds).toBe(1_000);
  });

  it('derives range, closing rate, and relative speed from the same evaluated poses', () => {
    const frame = new MissionPlaybackState(createPlaybackDefinition()).evaluate(0);
    expect(frame.telemetryById.elapsed.value).toBe(0);
    expect(frame.telemetryById.range.value).toBeCloseTo(10, 12);
    expect(frame.telemetryById.closing.value).toBeCloseTo(1, 12);
    expect(frame.telemetryById.speed.value).toBeCloseTo(Math.sqrt(1.01), 12);
  });

  it('derives soft and hard attachment state with no forward-history mutation', () => {
    const state = new MissionPlaybackState(createPlaybackDefinition());
    const before = state.evaluate(5);
    const soft = state.evaluate(6);
    const docked = state.evaluate(8);
    const rewound = state.evaluate(5);

    expect(before.dockings[0].status).toBe('independent');
    expect(soft.dockings[0].status).toBe('soft-captured');
    expect(soft.entitiesById.orion.attachedToEntityId).toBeNull();
    expect(docked.dockings[0].status).toBe('hard-docked');
    expect(docked.entitiesById.orion.attachedToEntityId).toBe('gateway');
    expect(docked.entitiesById.orion.position.x).toBeCloseTo(docked.entitiesById.gateway.position.x, 12);
    expect(docked.entitiesById.orion.position.y).toBeCloseTo(docked.entitiesById.gateway.position.y + 2, 12);
    expect(docked.telemetryById.speed.value).toBe(0);
    expect(rewound).toEqual(before);
    expect(rewound.entitiesById.orion.attachedToEntityId).toBeNull();
  });

  it('matches direct seek with any prior evaluation order and clamps outside the story', () => {
    const definition = createPlaybackDefinition();
    const state = new MissionPlaybackState(definition);
    const direct = state.evaluate(7.25);
    for (let time = 0; time <= 10; time += 0.25) state.evaluate(time);
    expect(state.evaluate(7.25)).toEqual(direct);
    expect(evaluateMissionDefinition(definition, -100).timeSeconds).toBe(0);
    expect(evaluateMissionDefinition(definition, 100).timeSeconds).toBe(10);
  });
});
