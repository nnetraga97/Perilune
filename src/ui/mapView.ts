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
  predictTrajectory,
  TrajectoryPrediction,
} from '../sim/maneuver';
import {
  projectedOrbitAfterRemainingBurn,
  type ManeuverPlan,
} from '../sim/maneuverPlan';
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
import { createAirlessGlobalMaterial } from '../render/airless/globalMaterial';
import { WEATHER_CLOUD_DRIFT_RATE } from '../render/terrestrial/cloudLayer';
import { createGlobalSphereGeometry } from '../render/terrestrial/globalGeometry';
import type { QualityTier, RuntimeBodyAssetPack } from '../render/bodyRenderer';
import { el, injectUiStyles } from './kit';
import { analyzeCraft } from '../sim/vessel';
import type { AlarmKind } from '../sim/state';
import { predictEntry, type EntryPrediction } from '../sim/entry';
import { pickOrbitSegment, type OrbitPick, type ScreenOrbitPoint } from './orbitPicking';

const SCALE = 1e-5;
const _mapOrientation = new Quat();

type NodeAxis = 'prograde' | 'normal' | 'radial';
type NodeHandleKind = 'prograde' | 'retrograde' | 'normal' | 'antinormal' | 'radial-out' | 'radial-in';

interface NodeHandle {
  axis: NodeAxis;
  sign: 1 | -1;
  label: string;
  sprite: THREE.Sprite;
}

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
      : pack && descriptor.renderer !== 'terrestrial'
        ? createAirlessGlobalMaterial(pack, maxAnisotropy)
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
  line.geometry.setDrawRange(0, attr.count);
  (line as THREE.Line & { computeLineDistances(): void }).computeLineDistances?.();
}

/** Fill a chronological conic patch between two absolute simulation times. */
function fillConicTimeRange(
  line: THREE.Line,
  elements: OrbitalElements,
  startTime: number,
  endTime: number,
  offset: Vec3 | null = null,
): void {
  const attribute = line.geometry.getAttribute('position') as THREE.BufferAttribute;
  const count = attribute.count;
  const position = new Vec3();
  const velocity = new Vec3();
  const duration = Math.max(1, endTime - startTime);
  for (let index = 0; index < count; index++) {
    const time = startTime + duration * index / Math.max(1, count - 1);
    elementsAtTime(elements, time, position, velocity);
    attribute.setXYZ(
      index,
      (position.x + (offset?.x ?? 0)) * SCALE,
      (position.y + (offset?.y ?? 0)) * SCALE,
      (position.z + (offset?.z ?? 0)) * SCALE,
    );
  }
  attribute.needsUpdate = true;
  line.geometry.setDrawRange(0, count);
  (line as THREE.Line & { computeLineDistances(): void }).computeLineDistances?.();
}

function elementsToStateSafe(el: OrbitalElements, nu: number, outR: Vec3, outV: Vec3): void {
  elementsToState(el, nu, outR, outV);
  if (!outR.isFinite()) outR.set(0, 0, 0);
}

export interface MapCallbacks {
  getManeuverPlan(): Readonly<ManeuverPlan> | null;
  onCreateManeuverNode(node: ManeuverNode): void;
  onUpdateManeuverNode(node: ManeuverNode): void;
  onDeleteManeuverNode(): void;
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
  private currentArcLine = orbitLine('#a9ebff');
  private nodeLine = orbitLine('#e8c76b', true);
  private completionLine = orbitLine('#fff0a8', true);
  private encounterLine = orbitLine('#c88be8', true);
  private entryLine = entryPathLine();
  private vesselMarker: THREE.Sprite;
  private nodeMarker: THREE.Sprite;
  private orbitHoverMarker: THREE.Sprite;
  private nodeHandles = new Map<NodeHandleKind, NodeHandle>();
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

  private prediction: TrajectoryPrediction | null = null;
  private predictionDirty = true;
  private lastElSig = '';
  private lastRenderedPlanRevision = -1;
  private lastPredictionRefreshAt = -Infinity;

  private panel: HTMLElement;
  private nodePanel: HTMLElement;
  private encounterInfo: HTMLElement;
  private entryInfo: HTMLElement;
  private dvReadout: HTMLElement;
  private etaReadout: HTMLElement;
  private postReadout: HTMLElement;
  private budgetReadout: HTMLElement;
  private cb: MapCallbacks;
  private focusBodyId = '';
  private followsActiveVessel = true;
  private desiredFocus = new THREE.Vector3();
  private bodyCard: HTMLElement | null = null;
  private markerEvents = new Map<THREE.Object3D, { label: string; time: number }>();
  private nodeStep = 1;
  private nodeInputs = new Map<'prograde' | 'normal' | 'radial' | 'time', HTMLInputElement>();
  private lastPanelPhase: ManeuverPlan['phase'] | null = null;
  private currentElements: OrbitalElements | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private dragControl: NodeAxis | 'time' | 'pending-orbit' | null = null;
  private dragHandleSign: 1 | -1 = 1;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragDistance = 0;
  private dragStartNode: ManeuverNode | null = null;
  private dragAxisScreen = new THREE.Vector2(0, -1);
  private pendingOrbitFraction: number | null = null;
  private orbitHover: OrbitPick | null = null;
  private orbitPointerCoarse = false;
  private orbitScreenPoints: ScreenOrbitPoint[] = Array.from({ length: 256 }, () => ({
    x: 0,
    y: 0,
    depth: 0,
    visible: false,
  }));
  private orbitHoverLabel: HTMLElement;
  private handleHoverLabel: HTMLElement;
  private readonly projectedPoint = new THREE.Vector3();
  entryPrediction: EntryPrediction | null = null;
  landingTargetDirBF: Vec3 | null = null;
  private entrySignature = '';
  private lastEntryPredictionAt = -Infinity;

  get node(): ManeuverNode | null {
    return this.cb.getManeuverPlan()?.node ?? null;
  }

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
    this.scene.add(
      this.vesselLine,
      this.currentArcLine,
      this.nodeLine,
      this.completionLine,
      this.encounterLine,
      this.entryLine,
    );
    (this.vesselLine.material as THREE.LineBasicMaterial).opacity = 0.32;

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
    const mkArrowSprite = (color: string) => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 48;
      const context = canvas.getContext('2d')!;
      context.strokeStyle = '#f4fbff';
      context.fillStyle = color;
      context.lineWidth = 2.5;
      context.lineJoin = 'round';
      context.beginPath();
      context.moveTo(24, 4);
      context.lineTo(41, 31);
      context.lineTo(30, 28);
      context.lineTo(30, 43);
      context.lineTo(18, 43);
      context.lineTo(18, 28);
      context.lineTo(7, 31);
      context.closePath();
      context.fill();
      context.stroke();
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(canvas),
        depthTest: false,
        transparent: true,
      }));
      sprite.renderOrder = 12;
      sprite.visible = false;
      return sprite;
    };
    this.vesselMarker = mkSprite('#7fd0e8', 5);
    this.nodeMarker = mkSprite('#e8c76b', 4);
    this.orbitHoverMarker = mkSprite('#dff8ff', 3.5, '+');
    this.orbitHoverMarker.visible = false;
    this.encounterMarker = mkSprite('#c88be8', 4);
    this.entryMarker = mkSprite('#e27a4f', 4, 'E');
    this.landingTargetMarker = mkSprite('#ef7dc2', 4, 'T');
    this.scene.add(
      this.vesselMarker,
      this.nodeMarker,
      this.orbitHoverMarker,
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
    for (const [kind, axis, sign, label, color] of [
      ['prograde', 'prograde', 1, 'Prograde', '#70d58c'],
      ['retrograde', 'prograde', -1, 'Retrograde', '#70d58c'],
      ['normal', 'normal', 1, 'Normal', '#b98ce8'],
      ['antinormal', 'normal', -1, 'Anti-normal', '#b98ce8'],
      ['radial-out', 'radial', 1, 'Radial out', '#6baee8'],
      ['radial-in', 'radial', -1, 'Radial in', '#6baee8'],
    ] as const) {
      const sprite = mkArrowSprite(color);
      this.nodeHandles.set(kind, { axis, sign, label, sprite });
      this.scene.add(sprite);
    }
    this.mkDepositSprite = () => mkSprite('#e2b13c', 3);

    this.orbitHoverLabel = el('div', 'map-orbit-hover', uiRoot);
    this.orbitHoverLabel.hidden = true;
    this.handleHoverLabel = el('div', 'map-handle-hover', uiRoot);
    this.handleHoverLabel.hidden = true;

    // ---- DOM panel
    this.panel = el('div', 'map-panel', uiRoot);
    injectUiStyles();
    el('div', 'map-title', this.panel, 'MANEUVER PLANNER');
    const btnRow = el('div', 'map-row', this.panel);
    const addBtn = el('button', 'hud-btn', btnRow, '+ Node in 2 min') as HTMLButtonElement;
    addBtn.onclick = () => this.createNode(120);
    const delBtn = el('button', 'hud-btn', btnRow, 'Delete') as HTMLButtonElement;
    delBtn.onclick = () => {
      cb.onDeleteManeuverNode();
      this.predictionDirty = true;
      this.refreshNodePanel();
    };
    const warpBtn = el('button', 'hud-btn', btnRow, 'Warp → node') as HTMLButtonElement;
    warpBtn.onclick = () => {
      if (this.node) cb.onWarpToNode(this.node);
    };
    const alarmBtn = el('button', 'hud-btn', btnRow, 'Alarm') as HTMLButtonElement;
    alarmBtn.onclick = () => {
      const alarmTime = this.node?.time;
      if (alarmTime !== undefined && alarmTime > (this.gameRef?.time ?? 0)) {
        cb.onCreateAlarm(alarmTime, 'Maneuver node', 'maneuver');
      }
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
    if (!vis) {
      this.orbitHoverMarker.visible = false;
      this.orbitHoverLabel.hidden = true;
      this.handleHoverLabel.hidden = true;
      this.cancelPointer();
    }
  }

  focusBody(bodyId: string): void {
    this.followsActiveVessel = false;
    this.focusBodyId = bodyId;
    const mesh = this.bodyMeshes.get(bodyId);
    if (mesh) this.desiredFocus.copy(mesh.position);
  }

  /** Return map focus to the celestial body currently carrying the active vessel. */
  focusActiveVessel(game: GameState): void {
    this.followsActiveVessel = true;
    const active = game.active;
    if (!active) return;
    this.focusBodyId = game.bodyOf(active).id;
    // The map coordinate frame is centered on the active vessel's SOI body.
    // Reset immediately so stale mesh positions from the previous vessel cannot
    // leave the newly opened map drifting across interplanetary distances.
    this.desiredFocus.set(0, 0, 0);
    this.camFocus.set(0, 0, 0);
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

  /** Update hover affordances using a stable pixel-space orbit hit band. */
  updatePointer(clientX: number, clientY: number, pointerType = 'mouse'): void {
    if (!this.visible) return;
    this.orbitPointerCoarse = pointerType !== 'mouse';
    const handle = this.pickNodeHandle(clientX, clientY);
    this.handleHoverLabel.hidden = !handle;
    if (handle) {
      this.handleHoverLabel.textContent = `${handle.label} · drag or click ${this.nodeStep} m/s`;
      this.handleHoverLabel.style.left = `${Math.min(window.innerWidth - 190, clientX + 14)}px`;
      this.handleHoverLabel.style.top = `${Math.max(8, clientY - 28)}px`;
    }

    const hitRadius = this.orbitPointerCoarse ? 24 : 12;
    this.orbitHover = handle ? null : pickOrbitSegment(this.orbitScreenPoints, clientX, clientY, hitRadius);
    const hoveringOrbit = !!this.orbitHover && !this.dragControl;
    this.orbitHoverMarker.visible = hoveringOrbit;
    this.orbitHoverLabel.hidden = !hoveringOrbit;
    const material = this.vesselLine.material as THREE.LineBasicMaterial;
    material.opacity = hoveringOrbit ? 0.72 : (this.node ? 0.32 : 0.85);
    if (hoveringOrbit && this.orbitHover) {
      this.positionAtOrbitPick(this.orbitHover, this.orbitHoverMarker.position);
      this.orbitHoverMarker.scale.setScalar(this.camDist * 0.011);
      const eta = this.timeAtOrbitFraction(this.orbitHover.fraction) - (this.gameRef?.time ?? 0);
      this.orbitHoverLabel.textContent = `${this.node ? 'MOVE MANEUVER' : 'ADD MANEUVER'} · T−${Math.max(1, eta).toFixed(0)}s`;
      this.orbitHoverLabel.style.left = `${Math.min(window.innerWidth - 190, clientX + 14)}px`;
      this.orbitHoverLabel.style.top = `${Math.max(8, clientY - 34)}px`;
    }
  }

  /** Begin direct node/conic interaction. Returns true when a map control captured the pointer. */
  beginPointer(clientX: number, clientY: number, pointerType = 'mouse'): boolean {
    if (!this.visible || !this.currentElements || !this.gameRef) return false;
    this.updatePointer(clientX, clientY, pointerType);
    this.dragStartX = clientX;
    this.dragStartY = clientY;
    this.dragDistance = 0;
    this.dragStartNode = this.node ? { ...this.node } : null;

    const handle = this.pickNodeHandle(clientX, clientY);
    if (handle && this.dragStartNode) {
      this.dragControl = handle.axis;
      this.dragHandleSign = handle.sign;
      const nodeScreen = this.projectObject(this.nodeMarker);
      const handleScreen = this.projectObject(handle.sprite);
      this.dragAxisScreen.set(handleScreen.x - nodeScreen.x, handleScreen.y - nodeScreen.y);
      if (this.dragAxisScreen.lengthSq() < 1e-6) this.dragAxisScreen.set(0, -1);
      else this.dragAxisScreen.normalize();
      return true;
    }

    if (this.nodeMarker.visible && this.screenDistanceTo(this.nodeMarker, clientX, clientY) <= (this.orbitPointerCoarse ? 24 : 18)) {
      this.dragControl = 'time';
      return true;
    }
    if (this.orbitHover) {
      this.pendingOrbitFraction = this.orbitHover.fraction;
      this.dragControl = 'pending-orbit';
      return true;
    }
    for (const [marker, event] of this.markerEvents) {
      if (marker !== this.nodeMarker && marker.visible && this.screenDistanceTo(marker, clientX, clientY) <= 18) {
        this.showMarkerCard(event, clientX, clientY);
        return true;
      }
    }

    const pointer = new THREE.Vector2(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
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

  dragPointer(clientX: number, clientY: number, shiftKey = false): boolean {
    if (!this.dragControl) return false;
    const dx = clientX - this.dragStartX;
    const dy = clientY - this.dragStartY;
    this.dragDistance = Math.hypot(dx, dy);
    if (this.dragControl === 'pending-orbit') return true;
    if (!this.dragStartNode || !this.node) return false;

    if (this.dragControl === 'time') {
      const pick = pickOrbitSegment(this.orbitScreenPoints, clientX, clientY, this.orbitPointerCoarse ? 96 : 72);
      if (pick) this.commitNode({ ...this.node, time: this.timeAtOrbitFraction(pick.fraction) });
    } else {
      const projectedPixels = dx * this.dragAxisScreen.x + dy * this.dragAxisScreen.y;
      const sensitivity = this.nodeStep * 0.08 * (shiftKey ? 0.1 : 1);
      this.commitNode({
        ...this.node,
        [this.dragControl]: this.dragStartNode[this.dragControl] + this.dragHandleSign * projectedPixels * sensitivity,
      });
    }
    return true;
  }

  endPointer(): void {
    if (this.dragControl === 'pending-orbit' && this.pendingOrbitFraction !== null && this.dragDistance < 6) {
      this.placeNodeAtOrbitFraction(this.pendingOrbitFraction);
    } else if (
      this.dragControl && this.dragControl !== 'time' && this.dragControl !== 'pending-orbit' &&
      this.dragDistance < 4 && this.dragStartNode
    ) {
      this.commitNode({
        ...this.dragStartNode,
        [this.dragControl]: this.dragStartNode[this.dragControl] + this.dragHandleSign * this.nodeStep,
      });
    }
    this.cancelPointer();
  }

  cancelPointer(): void {
    this.dragControl = null;
    this.pendingOrbitFraction = null;
    this.dragStartNode = null;
    this.dragDistance = 0;
  }

  openOrbitContext(clientX: number, clientY: number, pointerType = 'mouse'): boolean {
    this.cancelPointer();
    this.updatePointer(clientX, clientY, pointerType);
    const pick = this.orbitHover;
    if (!pick) return false;
    const time = this.timeAtOrbitFraction(pick.fraction);
    this.bodyCard?.remove();
    const card = el('div', 'map-body-card map-orbit-card', this.uiRoot);
    this.bodyCard = card;
    card.style.left = `${Math.min(window.innerWidth - 210, clientX + 10)}px`;
    card.style.top = `${Math.min(window.innerHeight - 130, clientY + 10)}px`;
    el('strong', '', card, `Orbit · T−${Math.max(1, time - (this.gameRef?.time ?? 0)).toFixed(0)} s`);
    const actions = el('div', 'map-row', card);
    const plan = el('button', 'hud-btn', actions, this.node ? 'Move maneuver' : 'Add maneuver');
    plan.onclick = () => {
      this.placeNodeAtOrbitFraction(pick.fraction);
      card.remove();
      this.bodyCard = null;
    };
    const warp = el('button', 'hud-btn', actions, 'Warp here');
    warp.onclick = () => this.cb.onWarpToTime(time, 10);
    const close = el('button', 'k-window-btn', card, '×');
    close.onclick = () => {
      card.remove();
      this.bodyCard = null;
    };
    return true;
  }

  private placeNodeAtOrbitFraction(fraction: number): void {
    if (!this.currentElements || !this.gameRef) return;
    const time = this.timeAtOrbitFraction(fraction);
    if (this.node) this.commitNode({ ...this.node, time });
    else {
      this.cb.onCreateManeuverNode({ time, prograde: 0, normal: 0, radial: 0 });
      this.predictionDirty = true;
      this.refreshNodePanel();
    }
  }

  createNode(inSeconds: number): void {
    const t = this.gameRef?.time ?? 0;
    this.cb.onCreateManeuverNode({ time: t + inSeconds, prograde: 0, normal: 0, radial: 0 });
    this.predictionDirty = true;
    this.refreshNodePanel();
  }

  setNode(node: ManeuverNode): void {
    this.cb.onCreateManeuverNode(node);
    this.predictionDirty = true;
    this.refreshNodePanel();
  }

  private gameRef: GameState | null = null;

  private commitNode(node: ManeuverNode): void {
    this.cb.onUpdateManeuverNode(node);
    this.predictionDirty = true;
    this.syncNodeInputs();
  }

  private timeAtOrbitFraction(fraction: number): number {
    if (!this.currentElements || !this.gameRef) return this.gameRef?.time ?? 0;
    const elements = this.currentElements;
    const trueAnomaly = elements.e < 1
      ? fraction * TWO_PI
      : -Math.acos(-1 / elements.e) * 0.96 + fraction * Math.acos(-1 / elements.e) * 1.92;
    const eta = timeToTrueAnomaly(elements, this.gameRef.time, trueAnomaly);
    return this.gameRef.time + Math.max(1, eta);
  }

  private positionAtOrbitPick(pick: OrbitPick, out: THREE.Vector3): void {
    const positions = this.vesselLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    const next = Math.min(positions.count - 1, pick.segmentIndex + 1);
    out.set(
      positions.getX(pick.segmentIndex) + (positions.getX(next) - positions.getX(pick.segmentIndex)) * pick.segmentT,
      positions.getY(pick.segmentIndex) + (positions.getY(next) - positions.getY(pick.segmentIndex)) * pick.segmentT,
      positions.getZ(pick.segmentIndex) + (positions.getZ(next) - positions.getZ(pick.segmentIndex)) * pick.segmentT,
    );
  }

  private refreshOrbitScreenPoints(): void {
    this.camera.updateMatrixWorld();
    const positions = this.vesselLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    const count = Math.min(positions.count, this.orbitScreenPoints.length);
    for (let index = 0; index < count; index++) {
      const point = this.orbitScreenPoints[index];
      this.projectedPoint
        .set(positions.getX(index), positions.getY(index), positions.getZ(index))
        .project(this.camera);
      point.x = (this.projectedPoint.x + 1) * 0.5 * window.innerWidth;
      point.y = (1 - this.projectedPoint.y) * 0.5 * window.innerHeight;
      point.depth = this.projectedPoint.z;
      point.visible = Number.isFinite(point.x) && Number.isFinite(point.y) &&
        point.depth >= -1 && point.depth <= 1;
    }
  }

  /** Read-only projection samples used by browser interaction checks. */
  orbitInteractionSamples(): Array<{ x: number; y: number; visible: boolean }> {
    return this.orbitScreenPoints.map(({ x, y, visible }) => ({ x, y, visible }));
  }

  private projectObject(object: THREE.Object3D): { x: number; y: number; depth: number } {
    this.projectedPoint.copy(object.position).project(this.camera);
    return {
      x: (this.projectedPoint.x + 1) * 0.5 * window.innerWidth,
      y: (1 - this.projectedPoint.y) * 0.5 * window.innerHeight,
      depth: this.projectedPoint.z,
    };
  }

  private screenDistanceTo(object: THREE.Object3D, clientX: number, clientY: number): number {
    const point = this.projectObject(object);
    return Math.hypot(clientX - point.x, clientY - point.y);
  }

  private pickNodeHandle(clientX: number, clientY: number): NodeHandle | null {
    const radius = this.orbitPointerCoarse ? 24 : 18;
    let best: NodeHandle | null = null;
    let bestDistance = Infinity;
    for (const handle of this.nodeHandles.values()) {
      if (!handle.sprite.visible) continue;
      const distance = this.screenDistanceTo(handle.sprite, clientX, clientY);
      if (distance <= radius && distance < bestDistance) {
        best = handle;
        bestDistance = distance;
      }
    }
    return best;
  }

  private refreshNodePanel(): void {
    this.nodePanel.innerHTML = '';
    this.nodeInputs.clear();
    const node = this.node;
    const phase = this.cb.getManeuverPlan()?.phase ?? null;
    const editingLocked = phase === 'executing' || phase === 'complete';
    this.lastPanelPhase = phase;
    this.panel.classList.toggle('has-node', !!node);
    if (!node) {
      const empty = el('div', 'map-empty', this.nodePanel);
      el('strong', '', empty, 'CLICK THE ORBIT TO PLAN');
      el('span', '', empty, 'The brightened arc has a wide invisible hit area.');
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
      const button = el('button', 'hud-btn', stepRow, String(step)) as HTMLButtonElement;
      button.classList.toggle('active', step === this.nodeStep);
      button.disabled = editingLocked;
      button.onclick = () => {
        this.nodeStep = step;
        this.refreshNodePanel();
      };
    }
    const axes: Array<{ key: 'prograde' | 'normal' | 'radial' | 'time'; label: string; minus?: string; plus?: string }> = [
      { key: 'prograde', label: 'Tangential', minus: 'Retrograde', plus: 'Prograde' },
      { key: 'normal', label: 'Plane', minus: 'Anti-normal', plus: 'Normal' },
      { key: 'radial', label: 'Radial', minus: 'Radial in', plus: 'Radial out' },
      { key: 'time', label: 'Node ETA' },
    ];
    for (const ax of axes) {
      const row = el('div', 'map-axis', this.nodePanel);
      el('label', '', row, ax.label);
      const minus = el('button', 'hud-btn', row, '−') as HTMLButtonElement;
      const input = el('input', 'map-number', row) as HTMLInputElement;
      const plus = el('button', 'hud-btn', row, '+') as HTMLButtonElement;
      minus.title = ax.minus ?? 'Earlier';
      minus.setAttribute('aria-label', ax.minus ?? 'Move node earlier');
      plus.title = ax.plus ?? 'Later';
      plus.setAttribute('aria-label', ax.plus ?? 'Move node later');
      input.type = 'number';
      input.step = String(ax.key === 'time' ? 10 : this.nodeStep);
      minus.disabled = editingLocked;
      input.disabled = editingLocked;
      plus.disabled = editingLocked;
      this.nodeInputs.set(ax.key, input);
      const apply = (delta: number) => {
        const current = this.node;
        if (!current) return;
        this.commitNode(ax.key === 'time'
          ? { ...current, time: current.time + delta }
          : { ...current, [ax.key]: current[ax.key] + delta });
      };
      const step = ax.key === 'time' ? 10 : this.nodeStep;
      minus.onclick = () => apply(-step);
      plus.onclick = () => apply(step);
      input.onchange = () => {
        const current = this.node;
        if (!current) return;
        const value = Number(input.value);
        if (!Number.isFinite(value)) return this.syncNodeInputs();
        this.commitNode(ax.key === 'time'
          ? { ...current, time: (this.gameRef?.time ?? 0) + Math.max(1, value) }
          : { ...current, [ax.key]: value });
      };
    }
    const snapRow = el('div', 'map-snap-row', this.nodePanel);
    el('span', 'map-step-label', snapRow, 'Snap');
    for (const [kind, label] of [
      ['ap', 'Ap'], ['pe', 'Pe'], ['an', 'AN'], ['dn', 'DN'], ['soi', 'SOI'],
    ] as const) {
      const button = el('button', 'hud-btn', snapRow, label) as HTMLButtonElement;
      const unavailable = editingLocked ||
        (kind === 'ap' && this.currentElements?.e !== undefined && this.currentElements.e >= 1) ||
        ((kind === 'an' || kind === 'dn') && !this.gameRef?.active?.target) ||
        (kind === 'soi' && !this.prediction?.encounter && !this.prediction?.escape);
      button.disabled = unavailable;
      button.onclick = () => this.snapNode(kind);
    }
    const period = this.cb.getManeuverPlan() ? periodOf(this.cb.getManeuverPlan()!.referenceOrbit) : Infinity;
    if (Number.isFinite(period)) {
      const passRow = el('div', 'map-snap-row', this.nodePanel);
      el('span', 'map-step-label', passRow, 'Orbit pass');
      const previous = el('button', 'hud-btn', passRow, '← Previous') as HTMLButtonElement;
      const next = el('button', 'hud-btn', passRow, 'Next →') as HTMLButtonElement;
      previous.disabled = editingLocked || node.time - period <= (this.gameRef?.time ?? 0) + 1;
      next.disabled = editingLocked;
      previous.onclick = () => this.commitNode({ ...node, time: node.time - period });
      next.onclick = () => this.commitNode({ ...node, time: node.time + period });
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
    this.commitNode({ ...this.node, time: now + Math.max(1, eta) });
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
    if (this.followsActiveVessel || !game.universe.bodies.has(this.focusBodyId)) {
      this.followsActiveVessel = true;
      this.focusBodyId = body.id;
    }
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

    // Vessel and maneuver conics.
    const elements = stateToElements(body.mu, v.pos, v.vel, t);
    this.currentElements = elements;
    fillConic(this.vesselLine, elements, null);
    const plan = this.cb.getManeuverPlan();
    const activePlan = plan?.vesselId === v.id && plan.bodyId === body.id ? plan : null;
    const node = activePlan?.node ?? null;
    if ((activePlan?.phase ?? null) !== this.lastPanelPhase) this.refreshNodePanel();
    (this.vesselLine.material as THREE.LineBasicMaterial).opacity = this.orbitHover
      ? 0.72
      : node ? 0.32 : 0.85;
    this.vesselMarker.position.set(v.pos.x * SCALE, v.pos.y * SCALE, v.pos.z * SCALE);
    const markerScale = this.camDist * 0.014;
    this.vesselMarker.scale.setScalar(markerScale);
    this.nodeMarker.scale.setScalar(markerScale * 0.8);
    this.encounterMarker.scale.setScalar(markerScale * 0.8);
    this.entryMarker.scale.setScalar(markerScale * 0.8);
    this.landingTargetMarker.scale.setScalar(markerScale * 0.8);
    this.updateOrbitMarkers(elements, gv.target, game, markerScale);

    if (activePlan && node) {
      const currentArcEnd = Math.max(t + 1, node.time);
      fillConicTimeRange(this.currentArcLine, elements, t, currentArcEnd);
      this.currentArcLine.visible = true;

      if (activePlan.revision !== this.lastRenderedPlanRevision) {
        this.lastRenderedPlanRevision = activePlan.revision;
        const targetPeriod = periodOf(activePlan.targetOrbit);
        const targetEnd = node.time + (Number.isFinite(targetPeriod) ? targetPeriod : 200_000);
        fillConicTimeRange(this.nodeLine, activePlan.targetOrbit, node.time, targetEnd);
      }
      this.nodeLine.visible = true;

      const nodePosition = new Vec3();
      const nodeVelocity = new Vec3();
      elementsAtTime(activePlan.referenceOrbit, node.time, nodePosition, nodeVelocity);
      this.nodeMarker.position.set(nodePosition.x * SCALE, nodePosition.y * SCALE, nodePosition.z * SCALE);
      this.nodeMarker.visible = true;
      const directions: Record<NodeAxis, Vec3> = {
        radial: nodePosition.clone().normalize(),
        normal: Vec3.cross(nodePosition, nodeVelocity, new Vec3()).normalize(),
        prograde: nodeVelocity.clone().normalize(),
      };
      const offset = markerScale * 2.7;
      for (const handle of this.nodeHandles.values()) {
        const direction = directions[handle.axis];
        handle.sprite.position.copy(this.nodeMarker.position).add(
          new THREE.Vector3(direction.x, direction.y, direction.z).multiplyScalar(offset * handle.sign),
        );
        handle.sprite.scale.setScalar(markerScale * 0.8);
        handle.sprite.visible = activePlan.phase !== 'executing' && activePlan.phase !== 'complete';
        const nodeScreen = this.projectObject(this.nodeMarker);
        const handleScreen = this.projectObject(handle.sprite);
        const angle = Math.atan2(handleScreen.y - nodeScreen.y, handleScreen.x - nodeScreen.x);
        (handle.sprite.material as THREE.SpriteMaterial).rotation = -angle - Math.PI / 2;
      }

      if (activePlan.phase === 'executing') {
        const completion = projectedOrbitAfterRemainingBurn(
          body.mu,
          v.pos,
          v.vel,
          t,
          activePlan.burnDirection,
          activePlan.remainingDeltaV,
        );
        const completionPeriod = periodOf(completion);
        fillConicTimeRange(
          this.completionLine,
          completion,
          t,
          t + (Number.isFinite(completionPeriod) ? completionPeriod : 200_000),
        );
        this.completionLine.visible = true;
      } else {
        this.completionLine.visible = false;
      }
    } else {
      this.lastRenderedPlanRevision = -1;
      this.currentArcLine.visible = false;
      this.nodeLine.visible = false;
      this.completionLine.visible = false;
      this.nodeMarker.visible = false;
      for (const handle of this.nodeHandles.values()) handle.sprite.visible = false;
    }

    this.refreshOrbitScreenPoints();

    // Prediction refresh. Local conics update immediately; encounter scans are throttled during drags.
    const signature = activePlan
      ? `${body.id}:plan:${activePlan.revision}`
      : [
          body.id,
          elements.a.toFixed(0), elements.e.toFixed(6), elements.i.toFixed(5),
          elements.raan.toFixed(5), elements.argPe.toFixed(5), elements.meanAnomaly0.toFixed(4),
          Math.floor(t / 5),
        ].join(':');
    const predictionNow = performance.now();
    const predictionChanged = signature !== this.lastElSig || this.predictionDirty;
    const predictionAllowed = !this.dragControl || predictionNow - this.lastPredictionRefreshAt >= 150;
    if (predictionChanged && predictionAllowed) {
      this.lastElSig = signature;
      this.predictionDirty = false;
      this.lastPredictionRefreshAt = predictionNow;
      const predictionElements = activePlan?.targetOrbit ?? elements;
      const predictionStart = activePlan?.node.time ?? t;
      this.prediction = predictTrajectory(game.universe, body, predictionElements, predictionStart);
      if (activePlan) {
        const transitionTime = this.prediction.encounter?.entryTime ?? this.prediction.escape?.exitTime;
        if (transitionTime) fillConicTimeRange(this.nodeLine, activePlan.targetOrbit, activePlan.node.time, transitionTime);
      }

      if (this.prediction.encounter) {
        const encounter = this.prediction.encounter;
        const moon = game.universe.get(encounter.bodyId);
        const moonPosition = new Vec3();
        game.universe.localPosition(moon, encounter.entryTime, moonPosition);
        const encounterPeriod = periodOf(encounter.elements);
        fillConicTimeRange(
          this.encounterLine,
          encounter.elements,
          encounter.entryTime,
          encounter.entryTime + (Number.isFinite(encounterPeriod) ? encounterPeriod : 80_000),
          moonPosition,
        );
        this.encounterLine.visible = true;
        this.encounterMarker.position.set(moonPosition.x * SCALE, moonPosition.y * SCALE, moonPosition.z * SCALE);
        this.encounterMarker.visible = true;
        this.encounterInfo.textContent =
          `${moon.name} encounter!\n` +
          `SOI entry in ${((encounter.entryTime - t) / 60).toFixed(0)} min\n` +
          `periapsis ${encounter.periapsisAltitude > 0 ? (encounter.periapsisAltitude / 1000).toFixed(0) + ' km' : 'IMPACT'}`;
      } else if (this.prediction.escape) {
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

    this.markerEvents.clear();
    const apoapsisTime = this.apsisTime('ap');
    const periapsisTime = this.apsisTime('pe');
    if (apoapsisTime !== null) this.markerEvents.set(this.orbitMarkers.get('ap')!, { label: 'Apoapsis', time: apoapsisTime });
    if (periapsisTime !== null) this.markerEvents.set(this.orbitMarkers.get('pe')!, { label: 'Periapsis', time: periapsisTime });
    if (node) this.markerEvents.set(this.nodeMarker, { label: 'Maneuver node', time: node.time });
    if (this.prediction?.encounter) {
      this.markerEvents.set(this.encounterMarker, { label: `${this.prediction.encounter.bodyId} SOI entry`, time: this.prediction.encounter.entryTime });
    } else if (this.prediction?.escape) {
      this.markerEvents.set(this.encounterMarker, { label: `${body.name} SOI exit`, time: this.prediction.escape.exitTime });
    }

    if (activePlan && node) {
      const phase = activePlan.phase === 'overdue' ? ' · OVERDUE' : activePlan.phase === 'executing' ? ' · EXECUTING' : '';
      this.dvReadout.textContent = `Δv ${nodeDeltaV(node).toFixed(1)} m/s${phase}`;
      this.etaReadout.textContent = `burn ${node.time >= t ? 'in ' : ''}${(node.time - t).toFixed(0)} s`;
      const after = activePlan.targetOrbit;
      const postApoapsis = after.e < 1 ? `${((apoapsisOf(after) - body.radius) / 1000).toFixed(1)} km` : 'escape';
      const postPeriapsis = `${((periapsisOf(after) - body.radius) / 1000).toFixed(1)} km`;
      const postPeriod = periodOf(after);
      this.postReadout.textContent =
        `TARGET ORBIT  Ap ${postApoapsis}  ·  Pe ${postPeriapsis}\n` +
        `Inc ${(after.i * 180 / Math.PI).toFixed(2)}°  ·  Period ${Number.isFinite(postPeriod) ? `${(postPeriod / 60).toFixed(1)} min` : '—'}`;
      const craftAnalysis = analyzeCraft(v.craft, body.surfaceGravity, body.pressureAt(v.pos.length() - body.radius));
      const available = craftAnalysis.stages
        .filter((stage) => stage.stageIndex >= v.currentStage)
        .reduce((sum, stage) => sum + stage.deltaV, 0);
      const required = activePlan.initialDeltaV;
      this.budgetReadout.textContent = activePlan.phase === 'executing'
        ? `REMAINING ${activePlan.remainingDeltaV.toFixed(1)} m/s  ·  target held stable`
        : `VESSEL Δv ${available.toFixed(0)} m/s  ·  margin ${(available - required).toFixed(0)} m/s`;
      this.budgetReadout.classList.toggle('warning', required > available);
      this.syncNodeInputs();
    } else {
      this.dvReadout.textContent = '';
      this.etaReadout.textContent = '';
      this.postReadout.textContent = '';
      this.budgetReadout.textContent = '';
    }
    this.updateEntryPrediction(game, body, elements, markerScale);
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
    const plan = this.cb.getManeuverPlan();
    const activePlan = plan?.vesselId === v.id && plan.bodyId === body.id ? plan : null;
    const signature = [
      body.id,
      elements.a.toFixed(0),
      elements.e.toFixed(5),
      elements.i.toFixed(4),
      Math.floor(game.time / 10),
      activePlan ? `plan:${activePlan.revision}` : 'none',
      v.massProps.mass.toFixed(0),
    ].join(':');
    const now = performance.now();
    if (signature !== this.entrySignature && now - this.lastEntryPredictionAt >= 750) {
      this.entrySignature = signature;
      this.lastEntryPredictionAt = now;
      let startPosition = v.pos;
      let startVelocity = v.vel;
      let startTime = game.time;
      if (activePlan) {
        const nodePosition = new Vec3();
        const nodeVelocity = new Vec3();
        elementsAtTime(activePlan.targetOrbit, activePlan.node.time, nodePosition, nodeVelocity);
        startPosition = nodePosition;
        startVelocity = nodeVelocity;
        startTime = activePlan.node.time;
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
    this.orbitHoverLabel.remove();
    this.handleHoverLabel.remove();
    this.gameRef = null;
  }
}
