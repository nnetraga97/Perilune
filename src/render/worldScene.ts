/**
 * Flight world scene: camera-relative rendering of the current SOI body,
 * nearby bodies, vessels, atmosphere tint, and sun light.
 *
 * The camera sits at the scene origin (floating origin, ADR-003); every
 * object's world position is computed in f64 relative to the camera each
 * frame before being written into f32 scene positions.
 */
import * as THREE from 'three';
import { Vec3 } from '../core/vec3';
import { Quat } from '../core/quat';
import { wrapOrbitAngle } from '../core/cameraOrbit';
import {
  GameState,
  GameVessel,
  LAUNCH_PAD_CONTACT_RADIUS,
  LAUNCH_PAD_FOOTPRINT_RADIUS,
  launchSiteDirection,
} from '../sim/state';
import { groundRadiusInertial, launchPadTerrainEnvelope } from '../sim/terrain';
import type { Body } from '../sim/universe';
import {
  planetDataAuthorityForBody,
  type FrozenPlanetDataAuthority,
} from '../sim/planetDataAuthority';
import type { PlanetQuality } from './planet';
import { buildVesselVisual, disposeVesselVisual, syncVesselVisual, VesselVisual } from './vesselMesh';
import type { PartModelLibrary } from './partModelLibrary';
import { makeStarfield } from './starfield';
import { bodyOrientation, inertialToBodyFixed, surfaceVelocity } from '../sim/bodyOrientation';
import type { RenderContext } from './context';
import type { BodyRenderer, BodyRenderFrame, QualityTier, RuntimeBodyAssetPack, VectorCoordinates } from './bodyRenderer';
import { BODY_VISUALS, DEFAULT_ENTRY_VISUAL, type BodyId, type BodyRendererKind } from '../content/bodyVisuals';
import { createBodyRendererCandidate } from './bodyRendererFactory';
import { BodyRendererManager, RendererResourceLedger } from './bodyRendererManager';
import { compileRendererCandidate } from './shaderCompiler';
import checkedPlanetArtifact from '../generated/checked-planet-manifest.json';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { checkPlanetManifest, PlanetAssetLoader, type CheckedPlanetManifest } from './planetAssetLoader';
import { geometryByteLength } from './resourceAccounting';
import type { RenderDiagnosticsPort } from './renderDiagnostics';
import { SrbSmokePool } from './srbSmoke';
import { bodyFixedFrustumPlanes, type BodyFixedFrustumPlane } from './terrain/terrainFrustum';
import { ActiveReentryEffect, type ReentryEffectStats } from './reentryEffects';
import { craftReentryFingerprint } from './reentryGeometry';
import { signalFromAero, type ReentrySignal } from './reentrySignal';
import { computeCelestialProjection, type CelestialProjection } from './celestialProjection';
import { celestialOcclusion } from './celestialOcclusion';
import {
  adaptExposure,
  createEnvironmentLightingState,
  environmentLighting,
  landingVisibilityAid,
  localShadowPolicy,
  snapShadowCenter,
} from './lightingPolicy';
import {
  bindFlightAerialPerspective,
  FlightAerialPerspectiveController,
} from './flightAerialPerspective';
import {
  MissionEntityRenderer,
  type MissionRenderLayers,
  type MissionRenderPath,
  type MissionRenderableEntity,
} from './missionEntityRenderer';
import type { MissionCameraPose } from './missionCameraController';

const _camAbs = new Vec3();
const _bodyAbs = new Vec3();
const _vesselAbs = new Vec3();
const _rel = new Vec3();
const _camBF = new Vec3();
const _surfaceAnchorBF = new Vec3();
const _sunDir = new Vec3();
const _tmp = new Vec3();
const _bodyQ = new Quat();
const _starAbs = new Vec3();
const _bodySunDir = new Vec3();
const _drawingBufferSize = new THREE.Vector2();
const _east = new Vec3();
const _north = new Vec3();
const _camOffset = new Vec3();
const _cameraOrbitUp = new Vec3();
const _craftRight = new Vec3();
const _craftNose = new Vec3();
const _craftUp = new Vec3();

async function loadSurfaceClassTexture(path: string): Promise<THREE.DataTexture> {
  const response = await fetch(path, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Surface-class PNG failed: HTTP ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Surface-class PNG requires a 2D decode context');
    context.drawImage(bitmap, 0, 0);
    const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const codes = new Uint8Array(bitmap.width * bitmap.height);
    for (let index = 0; index < codes.length; index++) {
      const offset = index * 4;
      const code = rgba[offset];
      if (code > 6 || rgba[offset + 1] !== code || rgba[offset + 2] !== code) {
        throw new Error(`Surface-class PNG contains invalid code ${code}`);
      }
      codes[index] = code;
    }
    const texture = new THREE.DataTexture(codes, bitmap.width, bitmap.height, THREE.RedFormat, THREE.UnsignedByteType);
    texture.flipY = false;
    return texture;
  } finally {
    bitmap.close();
  }
}
const _chaseForward = new Vec3();
const _chaseRight = new Vec3();
const _cameraFromBody = new Vec3();
const _cameraBodyRelative = new Vec3();
const _cameraVelocity = new Vec3();
const _cameraViewDirectionBF = new Vec3();
const _cameraForwardThree = new THREE.Vector3();
const _cameraForwardWorld = new Vec3();
const _renderOffset = new THREE.Vector3();
const _previousCameraRotation = new THREE.Quaternion();
const _targetCameraRotation = new THREE.Quaternion();
const _skyColor = new THREE.Color();
const _smokeNozzleRelative = new THREE.Vector3();
const _smokeNozzleBodyRelative = new THREE.Vector3();
const _smokeDirection = new THREE.Vector3();
const _smokeUp = new THREE.Vector3();
const _smokeQuaternion = new THREE.Quaternion();
const _reentryAtmosphereVelocity = new Vec3();
const _reentryVelocityOS = new THREE.Vector3(0, 1, 0);
const _reentryInverseAttitude = new THREE.Quaternion();
const _occluderAbs = new Vec3();
const _occluderDirection = new Vec3();
const _shadowCenter = new THREE.Vector3();
const _shadowDirection = new THREE.Vector3();
interface MutableVectorCoordinates { x: number; y: number; z: number }
interface MutableQuaternionCoordinates extends MutableVectorCoordinates { w: number }
interface MutableBodyRenderFrame {
  cameraRelativeOrigin: MutableVectorCoordinates;
  cameraBodyFixed: MutableVectorCoordinates;
  cameraViewDirectionBodyFixed: MutableVectorCoordinates;
  bodyFixedFrustum: BodyFixedFrustumPlane[];
  surfaceAnchorBodyFixed?: MutableVectorCoordinates;
  cameraBodyFixedVelocity: MutableVectorCoordinates;
  verticalFovRadians: number;
  drawingBufferWidth: number;
  drawingBufferHeight: number;
  projection: CelestialProjection;
  orientation: MutableQuaternionCoordinates;
  cameraSunDirection: MutableVectorCoordinates;
  bodySunDirection: MutableVectorCoordinates;
  solarVisibleFraction: number;
  solarOccluder?: {
    direction: MutableVectorCoordinates;
    angularRadius: number;
  };
  time: number;
  deltaSeconds: number;
  framePressure: boolean;
  altitude: number;
  allowFlightTerrain: boolean;
}

/** Structural subset of Universe required by the camera-relative body stage. */
export interface MissionCelestialUniverse {
  readonly root: Body;
  readonly bodies: ReadonlyMap<string, Body>;
  absolutePosition(body: Body, time: number, outPosition: Vec3, outVelocity?: Vec3): void;
}

/** Render-facing adapter for EvaluatedMissionFrame plus its immutable universe. */
export interface MissionWorldFrame {
  readonly universe: MissionCelestialUniverse;
  readonly universeTimeSeconds: number;
  readonly focusBodyId: string;
  readonly entities: readonly Readonly<MissionRenderableEntity>[];
  readonly paths?: readonly Readonly<MissionRenderPath>[];
  readonly layers?: Readonly<MissionRenderLayers>;
}

interface CelestialBodyStageInput {
  readonly universe: MissionCelestialUniverse;
  readonly focusBody: Body;
  readonly time: number;
  readonly cameraAbsolute: Readonly<Vec3>;
  readonly cameraForward: Readonly<Vec3>;
  readonly deltaSeconds: number;
  readonly verticalFovRadians: number;
  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;
  readonly allowFlightTerrain: boolean;
  readonly surfaceAnchorBodyRelative?: Readonly<Vec3>;
}

function copyCoordinates(target: MutableVectorCoordinates, source: Readonly<VectorCoordinates>): void {
  target.x = source.x; target.y = source.y; target.z = source.z;
}

export function usesLegacyAtmosphereTint(rendererKind: BodyRendererKind | undefined): boolean {
  return rendererKind !== 'terrestrial';
}

export function sunLightPosition(
  sunDirection: Readonly<Vec3>,
  distance: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  return out.set(sunDirection.x * distance, sunDirection.y * distance, sunDirection.z * distance);
}

export interface WorldRendererStats {
  readonly chunks: number;
  readonly visibleChunks: number;
  readonly rendererManagers: number;
  readonly residentFlightPacks: number;
  /** Checked flight-pack allocation only; procedural renderer resources are not mislabeled as zero. */
  readonly residentPackGpuBytes: number;
  readonly rendererFailures: number;
  /** Transaction candidates are hidden and swapped atomically; no fade clock exists yet. */
  readonly transitionActive: boolean;
  readonly transitionMs: number;
  readonly contextFallback: boolean;
}

export interface WorldSceneOptions {
  readonly quality: 'medium' | 'high';
  readonly diagnostics: RenderDiagnosticsPort;
  readonly reentryEffectsEnabled?: boolean;
  /** Application-owned decoder shared with part models. */
  readonly ktx2Loader?: KTX2Loader;
}

export const FLIGHT_CAMERA_MODES = ['orbit', 'chase', 'locked', 'free'] as const;
export type FlightCameraMode = (typeof FLIGHT_CAMERA_MODES)[number];

export function bodyFixedCameraVelocity(
  current: VectorCoordinates,
  previous: Readonly<BodyRenderFrame> | undefined,
  deltaSeconds: number,
  out: MutableVectorCoordinates = { x: 0, y: 0, z: 0 },
): VectorCoordinates {
  if (!previous || !(deltaSeconds > 0)) {
    out.x = 0; out.y = 0; out.z = 0;
    return out;
  }
  const inverseDelta = 1 / deltaSeconds;
  out.x = (current.x - previous.cameraBodyFixed.x) * inverseDelta;
  out.y = (current.y - previous.cameraBodyFixed.y) * inverseDelta;
  out.z = (current.z - previous.cameraBodyFixed.z) * inverseDelta;
  return out;
}

export function pruneBodyFrameSamples(
  samples: Map<string, BodyRenderFrame>,
  sampledBodyIds: ReadonlySet<string>,
): void {
  for (const bodyId of samples.keys()) {
    if (!sampledBodyIds.has(bodyId)) samples.delete(bodyId);
  }
}

function rendererGeometryBytes(renderer: BodyRenderer): number {
  const geometries = new Set<THREE.BufferGeometry>();
  renderer.root.traverse((object) => {
    if (object instanceof THREE.Mesh) geometries.add(object.geometry);
  });
  let bytes = 0;
  for (const geometry of geometries) bytes += geometryByteLength(geometry);
  return bytes;
}

export class WorldScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly environment: THREE.HemisphereLight;
  private readonly landingLight: THREE.SpotLight;
  private readonly environmentState = createEnvironmentLightingState();
  private readonly starfield: THREE.Points;
  private bodyRenderers = new Map<string, BodyRenderer>();
  private bodyRendererManagers = new Map<string, BodyRendererManager>();
  private bodyRendererLoads = new Map<string, Promise<void>>();
  /** Explicit authority selected only at the launch boundary. */
  private bodyAuthorities = new Map<string, Readonly<FrozenPlanetDataAuthority>>();
  private lastBodyFrames = new Map<string, BodyRenderFrame>();
  private readonly rendererLedger: RendererResourceLedger;
  private readonly checkedPlanetManifest: CheckedPlanetManifest;
  private readonly planetAssetLoader: PlanetAssetLoader;
  private vesselVisuals = new Map<string, VesselVisual>();
  private missionEntities: MissionEntityRenderer | null = null;
  private presentationMode: 'idle' | 'flight' | 'mission' = 'idle';
  /** Shared camera state is borrowed by replay and restored exactly on exit. */
  private missionPresentationSnapshot: {
    readonly fov: number;
    readonly quaternion: THREE.Quaternion;
    readonly up: THREE.Vector3;
    readonly exposure: number;
  } | null = null;
  private readonly srbSmoke: SrbSmokePool;
  private readonly launchSite: THREE.Group;
  private readonly flightAerial = new FlightAerialPerspectiveController();
  private quality: QualityTier;
  private readonly diagnostics: RenderDiagnosticsPort;
  private readonly resizeHandler: () => void;
  private readonly unsubscribeRestoration: () => void;
  private disposed = false;
  private flightTerrainBodyId: string | null = null;
  private flightPromotedBodyId: string | null = null;
  private readonly flightPromotionPending = new Set<string>();
  private readonly flightPromotionFailed = new Set<string>();
  private renderFailureState: { bodyId: string; message: string } | null = null;
  /** Last active vessel id, tracked for the read-only plume-count test probe. */
  private activeVesselId: string | null = null;
  private readonly renderSet = new Set<string>();
  private readonly sampledBodyIds = new Set<string>();
  private readonly considerBodies: Body[] = [];
  private effectTime = 0;
  /** Exactly one v1 reentry stack follows the active vessel. */
  private reentryEffect: ActiveReentryEffect | null = null;
  private reentryVesselId: string | null = null;
  private reentryFingerprint = '';
  private reentrySignal: ReentrySignal = { strength: 0, transonic: 0 };
  private reentryVelocityOS = new THREE.Vector3(0, 1, 0);
  private readonly reentryEffectsEnabled: boolean;
  private reducedMotion = false;

  /** Camera rig: orbit around the active vessel. */
  camYaw = 0.6;
  camPitch = 0.35;
  camDist = 18;
  cameraMode: FlightCameraMode = 'orbit';
  cameraSmoothing = true;

  setReducedMotion(reduced: boolean): void { this.reducedMotion = reduced; }

  cycleCameraMode(): FlightCameraMode {
    const index = FLIGHT_CAMERA_MODES.indexOf(this.cameraMode);
    this.cameraMode = FLIGHT_CAMERA_MODES[(index + 1) % FLIGHT_CAMERA_MODES.length];
    this.resetCamera(false);
    return this.cameraMode;
  }

  resetCamera(resetMode = false): void {
    if (resetMode) this.cameraMode = 'orbit';
    this.camYaw = this.cameraMode === 'orbit' || this.cameraMode === 'free' ? 0.6 : 0;
    this.camPitch = 0.28;
    this.camDist = 18;
    this.camera.fov = 62;
    this.camera.updateProjectionMatrix();
  }

  orbitCamera(dx: number, dy: number): void {
    this.camYaw -= dx * 0.005;
    this.camPitch = wrapOrbitAngle(this.camPitch + dy * 0.005);
  }

  zoomFov(delta: number): void {
    this.camera.fov = Math.max(20, Math.min(82, this.camera.fov + delta));
    this.camera.updateProjectionMatrix();
  }

  /** Pick a rendered part on the active vessel from a screen-space point. */
  pickActivePart(clientX: number, clientY: number): number | null {
    if (!this.activeVesselId) return null;
    const visual = this.vesselVisuals.get(this.activeVesselId);
    if (!visual) return null;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1,
    ), this.camera);
    for (const intersection of raycaster.intersectObject(visual.group, true)) {
      let object: THREE.Object3D | null = intersection.object;
      while (object && object !== visual.group) {
        if (Number.isInteger(object.userData.partKey)) return object.userData.partKey as number;
        object = object.parent;
      }
    }
    return null;
  }

  constructor(
    private readonly context: RenderContext,
    private readonly partModels: PartModelLibrary | undefined,
    options: Readonly<WorldSceneOptions>,
  ) {
    this.quality = options.quality;
    this.diagnostics = options.diagnostics;
    this.reentryEffectsEnabled = options.reentryEffectsEnabled ?? true;
    this.srbSmoke = new SrbSmokePool(this.quality);
    this.checkedPlanetManifest = checkPlanetManifest(checkedPlanetArtifact);
    this.diagnostics.record({
      subsystem: 'renderer',
      event: 'world-scene-created',
      severity: 'state',
      data: {
        quality: this.quality,
        manifestDigest: this.checkedPlanetManifest.digest,
      },
    });
    this.rendererLedger = new RendererResourceLedger(this.checkedPlanetManifest.budgets);
    const textureLoader = new THREE.TextureLoader();
    const configuredBaseUrl = import.meta.env.BASE_URL;
    const baseUrl = configuredBaseUrl.endsWith('/') ? configuredBaseUrl : `${configuredBaseUrl}/`;
    this.planetAssetLoader = new PlanetAssetLoader({
      renderer: context.renderer,
      manifest: this.checkedPlanetManifest,
      ktx2: options.ktx2Loader ?? new KTX2Loader(),
      ownsKtx2: options.ktx2Loader === undefined,
      compressedSupported: Object.values(context.caps.compressedTextures).some(Boolean),
      transcoderPath: `${baseUrl}basis/`,
      resolveAssetUrl: (path) => `${baseUrl}planets/${path}`,
      loadConventional: (path) => textureLoader.loadAsync(path),
      loadSurfaceClassConventional: (path) => loadSurfaceClassTexture(path),
      diagnostics: this.diagnostics,
    });
    this.camera = new THREE.PerspectiveCamera(
      62,
      window.innerWidth / window.innerHeight,
      0.3,
      6e8,
    );
    this.camera.userData.physicalDepthEnvelope = 'earth-moon-certified';
    this.resizeHandler = () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', this.resizeHandler);
    this.unsubscribeRestoration = context.lifecycle.subscribeRestoration(
      () => this.rebuildCommittedRenderers(),
    );
    this.scene.background = new THREE.Color('#04070a');
    this.starfield = makeStarfield(4200);
    this.scene.add(this.starfield);
    this.launchSite = this.buildLaunchSite();
    this.scene.add(this.launchSite);
    this.scene.add(this.srbSmoke.points);
    this.environment = new THREE.HemisphereLight('#0b1016', '#020304', 0.045);
    this.scene.add(this.environment);
    // A broad, neutral descent light preserves night-side contrast while
    // keeping the immediate landing area readable. Decay is intentionally zero
    // because scene distances are measured in metres, not Three.js light units.
    this.landingLight = new THREE.SpotLight(
      '#dcecff',
      0,
      0,
      THREE.MathUtils.degToRad(58),
      0.55,
      0,
    );
    this.landingLight.name = 'automatic-landing-visibility-aid';
    this.landingLight.castShadow = false;
    this.scene.add(this.landingLight, this.landingLight.target);
    this.configureShadowRenderer();
  }

  private buildLaunchSite(): THREE.Group {
    const group = new THREE.Group();
    const concrete = new THREE.MeshStandardMaterial({ color: '#68717a', roughness: 0.92, metalness: 0.05 });
    const structure = new THREE.MeshStandardMaterial({ color: '#c7d0d5', roughness: 0.65, metalness: 0.35 });
    bindFlightAerialPerspective(concrete, this.flightAerial);
    bindFlightAerialPerspective(structure, this.flightAerial);
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(LAUNCH_PAD_CONTACT_RADIUS, LAUNCH_PAD_FOOTPRINT_RADIUS, 1, 32),
      concrete,
    );
    pad.castShadow = true;
    pad.receiveShadow = true;
    pad.name = 'launch-pad-foundation';
    // The final depth is set from the complete terrain footprint each frame.
    pad.position.y = -0.5;
    group.add(pad);
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, 0.12, 32), structure);
    deck.castShadow = true;
    deck.receiveShadow = true;
    deck.position.y = 0.06;
    group.add(deck);
    group.visible = false;
    return group;
  }

  setQuality(q: PlanetQuality | QualityTier): void {
    const tier = typeof q === 'string'
      ? q
      : q.gridRes <= 9 ? 'low' : q.gridRes >= 33 ? 'high' : 'medium';
    const qualityChanged = this.quality !== tier;
    this.quality = tier;
    this.configureShadowRenderer();
    this.srbSmoke?.setQuality(tier);
    if (qualityChanged) this.clearReentryEffect();
    for (const [bodyId, manager] of this.bodyRendererManagers) {
      if (manager.current()?.quality === tier) continue;
      void manager.replaceQuality(tier).then(() => {
        const renderer = manager.current();
        if (renderer) this.bodyRenderers.set(bodyId, renderer);
        if (bodyId === this.flightTerrainBodyId && this.checkedPlanetManifest.hasPack(bodyId, tier)) {
          this.flightPromotedBodyId = bodyId;
        }
        if (this.renderFailureState?.bodyId === bodyId) this.renderFailureState = null;
      }).catch((error) => this.noteRendererFailure(bodyId, error));
    }
  }

  private configureShadowRenderer(): void {
    // Some policy-only unit probes construct a prototype shell without a WebGL
    // context; the live scene always has one.
    if (!this.context?.renderer?.shadowMap) return;
    this.context.renderer.shadowMap.enabled = this.quality !== 'low';
    this.context.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.context.renderer.shadowMap.needsUpdate = true;
  }

  private updateLocalSolarShadow(altitude: number, cameraDistance = this.camDist): void {
    const light = this.bodyRenderers.get('sun')?.shadowLight;
    if (!light) return;
    const policy = localShadowPolicy(this.quality, cameraDistance, altitude);
    light.castShadow = policy.enabled;
    if (!policy.enabled) return;
    light.shadow.mapSize.set(policy.mapSize, policy.mapSize);
    const camera = light.shadow.camera;
    camera.left = -policy.extent;
    camera.right = policy.extent;
    camera.top = policy.extent;
    camera.bottom = -policy.extent;
    camera.near = policy.near;
    camera.far = policy.far;
    light.shadow.bias = policy.bias;
    light.shadow.normalBias = policy.normalBias;
    const activeCenter = this.activeVesselId
      ? this.vesselVisuals.get(this.activeVesselId)?.group.position ?? _shadowCenter.set(0, 0, 0)
      : _shadowCenter.set(0, 0, 0);
    _shadowDirection.copy(light.position).sub(light.target.position).normalize();
    snapShadowCenter(activeCenter, _shadowDirection, policy.extent, policy.mapSize, _shadowCenter);
    light.target.position.copy(_shadowCenter);
    light.position.copy(_shadowCenter).addScaledVector(_shadowDirection, policy.lightDistance);
    light.target.updateMatrixWorld(true);
    light.shadow.camera.updateProjectionMatrix();
  }

  planetStats(): { chunks: number; visible: number } {
    let chunks = 0;
    let visible = 0;
    for (const renderer of this.bodyRenderers.values()) {
      const stats = renderer.stats();
      chunks += stats.chunks;
      visible += stats.visible;
    }
    return { chunks, visible };
  }

  /** Borrow the committed pack for secondary views; ownership remains with this scene. */
  bodyAssetPack(bodyId: string): Readonly<RuntimeBodyAssetPack> | null {
    return this.bodyRendererManagers.get(bodyId)?.currentAssetPack() ?? null;
  }

  /**
   * Load, stage, compile, and promote the active body's authored visuals before
   * the VAB hands control to flight. This is real readiness, not a timer-only
   * loading screen; callers can add a minimum presentation delay separately.
   */
  async prepareFlightBody(
    body: Body,
    authority: Readonly<FrozenPlanetDataAuthority> = planetDataAuthorityForBody(body),
    claimTerrain = true,
  ): Promise<void> {
    if (this.disposed) throw new Error('World scene is disposed');
    const installed = planetDataAuthorityForBody(body);
    if (authority.bodyId !== body.id || installed.generation !== authority.generation) {
      throw new Error(`Flight authority is not installed for ${body.id}`);
    }
    this.bodyAuthorities.set(body.id, authority);
    if (claimTerrain) this.setFlightTerrainOwner(body.id);
    this.rendererFor(body);
    const manager = this.bodyRendererManagers.get(body.id);
    if (!manager) throw new Error(`Renderer manager unavailable for ${body.id}`);

    const pending = this.bodyRendererLoads.get(body.id);
    if (pending) await pending;
    const currentAuthorityMismatch = () => (
      manager.current()?.terrainAuthorityGeneration !== authority.generation
      || manager.current()?.stats().terrainAuthorityFallbackReason !== authority.fallbackReason
    );
    if (currentAuthorityMismatch()) {
      await manager.rebuildCommitted();
      const replacement = manager.current();
      if (replacement) this.bodyRenderers.set(body.id, replacement);
    }
    if (currentAuthorityMismatch()) {
      throw new Error(`Renderer authority generation mismatch for ${body.id}`);
    }
    if (!claimTerrain) return;
    if (!this.checkedPlanetManifest.hasPack(body.id, this.quality)) return;
    if (manager.currentAssetPack() && manager.claimFlightResidency()) {
      this.flightPromotedBodyId = body.id;
      return;
    }

    // A compact pack may have completed just before the body became the flight
    // owner. Rebuild once with the active-body budget and flight-scale channels.
    await this.loadAuthoredRenderer(body.id, manager);
    if (!manager.currentAssetPack() || !manager.claimFlightResidency()) {
      throw new Error(`Flight-scale visual pack unavailable for ${body.id}`);
    }
    this.flightPromotedBodyId = body.id;
  }

  /**
   * Prepare compact authored body visuals for a replay without claiming the
   * active-flight terrain residency budget.
   */
  async prepareMissionBody(
    body: Body,
    authority: Readonly<FrozenPlanetDataAuthority> = planetDataAuthorityForBody(body),
  ): Promise<void> {
    await this.prepareFlightBody(body, authority, false);
  }

  qualityTier(): QualityTier { return this.quality; }

  /** Read-only diagnostics probe for the single pooled SRB smoke draw call. */
  smokeParticleCount(): number { return this.srbSmoke.particleCount(); }

  reentryStats(): Readonly<ReentryEffectStats> | null { return this.reentryEffect?.stats() ?? null; }

  /** Explicit diagnostic readback for deterministic occlusion-mask tests/tools. */
  reentryOcclusionPixel(x: number, y: number): Uint8Array | null {
    return this.reentryEffect?.debugOcclusionPixel(this.context.renderer, x, y) ?? null;
  }

  /** One profiled flight submission: occlusion prepass followed by the main scene. */
  render(): void {
    this.reentryEffect?.prepareOcclusion(this.context.renderer, this.reentryVelocityOS);
    this.context.renderer.render(this.scene, this.camera);
  }

  renderStats(): Readonly<WorldRendererStats> {
    const body = this.planetStats();
    let rendererFailures = 0;
    let transitionActive = false;
    let activeTransitionMs = 0;
    let completedTransitionMs = 0;
    for (const manager of this.bodyRendererManagers.values()) {
      const stats = manager.platformStats();
      rendererFailures += stats.failures;
      transitionActive ||= stats.transactionActive;
      if (stats.transactionActive) activeTransitionMs = Math.max(activeTransitionMs, stats.transitionMs);
      else completedTransitionMs = Math.max(completedTransitionMs, stats.transitionMs);
    }
    return Object.freeze({
      chunks: body.chunks,
      visibleChunks: body.visible,
      rendererManagers: this.bodyRendererManagers.size,
      residentFlightPacks: this.rendererLedger.residentFlightBodyIds().length,
      residentPackGpuBytes: this.rendererLedger.snapshot()?.gpuBytes ?? 0,
      rendererFailures,
      transitionActive,
      transitionMs: transitionActive ? activeTransitionMs : completedTransitionMs,
      contextFallback: this.context.lifecycle.state === 'fallback',
    });
  }

  private rendererFor(body: Body): BodyRenderer | null {
    const current = this.bodyRenderers.get(body.id);
    if (current) return current;
    if (this.bodyRendererManagers.has(body.id)) return null;
    let transactionChannels: readonly string[] = [];
    const manager = new BodyRendererManager({
      scene: this.scene,
      quality: this.quality,
      createCandidate: (candidate, tier) => createBodyRendererCandidate({
        body: candidate,
        caps: this.context.caps,
        quality: tier,
        diagnostics: this.diagnostics,
        activeBodyBudgetBytes: this.rendererLedger.activeBodyBudget(tier),
        flightAerial: this.flightAerial,
        authority: this.bodyAuthorities.get(candidate.id) ?? planetDataAuthorityForBody(candidate),
      }),
      loadAssets: async (candidateBody, tier) => {
        if (!this.checkedPlanetManifest.hasPack(candidateBody.id, tier)) {
          transactionChannels = ['legacy'];
          return { pack: null, gpuBytes: 0, transientBytes: 0, flightScale: false, dispose: () => undefined };
        }
        const loaded = await this.planetAssetLoader.load(candidateBody.id, tier);
        transactionChannels = loaded.pack.channels.map((channel) => channel.name);
        const pack: RuntimeBodyAssetPack = Object.freeze({
          bodyId: loaded.pack.bodyId,
          tier: loaded.pack.tier,
          width: loaded.pack.width,
          height: loaded.pack.height,
          manifestDigest: this.checkedPlanetManifest.digest,
          gpuBytes: loaded.gpuBytes,
          textures: loaded.textures,
        });
        return {
          pack,
          gpuBytes: loaded.gpuBytes,
          transientBytes: loaded.pack.transientBytes,
          flightScale: candidateBody.id === this.flightTerrainBodyId,
          dispose: () => loaded.dispose(),
        };
      },
      prepareCandidate: async (candidate) => {
        const frame = this.lastBodyFrames.get(candidate.bodyId);
        if (frame) candidate.update(frame);
      },
      compileCandidate: async (candidate, _candidateBody, tier) => {
        for (const channel of transactionChannels.length > 0 ? transactionChannels : [candidate.kind]) {
          await compileRendererCandidate({
            renderer: this.context.renderer,
            camera: this.camera,
            root: candidate.root,
            body: candidate.bodyId,
            tier,
            channel,
          });
        }
      },
      awaitCoverage: async (candidate) => {
        if (!candidate.ready) throw new Error(`${candidate.bodyId} renderer coverage is not ready`);
      },
      ledger: this.rendererLedger,
      diagnostics: this.diagnostics,
      authorityGenerationForBody: (candidate) => {
        const kind = BODY_VISUALS[candidate.id as BodyId]?.renderer;
        if (kind !== 'terrestrial' && kind !== 'airless') return undefined;
        return (this.bodyAuthorities.get(candidate.id) ?? planetDataAuthorityForBody(candidate)).generation;
      },
    });
    this.bodyRendererManagers.set(body.id, manager);
    const renderer = createBodyRendererCandidate({
      body,
      caps: this.context.caps,
      quality: this.quality,
      diagnostics: this.diagnostics,
      activeBodyBudgetBytes: this.rendererLedger.activeBodyBudget(this.quality),
      flightAerial: this.flightAerial,
      authority: this.bodyAuthorities.get(body.id) ?? planetDataAuthorityForBody(body),
    });
    const hasAuthoredPack = this.checkedPlanetManifest.hasPack(body.id, this.quality);
    manager.adoptInitial(body, renderer, {
      pack: null,
      gpuBytes: hasAuthoredPack ? rendererGeometryBytes(renderer) : 0,
      transientBytes: 0,
      flightScale: false,
      dispose: () => undefined,
    });
    this.bodyRenderers.set(body.id, renderer);
    if (hasAuthoredPack) void this.loadAuthoredRenderer(body.id, manager).catch(() => undefined);
    return renderer;
  }

  private loadAuthoredRenderer(bodyId: string, manager: BodyRendererManager): Promise<void> {
    // A few policy tests intentionally exercise a prototype-only WorldScene
    // shell without running its constructor.
    const loads = this.bodyRendererLoads ?? (this.bodyRendererLoads = new Map<string, Promise<void>>());
    const active = loads.get(bodyId);
    if (active) return active;
    const load = manager.rebuildCommitted().then(() => {
      const replacement = manager.current();
      if (!this.disposed && this.bodyRendererManagers.get(bodyId) === manager) {
        if (replacement) this.bodyRenderers.set(bodyId, replacement);
        if (bodyId === this.flightTerrainBodyId && manager.claimFlightResidency()) {
          this.flightPromotedBodyId = bodyId;
        }
        if (this.renderFailureState?.bodyId === bodyId) this.renderFailureState = null;
      } else {
        manager.dispose();
      }
    }).catch((error) => {
      this.noteRendererFailure(bodyId, error);
      throw error;
    }).finally(() => {
      if (loads.get(bodyId) === load) loads.delete(bodyId);
    });
    loads.set(bodyId, load);
    return load;
  }

  private setFlightTerrainOwner(bodyId: string | null): void {
    const previousId = this.flightTerrainBodyId;
    if (previousId !== bodyId && bodyId) this.flightPromotionFailed?.delete(bodyId);
    if (previousId && previousId !== bodyId) {
      // The previous primary is still rendered as a parent/sibling immediately
      // after an SOI change. Release only its active-body budget claim; keep
      // the manager, renderer, and loaded compact presentation alive.
      this.bodyRendererManagers?.get(previousId)?.releaseFlightResidency();
      if (this.flightPromotedBodyId === previousId) this.flightPromotedBodyId = null;
    }
    this.flightTerrainBodyId = bodyId;
    this.promoteFlightRenderer(bodyId);
  }

  private promoteFlightRenderer(bodyId: string | null): void {
    if (
      !bodyId || this.flightPromotedBodyId === bodyId || this.flightPromotionPending.has(bodyId) ||
      this.flightPromotionFailed.has(bodyId) ||
      !this.checkedPlanetManifest?.hasPack(bodyId, this.quality)
    ) return;
    const manager = this.bodyRendererManagers?.get(bodyId);
    if (!manager?.current()) return;
    if (manager.claimFlightResidency()) {
      this.flightPromotedBodyId = bodyId;
      if (this.renderFailureState?.bodyId === bodyId) this.renderFailureState = null;
      return;
    }
    this.flightPromotionPending.add(bodyId);
    void this.loadAuthoredRenderer(bodyId, manager).then(() => {
      if (this.disposed || this.flightTerrainBodyId !== bodyId || this.bodyRendererManagers.get(bodyId) !== manager) return;
      const renderer = manager.current();
      if (renderer) this.bodyRenderers.set(bodyId, renderer);
      if (manager.claimFlightResidency()) this.flightPromotedBodyId = bodyId;
      if (this.renderFailureState?.bodyId === bodyId) this.renderFailureState = null;
    }).catch(() => {
      if (this.flightTerrainBodyId === bodyId) this.flightPromotionFailed.add(bodyId);
    }).finally(() => {
      this.flightPromotionPending.delete(bodyId);
    });
  }

  /** Explicit recovery hook for context restoration or a user-requested visual retry. */
  retryActiveBodyRenderer(): boolean {
    const bodyId = this.flightTerrainBodyId;
    if (!bodyId || !this.flightPromotionFailed.has(bodyId)) return false;
    this.flightPromotionFailed.delete(bodyId);
    if (this.renderFailureState?.bodyId === bodyId) this.renderFailureState = null;
    this.promoteFlightRenderer(bodyId);
    return true;
  }

  rendererFailure(): Readonly<{ bodyId: string; message: string }> | null {
    return this.renderFailureState;
  }

  private noteRendererFailure(bodyId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.renderFailureState = { bodyId, message };
    this.diagnostics?.anomaly('planet-asset-pack-unavailable', 'assets', {
      body: bodyId,
      message,
      retryAvailable: bodyId === this.flightTerrainBodyId,
    }, { bodyId });
  }

  /** Rebuild every renderer owned by this live scene after WebGL restoration. */
  async rebuildCommittedRenderers(): Promise<void> {
    if (this.disposed) return;
    const managers = [...this.bodyRendererManagers.entries()];
    const results = await Promise.allSettled(managers.map(async ([bodyId, manager]) => {
      await manager.rebuildCommitted();
      if (this.disposed || this.bodyRendererManagers.get(bodyId) !== manager) return;
      const renderer = manager.current();
      if (renderer) this.bodyRenderers.set(bodyId, renderer);
    }));
    if (this.disposed) return;
    const failedBodies = results.flatMap((result, index) => result.status === 'rejected' ? [managers[index][0]] : []);
    if (failedBodies.length > 0) {
      throw new Error(`Failed to restore body renderers: ${failedBodies.join(', ')}`);
    }
  }

  visualFor(gv: GameVessel): VesselVisual {
    let vis = this.vesselVisuals.get(gv.runtime.id);
    if (!vis) {
      vis = buildVesselVisual(gv.runtime.craft, this.partModels, this.flightAerial);
      this.vesselVisuals.set(gv.runtime.id, vis);
      this.scene.add(vis.group);
    }
    return vis;
  }

  /**
   * Read-only test probe: number of nozzle plume holders for a part on the
   * active vessel (three for the Mule, one for the Colt), or 0 if absent.
   * Does not mutate scene state.
   */
  plumeCountForPart(key: number): number {
    if (this.activeVesselId === null) return 0;
    const group = this.vesselVisuals.get(this.activeVesselId)?.plumes.get(key);
    return group ? group.children.length : 0;
  }

  /** Read-only live effect state used by browser regressions and diagnostics. */
  plumeStateForPart(key: number): { visible: boolean; burning: boolean; power: number } | null {
    if (this.activeVesselId === null) return null;
    const group = this.vesselVisuals.get(this.activeVesselId)?.plumes.get(key);
    if (!group) return null;
    return {
      visible: group.visible,
      burning: group.userData.burning === true,
      power: Number(group.userData.power ?? 0),
    };
  }

  /** Drop visuals of vessels that no longer exist. */
  private pruneVessels(game: GameState): void {
    const alive = new Set(game.vessels.map((v) => v.runtime.id));
    for (const [id, vis] of this.vesselVisuals) {
      if (!alive.has(id)) {
        this.scene.remove(vis.group);
        disposeVesselVisual(vis);
        this.vesselVisuals.delete(id);
      }
    }
    if (this.reentryVesselId && !alive.has(this.reentryVesselId)) this.clearReentryEffect();
  }

  /** Rebuild the active vessel visual (after staging/destruction). */
  invalidateVessel(id: string): void {
    const vis = this.vesselVisuals.get(id);
    if (vis) {
      this.scene.remove(vis.group);
      disposeVesselVisual(vis);
      this.vesselVisuals.delete(id);
    }
    if (this.reentryVesselId === id) this.clearReentryEffect();
  }

  private clearReentryEffect(): void {
    this.reentryEffect?.dispose();
    this.reentryEffect = null;
    this.reentryVesselId = null;
    this.reentryFingerprint = '';
    this.reentrySignal = { strength: 0, transonic: 0 };
  }

  private updateActiveReentry(
    gv: GameVessel,
    visual: VesselVisual,
    body: Body,
    wallDeltaSeconds: number,
  ): void {
    const runtime = gv.runtime;
    if (!this.reentryEffectsEnabled || !body.def.atmosphere) {
      this.clearReentryEffect();
      return;
    }
    const fingerprint = `${this.quality}:${craftReentryFingerprint(runtime.craft)}`;
    if (
      !this.reentryEffect
      || this.reentryVesselId !== runtime.id
      || this.reentryFingerprint !== fingerprint
    ) {
      this.clearReentryEffect();
      const palette = BODY_VISUALS[body.id as BodyId]?.entryVisual ?? DEFAULT_ENTRY_VISUAL;
      const candidate = new ActiveReentryEffect(runtime.craft, runtime.aeroModel.axialFrac, this.quality, palette);
      this.reentryEffect = candidate;
      this.reentryVesselId = runtime.id;
      this.reentryFingerprint = fingerprint;
      this.scene.add(this.reentryEffect.group);
      const compileRoot = this.reentryEffect.compileCandidateRoot();
      void compileRendererCandidate({
        renderer: this.context.renderer,
        camera: this.camera,
        root: compileRoot,
        body: body.id,
        tier: this.quality,
        channel: 'reentry-effects',
      }).catch((error) => {
        if (this.reentryEffect !== candidate) return;
        this.diagnostics.anomaly('reentry-shader-compile-failed', 'effects', {
          message: error instanceof Error ? error.message : String(error),
        }, { bodyId: body.id });
        this.clearReentryEffect();
      });
    }
    const effect = this.reentryEffect;
    if (!effect) return;
    _reentryAtmosphereVelocity.copy(surfaceVelocity(body, runtime.pos, _reentryAtmosphereVelocity));
    _reentryVelocityOS.set(
      runtime.vel.x - _reentryAtmosphereVelocity.x,
      runtime.vel.y - _reentryAtmosphereVelocity.y,
      runtime.vel.z - _reentryAtmosphereVelocity.z,
    );
    _reentryInverseAttitude
      .set(runtime.att.x, runtime.att.y, runtime.att.z, runtime.att.w)
      .invert();
    _reentryVelocityOS.applyQuaternion(_reentryInverseAttitude);
    if (_reentryVelocityOS.lengthSq() < 1e-8) _reentryVelocityOS.set(0, 1, 0);
    else _reentryVelocityOS.normalize();
    this.reentryVelocityOS.copy(_reentryVelocityOS);
    const palette = BODY_VISUALS[body.id as BodyId]?.entryVisual ?? DEFAULT_ENTRY_VISUAL;
    this.reentrySignal = signalFromAero(
      this.reentrySignal,
      runtime.aero,
      wallDeltaSeconds,
      palette.strengthMultiplier,
    );
    effect.group.position.copy(visual.group.position);
    effect.group.quaternion.copy(visual.group.quaternion);
    effect.update({
      velocityOS: this.reentryVelocityOS,
      flowAlign: runtime.aero.flowAlign,
      signal: this.reentrySignal,
      time: this.effectTime,
      wallDeltaSeconds,
      reducedMotion: this.reducedMotion,
    });
    const stats = effect.stats();
    this.diagnostics.sample('active-reentry-effect', {
      subsystem: 'effects',
      event: 'active-reentry-effect',
      severity: 'sample',
      data: {
        active: stats.active,
        strength: Number(stats.strength.toFixed(4)),
        transonic: Number(stats.transonic.toFixed(4)),
        trails: stats.trails,
        bowshock: stats.bowshock,
        particles: stats.particles,
        occlusion: stats.occlusion,
        geometryBytes: stats.geometryBytes,
      },
    }, {
      simulationTime: this.effectTime,
      bodyId: body.id,
      altitudeMeters: runtime.pos.length() - body.radius,
    });
  }

  /** Clear save-specific visuals while retaining loaders and body renderers. */
  resetDynamicState(): void {
    this.clearReentryEffect();
    for (const visual of this.vesselVisuals.values()) {
      this.scene.remove(visual.group);
      disposeVesselVisual(visual);
    }
    this.vesselVisuals.clear();
    this.activeVesselId = null;
    this.srbSmoke.clear();
    this.lastBodyFrames.clear();
    this.setFlightTerrainOwner(null);
  }

  /** Remove replay-owned GPU objects while retaining shared body renderers. */
  resetMissionState(): void {
    this.missionEntities?.reset();
    this.lastBodyFrames.clear();
    if (this.landingLight) {
      this.landingLight.intensity = 0;
      this.landingLight.distance = 0;
    }
    this.launchSite.visible = false;
    const snapshot = this.missionPresentationSnapshot;
    if (snapshot) {
      this.camera.fov = snapshot.fov;
      this.camera.quaternion.copy(snapshot.quaternion);
      this.camera.up.copy(snapshot.up);
      this.camera.updateProjectionMatrix();
      this.context.renderer.toneMappingExposure = snapshot.exposure;
      this.missionPresentationSnapshot = null;
    }
    if (this.presentationMode === 'mission') this.presentationMode = 'idle';
  }

  /** Fully release the mission layer. Safe to call repeatedly on replay exit. */
  disposeMissionState(): void {
    this.missionEntities?.dispose();
    this.missionEntities = null;
    this.resetMissionState();
  }

  /**
   * Camera-relative celestial stage shared by flight and mission replay. The
   * caller supplies focus/camera authority explicitly; no active vessel is
   * required. Flight-only terrain remains an explicit opt-in.
   */
  private updateCelestialBodyStage(input: Readonly<CelestialBodyStageInput>): void {
    const {
      universe,
      focusBody,
      time,
      cameraAbsolute,
      cameraForward,
      deltaSeconds,
      verticalFovRadians,
      drawingBufferWidth,
      drawingBufferHeight,
      allowFlightTerrain,
      surfaceAnchorBodyRelative,
    } = input;

    // Keep star direction in f64 until the final camera-relative conversion.
    universe.absolutePosition(universe.root, time, _starAbs);
    _sunDir.copy(_starAbs).sub(cameraAbsolute).normalize();

    const renderSet = this.renderSet;
    renderSet.clear();
    const considerBodies = this.considerBodies;
    considerBodies.length = 0;
    const consider = (candidate: Body | null): void => {
      if (candidate && !considerBodies.some((existing) => existing.id === candidate.id)) considerBodies.push(candidate);
    };
    consider(focusBody);
    consider(universe.root);
    consider(focusBody.parent);
    for (const child of focusBody.children) consider(child);
    for (const sibling of focusBody.parent?.children ?? []) consider(sibling);

    const sampledBodyIds = this.sampledBodyIds;
    sampledBodyIds.clear();
    for (const body of considerBodies) {
      universe.absolutePosition(body, time, _bodyAbs);
      Vec3.sub(_bodyAbs, cameraAbsolute, _rel);
      const distance = _rel.length();
      renderSet.add(body.id);
      _tmp.copy(cameraAbsolute).sub(_bodyAbs);
      inertialToBodyFixed(body, time, _tmp, _camBF);
      inertialToBodyFixed(body, time, cameraForward, _cameraViewDirectionBF).normalize();
      const surfaceAnchorBodyFixed = body.id === focusBody.id && surfaceAnchorBodyRelative
        ? inertialToBodyFixed(body, time, surfaceAnchorBodyRelative, _surfaceAnchorBF)
        : undefined;
      bodyOrientation(body, time, _bodyQ);
      _bodySunDir.copy(_starAbs).sub(_bodyAbs);
      if (_bodySunDir.lengthSq() > 0) {
        inertialToBodyFixed(body, time, _bodySunDir, _bodySunDir).normalize();
      }
      const renderer = this.rendererFor(body);
      if (!renderer) continue;
      renderer.root.visible = true;
      const previousFrame = this.lastBodyFrames.get(body.id);
      bodyFixedCameraVelocity(_camBF, previousFrame, deltaSeconds, _cameraVelocity);
      let stableFrame = previousFrame as MutableBodyRenderFrame | undefined;
      if (!stableFrame) {
        stableFrame = {
          cameraRelativeOrigin: { x: 0, y: 0, z: 0 },
          cameraBodyFixed: { x: 0, y: 0, z: 0 },
          cameraViewDirectionBodyFixed: { x: 0, y: 0, z: -1 },
          bodyFixedFrustum: [],
          cameraBodyFixedVelocity: { x: 0, y: 0, z: 0 },
          verticalFovRadians: 0,
          drawingBufferWidth: 0,
          drawingBufferHeight: 0,
          projection: computeCelestialProjection({
            centerRelative: { x: 1, y: 0, z: 0 },
            bodyRadius: 1,
            verticalFovRadians: Math.PI / 3,
            drawingBufferHeight: 1,
            physicalFarMeters: this.camera.far,
            farField: false,
          }),
          orientation: { x: 0, y: 0, z: 0, w: 1 },
          cameraSunDirection: { x: 0, y: 0, z: 0 },
          bodySunDirection: { x: 0, y: 0, z: 0 },
          solarVisibleFraction: 1,
          solarOccluder: {
            direction: { x: 0, y: 0, z: 0 },
            angularRadius: 0,
          },
          time: 0,
          deltaSeconds: 0,
          framePressure: false,
          altitude: 0,
          allowFlightTerrain: false,
        };
      }
      copyCoordinates(stableFrame.cameraRelativeOrigin, _rel);
      copyCoordinates(stableFrame.cameraBodyFixed, _camBF);
      copyCoordinates(stableFrame.cameraViewDirectionBodyFixed, _cameraViewDirectionBF);
      bodyFixedFrustumPlanes(this.camera, _bodyQ, _rel, stableFrame.bodyFixedFrustum);
      copyCoordinates(stableFrame.cameraBodyFixedVelocity, _cameraVelocity);
      if (surfaceAnchorBodyFixed) {
        stableFrame.surfaceAnchorBodyFixed ??= { x: 0, y: 0, z: 0 };
        copyCoordinates(stableFrame.surfaceAnchorBodyFixed, surfaceAnchorBodyFixed);
      } else {
        stableFrame.surfaceAnchorBodyFixed = undefined;
      }
      copyCoordinates(stableFrame.orientation, _bodyQ);
      stableFrame.orientation.w = _bodyQ.w;
      copyCoordinates(stableFrame.cameraSunDirection, _sunDir);
      copyCoordinates(stableFrame.bodySunDirection, _bodySunDir);
      let solarVisibleFraction = 1;
      stableFrame.solarOccluder ??= {
        direction: { x: 0, y: 0, z: 0 },
        angularRadius: 0,
      };
      stableFrame.solarOccluder.angularRadius = 0;
      const solarAngularRadius = universe.root.radius > 0
        ? Math.asin(Math.min(
          1,
          universe.root.radius / Math.max(universe.root.radius, _starAbs.distanceTo(cameraAbsolute)),
        ))
        : 0;
      if (solarAngularRadius > 0) {
        for (const occluder of universe.bodies.values()) {
          if (occluder.def.isStar) continue;
          universe.absolutePosition(occluder, time, _occluderAbs);
          _occluderDirection.copy(_occluderAbs).sub(cameraAbsolute);
          const occluderDistance = _occluderDirection.length();
          if (!(occluderDistance > 0)) continue;
          const occlusion = celestialOcclusion(
            { direction: _sunDir, angularRadius: solarAngularRadius },
            {
              direction: _occluderDirection,
              angularRadius: Math.asin(Math.min(1, occluder.radius / occluderDistance)),
            },
          );
          if (occlusion.intersects && occlusion.sourceVisibleFraction < solarVisibleFraction) {
            solarVisibleFraction = occlusion.sourceVisibleFraction;
            copyCoordinates(stableFrame.solarOccluder.direction, _occluderDirection);
            stableFrame.solarOccluder.angularRadius = Math.asin(
              Math.min(1, occluder.radius / occluderDistance),
            );
          }
        }
      }
      stableFrame.solarVisibleFraction = solarVisibleFraction;
      stableFrame.verticalFovRadians = verticalFovRadians;
      stableFrame.drawingBufferWidth = drawingBufferWidth;
      stableFrame.drawingBufferHeight = drawingBufferHeight;
      stableFrame.projection = computeCelestialProjection({
        centerRelative: stableFrame.cameraRelativeOrigin,
        bodyRadius: body.radius,
        verticalFovRadians,
        drawingBufferHeight,
        physicalFarMeters: this.camera.far,
        preferredProxyDepth: this.camera.far * 0.74,
        farField: body.def.surfaceKind === 'star',
      });
      stableFrame.time = time;
      stableFrame.deltaSeconds = deltaSeconds;
      stableFrame.framePressure = deltaSeconds > 1 / 30;
      stableFrame.altitude = distance - body.radius;
      stableFrame.allowFlightTerrain = allowFlightTerrain
        && body.id === focusBody.id
        && body.def.surfaceKind === 'solid';
      this.lastBodyFrames.set(body.id, stableFrame);
      sampledBodyIds.add(body.id);
      renderer.update(stableFrame);
    }
    for (const [id, renderer] of this.bodyRenderers) {
      if (!renderSet.has(id)) renderer.root.visible = false;
    }
    pruneBodyFrameSamples(this.lastBodyFrames, sampledBodyIds);
  }

  /**
   * Update the whole scene for this frame.
   * Returns the camera's absolute position for other systems (map etc).
   */
  update(game: GameState, dt: number, smokeDt = dt): void {
    const active = game.active;
    this.activeVesselId = active?.runtime.id ?? null;
    if (!active) {
      this.presentationMode = 'idle';
      if (this.landingLight) {
        this.landingLight.intensity = 0;
        this.landingLight.distance = 0;
      }
      this.clearReentryEffect();
      this.setFlightTerrainOwner(null);
      this.lastBodyFrames?.clear();
      this.srbSmoke?.clear();
      return;
    }
    if (this.presentationMode === 'mission') this.disposeMissionState();
    this.presentationMode = 'flight';
    const v = active.runtime;
    const body = game.bodyOf(active);
    this.context.renderer.getDrawingBufferSize(_drawingBufferSize);
    const verticalFovRadians = THREE.MathUtils.degToRad(this.camera.fov);
    const drawingBufferWidth = Math.max(1, Math.floor(_drawingBufferSize.x));
    const drawingBufferHeight = Math.max(1, Math.floor(_drawingBufferSize.y));
    this.setFlightTerrainOwner(body.id);
    const t = game.time;

    // ---- camera position: orbit rig around the vessel, in vessel-local
    // "horizon" space (up = away from body center).
    const up = _tmp.copy(v.pos).normalize();
    // Build a local frame: up + east.
    const east = _east.set(-up.y, up.x, 0);
    if (east.lengthSq() < 1e-9) east.set(1, 0, 0);
    east.normalize();
    const north = _north;
    Vec3.cross(up, east, north);

    const cy = Math.cos(this.camYaw);
    const sy = Math.sin(this.camYaw);
    const cp = Math.cos(this.camPitch);
    const sp = Math.sin(this.camPitch);
    // Camera offset from vessel (in the local horizon frame).
    const camOffset = _camOffset.set(0, 0, 0);
    const craftRight = v.att.rotate(_craftRight.set(1, 0, 0), _craftRight);
    const craftNose = v.att.rotate(_craftNose.set(0, 1, 0), _craftNose);
    const craftUp = v.att.rotate(_craftUp.set(0, 0, 1), _craftUp);
    const cameraUp = _cameraOrbitUp;
    if (this.cameraMode === 'orbit') {
      camOffset
        .addScaled(east, cy * cp * this.camDist)
        .addScaled(north, sy * cp * this.camDist)
        .addScaled(up, sp * this.camDist);
      cameraUp
        .set(0, 0, 0)
        .addScaled(east, -cy * sp)
        .addScaled(north, -sy * sp)
        .addScaled(up, cp);
    } else if (this.cameraMode === 'chase') {
      const chaseForward = _chaseForward.copy(craftNose).addScaled(up, -craftNose.dot(up));
      if (chaseForward.lengthSq() < 1e-8) chaseForward.copy(north);
      chaseForward.normalize();
      const chaseRight = Vec3.cross(chaseForward, up, _chaseRight).normalize();
      camOffset
        .addScaled(chaseForward, -cy * cp * this.camDist)
        .addScaled(chaseRight, sy * cp * this.camDist)
        .addScaled(up, sp * this.camDist);
      cameraUp
        .set(0, 0, 0)
        .addScaled(chaseForward, cy * sp)
        .addScaled(chaseRight, -sy * sp)
        .addScaled(up, cp);
    } else if (this.cameraMode === 'locked') {
      camOffset
        .addScaled(craftNose, -cy * cp * this.camDist)
        .addScaled(craftRight, sy * cp * this.camDist)
        .addScaled(craftUp, sp * this.camDist);
      cameraUp
        .set(0, 0, 0)
        .addScaled(craftNose, cy * sp)
        .addScaled(craftRight, -sy * sp)
        .addScaled(craftUp, cp);
    } else {
      camOffset.set(cy * cp * this.camDist, sy * cp * this.camDist, sp * this.camDist);
      cameraUp.set(-cy * sp, -sy * sp, cp);
    }

    // Keep the camera above authoritative terrain on solid bodies.
    if (body.def.surfaceKind === 'solid') {
      const cameraFromBody = _cameraFromBody.copy(v.pos).add(camOffset);
      if (cameraFromBody.lengthSq() > 0) {
        const ground = groundRadiusInertial(body, cameraFromBody, t) + 1.5;
        if (cameraFromBody.length() < ground) {
          cameraFromBody.normalize().scale(ground);
          camOffset.copy(cameraFromBody).sub(v.pos);
        }
      }
    }
    // Absolute camera position: vessel absolute + offset.
    game.universe.absolutePosition(body, t, _bodyAbs);
    _vesselAbs.copy(_bodyAbs).add(v.pos);
    _camAbs.copy(_vesselAbs).add(camOffset);
    _cameraBodyRelative.copy(v.pos).add(camOffset);
    this.effectTime += Math.min(1 / 15, Math.max(0, smokeDt));
    // Keep near-vessel particles in the active body's inertial frame. Root-frame
    // orbital velocity is common to both camera and craft, and retaining it in
    // the particle integrator magnifies a dropped frame into kilometre-scale
    // smoke jumps.
    this.srbSmoke.beginFrame(smokeDt, _cameraBodyRelative);

    // Finalize this frame's rendered camera before any body performs terrain
    // selection. Frustum culling and selection reuse must describe the same
    // smoothed camera pose that WebGL renders below.
    const previousCameraRotation = _previousCameraRotation.copy(this.camera.quaternion);
    this.camera.position.set(0, 0, 0);
    this.camera.up.set(cameraUp.x, cameraUp.y, cameraUp.z);
    this.camera.lookAt(-camOffset.x, -camOffset.y, -camOffset.z);
    if (this.cameraSmoothing && dt > 0) {
      const targetCameraRotation = _targetCameraRotation.copy(this.camera.quaternion);
      this.camera.quaternion.copy(previousCameraRotation).slerp(targetCameraRotation, 1 - Math.exp(-dt * 12));
    }
    this.camera.updateMatrixWorld(true);
    this.camera.getWorldDirection(_cameraForwardThree);
    _cameraForwardWorld.set(_cameraForwardThree.x, _cameraForwardThree.y, _cameraForwardThree.z);

    this.updateCelestialBodyStage({
      universe: game.universe,
      focusBody: body,
      time: t,
      cameraAbsolute: _camAbs,
      cameraForward: _cameraForwardWorld,
      deltaSeconds: dt,
      verticalFovRadians,
      drawingBufferWidth,
      drawingBufferHeight,
      allowFlightTerrain: true,
      surfaceAnchorBodyRelative: v.pos,
    });

    // LC-39B is a single persistent world object, positioned from the
    // same transform used by spawnOnPad. It never accumulates across launches.
    if (body.def.launchSite) {
      const siteDir = launchSiteDirection(body, t, _tmp);
      const padEnvelope = launchPadTerrainEnvelope(body);
      // Model origin and physics both own the deck top. The foundation extends
      // below the lowest sampled terrain so the hillside cannot clip or expose
      // a floating underside anywhere across the footprint.
      const siteRadius = body.radius + padEnvelope.deckHeight;
      const foundationDepth = padEnvelope.deckHeight - padEnvelope.minimumHeight + 0.5;
      const foundation = this.launchSite.getObjectByName('launch-pad-foundation');
      if (foundation) {
        foundation.scale.y = foundationDepth;
        foundation.position.y = -foundationDepth / 2;
      }
      game.universe.absolutePosition(body, t, _bodyAbs);
      _rel.copy(_bodyAbs).addScaled(siteDir, siteRadius).sub(_camAbs);
      this.launchSite.visible = _rel.length() < 250_000;
      if (this.launchSite.visible) {
        this.launchSite.position.set(_rel.x, _rel.y, _rel.z);
        this.launchSite.quaternion.setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(siteDir.x, siteDir.y, siteDir.z),
        );
      }
    } else {
      this.launchSite.visible = false;
    }

    // ---- vessels
    this.pruneVessels(game);
    for (const gv of game.vessels) {
      const rv = gv.runtime;
      const vesselBody = this.bodyOf(game, gv);
      const sameSystem = rv.bodyId === v.bodyId;
      if (!sameSystem && gv !== active) continue; // render only local vessels
      const vis = this.visualFor(gv);
      if (gv.regime === 'rails' && gv !== active) {
        game.railsPosition(gv, _tmp);
        game.universe.absolutePosition(vesselBody, t, _bodyAbs);
        _vesselAbs.copy(_bodyAbs).add(_tmp);
      } else {
        game.universe.absolutePosition(vesselBody, t, _bodyAbs);
        _vesselAbs.copy(_bodyAbs).add(rv.pos);
      }
      Vec3.sub(_vesselAbs, _camAbs, _rel);
      if (_rel.length() > 50_000 && gv !== active) {
        vis.group.visible = false;
        continue;
      }
      vis.group.visible = true;
      // rv.pos tracks the craft CoM; shift the model so its CoM lands there.
      vis.group.position.set(_rel.x, _rel.y, _rel.z);
      vis.group.quaternion.set(rv.att.x, rv.att.y, rv.att.z, rv.att.w);
      const com = rv.massProps.com;
      const offset = _renderOffset.set(-com.x, -com.y, -com.z).applyQuaternion(vis.group.quaternion);
      vis.group.position.x += offset.x;
      vis.group.position.y += offset.y;
      vis.group.position.z += offset.z;

      const pressureFrac = Math.min(
        1,
        vesselBody.pressureAt(rv.pos.length() - vesselBody.radius) / 101_325,
      );
      syncVesselVisual(
        vis,
        rv.craft,
        rv.controls.throttle,
        pressureFrac,
        dt,
        rv.crossfeedIndex,
        this.effectTime,
      );
      if (gv === active) this.updateActiveReentry(gv, vis, vesselBody, smokeDt);
      this.emitSrbSmoke(gv, vis, pressureFrac, rv.vel);
    }
    this.srbSmoke.endFrame();

    // ---- shared local illumination: the atmosphere supplies hemispherical
    // fill while airless/deep-space scenes remain almost black. Direct solar
    // light is still owned by SolarBodyRenderer.
    const alt = v.pos.length() - body.radius;
    const atmo = body.def.atmosphere;
    const rendererKind = this.bodyRenderers.get(body.id)?.kind;
    const solarVisibleFraction = this.lastBodyFrames.get(body.id)?.solarVisibleFraction ?? 1;
    const surfaceSunCosine = Vec3.dot(up, _sunDir);
    const dayness = Math.max(0, surfaceSunCosine);
    const sunInFrame = Vec3.dot(_cameraForwardWorld, _sunDir)
      > Math.cos(verticalFovRadians * 0.65);
    const environment = environmentLighting(
      rendererKind,
      atmo?.height ?? 0,
      alt,
      dayness,
      solarVisibleFraction,
      sunInFrame,
      this.environmentState,
    );
    this.environment.color.set(environment.sky);
    this.environment.groundColor.set(environment.ground);
    this.environment.intensity = environment.intensity;
    (this.scene.background as THREE.Color).set(environment.background);
    const landingAid = landingVisibilityAid(
      body.def.surfaceKind,
      alt,
      surfaceSunCosine,
      solarVisibleFraction,
    );
    this.landingLight.intensity = landingAid.intensity;
    this.landingLight.distance = landingAid.distance;
    this.landingLight.position.set(
      -camOffset.x + up.x * 2,
      -camOffset.y + up.y * 2,
      -camOffset.z + up.z * 2,
    );
    const landingTargetDepth = Math.max(1_000, alt + 1_000);
    this.landingLight.target.position.set(
      this.landingLight.position.x - up.x * landingTargetDepth,
      this.landingLight.position.y - up.y * landingTargetDepth,
      this.landingLight.position.z - up.z * landingTargetDepth,
    );
    this.landingLight.target.updateMatrixWorld(true);
    this.context.renderer.toneMappingExposure = adaptExposure(
      this.context.renderer.toneMappingExposure,
      environment.exposure,
      smokeDt,
    );
    this.updateLocalSolarShadow(alt);
  }

  /**
   * Render one deterministic mission snapshot without an active GameVessel.
   * `frame` and `cameraPose` are both focus-body-relative structural data.
   */
  updateMission(
    frame: Readonly<MissionWorldFrame>,
    cameraPose: Readonly<MissionCameraPose>,
    dt: number,
  ): void {
    if (this.disposed) throw new Error('World scene is disposed');
    const focusBody = frame.universe.bodies.get(frame.focusBodyId);
    if (!focusBody) throw new Error(`Mission focus body not found: ${frame.focusBodyId}`);
    const enteringMission = this.presentationMode !== 'mission';
    if (enteringMission && !this.missionPresentationSnapshot) {
      this.missionPresentationSnapshot = {
        fov: this.camera.fov,
        quaternion: this.camera.quaternion.clone(),
        up: this.camera.up.clone(),
        exposure: this.context.renderer.toneMappingExposure,
      };
    }
    this.presentationMode = 'mission';
    this.activeVesselId = null;
    this.setFlightTerrainOwner(null);
    this.clearReentryEffect();
    this.srbSmoke.clear();
    this.launchSite.visible = false;
    this.landingLight.intensity = 0;
    this.landingLight.distance = 0;
    for (const visual of this.vesselVisuals.values()) visual.group.visible = false;

    if (enteringMission || cameraPose.discontinuity) this.lastBodyFrames.clear();
    this.context.renderer.getDrawingBufferSize(_drawingBufferSize);
    const drawingBufferWidth = Math.max(1, Math.floor(_drawingBufferSize.x));
    const drawingBufferHeight = Math.max(1, Math.floor(_drawingBufferSize.y));
    const fov = Number.isFinite(cameraPose.fieldOfViewDegrees)
      ? THREE.MathUtils.clamp(cameraPose.fieldOfViewDegrees, 15, 82)
      : 52;
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    _cameraBodyRelative.set(cameraPose.position.x, cameraPose.position.y, cameraPose.position.z);
    frame.universe.absolutePosition(focusBody, frame.universeTimeSeconds, _bodyAbs);
    _camAbs.copy(_bodyAbs).add(_cameraBodyRelative);
    _camOffset.set(
      cameraPose.target.x - cameraPose.position.x,
      cameraPose.target.y - cameraPose.position.y,
      cameraPose.target.z - cameraPose.position.z,
    );
    if (_camOffset.lengthSq() < 1e-12) _camOffset.set(0, 1, 0);
    _cameraOrbitUp.set(cameraPose.up.x, cameraPose.up.y, cameraPose.up.z);
    if (_cameraOrbitUp.lengthSq() < 1e-12) _cameraOrbitUp.set(0, 0, 1);
    else _cameraOrbitUp.normalize();
    this.camera.position.set(0, 0, 0);
    this.camera.up.set(_cameraOrbitUp.x, _cameraOrbitUp.y, _cameraOrbitUp.z);
    this.camera.lookAt(_camOffset.x, _camOffset.y, _camOffset.z);
    this.camera.updateMatrixWorld(true);
    this.camera.getWorldDirection(_cameraForwardThree);
    _cameraForwardWorld.set(_cameraForwardThree.x, _cameraForwardThree.y, _cameraForwardThree.z);

    const safeDelta = THREE.MathUtils.clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    const verticalFovRadians = THREE.MathUtils.degToRad(this.camera.fov);
    this.updateCelestialBodyStage({
      universe: frame.universe,
      focusBody,
      time: frame.universeTimeSeconds,
      cameraAbsolute: _camAbs,
      cameraForward: _cameraForwardWorld,
      deltaSeconds: safeDelta,
      verticalFovRadians,
      drawingBufferWidth,
      drawingBufferHeight,
      allowFlightTerrain: false,
    });

    this.missionEntities ??= new MissionEntityRenderer(this.scene);
    this.missionEntities.update(
      frame.entities,
      _cameraBodyRelative,
      this.camera,
      drawingBufferHeight,
      frame.paths,
      frame.layers,
    );

    const altitude = _cameraBodyRelative.length() - focusBody.radius;
    const radialUp = _tmp.copy(_cameraBodyRelative);
    if (radialUp.lengthSq() < 1e-12) radialUp.set(0, 0, 1);
    else radialUp.normalize();
    const rendererKind = this.bodyRenderers.get(focusBody.id)?.kind;
    const solarVisibleFraction = this.lastBodyFrames.get(focusBody.id)?.solarVisibleFraction ?? 1;
    const surfaceSunCosine = Vec3.dot(radialUp, _sunDir);
    const dayness = Math.max(0, surfaceSunCosine);
    const sunInFrame = Vec3.dot(_cameraForwardWorld, _sunDir)
      > Math.cos(verticalFovRadians * 0.65);
    const environment = environmentLighting(
      rendererKind,
      focusBody.def.atmosphere?.height ?? 0,
      altitude,
      dayness,
      solarVisibleFraction,
      sunInFrame,
      this.environmentState,
    );
    this.environment.color.set(environment.sky);
    this.environment.groundColor.set(environment.ground);
    this.environment.intensity = environment.intensity;
    (this.scene.background as THREE.Color).set(environment.background);
    this.context.renderer.toneMappingExposure = cameraPose.discontinuity || enteringMission
      ? environment.exposure
      : adaptExposure(this.context.renderer.toneMappingExposure, environment.exposure, safeDelta);
    _tmp.set(cameraPose.target.x, cameraPose.target.y, cameraPose.target.z);
    this.updateLocalSolarShadow(altitude, _cameraBodyRelative.distanceTo(_tmp));
  }

  missionEntityStats(): Readonly<{ visuals: number; proxyVisuals: number; paths: number }> | null {
    return this.missionEntities?.stats() ?? null;
  }

  private bodyOf(game: GameState, gv: GameVessel): Body {
    return game.universe.get(gv.runtime.bodyId);
  }

  private emitSrbSmoke(
    gv: GameVessel,
    visual: VesselVisual,
    pressureFrac: number,
    inheritedVelocity: Readonly<Vec3>,
  ): void {
    const burningGroups = [...visual.plumes.entries()].filter(([, group]) => (
      group.userData.solid === true && group.userData.burning === true
    ));
    if (burningGroups.length === 0) return;
    visual.group.updateMatrixWorld(true);
    const radial = gv.runtime.pos;
    _smokeUp.set(radial.x, radial.y, radial.z).normalize();
    for (const [partKey, group] of burningGroups) {
      for (let nozzleIndex = 0; nozzleIndex < group.children.length; nozzleIndex++) {
        const nozzle = group.children[nozzleIndex];
        nozzle.getWorldPosition(_smokeNozzleRelative);
        _smokeNozzleBodyRelative.set(
          _smokeNozzleRelative.x + _cameraBodyRelative.x,
          _smokeNozzleRelative.y + _cameraBodyRelative.y,
          _smokeNozzleRelative.z + _cameraBodyRelative.z,
        );
        nozzle.getWorldQuaternion(_smokeQuaternion);
        _smokeDirection.set(0, -1, 0).applyQuaternion(_smokeQuaternion).normalize();
        this.srbSmoke.emit({
          emitterId: `${gv.runtime.id}:${partKey}:${nozzleIndex}`,
          position: _smokeNozzleBodyRelative,
          direction: _smokeDirection,
          inheritedVelocity,
          up: _smokeUp,
          pressureFrac,
          plumeScale: Number(nozzle.userData.baseScale ?? 1),
        });
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.diagnostics.record({
      subsystem: 'renderer',
      event: 'world-scene-disposed',
      severity: 'state',
      data: { quality: this.quality },
    });
    this.disposed = true;
    this.unsubscribeRestoration();
    window.removeEventListener('resize', this.resizeHandler);
    for (const manager of this.bodyRendererManagers.values()) manager.dispose();
    this.bodyRendererManagers.clear();
    this.bodyRendererLoads?.clear();
    for (const renderer of this.bodyRenderers.values()) {
      if (renderer.root.parent === this.scene) this.scene.remove(renderer.root);
    }
    this.bodyRenderers.clear();
    this.lastBodyFrames.clear();
    this.planetAssetLoader.dispose();
    this.flightTerrainBodyId = null;
    this.flightPromotedBodyId = null;
    this.flightPromotionPending.clear();
    this.flightPromotionFailed.clear();
    this.missionEntities?.dispose();
    this.missionEntities = null;
    this.clearReentryEffect();
    for (const visual of this.vesselVisuals.values()) {
      this.scene.remove(visual.group);
      disposeVesselVisual(visual);
    }
    this.vesselVisuals.clear();
    this.scene.remove(this.srbSmoke.points);
    this.srbSmoke.dispose();
    this.flightAerial.dispose();
    disposeOwnedGroup(this.launchSite);
    this.starfield.geometry.dispose();
    const starfieldMaterials = Array.isArray(this.starfield.material) ? this.starfield.material : [this.starfield.material];
    for (const material of starfieldMaterials) material.dispose();
    this.scene.clear();
  }
}

/** Dispose geometry/materials wholly owned by one scene group, once each. */
function disposeOwnedGroup(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    const owned = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of owned) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  root.clear();
}
