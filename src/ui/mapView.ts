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
  apoapsisOf,
  periapsisOf,
  periodOf,
  stateToElements,
  timeToTrueAnomaly,
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
import { createTerrestrialGlobalMaterial, updateTerrestrialCloudLighting } from '../render/terrestrial/globalMaterial';
import { WEATHER_CLOUD_DRIFT_RATE } from '../render/terrestrial/cloudLayer';
import { createGlobalSphereGeometry } from '../render/terrestrial/globalGeometry';
import type { QualityTier, RuntimeBodyAssetPack } from '../render/bodyRenderer';
import { el, injectUiStyles } from './kit';
import { analyzeCraft } from '../sim/vessel';
import type { AlarmKind } from '../sim/state';
import { predictEntry, type EntryPrediction } from '../sim/entry';
import { launchSiteBodyFixedDirection } from '../sim/launchSite';

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

/** Build a compact body, borrowing authored terrestrial maps when a committed pack is available. */
export function compactBodyMesh(
  descriptor: Readonly<BodyMaterialDescriptor>,
  pack: Readonly<RuntimeBodyAssetPack> | null = null,
  maxAnisotropy = 1,
  quality: QualityTier = pack?.tier ?? 'medium',
): THREE.Mesh<THREE.SphereGeometry, THREE.Material> {
  const geometry = descriptor.identity === 'solid'
    ? createGlobalSphereGeometry(quality)
    : new THREE.SphereGeometry(1, 48, 32);
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
  if (!geometry.getAttribute('bodyDirection')) installBodyFixedDirectionAttribute(geometry);

  const material: THREE.Material = descriptor.identity === 'star'
    ? new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false })
    : descriptor.identity === 'gas'
      ? new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 18 })
      : createTerrestrialGlobalMaterial(pack, descriptor, maxAnisotropy);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `compact-body:${descriptor.bodyId}`;
  mesh.userData.bodyMaterial = {
    bodyId: descriptor.bodyId,
    renderer: descriptor.renderer,
    identity: descriptor.identity,
    albedo: { ...descriptor.albedo },
  };
  mesh.userData.orientationConvention = descriptor.orientationConvention;
  mesh.userData.assetPack = pack;
  mesh.userData.quality = quality;
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

function entryPathLine(): THREE.Line {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(2048 * 3), 3));
  geometry.setDrawRange(0, 0);
  return new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({ color: '#e27a4f', transparent: true, opacity: 0.9 }),
  );
}

function fillEntryPath(line: THREE.Line, samples: readonly Vec3[]): void {
  const geometry = line.geometry as THREE.BufferGeometry;
  const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
  const count = Math.min(samples.length, positions.count);
  for (let index = 0; index < count; index++) {
    const sample = samples[index];
    positions.setXYZ(index, sample.x * SCALE, sample.y * SCALE, sample.z * SCALE);
  }
  positions.needsUpdate = true;
  geometry.setDrawRange(0, count);
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
  onWarpToNode(node: ManeuverNode): void;
  onCreateAlarm(time: number, label: string, kind: AlarmKind): void;
  onSetTarget(bodyId: string | null): void;
  onWarpToTime(time: number, margin: number): void;
  getBodyAssetPack?(bodyId: string): Readonly<RuntimeBodyAssetPack> | null;
  getQualityTier?(): QualityTier;
  readonly maxAnisotropy?: number;
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
  private entryLine = entryPathLine();
  private vesselMarker: THREE.Sprite;
  private nodeMarker: THREE.Sprite;
  private nodeHandles = new Map<'prograde' | 'normal' | 'radial', THREE.Sprite>();
  private encounterMarker: THREE.Sprite;
  private entryMarker: THREE.Sprite;
  private landingTargetMarker: THREE.Sprite;
  private orbitMarkers = new Map<'ap' | 'pe' | 'an' | 'dn', THREE.Sprite>();
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
  private camFocus = new THREE.Vector3();

  node: ManeuverNode | null = null;
  private prediction: TrajectoryPrediction | null = null;
  private predictionDirty = true;
  private lastElSig = '';

  private panel: HTMLElement;
  private nodePanel: HTMLElement;
  private encounterInfo: HTMLElement;
  private entryInfo: HTMLElement;
  private dvReadout: HTMLElement;
  private etaReadout: HTMLElement;
  private postReadout: HTMLElement;
  private budgetReadout: HTMLElement;
  private cb: MapCallbacks;
  private focusBodyId = 'veyra';
  private desiredFocus = new THREE.Vector3();
  private bodyCard: HTMLElement | null = null;
  private markerEvents = new Map<THREE.Object3D, { label: string; time: number }>();
  private nodeStep = 1;
  private nodeInputs = new Map<'prograde' | 'normal' | 'radial' | 'time', HTMLInputElement>();
  private currentElements: OrbitalElements | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private dragControl: 'prograde' | 'normal' | 'radial' | 'time' | null = null;
  entryPrediction: EntryPrediction | null = null;
  landingTargetDirBF: Vec3 | null = null;
  private entrySignature = '';
  private lastEntryPredictionAt = -Infinity;

  constructor(private readonly uiRoot: HTMLElement, cb: MapCallbacks) {
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
    this.scene.add(this.vesselLine, this.nodeLine, this.encounterLine, this.entryLine);

    const mkSprite = (color: string, size: number, glyph = '') => {
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
      if (glyph) {
        g.fillStyle = '#071018';
        g.font = 'bold 12px monospace';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(glyph, 16, 16);
      }
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
    this.entryMarker = mkSprite('#e27a4f', 4, 'E');
    this.landingTargetMarker = mkSprite('#ef7dc2', 4, 'T');
    this.scene.add(
      this.vesselMarker,
      this.nodeMarker,
      this.encounterMarker,
      this.entryMarker,
      this.landingTargetMarker,
    );
    for (const [kind, color, glyph] of [
      ['ap', '#7fd0e8', 'Ap'], ['pe', '#7fd0e8', 'Pe'],
      ['an', '#70d58c', 'AN'], ['dn', '#d56ba9', 'DN'],
    ] as const) {
      const marker = mkSprite(color, 3.5, glyph);
      marker.visible = false;
      this.orbitMarkers.set(kind, marker);
      this.scene.add(marker);
    }
    for (const [axis, color, glyph] of [
      ['prograde', '#70d58c', 'P'],
      ['normal', '#b98ce8', 'N'],
      ['radial', '#6baee8', 'R'],
    ] as const) {
      const handle = mkSprite(color, 3.5, glyph);
      handle.visible = false;
      this.nodeHandles.set(axis, handle);
      this.scene.add(handle);
    }
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
      if (this.node) cb.onWarpToNode(this.node);
    };
    const alarmRow = el('div', 'map-row map-alarm-row', this.panel);
    const alarmButton = (label: string, time: () => number | null, alarmLabel: string, kind: AlarmKind) => {
      const button = el('button', 'hud-btn', alarmRow, label);
      button.onclick = () => {
        const alarmTime = time();
        if (alarmTime !== null && alarmTime > (this.gameRef?.time ?? 0)) {
          cb.onCreateAlarm(alarmTime, alarmLabel, kind);
        }
      };
    };
    alarmButton('Alarm node', () => this.node?.time ?? null, 'Maneuver node', 'maneuver');
    alarmButton('Ap', () => this.apsisTime('ap'), 'Apoapsis', 'custom');
    alarmButton('Pe', () => this.apsisTime('pe'), 'Periapsis', 'custom');
    alarmButton('SOI', () => this.prediction?.encounter?.entryTime ?? this.prediction?.escape?.exitTime ?? null, 'SOI transition', 'custom');
    const targetRow = el('div', 'map-row map-alarm-row', this.panel);
    const pinCape = el('button', 'hud-btn', targetRow, 'Pin Cape Skyward');
    pinCape.onclick = () => {
      const body = this.gameRef?.active ? this.gameRef.bodyOf(this.gameRef.active) : null;
      if (!body || body.id !== 'veyra') return;
      this.landingTargetDirBF = this.landingTargetDirBF ? null : launchSiteBodyFixedDirection(new Vec3());
      pinCape.textContent = this.landingTargetDirBF ? 'Clear landing target' : 'Pin Cape Skyward';
    };

    this.nodePanel = el('div', 'map-node-panel', this.panel);
    this.dvReadout = el('div', 'map-readout', this.panel);
    this.etaReadout = el('div', 'map-readout', this.panel);
    this.postReadout = el('div', 'map-orbit-after', this.panel);
    this.budgetReadout = el('div', 'map-budget', this.panel);
    this.encounterInfo = el('div', 'map-encounter', this.panel);
    this.entryInfo = el('div', 'map-entry-info', this.panel);
    this.refreshNodePanel();
    this.setVisible(false);
  }

  setVisible(vis: boolean): void {
    this.visible = vis;
    this.panel.style.display = vis ? '' : 'none';
  }

  focusBody(bodyId: string): void {
    this.focusBodyId = bodyId;
    const mesh = this.bodyMeshes.get(bodyId);
    if (mesh) this.desiredFocus.copy(mesh.position);
  }

  /** Pointer controls (called by game shell). */
  orbitCamera(dx: number, dy: number): void {
    this.camYaw -= dx * 0.005;
    this.camPitch = Math.max(0.05, Math.min(Math.PI / 2.05, this.camPitch + dy * 0.005));
  }

  panCamera(dx: number, dy: number): void {
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const scale = this.camDist * 0.0015;
    this.camFocus.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
  }

  zoomCamera(factor: number, clientX?: number, clientY?: number): void {
    if (factor < 1 && clientX !== undefined && clientY !== undefined) {
      const pointer = new THREE.Vector2(
        (clientX / window.innerWidth) * 2 - 1,
        -(clientY / window.innerHeight) * 2 + 1,
      );
      this.raycaster.setFromCamera(pointer, this.camera);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
        this.camera.getWorldDirection(new THREE.Vector3()),
        this.camFocus,
      );
      const point = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
      if (point) this.camFocus.lerp(point, 0.12);
    }
    this.camDist = Math.max(3, Math.min(2.5e5, this.camDist * factor));
    this.predictionDirty = true;
  }

  resetCamera(): void {
    this.camYaw = 0.8;
    this.camPitch = 0.65;
    this.camDist = 400;
    this.camFocus.set(0, 0, 0);
    this.predictionDirty = true;
  }

  /** Begin direct node/conic interaction. Returns true when a map control captured the pointer. */
  beginPointer(clientX: number, clientY: number): boolean {
    if (!this.visible || !this.currentElements || !this.gameRef) return false;
    const pointer = new THREE.Vector2(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    this.raycaster.params.Line = { threshold: Math.max(0.08, this.camDist * 0.0015) };
    for (const [axis, handle] of this.nodeHandles) {
      if (handle.visible && this.raycaster.intersectObject(handle, false).length) {
        this.dragControl = axis;
        return true;
      }
    }
    for (const [marker, event] of this.markerEvents) {
      if (marker.visible && this.raycaster.intersectObject(marker, false).length) {
        this.showMarkerCard(event, clientX, clientY);
        return true;
      }
    }
    if (this.nodeMarker.visible && this.raycaster.intersectObject(this.nodeMarker, false).length) {
      this.dragControl = 'time';
      return true;
    }
    const conicHit = this.raycaster.intersectObject(this.vesselLine, false)[0];
    if (conicHit) {
      this.placeNodeAtMapPoint(conicHit.point);
      this.dragControl = 'time';
      return true;
    }
    for (const [bodyId, mesh] of this.bodyMeshes) {
      if (mesh.visible && this.raycaster.intersectObject(mesh, false).length) {
        this.showBodyCard(bodyId, clientX, clientY);
        return true;
      }
    }
    return false;
  }

  private showBodyCard(bodyId: string, clientX: number, clientY: number): void {
    this.bodyCard?.remove();
    const body = this.gameRef?.universe.get(bodyId);
    if (!body) return;
    const card = el('div', 'map-body-card', this.uiRoot);
    this.bodyCard = card;
    card.style.left = `${Math.min(window.innerWidth - 210, clientX + 10)}px`;
    card.style.top = `${Math.min(window.innerHeight - 130, clientY + 10)}px`;
    el('strong', '', card, body.name);
    el('span', '', card, `${body.def.surfaceKind} · ${(body.radius / 1000).toFixed(0)} km radius`);
    const actions = el('div', 'map-row', card);
    const focus = el('button', 'hud-btn', actions, 'Focus');
    focus.onclick = () => this.focusBody(bodyId);
    const targeted = this.gameRef?.active?.target === bodyId;
    const target = el('button', 'hud-btn', actions, targeted ? 'Clear target' : 'Set target');
    target.onclick = () => {
      this.cb.onSetTarget(targeted ? null : bodyId);
      card.remove();
      this.bodyCard = null;
    };
    const close = el('button', 'k-window-btn', card, '×');
    close.onclick = () => {
      card.remove();
      this.bodyCard = null;
    };
  }

  private showMarkerCard(
    event: { label: string; time: number },
    clientX: number,
    clientY: number,
  ): void {
    this.bodyCard?.remove();
    const card = el('div', 'map-body-card', this.uiRoot);
    this.bodyCard = card;
    card.style.left = `${Math.min(window.innerWidth - 210, clientX + 10)}px`;
    card.style.top = `${Math.min(window.innerHeight - 130, clientY + 10)}px`;
    el('strong', '', card, event.label);
    el('span', '', card, `T−${Math.max(0, event.time - (this.gameRef?.time ?? 0)).toFixed(0)} s`);
    const actions = el('div', 'map-row', card);
    const warp = el('button', 'hud-btn', actions, 'Warp −30s');
    warp.onclick = () => this.cb.onWarpToTime(event.time, 30);
    const alarm = el('button', 'hud-btn', actions, 'Alarm');
    alarm.onclick = () => this.cb.onCreateAlarm(event.time, event.label, 'custom');
    const close = el('button', 'k-window-btn', card, '×');
    close.onclick = () => {
      card.remove();
      this.bodyCard = null;
    };
  }

  dragPointer(dx: number, dy: number): boolean {
    if (!this.dragControl || !this.node) return false;
    if (this.dragControl === 'time') {
      const period = this.currentElements ? periodOf(this.currentElements) : 600;
      const secondsPerPixel = Number.isFinite(period) ? period / Math.max(400, window.innerWidth) : 5;
      this.node.time = Math.max((this.gameRef?.time ?? 0) + 1, this.node.time + dx * secondsPerPixel);
    } else {
      this.node[this.dragControl] += -dy * this.nodeStep * 0.2;
    }
    this.predictionDirty = true;
    this.syncNodeInputs();
    return true;
  }

  endPointer(): void {
    this.dragControl = null;
  }

  private placeNodeAtMapPoint(point: THREE.Vector3): void {
    if (!this.currentElements || !this.gameRef) return;
    const positions = this.vesselLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    let nearestIndex = 0;
    let nearestDistance = Infinity;
    for (let index = 0; index < positions.count; index++) {
      const distance = point.distanceToSquared(new THREE.Vector3(
        positions.getX(index), positions.getY(index), positions.getZ(index),
      ));
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = index;
      }
    }
    const fraction = nearestIndex / Math.max(1, positions.count - 1);
    const elements = this.currentElements;
    const trueAnomaly = elements.e < 1
      ? fraction * TWO_PI
      : -Math.acos(-1 / elements.e) * 0.96 + fraction * Math.acos(-1 / elements.e) * 1.92;
    const eta = timeToTrueAnomaly(elements, this.gameRef.time, trueAnomaly);
    this.node = {
      time: this.gameRef.time + Math.max(1, eta),
      prograde: 0,
      normal: 0,
      radial: 0,
    };
    this.predictionDirty = true;
    this.refreshNodePanel();
  }

  createNode(inSeconds: number): void {
    this.nodeTimeBase = null;
    const t = this.gameRef?.time ?? 0;
    this.node = { time: t + inSeconds, prograde: 0, normal: 0, radial: 0 };
    this.predictionDirty = true;
    this.refreshNodePanel();
  }

  setNode(node: ManeuverNode): void {
    this.node = { ...node };
    this.nodeTimeBase = null;
    this.predictionDirty = true;
    this.refreshNodePanel();
  }

  private nodeTimeBase: number | null = null;
  private gameRef: GameState | null = null;

  private refreshNodePanel(): void {
    this.nodePanel.innerHTML = '';
    this.nodeInputs.clear();
    if (!this.node) {
      el('div', 'map-readout', this.nodePanel, 'no node planned');
      this.dvReadout.textContent = '';
      this.etaReadout.textContent = '';
      this.encounterInfo.textContent = '';
      this.postReadout.textContent = '';
      this.budgetReadout.textContent = '';
      return;
    }
    const stepRow = el('div', 'map-step-row', this.nodePanel);
    el('span', 'map-step-label', stepRow, 'Δv step');
    for (const step of [0.1, 1, 10, 100]) {
      const button = el('button', 'hud-btn', stepRow, String(step));
      button.classList.toggle('active', step === this.nodeStep);
      button.onclick = () => {
        this.nodeStep = step;
        this.refreshNodePanel();
      };
    }
    const axes: Array<{ key: 'prograde' | 'normal' | 'radial' | 'time'; label: string }> = [
      { key: 'prograde', label: 'Prograde' },
      { key: 'normal', label: 'Normal' },
      { key: 'radial', label: 'Radial' },
      { key: 'time', label: 'Node ETA' },
    ];
    for (const ax of axes) {
      const row = el('div', 'map-axis', this.nodePanel);
      el('label', '', row, ax.label);
      const minus = el('button', 'hud-btn', row, '−') as HTMLButtonElement;
      const input = el('input', 'map-number', row) as HTMLInputElement;
      const plus = el('button', 'hud-btn', row, '+') as HTMLButtonElement;
      input.type = 'number';
      input.step = String(ax.key === 'time' ? 10 : this.nodeStep);
      this.nodeInputs.set(ax.key, input);
      const apply = (delta: number) => {
        if (!this.node) return;
        if (ax.key === 'time') this.node.time += delta;
        else this.node[ax.key] += delta;
        this.predictionDirty = true;
        this.syncNodeInputs();
      };
      const step = ax.key === 'time' ? 10 : this.nodeStep;
      minus.onclick = () => apply(-step);
      plus.onclick = () => apply(step);
      input.onchange = () => {
        if (!this.node) return;
        const value = Number(input.value);
        if (!Number.isFinite(value)) return this.syncNodeInputs();
        if (ax.key === 'time') this.node.time = (this.gameRef?.time ?? 0) + Math.max(1, value);
        else this.node[ax.key] = value;
        this.predictionDirty = true;
        this.syncNodeInputs();
      };
    }
    const snapRow = el('div', 'map-snap-row', this.nodePanel);
    el('span', 'map-step-label', snapRow, 'Snap');
    for (const [kind, label] of [
      ['ap', 'Ap'], ['pe', 'Pe'], ['an', 'AN'], ['dn', 'DN'], ['soi', 'SOI'],
    ] as const) {
      const button = el('button', 'hud-btn', snapRow, label);
      button.onclick = () => this.snapNode(kind);
    }
    this.syncNodeInputs();
  }

  private syncNodeInputs(): void {
    if (!this.node) return;
    for (const [key, input] of this.nodeInputs) {
      if (document.activeElement === input) continue;
      const value = key === 'time' ? this.node.time - (this.gameRef?.time ?? 0) : this.node[key];
      input.value = value.toFixed(key === 'time' ? 0 : 1);
    }
  }

  private snapNode(kind: 'ap' | 'pe' | 'an' | 'dn' | 'soi'): void {
    if (!this.node || !this.currentElements || !this.gameRef) return;
    const elements = this.currentElements;
    const now = this.gameRef.time;
    let eta: number | null = null;
    if (kind === 'ap' && elements.e < 1) eta = timeToTrueAnomaly(elements, now, Math.PI);
    else if (kind === 'pe') eta = timeToTrueAnomaly(elements, now, 0);
    else if (kind === 'an') eta = timeToTrueAnomaly(elements, now, -elements.argPe);
    else if (kind === 'dn') eta = timeToTrueAnomaly(elements, now, Math.PI - elements.argPe);
    else if (kind === 'soi') {
      eta = this.prediction?.encounter
        ? this.prediction.encounter.entryTime - now
        : this.prediction?.escape
          ? this.prediction.escape.exitTime - now
          : null;
    }
    if (eta === null || !Number.isFinite(eta)) return;
    this.node.time = now + Math.max(1, eta);
    this.predictionDirty = true;
    this.syncNodeInputs();
  }

  private apsisTime(kind: 'ap' | 'pe'): number | null {
    if (!this.currentElements || !this.gameRef) return null;
    if (kind === 'ap' && this.currentElements.e >= 1) return null;
    const eta = timeToTrueAnomaly(this.currentElements, this.gameRef.time, kind === 'ap' ? Math.PI : 0);
    return Number.isFinite(eta) ? this.gameRef.time + Math.max(1, eta) : null;
  }

  /** Per-frame update. */
  update(game: GameState): void {
    this.gameRef = game;
    const gv = game.active;
    if (!gv) return;
    const v = gv.runtime;
    const body = game.bodyOf(gv);
    if (!game.universe.bodies.has(this.focusBodyId)) this.focusBodyId = body.id;
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
    this.camera.position.set(cx * this.camDist, cy * this.camDist, cz * this.camDist).add(this.camFocus);
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(this.camFocus);

    // Bodies in the active body's frame; camera focus may move among them.
    const shown = new Set<string>();
    const place = (b: Body, pos: Vec3) => {
      shown.add(b.id);
      let mesh = this.bodyMeshes.get(b.id);
      const pack = this.cb.getBodyAssetPack?.(b.id) ?? null;
      const quality = this.cb.getQualityTier?.() ?? pack?.tier ?? 'medium';
      if (!mesh || mesh.userData.assetPack !== pack || mesh.userData.quality !== quality) {
        if (mesh) {
          this.scene.remove(mesh);
          mesh.geometry.dispose();
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const material of materials) material.dispose();
        }
        mesh = compactBodyMesh(bodyMaterialDescriptor(b), pack, this.cb.maxAnisotropy ?? 1, quality);
        this.bodyMeshes.set(b.id, mesh);
        this.scene.add(mesh);
      }
      mesh.scale.setScalar(Math.max(b.radius * SCALE, this.camDist * 0.008));
      mesh.position.set(pos.x * SCALE, pos.y * SCALE, pos.z * SCALE);
      updateCompactBodyOrientation(mesh, b, t);
      const bodyMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of bodyMaterials) {
        updateTerrestrialCloudLighting(material, starDirection, t * WEATHER_CLOUD_DRIFT_RATE);
      }
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
    const candidatePos = new Vec3();
    const parentOffset = new Vec3();
    for (const candidate of game.universe.bodies.values()) {
      if (candidate === body) continue;
      game.universe.relativePosition(candidate, body, t, candidatePos);
      place(candidate, candidatePos);
      if (!candidate.orbit || !candidate.parent) continue;
      let line = this.bodyOrbits.get(candidate.id);
      if (!line) {
        line = orbitLine('#4a6072');
        this.bodyOrbits.set(candidate.id, line);
        this.scene.add(line);
      }
      game.universe.relativePosition(candidate.parent, body, t, parentOffset);
      fillConic(line, candidate.orbit, parentOffset);
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
    const focusMesh = this.bodyMeshes.get(this.focusBodyId);
    if (focusMesh?.visible) this.desiredFocus.copy(focusMesh.position);
    else this.desiredFocus.set(0, 0, 0);
    this.camFocus.lerp(this.desiredFocus, 0.12);

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
    this.currentElements = els;
    fillConic(this.vesselLine, els, null);
    this.vesselMarker.position.set(v.pos.x * SCALE, v.pos.y * SCALE, v.pos.z * SCALE);
    const markerScale = this.camDist * 0.014;
    this.vesselMarker.scale.setScalar(markerScale);
    this.nodeMarker.scale.setScalar(markerScale * 0.8);
    this.encounterMarker.scale.setScalar(markerScale * 0.8);
    this.entryMarker.scale.setScalar(markerScale * 0.8);
    this.landingTargetMarker.scale.setScalar(markerScale * 0.8);
    this.updateOrbitMarkers(els, gv.target, game, markerScale);
    this.markerEvents.clear();
    const apTime = this.apsisTime('ap');
    const peTime = this.apsisTime('pe');
    if (apTime !== null) this.markerEvents.set(this.orbitMarkers.get('ap')!, { label: 'Apoapsis', time: apTime });
    if (peTime !== null) this.markerEvents.set(this.orbitMarkers.get('pe')!, { label: 'Periapsis', time: peTime });
    if (this.node) this.markerEvents.set(this.nodeMarker, { label: 'Maneuver node', time: this.node.time });
    if (this.prediction?.encounter) {
      this.markerEvents.set(this.encounterMarker, { label: `${this.prediction.encounter.bodyId} SOI entry`, time: this.prediction.encounter.entryTime });
    } else if (this.prediction?.escape) {
      this.markerEvents.set(this.encounterMarker, { label: `${body.name} SOI exit`, time: this.prediction.escape.exitTime });
    }

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
        const radial = nr.clone().normalize();
        const normal = Vec3.cross(nr, nv, new Vec3()).normalize();
        const prograde = nv.clone().normalize();
        const offset = markerScale * 2.4;
        for (const [axis, direction] of [
          ['prograde', prograde], ['normal', normal], ['radial', radial],
        ] as const) {
          const handle = this.nodeHandles.get(axis)!;
          handle.position.copy(this.nodeMarker.position).add(
            new THREE.Vector3(direction.x, direction.y, direction.z).multiplyScalar(offset),
          );
          handle.scale.setScalar(markerScale * 0.65);
          handle.visible = true;
        }
      } else {
        this.prediction = predictTrajectory(game.universe, body, els, t);
        this.nodeLine.visible = false;
        this.nodeMarker.visible = false;
        for (const handle of this.nodeHandles.values()) handle.visible = false;
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
      } else if (this.prediction?.escape) {
        this.encounterLine.visible = false;
        const exitPosition = new Vec3();
        const exitVelocity = new Vec3();
        elementsAtTime(this.prediction.elements, this.prediction.escape.exitTime, exitPosition, exitVelocity);
        this.encounterMarker.position.set(exitPosition.x * SCALE, exitPosition.y * SCALE, exitPosition.z * SCALE);
        this.encounterMarker.visible = true;
        this.encounterInfo.textContent =
          `escapes ${body.name} SOI in ${((this.prediction.escape.exitTime - t) / 60).toFixed(0)} min`;
      } else {
        this.encounterLine.visible = false;
        this.encounterMarker.visible = false;
        this.encounterInfo.textContent = '';
      }
    }

    if (this.node) {
      this.dvReadout.textContent = `Δv ${nodeDeltaV(this.node).toFixed(1)} m/s`;
      this.etaReadout.textContent = `burn in ${(this.node.time - t).toFixed(0)} s`;
      const after = orbitAfterNode(els, this.node);
      const postApoapsis = after.e < 1 ? `${((apoapsisOf(after) - body.radius) / 1000).toFixed(1)} km` : 'escape';
      const postPeriapsis = `${((periapsisOf(after) - body.radius) / 1000).toFixed(1)} km`;
      const postPeriod = periodOf(after);
      this.postReadout.textContent =
        `ORBIT AFTER  Ap ${postApoapsis}  ·  Pe ${postPeriapsis}\n` +
        `Inc ${(after.i * 180 / Math.PI).toFixed(2)}°  ·  Period ${Number.isFinite(postPeriod) ? `${(postPeriod / 60).toFixed(1)} min` : '—'}`;
      const analysis = analyzeCraft(v.craft, body.surfaceGravity, body.pressureAt(v.pos.length() - body.radius));
      const available = analysis.stages
        .filter((stage) => stage.stageIndex >= v.currentStage)
        .reduce((sum, stage) => sum + stage.deltaV, 0);
      const required = nodeDeltaV(this.node);
      this.budgetReadout.textContent = `VESSEL Δv ${available.toFixed(0)} m/s  ·  margin ${(available - required).toFixed(0)} m/s`;
      this.budgetReadout.classList.toggle('warning', required > available);
      this.syncNodeInputs();
    } else {
      this.postReadout.textContent = '';
      this.budgetReadout.textContent = '';
    }
    this.updateEntryPrediction(game, body, els, markerScale);
  }

  private updateOrbitMarkers(
    elements: OrbitalElements,
    targetBodyId: string | null,
    game: GameState,
    markerScale: number,
  ): void {
    const position = new Vec3();
    const velocity = new Vec3();
    const placeAtAnomaly = (kind: 'ap' | 'pe', anomaly: number) => {
      elementsToStateSafe(elements, anomaly, position, velocity);
      const marker = this.orbitMarkers.get(kind)!;
      marker.position.set(position.x * SCALE, position.y * SCALE, position.z * SCALE);
      marker.scale.setScalar(markerScale * 0.68);
      marker.visible = kind === 'pe' || elements.e < 1;
    };
    placeAtAnomaly('ap', Math.PI);
    placeAtAnomaly('pe', 0);

    const an = this.orbitMarkers.get('an')!;
    const dn = this.orbitMarkers.get('dn')!;
    if (!targetBodyId) {
      an.visible = false;
      dn.visible = false;
      return;
    }
    const target = game.universe.get(targetBodyId);
    const targetR = new Vec3();
    const targetV = new Vec3();
    if (target.orbit) game.universe.localPosition(target, game.time, targetR, targetV);
    const targetNormal = target.orbit
      ? Vec3.cross(targetR, targetV, new Vec3()).normalize()
      : new Vec3(0, 0, 1);
    const vesselR = new Vec3();
    const vesselV = new Vec3();
    elementsAtTime(elements, game.time, vesselR, vesselV);
    const vesselNormal = Vec3.cross(vesselR, vesselV, new Vec3()).normalize();
    const nodeDirection = Vec3.cross(targetNormal, vesselNormal, new Vec3());
    if (nodeDirection.lengthSq() < 1e-8) {
      an.visible = false;
      dn.visible = false;
      return;
    }
    nodeDirection.normalize();
    const vertices = this.vesselLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    const closest = (direction: Readonly<Vec3>): THREE.Vector3 => {
      let best = new THREE.Vector3();
      let bestDot = -Infinity;
      for (let index = 0; index < vertices.count; index++) {
        const candidate = new THREE.Vector3(vertices.getX(index), vertices.getY(index), vertices.getZ(index));
        const dot = candidate.clone().normalize().dot(direction);
        if (dot > bestDot) {
          bestDot = dot;
          best = candidate;
        }
      }
      return best;
    };
    an.position.copy(closest(nodeDirection));
    dn.position.copy(closest(nodeDirection.clone().negate()));
    an.scale.setScalar(markerScale * 0.68);
    dn.scale.setScalar(markerScale * 0.68);
    an.visible = true;
    dn.visible = true;
  }

  private updateEntryPrediction(
    game: GameState,
    body: Body,
    elements: OrbitalElements,
    markerScale: number,
  ): void {
    const gv = game.active!;
    const v = gv.runtime;
    const signature = [
      body.id,
      elements.a.toFixed(0),
      elements.e.toFixed(5),
      elements.i.toFixed(4),
      Math.floor(game.time / 10),
      this.node ? `${this.node.time.toFixed(0)}:${this.node.prograde.toFixed(1)}:${this.node.normal.toFixed(1)}:${this.node.radial.toFixed(1)}` : 'none',
      v.massProps.mass.toFixed(0),
    ].join(':');
    const now = performance.now();
    if (signature !== this.entrySignature && now - this.lastEntryPredictionAt >= 750) {
      this.entrySignature = signature;
      this.lastEntryPredictionAt = now;
      let startPosition = v.pos;
      let startVelocity = v.vel;
      let startTime = game.time;
      if (this.node) {
        const postNode = orbitAfterNode(elements, this.node);
        const nodePosition = new Vec3();
        const nodeVelocity = new Vec3();
        elementsAtTime(postNode, this.node.time, nodePosition, nodeVelocity);
        startPosition = nodePosition;
        startVelocity = nodeVelocity;
        startTime = this.node.time;
      }
      this.entryPrediction = predictEntry(
        body,
        v.aeroModel,
        v.massProps.mass,
        startPosition,
        startVelocity,
        startTime,
      );
      fillEntryPath(this.entryLine, this.entryPrediction.samples);
    }
    const prediction = this.entryPrediction;
    this.entryLine.visible = !!prediction?.willEnter;
    if (prediction?.willEnter && prediction.samples.length) {
      const end = prediction.samples[prediction.samples.length - 1];
      this.entryMarker.position.set(end.x * SCALE, end.y * SCALE, end.z * SCALE);
      this.entryMarker.scale.setScalar(markerScale * 0.8);
      this.entryMarker.visible = true;
      if (prediction.landingTime > game.time) {
        this.markerEvents.set(this.entryMarker, { label: 'Predicted landing', time: prediction.landingTime });
      }
      this.entryInfo.textContent = prediction.lands
        ? `ENTRY CORRIDOR · landing T−${((prediction.landingTime - game.time) / 60).toFixed(1)} min`
        : 'ENTRY CORRIDOR · skip-out / no surface intercept';
    } else {
      this.entryMarker.visible = false;
      this.entryInfo.textContent = '';
    }
    if (this.landingTargetDirBF) {
      const targetInertial = bodyFixedToInertial(body, game.time, this.landingTargetDirBF, new Vec3());
      const radius = body.radius * 1.02 * SCALE;
      this.landingTargetMarker.position.set(
        targetInertial.x * radius,
        targetInertial.y * radius,
        targetInertial.z * radius,
      );
      this.landingTargetMarker.visible = true;
    } else {
      this.landingTargetMarker.visible = false;
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
