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
import { GameState, GameVessel, LAUNCH_PAD_DECK_HEIGHT, launchSiteDirection } from '../sim/state';
import { groundRadiusInertial } from '../sim/terrain';
import type { Body } from '../sim/universe';
import type { PlanetQuality } from './planet';
import { buildVesselVisual, disposeVesselVisual, syncVesselVisual, VesselVisual } from './vesselMesh';
import { makeStarfield } from './starfield';
import { bodyOrientation, inertialToBodyFixed } from '../sim/bodyOrientation';
import type { RenderContext } from './context';
import type { BodyRenderer, BodyRenderFrame, QualityTier, RuntimeBodyAssetPack, VectorCoordinates } from './bodyRenderer';
import type { BodyRendererKind } from '../content/bodyVisuals';
import { createBodyRendererCandidate } from './bodyRendererFactory';
import { BodyRendererManager, RendererResourceLedger } from './bodyRendererManager';
import { compileRendererCandidate } from './shaderCompiler';
import checkedPlanetArtifact from '../generated/checked-planet-manifest.json';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { checkPlanetManifest, PlanetAssetLoader, type CheckedPlanetManifest } from './planetAssetLoader';
import { geometryByteLength } from './resourceAccounting';

const _camAbs = new Vec3();
const _bodyAbs = new Vec3();
const _vesselAbs = new Vec3();
const _rel = new Vec3();
const _camBF = new Vec3();
const _sunDir = new Vec3();
const _tmp = new Vec3();
const _bodyQ = new Quat();
const _starAbs = new Vec3();
const _bodySunDir = new Vec3();

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

export function bodyFixedCameraVelocity(
  current: VectorCoordinates,
  previous: Readonly<BodyRenderFrame> | undefined,
  deltaSeconds: number,
): VectorCoordinates {
  if (!previous || !(deltaSeconds > 0)) return { x: 0, y: 0, z: 0 };
  const inverseDelta = 1 / deltaSeconds;
  return {
    x: (current.x - previous.cameraBodyFixed.x) * inverseDelta,
    y: (current.y - previous.cameraBodyFixed.y) * inverseDelta,
    z: (current.z - previous.cameraBodyFixed.z) * inverseDelta,
  };
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
  private readonly ambient: THREE.AmbientLight;
  private readonly starfield: THREE.Points;
  private bodyRenderers = new Map<string, BodyRenderer>();
  private bodyRendererManagers = new Map<string, BodyRendererManager>();
  private lastBodyFrames = new Map<string, BodyRenderFrame>();
  private readonly rendererLedger: RendererResourceLedger;
  private readonly checkedPlanetManifest: CheckedPlanetManifest;
  private readonly planetAssetLoader: PlanetAssetLoader;
  private vesselVisuals = new Map<string, VesselVisual>();
  private readonly launchSite: THREE.Group;
  private quality: QualityTier = 'medium';
  private readonly resizeHandler: () => void;
  private readonly unsubscribeRestoration: () => void;
  private disposed = false;
  private flightTerrainBodyId: string | null = null;
  private flightPromotedBodyId: string | null = null;
  private readonly flightPromotionPending = new Set<string>();
  private readonly flightPromotionFailed = new Set<string>();

  /** Camera rig: orbit around the active vessel. */
  camYaw = 0.6;
  camPitch = 0.35;
  camDist = 18;

  constructor(private readonly context: RenderContext) {
    this.checkedPlanetManifest = checkPlanetManifest(checkedPlanetArtifact);
    this.rendererLedger = new RendererResourceLedger(this.checkedPlanetManifest.budgets);
    const textureLoader = new THREE.TextureLoader();
    const configuredBaseUrl = import.meta.env.BASE_URL;
    const baseUrl = configuredBaseUrl.endsWith('/') ? configuredBaseUrl : `${configuredBaseUrl}/`;
    this.planetAssetLoader = new PlanetAssetLoader({
      renderer: context.renderer,
      manifest: this.checkedPlanetManifest,
      ktx2: new KTX2Loader(),
      compressedSupported: Object.values(context.caps.compressedTextures).some(Boolean),
      transcoderPath: `${baseUrl}basis/`,
      resolveAssetUrl: (path) => `${baseUrl}planets/${path}`,
      loadConventional: (path) => textureLoader.loadAsync(path),
    });
    this.camera = new THREE.PerspectiveCamera(
      62,
      window.innerWidth / window.innerHeight,
      0.3,
      6e8,
    );
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
    this.ambient = new THREE.AmbientLight('#2a3844', 0.55);
    this.scene.add(this.ambient);
  }

  private buildLaunchSite(): THREE.Group {
    const group = new THREE.Group();
    const concrete = new THREE.MeshStandardMaterial({ color: '#68717a', roughness: 0.92, metalness: 0.05 });
    const structure = new THREE.MeshStandardMaterial({ color: '#c7d0d5', roughness: 0.65, metalness: 0.35 });
    const accent = new THREE.MeshStandardMaterial({ color: '#c96a3b', roughness: 0.7, metalness: 0.2 });
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(9, 9.8, LAUNCH_PAD_DECK_HEIGHT, 32),
      concrete,
    );
    pad.position.y = LAUNCH_PAD_DECK_HEIGHT / 2;
    group.add(pad);
    const deck = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, 0.12, 32), structure);
    deck.position.y = LAUNCH_PAD_DECK_HEIGHT + 0.06;
    group.add(deck);
    const tower = new THREE.Mesh(new THREE.BoxGeometry(1.1, 13, 1.1), structure);
    tower.position.set(6.2, LAUNCH_PAD_DECK_HEIGHT + 6.5, 0);
    group.add(tower);
    for (let y = 2; y <= 11; y += 3) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.3, 0.35), accent);
      arm.position.set(3.8, LAUNCH_PAD_DECK_HEIGHT + y, 0);
      group.add(arm);
    }
    group.visible = false;
    return group;
  }

  setQuality(q: PlanetQuality | QualityTier): void {
    const tier = typeof q === 'string'
      ? q
      : q.gridRes <= 9 ? 'low' : q.gridRes >= 33 ? 'high' : 'medium';
    this.quality = tier;
    for (const [bodyId, manager] of this.bodyRendererManagers) {
      if (manager.current()?.quality === tier) continue;
      void manager.replaceQuality(tier).then(() => {
        const renderer = manager.current();
        if (renderer) this.bodyRenderers.set(bodyId, renderer);
        if (bodyId === this.flightTerrainBodyId && this.checkedPlanetManifest.hasPack(bodyId, tier)) {
          this.flightPromotedBodyId = bodyId;
        }
      }).catch(() => undefined);
    }
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
        body: candidate, caps: this.context.caps, quality: tier,
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
    });
    this.bodyRendererManagers.set(body.id, manager);
    const renderer = createBodyRendererCandidate({ body, caps: this.context.caps, quality: this.quality });
    const hasAuthoredPack = this.checkedPlanetManifest.hasPack(body.id, this.quality);
    manager.adoptInitial(body, renderer, {
      pack: null,
      gpuBytes: hasAuthoredPack ? rendererGeometryBytes(renderer) : 0,
      transientBytes: 0,
      flightScale: false,
      dispose: () => undefined,
    });
    this.bodyRenderers.set(body.id, renderer);
    if (hasAuthoredPack) {
      void manager.rebuildCommitted().then(() => {
        const replacement = manager.current();
        if (!this.disposed && this.bodyRendererManagers.get(body.id) === manager) {
          if (replacement) this.bodyRenderers.set(body.id, replacement);
          if (body.id === this.flightTerrainBodyId) this.flightPromotedBodyId = body.id;
        } else {
          manager.dispose();
        }
      }).catch(() => undefined);
    }
    return renderer;
  }

  private setFlightTerrainOwner(bodyId: string | null): void {
    const previousId = this.flightTerrainBodyId;
    if (previousId !== bodyId && bodyId) this.flightPromotionFailed?.delete(bodyId);
    if (previousId && previousId !== bodyId) {
      const manager = this.bodyRendererManagers?.get(previousId);
      if (manager) {
        manager.dispose();
        this.bodyRendererManagers.delete(previousId);
      }
      const previous = this.bodyRenderers.get(previousId);
      if (previous && !manager) {
        this.scene.remove(previous.root);
        previous.dispose();
      }
      this.bodyRenderers.delete(previousId);
      this.flightPromotionPending?.delete(previousId);
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
    this.flightPromotionPending.add(bodyId);
    void manager.rebuildCommitted().then(() => {
      if (this.disposed || this.flightTerrainBodyId !== bodyId || this.bodyRendererManagers.get(bodyId) !== manager) return;
      const renderer = manager.current();
      if (renderer) this.bodyRenderers.set(bodyId, renderer);
      this.flightPromotedBodyId = bodyId;
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
    this.promoteFlightRenderer(bodyId);
    return true;
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
      vis = buildVesselVisual(gv.runtime.craft);
      this.vesselVisuals.set(gv.runtime.id, vis);
      this.scene.add(vis.group);
    }
    return vis;
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
  }

  /** Rebuild the active vessel visual (after staging/destruction). */
  invalidateVessel(id: string): void {
    const vis = this.vesselVisuals.get(id);
    if (vis) {
      this.scene.remove(vis.group);
      disposeVesselVisual(vis);
      this.vesselVisuals.delete(id);
    }
  }

  /**
   * Update the whole scene for this frame.
   * Returns the camera's absolute position for other systems (map etc).
   */
  update(game: GameState, dt: number): void {
    const active = game.active;
    if (!active) {
      this.setFlightTerrainOwner(null);
      this.lastBodyFrames?.clear();
      return;
    }
    const v = active.runtime;
    const body = game.bodyOf(active);
    this.setFlightTerrainOwner(body.id);
    const t = game.time;

    // ---- camera position: orbit rig around the vessel, in vessel-local
    // "horizon" space (up = away from body center).
    const up = _tmp.copy(v.pos).normalize();
    // Build a local frame: up + east.
    const east = new Vec3(-up.y, up.x, 0);
    if (east.lengthSq() < 1e-9) east.set(1, 0, 0);
    east.normalize();
    const north = new Vec3();
    Vec3.cross(up, east, north);

    const cy = Math.cos(this.camYaw);
    const sy = Math.sin(this.camYaw);
    const cp = Math.cos(this.camPitch);
    const sp = Math.sin(this.camPitch);
    // Camera offset from vessel (in the local horizon frame).
    const camOffset = new Vec3()
      .addScaled(east, cy * cp * this.camDist)
      .addScaled(north, sy * cp * this.camDist)
      .addScaled(up, sp * this.camDist);

    // Absolute camera position: vessel absolute + offset.
    game.universe.absolutePosition(body, t, _bodyAbs);
    _vesselAbs.copy(_bodyAbs).add(v.pos);
    _camAbs.copy(_vesselAbs).add(camOffset);

    // Keep star direction in f64 until the final camera-relative conversion.
    game.universe.absolutePosition(game.universe.root, t, _starAbs);
    _sunDir.copy(_starAbs).sub(_camAbs).normalize();

    // ---- planets: full LOD for the SOI body and its close family; simple
    // spheres beyond.
    const renderSet = new Set<string>();
    const considerBodies: Body[] = [];
    const consider = (candidate: Body | null): void => {
      if (candidate && !considerBodies.some((existing) => existing.id === candidate.id)) considerBodies.push(candidate);
    };
    consider(body);
    consider(game.universe.root);
    consider(body.parent);
    for (const child of body.children) consider(child);
    for (const sibling of body.parent?.children ?? []) {
      consider(sibling);
    }

    const sampledBodyIds = new Set<string>();
    for (const b of considerBodies) {
      game.universe.absolutePosition(b, t, _bodyAbs);
      Vec3.sub(_bodyAbs, _camAbs, _rel); // body center in camera-relative world
      const dist = _rel.length();
      renderSet.add(b.id);
      _tmp.copy(_camAbs).sub(_bodyAbs);
      inertialToBodyFixed(b, t, _tmp, _camBF);
      bodyOrientation(b, t, _bodyQ);
      _bodySunDir.copy(_starAbs).sub(_bodyAbs);
      if (_bodySunDir.lengthSq() > 0) _bodySunDir.normalize();
      const renderer = this.rendererFor(b);
      if (!renderer) continue;
      renderer.root.visible = true;
      const previousFrame = this.lastBodyFrames.get(b.id);
      const cameraBodyFixedVelocity = bodyFixedCameraVelocity(_camBF, previousFrame, dt);
      const frame: BodyRenderFrame = {
        cameraRelativeOrigin: _rel,
        cameraBodyFixed: _camBF,
        cameraBodyFixedVelocity,
        orientation: _bodyQ,
        cameraSunDirection: _sunDir,
        bodySunDirection: _bodySunDir,
        time: t,
        deltaSeconds: dt,
        framePressure: dt > 1 / 45,
        altitude: dist - b.radius,
        allowFlightTerrain: b.id === body.id && b.def.surfaceKind === 'solid',
      };
      const stableFrame: BodyRenderFrame = {
        ...frame,
        cameraRelativeOrigin: { ...frame.cameraRelativeOrigin },
        cameraBodyFixed: { ...frame.cameraBodyFixed },
        cameraBodyFixedVelocity: { ...frame.cameraBodyFixedVelocity },
        orientation: { ...frame.orientation },
        cameraSunDirection: { ...frame.cameraSunDirection },
        bodySunDirection: { ...frame.bodySunDirection },
      };
      this.lastBodyFrames.set(b.id, stableFrame);
      sampledBodyIds.add(b.id);
      renderer.update(stableFrame);
    }
    // Hide renderers of bodies no longer relevant.
    for (const [id, renderer] of this.bodyRenderers) {
      if (!renderSet.has(id)) renderer.root.visible = false;
    }
    pruneBodyFrameSamples(this.lastBodyFrames, sampledBodyIds);

    // Cape Skyward is a single persistent world object, positioned from the
    // same transform used by spawnOnPad. It never accumulates across launches.
    if (body.id === 'veyra') {
      const siteDir = launchSiteDirection(body, t, _tmp);
      const siteRadius = groundRadiusInertial(body, siteDir, t);
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
      const sameSystem = rv.bodyId === v.bodyId;
      if (!sameSystem && gv !== active) continue; // render only local vessels
      const vis = this.visualFor(gv);
      if (gv.regime === 'rails' && gv !== active) {
        game.railsPosition(gv, _tmp);
        game.universe.absolutePosition(this.bodyOf(game, gv), t, _bodyAbs);
        _vesselAbs.copy(_bodyAbs).add(_tmp);
      } else {
        game.universe.absolutePosition(this.bodyOf(game, gv), t, _bodyAbs);
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
      const offset = new THREE.Vector3(-com.x, -com.y, -com.z).applyQuaternion(vis.group.quaternion);
      vis.group.position.x += offset.x;
      vis.group.position.y += offset.y;
      vis.group.position.z += offset.z;

      const pressureFrac = Math.min(
        1,
        this.bodyOf(game, gv).pressureAt(rv.pos.length() - this.bodyOf(game, gv).radius) / 101_325,
      );
      syncVesselVisual(vis, rv.craft, rv.controls.throttle, pressureFrac, dt);
    }

    // ---- camera orientation: look at the active vessel.
    this.camera.position.set(0, 0, 0);
    this.camera.up.set(up.x, up.y, up.z);
    this.camera.lookAt(-camOffset.x, -camOffset.y, -camOffset.z);

    // ---- atmosphere tint: fade background + fog by altitude.
    const alt = v.pos.length() - body.radius;
    const atmo = body.def.atmosphere;
    const legacyAtmosphereTint = usesLegacyAtmosphereTint(this.bodyRenderers.get(body.id)?.kind);
    if (atmo && legacyAtmosphereTint && alt < atmo.height) {
      const f = Math.max(0, 1 - alt / atmo.height);
      const dayness = Math.max(0, Vec3.dot(up, _sunDir));
      const sky = new THREE.Color().setRGB(
        0.05 + 0.35 * f * dayness,
        0.07 + 0.5 * f * dayness,
        0.1 + 0.72 * f * dayness,
      );
      (this.scene.background as THREE.Color).copy(sky);
      this.ambient.intensity = 0.55 + 0.5 * f * dayness;
    } else {
      (this.scene.background as THREE.Color).set('#04070a');
      this.ambient.intensity = 0.55;
    }
  }

  private bodyOf(game: GameState, gv: GameVessel): Body {
    return game.universe.get(gv.runtime.bodyId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeRestoration();
    window.removeEventListener('resize', this.resizeHandler);
    for (const manager of this.bodyRendererManagers.values()) manager.dispose();
    this.bodyRendererManagers.clear();
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
    for (const visual of this.vesselVisuals.values()) {
      this.scene.remove(visual.group);
      disposeVesselVisual(visual);
    }
    this.vesselVisuals.clear();
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
