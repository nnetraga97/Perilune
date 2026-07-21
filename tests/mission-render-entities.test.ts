import { describe, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import {
  MissionEntityRenderer,
  minimumApparentScale,
  type MissionRenderableEntity,
  type MissionVisualInstance,
} from '../src/render/missionEntityRenderer';
import { WorldScene } from '../src/render/worldScene';
import { createEnvironmentLightingState } from '../src/render/lightingPolicy';

const IDENTITY = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

function entity(overrides: Partial<MissionRenderableEntity> = {}): MissionRenderableEntity {
  return {
    id: 'test-entity',
    kind: 'spacecraft',
    label: 'Test Entity',
    position: { x: 100, y: 20, z: -5 },
    velocity: { x: 0, y: 1, z: 0 },
    attitude: IDENTITY,
    visual: { providerId: 'custom', scalePolicy: 'physical' },
    ...overrides,
  };
}

describe('mission entity rendering', () => {
  test('keeps stable scene objects and reapplies camera-relative poses without reparenting', () => {
    const scene = new THREE.Scene();
    const dispose = vi.fn();
    const provider = vi.fn((): MissionVisualInstance => ({
      root: new THREE.Group(),
      physicalDiameter: 10,
      dispose,
    }));
    const renderer = new MissionEntityRenderer(scene, { providers: { custom: provider } });
    const camera = new THREE.PerspectiveCamera(50, 1, 0.3, 1e8);
    const first = entity();

    renderer.update([first], { x: 10, y: 5, z: -10 }, camera, 1000);
    const object = renderer.entityObject(first.id);
    expect(object).not.toBeNull();
    expect(object?.position.toArray()).toEqual([90, 15, 5]);
    expect(object?.parent).toBe(renderer.root);

    renderer.update([
      entity({ position: { x: -40, y: 8, z: 12 }, attitude: { x: 0, y: 0, z: 1, w: 0 } }),
    ], { x: 5, y: -2, z: 2 }, camera, 1000);
    expect(renderer.entityObject(first.id)).toBe(object);
    expect(object?.position.toArray()).toEqual([-45, 10, 10]);
    expect(object?.quaternion.toArray()).toEqual([0, 0, 1, 0]);
    expect(object?.parent).toBe(renderer.root);
    expect(provider).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();

    renderer.update([], { x: 0, y: 0, z: 0 }, camera, 1000);
    expect(renderer.entityObject(first.id)).toBeNull();
    expect(dispose).toHaveBeenCalledOnce();
  });

  test('owns disposable path overlays and obeys reference/corridor/label layers', () => {
    const scene = new THREE.Scene();
    const renderer = new MissionEntityRenderer(scene);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.3, 1e8);
    const gateway = entity({
      id: 'gateway',
      label: 'Gateway',
      kind: 'station',
      visual: { providerId: 'gateway-proxy', scalePolicy: 'minimum-pixel-size', minimumPixels: 7 },
    });
    const paths = [
      {
        id: 'nrho',
        kind: 'reference-orbit' as const,
        points: [{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }],
      },
      {
        id: 'corridor',
        kind: 'approach-corridor' as const,
        points: [{ x: 50, y: 10, z: 0 }, { x: 10, y: 2, z: 0 }],
      },
    ];

    renderer.update([gateway], { x: 10, y: 0, z: 0 }, camera, 1000, paths, {
      referenceOrbit: false,
      approachCorridor: true,
      labels: false,
    });

    const orbit = renderer.pathRoot.getObjectByName('mission-path:nrho') as THREE.Line;
    const corridor = renderer.pathRoot.getObjectByName('mission-path:corridor') as THREE.Line;
    expect(orbit.visible).toBe(false);
    expect(corridor.visible).toBe(true);
    expect((corridor.geometry.getAttribute('position') as THREE.BufferAttribute).getX(0)).toBe(40);
    expect(renderer.entityObject('gateway')?.userData.proxyVisualId).toBe('gateway');
    expect(renderer.entityObject('gateway')?.getObjectByName('proxy-visual-label')?.visible ?? false).toBe(false);
    expect(renderer.stats()).toEqual({ visuals: 1, proxyVisuals: 1, paths: 2 });

    const orbitGeometry = orbit.geometry;
    const corridorGeometry = corridor.geometry;
    const orbitDispose = vi.spyOn(orbitGeometry, 'dispose');
    const corridorDispose = vi.spyOn(corridorGeometry, 'dispose');
    renderer.reset();
    expect(orbitDispose).toHaveBeenCalledOnce();
    expect(corridorDispose).toHaveBeenCalledOnce();
    expect(renderer.stats()).toEqual({ visuals: 0, proxyVisuals: 0, paths: 0 });

    renderer.dispose();
    renderer.dispose();
    expect(scene.children).not.toContain(renderer.root);
    expect(scene.children).not.toContain(renderer.pathRoot);
  });

  test('minimum-pixel presentation never shrinks a physically scaled proxy', () => {
    expect(minimumApparentScale(100, 50, 1000, 8, 10, 2)).toBe(2);
    expect(minimumApparentScale(1_000_000, 50, 1000, 8, 10, 1)).toBeGreaterThan(1);
    expect(minimumApparentScale(1_000_000, 50, 0, 8, 10, 3)).toBe(3);
  });

  test('WorldScene mission cleanup is explicit, idempotent, and retains shared body ownership', () => {
    const missionDispose = vi.fn();
    const camera = new THREE.PerspectiveCamera(62, 1, 0.3, 1e8);
    camera.fov = 48;
    camera.quaternion.set(0.1, 0.2, 0.3, 0.9).normalize();
    camera.up.set(0, 0, 1);
    const expectedQuaternion = new THREE.Quaternion(0, 0, 0, 1);
    const expectedUp = new THREE.Vector3(0, 1, 0);
    const world = Object.create(WorldScene.prototype) as WorldScene;
    Object.assign(world as unknown as Record<string, unknown>, {
      missionEntities: { dispose: missionDispose, reset: vi.fn() },
      lastBodyFrames: new Map([['moon', {}]]),
      landingLight: { intensity: 3, distance: 100 },
      launchSite: { visible: true },
      presentationMode: 'mission',
      bodyRendererManagers: new Map([['moon', {}]]),
      camera,
      context: { renderer: { toneMappingExposure: 2.4 } },
      missionPresentationSnapshot: {
        fov: 62,
        quaternion: expectedQuaternion,
        up: expectedUp,
        exposure: 1.15,
      },
    });

    world.disposeMissionState();
    world.disposeMissionState();

    expect(missionDispose).toHaveBeenCalledOnce();
    expect((world as unknown as { lastBodyFrames: Map<string, unknown> }).lastBodyFrames.size).toBe(0);
    expect((world as unknown as { bodyRendererManagers: Map<string, unknown> }).bodyRendererManagers.size).toBe(1);
    expect((world as unknown as { landingLight: { intensity: number } }).landingLight.intensity).toBe(0);
    expect((world as unknown as { launchSite: { visible: boolean } }).launchSite.visible).toBe(false);
    expect(camera.fov).toBe(62);
    expect(camera.quaternion.equals(expectedQuaternion)).toBe(true);
    expect(camera.up.equals(expectedUp)).toBe(true);
    expect((world as unknown as { context: { renderer: { toneMappingExposure: number } } }).context.renderer.toneMappingExposure).toBe(1.15);
    expect((world as unknown as { missionPresentationSnapshot: unknown }).missionPresentationSnapshot).toBeNull();
  });

  test('WorldScene mission path renders without any active GameVessel or flight-only stage', () => {
    const focusBody = {
      id: 'moon',
      radius: 1_737_400,
      def: { surfaceKind: 'solid' },
      parent: null,
      children: [],
    };
    const rootBody = { id: 'sun', radius: 696_340_000, def: { isStar: true }, parent: null, children: [] };
    const stage = vi.fn();
    const missionUpdate = vi.fn();
    const smokeClear = vi.fn();
    const world = Object.create(WorldScene.prototype) as WorldScene;
    Object.assign(world as unknown as Record<string, unknown>, {
      disposed: false,
      presentationMode: 'idle',
      activeVesselId: 'old-flight-vessel',
      flightTerrainBodyId: null,
      flightPromotedBodyId: null,
      flightPromotionPending: new Set(),
      flightPromotionFailed: new Set(),
      bodyRendererManagers: new Map(),
      bodyRenderers: new Map(),
      vesselVisuals: new Map(),
      reentryEffect: null,
      reentryVesselId: null,
      reentryFingerprint: '',
      reentrySignal: { strength: 0, transonic: 0 },
      srbSmoke: { clear: smokeClear },
      launchSite: { visible: true },
      landingLight: { intensity: 1, distance: 100 },
      lastBodyFrames: new Map([['moon', {}]]),
      camera: new THREE.PerspectiveCamera(62, 1, 0.3, 6e8),
      context: {
        renderer: {
          toneMappingExposure: 1,
          getDrawingBufferSize: (out: THREE.Vector2) => out.set(1200, 800),
        },
      },
      scene: Object.assign(new THREE.Scene(), { background: new THREE.Color('#04070a') }),
      environment: new THREE.HemisphereLight(),
      environmentState: createEnvironmentLightingState(),
      missionEntities: { update: missionUpdate, stats: () => ({ visuals: 0, proxyVisuals: 0, paths: 0 }) },
      updateCelestialBodyStage: stage,
    });

    world.updateMission({
      universe: {
        root: rootBody,
        bodies: new Map<string, unknown>([['moon', focusBody], ['sun', rootBody]]),
        absolutePosition: (
          _body: unknown,
          _time: number,
          out: { set(x: number, y: number, z: number): unknown },
        ) => { out.set(0, 0, 0); },
      },
      universeTimeSeconds: 123,
      focusBodyId: 'moon',
      entities: [],
      paths: [],
      layers: { referenceOrbit: false, approachCorridor: false, labels: false },
    } as never, {
      position: { x: 4_000_000, y: -200, z: 100 },
      target: { x: 4_000_000, y: 0, z: 0 },
      up: { x: 1, y: 0, z: 0 },
      fieldOfViewDegrees: 50,
      discontinuity: true,
    }, 1 / 60);

    expect(stage).toHaveBeenCalledOnce();
    expect(stage.mock.calls[0][0]).toMatchObject({
      focusBody,
      time: 123,
      allowFlightTerrain: false,
    });
    expect(stage.mock.calls[0][0]).not.toHaveProperty('surfaceAnchorBodyRelative');
    expect(missionUpdate).toHaveBeenCalledOnce();
    expect(smokeClear).toHaveBeenCalledOnce();
    expect((world as unknown as { activeVesselId: string | null }).activeVesselId).toBeNull();
    expect((world as unknown as { launchSite: { visible: boolean } }).launchSite.visible).toBe(false);
    expect((world as unknown as { landingLight: { intensity: number } }).landingLight.intensity).toBe(0);
  });
});
