import { describe, expect, it } from 'vitest';
import type { MissionDefinition } from '../src/mission/types';
import {
  collectMissionValidationErrors,
  MissionValidationError,
  validateMissionDefinition,
} from '../src/mission/validate';

function validMission(): MissionDefinition {
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
      sourceIds: ['source'],
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
        sourceIds: ['source'],
      },
      {
        id: 'orion',
        kind: 'spacecraft',
        label: 'Orion / I-Hab',
        bodyId: 'moon',
        positionTrackId: 'orion-position',
        attitudeTrackId: 'orion-attitude',
        visual: {
          providerId: 'orion-proxy',
          fidelity: 'proxy-visual',
          scalePolicy: 'minimum-pixel-size',
          minimumPixels: 8,
        },
        fidelity: 'proxy-visual',
        sourceIds: ['source'],
      },
    ],
    phases: [
      {
        id: 'approach',
        title: 'Approach',
        narrative: 'Approach the station.',
        startTimeSeconds: 0,
        endTimeSeconds: 5,
        contextOnly: false,
        defaultCameraCueId: 'wide',
        suggestedRate: 10,
        claimIds: ['target-claim'],
      },
      {
        id: 'capture',
        title: 'Capture',
        narrative: 'Capture and dock.',
        startTimeSeconds: 5,
        endTimeSeconds: 10,
        contextOnly: false,
        defaultCameraCueId: 'close',
        suggestedRate: 1,
        claimIds: ['target-claim'],
      },
    ],
    tracks: [
      {
        id: 'gateway-position',
        kind: 'position-velocity',
        frameId: 'moon-j2000',
        interpolation: 'cubic-hermite',
        extrapolation: 'clamp',
        timeUnit: 's',
        positionUnit: 'm',
        velocityUnit: 'm/s',
        fidelity: 'reference-trajectory',
        sourceIds: ['source'],
        samples: [
          { timeSeconds: 0, position: { x: 100, y: 0, z: 0 }, velocity: { x: 0, y: 1, z: 0 } },
          { timeSeconds: 10, position: { x: 100, y: 10, z: 0 }, velocity: { x: 0, y: 1, z: 0 } },
        ],
      },
      {
        id: 'orion-position',
        kind: 'position-velocity',
        frameId: 'gateway-lvlh',
        interpolation: 'cubic-hermite',
        extrapolation: 'clamp',
        timeUnit: 's',
        positionUnit: 'm',
        velocityUnit: 'm/s',
        fidelity: 'representative',
        sourceIds: ['source'],
        samples: [
          { timeSeconds: 0, position: { x: 10, y: 0, z: 0 }, velocity: { x: -1, y: 0, z: 0 } },
          { timeSeconds: 10, position: { x: 0, y: 0, z: 0 }, velocity: { x: -1, y: 0, z: 0 } },
        ],
      },
      ...['gateway-attitude', 'orion-attitude'].map((id) => ({
        id,
        kind: 'attitude' as const,
        frameId: id === 'gateway-attitude' ? 'moon-j2000' : 'gateway-lvlh',
        interpolation: 'shortest-path-slerp' as const,
        extrapolation: 'clamp' as const,
        timeUnit: 's' as const,
        fidelity: 'representative' as const,
        sourceIds: ['source'],
        samples: [
          { timeSeconds: 0, attitude: { x: 0, y: 0, z: 0, w: 1 } },
          { timeSeconds: 10, attitude: { x: 0, y: 0, z: 0, w: 1 } },
        ],
      })),
    ],
    events: [
      {
        id: 'soft',
        kind: 'soft-capture',
        timeSeconds: 6,
        title: 'Soft capture',
        entityIds: ['gateway', 'orion'],
        fidelity: 'representative',
        sourceIds: ['source'],
      },
      {
        id: 'hard',
        kind: 'hard-dock',
        timeSeconds: 8,
        title: 'Hard dock',
        entityIds: ['gateway', 'orion'],
        fidelity: 'representative',
        sourceIds: ['source'],
      },
    ],
    dockings: [{
      id: 'orion-gateway-docking',
      childEntityId: 'orion',
      targetEntityId: 'gateway',
      softCaptureEventId: 'soft',
      hardDockEventId: 'hard',
      dockedPosition: { x: 0, y: 2, z: 0 },
      dockedAttitude: { x: 0, y: 0, z: 0, w: 1 },
    }],
    cameraCues: [
      {
        id: 'wide',
        label: 'Wide',
        anchor: { kind: 'body', bodyId: 'moon' },
        offset: { x: 0, y: -1_000, z: 500 },
        lookAt: { kind: 'entity', entityId: 'gateway' },
        up: { x: 0, y: 0, z: 1 },
        fieldOfViewRadians: 0.8,
        transition: 'cut',
        fidelity: 'representative',
        sourceIds: ['source'],
      },
      {
        id: 'close',
        label: 'Close',
        startTimeSeconds: 5,
        endTimeSeconds: 10,
        anchor: { kind: 'frame', frameId: 'gateway-lvlh' },
        offset: { x: 20, y: -30, z: 10 },
        lookAt: { kind: 'entity', entityId: 'orion' },
        fieldOfViewRadians: 0.6,
        transition: 'ease',
        transitionDurationSeconds: 1,
        fidelity: 'representative',
        sourceIds: ['source'],
      },
    ],
    layers: [{
      id: 'labels',
      label: 'Labels',
      defaultVisible: true,
      fidelity: 'proxy-visual',
      sourceIds: [],
    }],
    telemetryChannels: [
      {
        id: 'elapsed',
        label: 'Elapsed',
        kind: 'elapsed-time',
        unit: 's',
        fidelity: 'representative',
        sourceIds: [],
      },
      ...([
        ['range', 'Range', 'range', 'm'],
        ['closing', 'Closing rate', 'closing-rate', 'm/s'],
        ['speed', 'Relative speed', 'relative-speed', 'm/s'],
      ] as const).map(([id, label, kind, unit]) => ({
        id,
        label,
        kind,
        unit,
        entityId: 'orion',
        relativeToEntityId: 'gateway',
        fidelity: 'representative' as const,
        sourceIds: ['source'],
      })),
    ],
  };
}

describe('mission definition validation', () => {
  it('accepts a complete, cross-linked SI mission definition', () => {
    const definition = validMission();
    expect(collectMissionValidationErrors(definition)).toEqual([]);
    expect(validateMissionDefinition(definition)).toBe(definition);
  });

  it('aggregates actionable duplicate, reference, unit, sample, and quaternion errors', () => {
    const broken = structuredClone(validMission()) as any;
    broken.sources[0].retrievedAt = '2026-02-30';
    broken.entities[1].id = 'gateway';
    broken.entities[1].positionTrackId = 'missing-track';
    broken.tracks[0].positionUnit = 'km';
    broken.tracks[0].samples[1].timeSeconds = 0;
    broken.tracks[1].frameId = 'missing-frame';
    broken.tracks[2].samples[0].attitude = { x: 0, y: 0, z: 0, w: 0 };
    broken.telemetryChannels[1].relativeToEntityId = 'missing-entity';

    expect(() => validateMissionDefinition(broken)).toThrow(MissionValidationError);
    const errors = collectMissionValidationErrors(broken).join('\n');
    expect(errors).toContain('not a valid calendar date');
    expect(errors).toContain("duplicates 'gateway'");
    expect(errors).toContain("unknown track 'missing-track'");
    expect(errors).toContain("positionUnit must be 'm'");
    expect(errors).toContain('timeSeconds must be strictly increasing');
    expect(errors).toContain("unknown frame 'missing-frame'");
    expect(errors).toContain('attitude must be non-zero');
    expect(errors).toContain("unknown entity 'missing-entity'");
  });

  it('rejects phase gaps and overlaps instead of guessing which phase is active', () => {
    const gap = structuredClone(validMission()) as any;
    gap.phases[1].startTimeSeconds = 6;
    expect(collectMissionValidationErrors(gap).join('\n')).toContain('gap after');

    const overlap = structuredClone(validMission()) as any;
    overlap.phases[1].startTimeSeconds = 4;
    expect(collectMissionValidationErrors(overlap).join('\n')).toContain('overlaps');
  });

  it('rejects cyclic frame-driven entity dependencies', () => {
    const broken = structuredClone(validMission()) as any;
    broken.tracks[0].frameId = 'gateway-lvlh';
    expect(collectMissionValidationErrors(broken)).toContain(
      'entity dependency cycle: gateway -> gateway',
    );
  });

  it('rejects trajectory roots and entities centred on a body other than the mission focus', () => {
    const broken = structuredClone(validMission()) as any;
    broken.frames[0].bodyId = 'earth';
    broken.entities[0].bodyId = 'earth';
    const errors = collectMissionValidationErrors(broken).join('\n');
    expect(errors).toContain("frames[0].bodyId must match mission focus body 'moon'");
    expect(errors).toContain("entities[0].bodyId must match mission focus body 'moon'");
  });

  it('requires docking transitions to reference ordered soft and hard capture events', () => {
    const broken = structuredClone(validMission()) as any;
    broken.dockings[0].softCaptureEventId = 'hard';
    broken.events[1].timeSeconds = 5;
    const errors = collectMissionValidationErrors(broken).join('\n');
    expect(errors).toContain('softCaptureEventId must reference a soft-capture event');

    const reversed = structuredClone(validMission()) as any;
    reversed.events[0].timeSeconds = 9;
    expect(collectMissionValidationErrors(reversed).join('\n')).toContain('hard-dock event cannot precede soft capture');
  });
});
