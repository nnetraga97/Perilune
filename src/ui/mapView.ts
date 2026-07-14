/**
 * Map view: orbital display with maneuver-node planning.
 *
 * A separate Three.js scene at 1:100,000 scale, focused on the active
 * vessel's SOI body. Shows body orbits, the vessel's conic, the post-node
 * conic, SOI spheres, and encounter markers with periapsis readout.
 * Node editing happens in a DOM panel (prograde/normal/radial ± time).
 */
import * as THREE from 'three';
import { Vec3 } from '../core/vec3';
import { Quat } from '../core/quat';
import {
  OrbitalElements,
  elementsAtTime,
  elementsToState,
  stateToElements,
  TWO_PI,
} from '../core/orbit';
import { GameState } from '../sim/state';
import type { Body, Universe } from '../sim/universe';
import {
  ManeuverNode,
  nodeDeltaV,
  orbitAfterNode,
  predictTrajectory,
  TrajectoryPrediction,
} from '../sim/maneuver';
import { makeStarfield } from '../render/starfield';
import { depositSites, DepositSite } from '../sim/resources';
import { bodyFixedToInertial, bodyOrientation } from '../sim/bodyOrientation';
import {
  bodyFixedUv,
  bodyMaterialDescriptor,
  type BodyMaterialDescriptor,
} from '../render/bodyMaterial';
import { installBodyFixedDirectionAttribute } from '../render/terrestrial/globalCoordinates';
import { createTerrestrialGlobalMaterial } from '../render/terrestrial/globalMaterial';
import { el, injectUiStyles } from './kit';

const SCALE = 1e-5;
const _mapOrientation = new Quat();

function paletteColor(descriptor: Readonly<BodyMaterialDescriptor>, u: number, v: number): THREE.Color {
  if (descriptor.identity === 'star') {
    return new THREE.Color(v > 0.25 && v < 0.75 ? descriptor.albedo.high : descriptor.albedo.mid);
  }
  if (descriptor.identity === 'gas') {
    const band = Math.floor(v * 18 + Math.sin(u * Math.PI * 4) * 0.35) % 4;
    return new THREE.Color(band === 0 ? descriptor.albedo.high : band === 1 ? descriptor.albedo.low : descriptor.albedo.mid);
  }
  const continental = Math.sin(u * Math.PI * 12) + Math.sin(v * Math.PI * 9) * 0.7;
  if (descriptor.albedo.ocean && continental < -0.55) return new THREE.Color(descriptor.albedo.ocean);
  if (v < 0.18 || v > 0.82 || continental > 1.05) return new THREE.Color(descriptor.albedo.high);
  return new THREE.Color(continental < 0 ? descriptor.albedo.low : descriptor.albedo.mid);
}

/** Build a pack-free compact body whose local colors use the shared body-fixed UV convention. */
export function compactBodyMesh(descriptor: Readonly<BodyMaterialDescriptor>): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(1, 32, 20);
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
  const colors = new Float32Array(positions.count * 3);
  for (let index = 0; index < positions.count; index++) {
    const uv = bodyFixedUv({ x: positions.getX(index), y: positions.getY(index), z: positions.getZ(index) });
    const color = paletteColor(descriptor, uv.u, uv.v);
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  installBodyFixedDirectionAttribute(geometry);

  const material: THREE.Material = descriptor.identity === 'star'
    ? new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false })
    : descriptor.identity === 'gas'
      ? new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 18 })
      : createTerrestrialGlobalMaterial(null, descriptor);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `compact-body:${descriptor.bodyId}`;
  mesh.userData.bodyMaterial = {
    bodyId: descriptor.bodyId,
    renderer: descriptor.renderer,
    identity: descriptor.identity,
    albedo: { ...descriptor.albedo },
  };
  mesh.userData.orientationConvention = descriptor.orientationConvention;
  return mesh;
}

export function updateCompactBodyOrientation(mesh: THREE.Object3D, body: Body, time: number): void {
  bodyOrientation(body, time, _mapOrientation);
  mesh.quaternion.set(_mapOrientation.x, _mapOrientation.y, _mapOrientation.z, _mapOrientation.w);
}

/** Unit vector in map coordinates from the focus-body center toward Auren. */
export function mapStarDirection(universe: Universe, focusBody: Body, time: number, out: Vec3): Vec3 {
  universe.relativePosition(universe.root, focusBody, time, out);
  return out.lengthSq() > 0 ? out.normalize() : out.set(1, 0, 0);
}

function orbitLine(color: string, dashed = false): THREE.Line {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(256 * 3), 3));
  const mat = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 0.6, gapSize: 0.35, transparent: true, opacity: 0.9 })
    : new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 });
  const line = new THREE.Line(geo, mat);
  line.frustumCulled = false;
  return line;
}

/** Fill a line's positions from a conic around origin (parent-centered). */
function fillConic(line: THREE.Line, el: OrbitalElements, offset: Vec3 | null): void {
  const attr = (line.geometry as THREE.BufferGeometry).getAttribute('position') as THREE.BufferAttribute;
  const arr = attr.array as Float32Array;
  const r = new Vec3();
  const v = new Vec3();
  const n = 255;
  if (el.e < 1) {
    for (let i = 0; i <= n; i++) {
      const nu = (i / n) * TWO_PI;
      elementsToStateSafe(el, nu, r, v);
      arr[i * 3] = (r.x + (offset?.x ?? 0)) * SCALE;
      arr[i * 3 + 1] = (r.y + (offset?.y ?? 0)) * SCALE;
      arr[i * 3 + 2] = (r.z + (offset?.z ?? 0)) * SCALE;
    }
  } else {
    // Hyperbolic: sample true anomaly within asymptote limits.
    const nuInf = Math.acos(-1 / el.e) * 0.96;
    for (let i = 0; i <= n; i++) {
      const nu = -nuInf + (i / n) * 2 * nuInf;
      elementsToStateSafe(el, nu, r, v);
      arr[i * 3] = (r.x + (offset?.x ?? 0)) * SCALE;
      arr[i * 3 + 1] = (r.y + (offset?.y ?? 0)) * SCALE;
      arr[i * 3 + 2] = (r.z + (offset?.z ?? 0)) * SCALE;
    }
  }
  attr.needsUpdate = true;
  (line as THREE.Line & { computeLineDistances(): void }).computeLineDistances?.();
}

function elementsToStateSafe(el: OrbitalElements, nu: number, outR: Vec3, outV: Vec3): void {
  elementsToState(el, nu, outR, outV);
  if (!outR.isFinite()) outR.set(0, 0, 0);
}

export interface MapCallbacks {
  onWarpToNode(nodeTime: number): void;
}

export class MapView {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  visible = false;

  private bodyMeshes = new Map<string, THREE.Mesh>();
  private bodyOrbits = new Map<string, THREE.Line>();
  private soiMeshes = new Map<string, THREE.Mesh>();
  private vesselLine = orbitLine('#7fd0e8');
  private nodeLine = orbitLine('#e8c76b', true);
  private encounterLine = orbitLine('#c88be8', true);
  private vesselMarker: THREE.Sprite;
  private nodeMarker: THREE.Sprite;
  private encounterMarker: THREE.Sprite;
  private depositMarkers: THREE.Sprite[] = [];
  private depositCache = new Map<string, DepositSite[]>();
  private mkDepositSprite!: () => THREE.Sprite;
  private readonly starfield: THREE.Points;
  private readonly sun: THREE.DirectionalLight;
  private readonly resizeHandler: () => void;
  private disposed = false;

  private camYaw = 0.8;
  private camPitch = 0.9;
  private camDist = 400; // scene units

  node: ManeuverNode | null = null;
  private prediction: TrajectoryPrediction | null = null;
  private predictionDirty = true;
  private lastElSig = '';

  private panel: HTMLElement;
  private nodePanel: HTMLElement;
  private encounterInfo: HTMLElement;
  private dvReadout: HTMLElement;
  private etaReadout: HTMLElement;
  private cb: MapCallbacks;
  private focusBodyId = 'veyra';

  constructor(uiRoot: HTMLElement, cb: MapCallbacks) {
    this.cb = cb;
    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.01, 1e7);
    this.resizeHandler = () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', this.resizeHandler);
    this.scene.background = new THREE.Color('#05080c');
    this.starfield = makeStarfield(2600, 777);
    this.scene.add(this.starfield);
    this.scene.add(new THREE.AmbientLight('#8899aa', 1.6));
    this.sun = new THREE.DirectionalLight('#fff4e0', 1.4);
    this.sun.position.set(1, 0.3, 0.5);
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(this.vesselLine, this.nodeLine, this.encounterLine);

    const mkSprite = (color: string, size: number) => {
      const c = document.createElement('canvas');
      c.width = c.height = 32;
      const g = c.getContext('2d')!;
      g.fillStyle = color;
      g.beginPath();
      g.arc(16, 16, 10, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#ffffff';
      g.lineWidth = 2.5;
      g.stroke();
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }),
      );
      sprite.scale.setScalar(size);
      sprite.renderOrder = 10;
      return sprite;
    };
    this.vesselMarker = mkSprite('#7fd0e8', 5);
    this.nodeMarker = mkSprite('#e8c76b', 4);
    this.encounterMarker = mkSprite('#c88be8', 4);
    this.scene.add(this.vesselMarker, this.nodeMarker, this.encounterMarker);
    this.mkDepositSprite = () => mkSprite('#e2b13c', 3);

    // ---- DOM panel
    this.panel = el('div', 'map-panel', uiRoot);
    injectUiStyles();
    const title = el('div', 'map-title', this.panel, 'MANEUVER PLANNER');
    const btnRow = el('div', 'map-row', this.panel);
    const addBtn = el('button', 'hud-btn', btnRow, '+ Node in 2 min') as HTMLButtonElement;
    addBtn.onclick = () => this.createNode(120);
    const delBtn = el('button', 'hud-btn', btnRow, 'Delete') as HTMLButtonElement;
    delBtn.onclick = () => {
      this.node = null;
      this.predictionDirty = true;
      this.refreshNodePanel();
    };
    const warpBtn = el('button', 'hud-btn', btnRow, 'Warp → node') as HTMLButtonElement;
    warpBtn.onclick = () => {
      if (this.node) cb.onWarpToNode(this.node.time);
    };

    this.nodePanel = el('div', 'map-node-panel', this.panel);
    this.dvReadout = el('div', 'map-readout', this.panel);
    this.etaReadout = el('div', 'map-readout', this.panel);
    this.encounterInfo = el('div', 'map-encounter', this.panel);
    this.refreshNodePanel();
    this.setVisible(false);
  }

  setVisible(vis: boolean): void {
    this.visible = vis;
    this.panel.style.display = vis ? '' : 'none';
  }

  /** Pointer controls (called by game shell). */
  orbitCamera(dx: number, dy: number): void {
    this.camYaw -= dx * 0.005;
    this.camPitch = Math.max(0.05, Math.min(Math.PI / 2.05, this.camPitch + dy * 0.005));
  }

  zoomCamera(factor: number): void {
    this.camDist = Math.max(3, Math.min(2.5e5, this.camDist * factor));
  }

  createNode(inSeconds: number): void {
    this.nodeTimeBase = null;
    const t = this.gameRef?.time ?? 0;
    this.node = { time: t + inSeconds, prograde: 0, normal: 0, radial: 0 };
    this.predictionDirty = true;
    this.refreshNodePanel();
  }

  private nodeTimeBase: number | null = null;
  private gameRef: GameState | null = null;

  private refreshNodePanel(): void {
    this.nodePanel.innerHTML = '';
    if (!this.node) {
      el('div', 'map-readout', this.nodePanel, 'no node planned');
      this.dvReadout.textContent = '';
      this.etaReadout.textContent = '';
      this.encounterInfo.textContent = '';
      return;
    }
    const axes: Array<{ key: 'prograde' | 'normal' | 'radial' | 'time'; label: string; step: number }> = [
      { key: 'prograde', label: 'Prograde', step: 5 },
      { key: 'normal', label: 'Normal', step: 5 },
      { key: 'radial', label: 'Radial', step: 5 },
      { key: 'time', label: 'Time +/-', step: 30 },
    ];
    for (const ax of axes) {
      const row = el('div', 'map-axis', this.nodePanel);
      el('label', '', row, ax.label);
      const minus = el('button', 'hud-btn', row, '−') as HTMLButtonElement;
      const fine = el('button', 'hud-btn', row, '‹') as HTMLButtonElement;
      const coarse = el('button', 'hud-btn', row, '›') as HTMLButtonElement;
      const plus = el('button', 'hud-btn', row, '+') as HTMLButtonElement;
      const val = el('span', 'val', row, '0');
      const apply = (delta: number) => {
        if (!this.node) return;
        if (ax.key === 'time') this.node.time += delta;
        else this.node[ax.key] += delta;
        this.predictionDirty = true;
        val.textContent =
          ax.key === 'time'
            ? `${(this.node.time - (this.gameRef?.time ?? 0)).toFixed(0)}s`
            : `${this.node[ax.key].toFixed(1)}`;
      };
      minus.onclick = () => apply(-ax.step);
      fine.onclick = () => apply(-ax.step / 10);
      coarse.onclick = () => apply(ax.step / 10);
      plus.onclick = () => apply(ax.step);
      val.textContent = ax.key === 'time' ? '—' : `${this.node[ax.key].toFixed(1)}`;
    }
  }

  /** Per-frame update. */
  update(game: GameState): void {
    this.gameRef = game;
    const gv = game.active;
    if (!gv) return;
    const v = gv.runtime;
    const body = game.bodyOf(gv);
    this.focusBodyId = body.id;
    const t = game.time;
    const starDirection = mapStarDirection(game.universe, body, t, new Vec3());
    const lightDistance = Math.max(100, this.camDist * 2);
    this.sun.position.set(
      starDirection.x * lightDistance,
      starDirection.y * lightDistance,
      starDirection.z * lightDistance,
    );
    this.sun.target.position.set(0, 0, 0);

    // Camera around focus body origin.
    const cx = Math.cos(this.camYaw) * Math.cos(this.camPitch);
    const cy = Math.sin(this.camYaw) * Math.cos(this.camPitch);
    const cz = Math.sin(this.camPitch);
    this.camera.position.set(cx * this.camDist, cy * this.camDist, cz * this.camDist);
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(0, 0, 0);

    // Bodies: focus body at origin; children + parent + siblings around it.
    const shown = new Set<string>();
    const place = (b: Body, pos: Vec3) => {
      shown.add(b.id);
      let mesh = this.bodyMeshes.get(b.id);
      if (!mesh) {
        mesh = compactBodyMesh(bodyMaterialDescriptor(b));
        this.bodyMeshes.set(b.id, mesh);
        this.scene.add(mesh);
      }
      mesh.scale.setScalar(Math.max(b.radius * SCALE, this.camDist * 0.008));
      mesh.position.set(pos.x * SCALE, pos.y * SCALE, pos.z * SCALE);
      updateCompactBodyOrientation(mesh, b, t);
      // SOI sphere (children only, subtle).
      if (b.soiRadius !== Infinity && b.id !== body.id) {
        let soi = this.soiMeshes.get(b.id);
        if (!soi) {
          soi = new THREE.Mesh(
            new THREE.SphereGeometry(1, 20, 12),
            new THREE.MeshBasicMaterial({ color: '#5a7f96', transparent: true, opacity: 0.1, side: THREE.BackSide }),
          );
          this.soiMeshes.set(b.id, soi);
          this.scene.add(soi);
        }
        soi.scale.setScalar(b.soiRadius * SCALE);
        soi.position.copy(mesh.position);
        soi.visible = true;
      }
    };

    const zero = new Vec3();
    place(body, zero);
    const childPos = new Vec3();
    for (const child of body.children) {
      game.universe.localPosition(child, t, childPos);
      place(child, childPos);
      // Child orbit line around focus.
      let line = this.bodyOrbits.get(child.id);
      if (!line) {
        line = orbitLine('#4a6072');
        this.bodyOrbits.set(child.id, line);
        this.scene.add(line);
      }
      if (child.orbit) fillConic(line, child.orbit, null);
      line.visible = true;
    }
    for (const [id, mesh] of this.bodyMeshes) {
      if (!shown.has(id)) mesh.visible = false;
      else mesh.visible = true;
    }
    for (const [id, line] of this.bodyOrbits) {
      line.visible = shown.has(id);
    }
    for (const [id, soi] of this.soiMeshes) {
      soi.visible = shown.has(id);
    }

    // Ore deposit markers on the focus body (after an orbital survey).
    if (game.scannedBodies.has(body.id)) {
      let sites = this.depositCache.get(body.id);
      if (!sites) {
        sites = depositSites(body, 6);
        this.depositCache.set(body.id, sites);
      }
      for (let i = 0; i < sites.length; i++) {
        let sprite = this.depositMarkers[i];
        if (!sprite) {
          sprite = this.mkDepositSprite();
          this.depositMarkers.push(sprite);
          this.scene.add(sprite);
        }
        const d = sites[i].dir;
        const r = body.radius * 1.02 * SCALE;
        const inertial = bodyFixedToInertial(body, t, d, new Vec3());
        sprite.position.set(inertial.x * r, inertial.y * r, inertial.z * r);
        sprite.scale.setScalar(this.camDist * 0.01);
        sprite.visible = true;
      }
      for (let i = sites.length; i < this.depositMarkers.length; i++) {
        this.depositMarkers[i].visible = false;
      }
    } else {
      for (const m of this.depositMarkers) m.visible = false;
    }

    // Vessel conic.
    const els = stateToElements(body.mu, v.pos, v.vel, t);
    fillConic(this.vesselLine, els, null);
    this.vesselMarker.position.set(v.pos.x * SCALE, v.pos.y * SCALE, v.pos.z * SCALE);
    const markerScale = this.camDist * 0.014;
    this.vesselMarker.scale.setScalar(markerScale);
    this.nodeMarker.scale.setScalar(markerScale * 0.8);
    this.encounterMarker.scale.setScalar(markerScale * 0.8);

    // Node: keep it in the future.
    if (this.node && this.node.time < t + 1) {
      this.node.time = t + 1;
      this.predictionDirty = true;
    }

    // Prediction refresh (only when orbit/node changed).
    const sig = `${els.a.toFixed(0)}:${els.e.toFixed(5)}:${els.i.toFixed(4)}:${this.node ? `${this.node.time.toFixed(0)}:${this.node.prograde.toFixed(1)}:${this.node.normal.toFixed(1)}:${this.node.radial.toFixed(1)}` : 'x'}`;
    if (sig !== this.lastElSig || this.predictionDirty) {
      this.lastElSig = sig;
      this.predictionDirty = false;
      if (this.node) {
        const after = orbitAfterNode(els, this.node);
        this.prediction = predictTrajectory(game.universe, body, after, this.node.time);
        fillConic(this.nodeLine, after, null);
        this.nodeLine.visible = true;
        const nr = new Vec3();
        const nv = new Vec3();
        elementsAtTime(els, this.node.time, nr, nv);
        this.nodeMarker.position.set(nr.x * SCALE, nr.y * SCALE, nr.z * SCALE);
        this.nodeMarker.visible = true;
      } else {
        this.prediction = predictTrajectory(game.universe, body, els, t);
        this.nodeLine.visible = false;
        this.nodeMarker.visible = false;
      }
      // Encounter display.
      if (this.prediction?.encounter) {
        const enc = this.prediction.encounter;
        const moon = game.universe.get(enc.bodyId);
        const mp = new Vec3();
        game.universe.localPosition(moon, enc.entryTime, mp);
        fillConic(this.encounterLine, enc.elements, mp);
        this.encounterLine.visible = true;
        this.encounterMarker.position.set(mp.x * SCALE, mp.y * SCALE, mp.z * SCALE);
        this.encounterMarker.visible = true;
        this.encounterInfo.textContent =
          `${moon.name} encounter!\n` +
          `SOI entry in ${((enc.entryTime - t) / 60).toFixed(0)} min\n` +
          `periapsis ${enc.periapsisAltitude > 0 ? (enc.periapsisAltitude / 1000).toFixed(0) + ' km' : 'IMPACT'}`;
      } else {
        this.encounterLine.visible = false;
        this.encounterMarker.visible = false;
        this.encounterInfo.textContent = this.prediction?.escape
          ? `escapes ${body.name} SOI in ${((this.prediction.escape.exitTime - t) / 60).toFixed(0)} min`
          : '';
      }
    }

    if (this.node) {
      this.dvReadout.textContent = `Δv ${nodeDeltaV(this.node).toFixed(1)} m/s`;
      this.etaReadout.textContent = `burn in ${(this.node.time - t).toFixed(0)} s`;
    }
  }

  /** Release every scene and DOM resource owned by this map instance. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('resize', this.resizeHandler);

    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
        geometries.add(object.geometry);
      }
      if (
        object instanceof THREE.Mesh || object instanceof THREE.Line ||
        object instanceof THREE.Points || object instanceof THREE.Sprite
      ) {
        const owned = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of owned) materials.add(material);
      }
    });
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
    for (const texture of textures) texture.dispose();
    for (const material of materials) material.dispose();
    for (const geometry of geometries) geometry.dispose();

    this.bodyMeshes.clear();
    this.bodyOrbits.clear();
    this.soiMeshes.clear();
    this.depositMarkers.length = 0;
    this.depositCache.clear();
    this.scene.clear();
    this.panel.remove();
    this.gameRef = null;
  }
}
