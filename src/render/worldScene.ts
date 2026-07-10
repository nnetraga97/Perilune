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
import { GameState, GameVessel } from '../sim/state';
import type { Body } from '../sim/universe';
import { PlanetRenderer, PLANET_QUALITY, PlanetQuality } from './planet';
import { buildVesselVisual, syncVesselVisual, VesselVisual } from './vesselMesh';
import { makeStarfield } from './starfield';

const _camAbs = new Vec3();
const _bodyAbs = new Vec3();
const _vesselAbs = new Vec3();
const _rel = new Vec3();
const _camBF = new Vec3();
const _sunDir = new Vec3();
const _tmp = new Vec3();

export class WorldScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly sun: THREE.DirectionalLight;
  private readonly ambient: THREE.AmbientLight;
  private readonly sunSprite: THREE.Sprite;
  private planetRenderers = new Map<string, PlanetRenderer>();
  private distantBodies = new Map<string, THREE.Mesh>();
  private vesselVisuals = new Map<string, VesselVisual>();
  private quality: PlanetQuality = PLANET_QUALITY.medium;

  /** Camera rig: orbit around the active vessel. */
  camYaw = 0.6;
  camPitch = 0.35;
  camDist = 18;

  constructor() {
    this.camera = new THREE.PerspectiveCamera(
      62,
      window.innerWidth / window.innerHeight,
      0.3,
      6e8,
    );
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    });
    this.scene.background = new THREE.Color('#04070a');
    this.scene.add(makeStarfield(4200));
    this.sun = new THREE.DirectionalLight('#fff4e0', 2.6);
    this.scene.add(this.sun);
    this.ambient = new THREE.AmbientLight('#2a3844', 0.55);
    this.scene.add(this.ambient);

    const spriteMat = new THREE.SpriteMaterial({
      color: '#fff7dd',
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      depthTest: false,
    });
    this.sunSprite = new THREE.Sprite(spriteMat);
    this.sunSprite.scale.setScalar(4e6);
    this.scene.add(this.sunSprite);
  }

  setQuality(q: PlanetQuality): void {
    this.quality = q;
    for (const pr of this.planetRenderers.values()) pr.setQuality(q);
  }

  planetStats(): { chunks: number; visible: number } {
    let chunks = 0;
    let visible = 0;
    for (const pr of this.planetRenderers.values()) {
      chunks += pr.stats.chunks;
      visible += pr.stats.visible;
    }
    return { chunks, visible };
  }

  private planetFor(body: Body): PlanetRenderer {
    let pr = this.planetRenderers.get(body.id);
    if (!pr) {
      pr = new PlanetRenderer(body, this.quality);
      this.planetRenderers.set(body.id, pr);
      this.scene.add(pr.group);
    }
    return pr;
  }

  private distantFor(body: Body): THREE.Mesh {
    let mesh = this.distantBodies.get(body.id);
    if (!mesh) {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(1, 28, 18),
        new THREE.MeshLambertMaterial({ color: body.def.color }),
      );
      mesh.scale.setScalar(body.radius);
      this.distantBodies.set(body.id, mesh);
      this.scene.add(mesh);
    }
    return mesh;
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
        this.vesselVisuals.delete(id);
      }
    }
  }

  /** Rebuild the active vessel visual (after staging/destruction). */
  invalidateVessel(id: string): void {
    const vis = this.vesselVisuals.get(id);
    if (vis) {
      this.scene.remove(vis.group);
      this.vesselVisuals.delete(id);
    }
  }

  /**
   * Update the whole scene for this frame.
   * Returns the camera's absolute position for other systems (map etc).
   */
  update(game: GameState, dt: number): void {
    const active = game.active;
    if (!active) return;
    const v = active.runtime;
    const body = game.bodyOf(active);
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

    // ---- sun light: from camera toward the star (star at origin).
    _sunDir.copy(_camAbs).scale(-1).normalize();
    this.sun.position.set(_sunDir.x * -1e4, _sunDir.y * -1e4, _sunDir.z * -1e4);
    this.sun.target.position.set(0, 0, 0);
    this.sun.target.updateMatrixWorld();
    // Sun sprite at great distance toward the star.
    this.sunSprite.position.set(_sunDir.x * 3e8, _sunDir.y * 3e8, _sunDir.z * 3e8);

    // ---- planets: full LOD for the SOI body and its close family; simple
    // spheres beyond.
    const renderSet = new Set<string>();
    const considerBodies: Body[] = [body];
    if (body.parent) considerBodies.push(body.parent);
    for (const child of body.children) considerBodies.push(child);
    for (const sibling of body.parent?.children ?? []) {
      if (!considerBodies.includes(sibling)) considerBodies.push(sibling);
    }

    for (const b of considerBodies) {
      if (b.def.isStar) continue;
      game.universe.absolutePosition(b, t, _bodyAbs);
      Vec3.sub(_bodyAbs, _camAbs, _rel); // body center in camera-relative world
      const dist = _rel.length();
      renderSet.add(b.id);
      if (dist < b.radius * 60) {
        // Near: quadtree terrain.
        const pr = this.planetFor(b);
        const spin = b.rotationAngle(t);
        // camera in body-fixed frame
        _tmp.copy(_camAbs).sub(_bodyAbs);
        const cs = Math.cos(-spin);
        const ss = Math.sin(-spin);
        _camBF.set(_tmp.x * cs - _tmp.y * ss, _tmp.x * ss + _tmp.y * cs, _tmp.z);
        pr.update(_camBF, spin, _rel);
        pr.group.visible = true;
        const distant = this.distantBodies.get(b.id);
        if (distant) distant.visible = false;
      } else {
        // Far: single sphere.
        const mesh = this.distantFor(b);
        mesh.position.set(_rel.x, _rel.y, _rel.z);
        mesh.visible = true;
        const pr = this.planetRenderers.get(b.id);
        if (pr) pr.group.visible = false;
      }
    }
    // Hide renderers of bodies no longer relevant.
    for (const [id, pr] of this.planetRenderers) {
      if (!renderSet.has(id)) pr.group.visible = false;
    }
    for (const [id, mesh] of this.distantBodies) {
      if (!renderSet.has(id)) mesh.visible = false;
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
      vis.group.position.set(
        _rel.x - rv.massProps.com.x, // group origin is craft origin; offset so CoM lands on pos
        _rel.y,
        _rel.z,
      );
      // Position: vessel pos refers to craft origin; account attitude:
      vis.group.position.set(_rel.x, _rel.y, _rel.z);
      vis.group.quaternion.set(rv.att.x, rv.att.y, rv.att.z, rv.att.w);
      // The craft origin: rv.pos tracks the craft CoM? (we integrate CoM).
      // Shift so the CoM of the model sits at _rel.
      const com = rv.massProps.com;
      const offset = new THREE.Vector3(-com.x, -com.y, -com.z).applyQuaternion(vis.group.quaternion);
      vis.group.position.x += offset.x;
      vis.group.position.y += offset.y;
      vis.group.position.z += offset.z;

      const pressureFrac = Math.min(
        1,
        this.bodyOf(game, gv).pressureAt(rv.pos.length() - this.bodyOf(game, gv).radius) / 101_325,
      );
      syncVesselVisual(vis, rv.craft, rv.controls.throttle, pressureFrac);
    }

    // ---- camera orientation: look at the active vessel.
    this.camera.position.set(0, 0, 0);
    this.camera.up.set(up.x, up.y, up.z);
    this.camera.lookAt(-camOffset.x, -camOffset.y, -camOffset.z);

    // ---- atmosphere tint: fade background + fog by altitude.
    const alt = v.pos.length() - body.radius;
    const atmo = body.def.atmosphere;
    if (atmo && alt < atmo.height) {
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
    for (const pr of this.planetRenderers.values()) pr.dispose();
    this.planetRenderers.clear();
  }
}
