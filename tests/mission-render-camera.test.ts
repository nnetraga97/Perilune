import { describe, expect, test } from 'vitest';
import {
  MISSION_CAMERA_MODES,
  MissionCameraController,
  lvlhBasis,
  type MissionCameraCue,
  type MissionCameraFrame,
} from '../src/render/missionCameraController';
import { FLIGHT_CAMERA_MODES } from '../src/render/worldScene';

const IDENTITY = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

function cue(overrides: Partial<MissionCameraCue> = {}): MissionCameraCue {
  return {
    id: 'gateway-wide',
    anchor: { kind: 'body', bodyId: 'moon' },
    offset: { x: 100, y: -200, z: 50 },
    lookAt: { kind: 'entity', entityId: 'gateway' },
    fieldOfViewRadians: Math.PI / 3,
    transition: 'ease',
    transitionDurationSeconds: 1,
    ...overrides,
  };
}

function frame(overrides: Partial<MissionCameraFrame> = {}): MissionCameraFrame {
  return {
    timeSeconds: 10,
    focusBodyId: 'moon',
    focusBodyRadius: 1_737_400,
    entities: [
      {
        id: 'gateway',
        kind: 'station',
        label: 'Gateway',
        position: { x: 4_000_000, y: 100, z: 0 },
        velocity: { x: 0, y: 1_000, z: 0 },
        attitude: IDENTITY,
        visual: { providerId: 'gateway-proxy' },
      },
      {
        id: 'orion',
        kind: 'spacecraft',
        label: 'Orion',
        position: { x: 4_000_500, y: 100, z: 0 },
        velocity: { x: 0, y: 999, z: 0 },
        attitude: IDENTITY,
        visual: { providerId: 'orion-proxy' },
      },
    ],
    directorCue: cue(),
    frameDefinitions: [
      { id: 'moon-j2000', kind: 'body-centered-inertial', bodyId: 'moon' },
      { id: 'gateway-local', kind: 'entity-local', entityId: 'gateway', parentFrameId: 'moon-j2000' },
      { id: 'gateway-lvlh', kind: 'lvlh', entityId: 'gateway', parentFrameId: 'moon-j2000' },
    ],
    ...overrides,
  };
}

describe('mission camera controller', () => {
  test('stays separate from flight modes', () => {
    expect(FLIGHT_CAMERA_MODES).toEqual(['orbit', 'chase', 'locked', 'free']);
    expect(MISSION_CAMERA_MODES).toEqual([
      'director',
      'gateway-orbit',
      'orion-follow',
      'moon-overview',
      'free',
    ]);
    expect(FLIGHT_CAMERA_MODES).not.toContain('director');
  });

  test('solves entity-local and LVLH director cues deterministically', () => {
    const controller = new MissionCameraController();
    const quarterTurn = { x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) };
    const localFrame = frame({
      entities: [{
        id: 'gateway',
        kind: 'station',
        label: 'Gateway',
        position: { x: 1_000, y: 2_000, z: 3_000 },
        velocity: { x: 0, y: 10, z: 0 },
        attitude: quarterTurn,
        visual: { providerId: 'gateway-proxy' },
      }],
      directorCue: cue({
        anchor: { kind: 'frame', frameId: 'gateway-local' },
        offset: { x: 10, y: 0, z: 0 },
        lookAt: { kind: 'entity', entityId: 'gateway' },
      }),
    });

    const localPose = controller.desiredPose(localFrame);
    expect(localPose.position.x).toBeCloseTo(1_000, 8);
    expect(localPose.position.y).toBeCloseTo(2_010, 8);
    expect(localPose.position.z).toBeCloseTo(3_000, 8);
    expect(localPose.target).toEqual({ x: 1_000, y: 2_000, z: 3_000 });

    const basis = lvlhBasis({ x: 10, y: 0, z: 0 }, { x: 0, y: 4, z: 0 });
    expect(basis.radial).toMatchObject({ x: 1, y: 0, z: 0 });
    expect(basis.alongTrack).toMatchObject({ x: 0, y: 1, z: 0 });
    expect(basis.normal).toMatchObject({ x: 0, y: 0, z: 1 });
  });

  test('smooths continuous playback but snaps and reseeds discontinuous seeks', () => {
    const controller = new MissionCameraController();
    const first = controller.update(frame(), 1 / 60, { discontinuityToken: 1 });
    expect(first.discontinuity).toBe(true);
    expect(first.position).toEqual({ x: 100, y: -200, z: 50 });

    const movedFrame = frame({
      timeSeconds: 11,
      directorCue: cue({ offset: { x: 300, y: -500, z: 150 } }),
    });
    const smooth = controller.update(movedFrame, 1 / 60, { discontinuityToken: 1 });
    expect(smooth.discontinuity).toBe(false);
    expect(smooth.position.x).toBeGreaterThan(100);
    expect(smooth.position.x).toBeLessThan(300);

    const sought = controller.update(movedFrame, 1 / 60, {
      discontinuity: true,
      discontinuityToken: 2,
    });
    expect(sought.discontinuity).toBe(true);
    expect(sought.position).toEqual({ x: 300, y: -500, z: 150 });

    const backwards = controller.update(frame({ timeSeconds: 5 }), 1 / 60, { discontinuityToken: 2 });
    expect(backwards.discontinuity).toBe(true);
    expect(backwards.position).toEqual({ x: 100, y: -200, z: 50 });
  });

  test('manual takeover persists across phase cues until Return to Director', () => {
    const controller = new MissionCameraController();
    controller.update(frame(), 1 / 60);
    controller.orbit(0.2, -0.1);
    expect(controller.cameraMode()).toBe('free');
    expect(controller.directorActive()).toBe(false);

    const nextPhase = frame({
      timeSeconds: 20,
      directorCue: cue({
        id: 'capture-close',
        offset: { x: 10, y: -30, z: 8 },
        transition: 'cut',
      }),
    });
    const manual = controller.update(nextPhase, 1 / 60);
    expect(controller.cameraMode()).toBe('free');
    expect(manual.position).not.toEqual({ x: 10, y: -30, z: 8 });

    controller.returnToDirector();
    const directed = controller.update(nextPhase, 1 / 60, { discontinuity: true });
    expect(controller.directorActive()).toBe(true);
    expect(directed.position).toEqual({ x: 10, y: -30, z: 8 });
  });

  test('reduced motion cuts to each desired pose and degenerate LVLH remains finite', () => {
    const controller = new MissionCameraController();
    controller.setReducedMotion(true);
    controller.update(frame(), 1 / 60);
    const next = controller.update(frame({
      timeSeconds: 11,
      directorCue: cue({ offset: { x: -20, y: -40, z: 5 } }),
    }), 1 / 60);
    // Reduced motion snaps visual interpolation without fabricating a timeline
    // discontinuity on every continuously evaluated frame.
    expect(next.discontinuity).toBe(false);
    expect(next.position).toEqual({ x: -20, y: -40, z: 5 });

    const basis = lvlhBasis({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    for (const axis of [basis.radial, basis.alongTrack, basis.normal]) {
      expect(Number.isFinite(axis.x) && Number.isFinite(axis.y) && Number.isFinite(axis.z)).toBe(true);
      expect(axis.length()).toBeCloseTo(1, 8);
    }
  });
});
