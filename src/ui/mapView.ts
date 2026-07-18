/**
 * Map view: orbital display with maneuver-node planning.
 *
 * A separate Three.js scene at 1:100,000 scale, focused on the active
 * vessel's SOI body. Shows body orbits, the vessel's conic, the post-node
 * conic, SOI spheres, and encounter markers with periapsis readout.
 * Node editing happens in a DOM panel (prograde/normal/radial ± time).
 */
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { Vec3 } from '../core/vec3';
import { Quat } from '../core/quat';
import {
  OrbitalElements,
  elementsAtTime,
  elementsToState,
  apoapsisOf,
  meanMotionOf,
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

function predictionOrbitSignature(bodyId: string, elements: OrbitalElements): string {
  let phaseAtZero = elements.meanAnomaly0 - meanMotionOf(elements) * elements.epoch;
  if (elements.e < 1) phaseAtZero = ((phaseAtZero % TWO_PI) + TWO_PI) % TWO_PI;
  return [
    bodyId,
    elements.a.toFixed(0), elements.e.toFixed(6), elements.i.toFixed(5),
    elements.raan.toFixed(5), elements.argPe.toFixed(5), phaseAtZero.toFixed(4),
  ].join(':');
}

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

/** Authoritative map-space body center, relative to the active SOI anchor. */
export function mapBodyScenePosition(
  universe: Universe,
  body: Body,
  anchor: Body,
  time: number,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  const position = new Vec3();
  universe.relativePosition(body, anchor, time, position);
  return out.set(position.x * SCALE, position.y * SCALE, position.z * SCALE);
}

type MapLine = Line2;

function mapLine(color: string, width: number, dashed = false, count = 256): MapLine {
  const geo = new LineGeometry();
  const positions = new Float32Array(count * 3);
  geo.setPositions(positions);
  const mat = new LineMaterial({
    color,
    linewidth: width,
    dashed,
    dashSize: 8,
    gapSize: 5,
    transparent: true,
    opacity: dashed ? 0.9 : 0.85,
    worldUnits: false,
  });
  mat.resolution.set(window.innerWidth, window.innerHeight);
  const line = new Line2(geo, mat);
  line.userData.mapPositions = positions;
  line.frustumCulled = false;
  if (dashed) line.computeLineDistances();
  return line;
}

function orbitLine(color: string, dashed = false, width = 2): MapLine {
  return mapLine(color, width, dashed);
}

function entryPathLine(): MapLine {
  return mapLine('#e27a4f', 3, false, 2);
}

function linePositions(line: MapLine): Float32Array {
  return line.userData.mapPositions as Float32Array;
}

function commitLinePositions(line: MapLine, positions: Float32Array): void {
  line.userData.mapPositions = positions;
  line.geometry.setPositions(positions);
  if (line.material.dashed) line.computeLineDistances();
}

function fillEntryPath(line: MapLine, samples: readonly Vec3[]): void {
  const count = Math.max(2, samples.length);
  const positions = new Float32Array(count * 3);
  for (let index = 0; index < count; index++) {
    const sample = samples[Math.min(samples.length - 1, index)];
    if (!sample) continue;
    positions[index * 3] = sample.x * SCALE;
    positions[index * 3 + 1] = sample.y * SCALE;
    positions[index * 3 + 2] = sample.z * SCALE;
  }
  commitLinePositions(line, positions);
}

/** Fill a line's positions from a conic around origin (parent-centered). */
function fillConic(line: MapLine, el: OrbitalElements, offset: Vec3 | null): void {
  const arr = linePositions(line);
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
  commitLinePositions(line, arr);
}

/** Fill a chronological conic patch between two absolute simulation times. */
function fillConicTimeRange(
  line: MapLine,
  elements: OrbitalElements,
  startTime: number,
  endTime: number,
  offset: Vec3 | null = null,
): void {
  const positions = linePositions(line);
  const count = positions.length / 3;
  const position = new Vec3();
  const velocity = new Vec3();
  const duration = Math.max(1, endTime - startTime);
  for (let index = 0; index < count; index++) {
    const time = startTime + duration * index / Math.max(1, count - 1);
    elementsAtTime(elements, time, position, velocity);
    positions[index * 3] = (position.x + (offset?.x ?? 0)) * SCALE;
    positions[index * 3 + 1] = (position.y + (offset?.y ?? 0)) * SCALE;
    positions[index * 3 + 2] = (position.z + (offset?.z ?? 0)) * SCALE;
  }
  commitLinePositions(line, positions);
}

function elementsToStateSafe(el: OrbitalElements, nu: number, outR: Vec3, outV: Vec3): void {
  elementsToState(el, nu, outR, outV);
  if (!outR.isFinite()) outR.set(0, 0, 0);
}

export interface MapCallbacks {
  getManeuverPlan(): Readonly<ManeuverPlan> | null;
  getManeuverPlans(): readonly Readonly<ManeuverPlan>[];
  onSelectManeuverNode(id: string): void;
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
  private bodyOrbits = new Map<string, MapLine>();
  private soiMeshes = new Map<string, THREE.Mesh>();
  private vesselLine = orbitLine('#7fd0e8', false, 3.2);
  private currentArcLine = orbitLine('#a9ebff', false, 4.2);
  private nodeLine = orbitLine('#e8c76b', true, 3.4);
  private completionLine = orbitLine('#fff0a8', true, 3.2);
  private encounterLine = orbitLine('#c88be8', true, 3.2);
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
  private panelContent: HTMLElement;
  private nodePanel: HTMLElement;
  private nodeQueue: HTMLElement;
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
  private cameraControls: HTMLElement;
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
      this.scene.traverse((object) => {
        if (object instanceof Line2) object.material.resolution.set(window.innerWidth, window.innerHeight);
      });
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
    this.vesselLine.material.opacity = 0.32;

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
    const mkLabelSprite = (label: string, color: string, craft = false) => {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 48;
      const context = canvas.getContext('2d')!;
      context.fillStyle = 'rgba(5, 14, 20, 0.94)';
      context.strokeStyle = color;
      context.lineWidth = 3;
      context.beginPath();
      context.roundRect(2, 2, 124, 44, 10);
      context.fill();
      context.stroke();
      context.fillStyle = color;
      context.strokeStyle = color;
      context.lineWidth = 3;
      if (craft) {
        context.beginPath();
        context.moveTo(18, 8);
        context.lineTo(28, 30);
        context.lineTo(21, 27);
        context.lineTo(21, 39);
        context.lineTo(15, 39);
        context.lineTo(15, 27);
        context.lineTo(8, 30);
        context.closePath();
        context.fill();
      } else {
        context.beginPath();
        context.arc(18, 24, 7, 0, Math.PI * 2);
        context.stroke();
        context.beginPath();
        context.moveTo(18, 8);
        context.lineTo(18, 15);
        context.moveTo(18, 33);
        context.lineTo(18, 40);
        context.stroke();
      }
      context.fillStyle = '#edf7fa';
      context.font = '700 21px ui-monospace, SFMono-Regular, Menlo, monospace';
      context.textAlign = 'left';
      context.textBaseline = 'middle';
      context.fillText(label, 36, 25);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: texture,
        depthTest: false,
        transparent: true,
      }));
      sprite.renderOrder = 13;
      sprite.userData.labelMarker = true;
      return sprite;
    };
    const mkOrbitLabelSprite = (label: string, color: string) => {
      const canvas = document.createElement('canvas');
      canvas.width = 72;
      canvas.height = 44;
      const context = canvas.getContext('2d')!;
      context.fillStyle = 'rgba(5, 14, 20, 0.96)';
      context.strokeStyle = color;
      context.lineWidth = 3;
      context.beginPath();
      context.roundRect(2, 2, 68, 40, 9);
      context.fill();
      context.stroke();
      context.fillStyle = '#edf7fa';
      context.font = '700 22px ui-monospace, SFMono-Regular, Menlo, monospace';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(label, 36, 23);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: texture,
        depthTest: false,
        transparent: true,
      }));
      sprite.renderOrder = 13;
      sprite.userData.labelMarker = true;
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
    this.vesselMarker = mkLabelSprite('CRAFT', '#7fd0e8', true);
    this.vesselMarker.center.set(0, 0.5);
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
      ['ap', '#7fd0e8', 'AP'], ['pe', '#e8b66b', 'PE'],
      ['an', '#70d58c', 'AN'], ['dn', '#d56ba9', 'DN'],
    ] as const) {
      const marker = mkOrbitLabelSprite(glyph, color);
      if (kind === 'ap') marker.center.set(1, 0.5);
      else if (kind === 'pe') marker.center.set(0.5, 0);
      else if (kind === 'an') marker.center.set(0, 1);
      else marker.center.set(1, 1);
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

    this.cameraControls = el('div', 'map-camera-controls', uiRoot);
    this.cameraControls.setAttribute('aria-label', 'Map camera controls');
    const cameraButton = (glyph: string, label: string, action: () => void) => {
      const button = el('button', 'map-camera-btn', this.cameraControls, glyph) as HTMLButtonElement;
      button.type = 'button';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.onclick = action;
      return button;
    };
    cameraButton('+', 'Zoom in', () => this.zoomCamera(0.72));
    cameraButton('−', 'Zoom out', () => this.zoomCamera(1.38));
    cameraButton('◎', 'Recenter selected body', () => this.recenterCamera());
    cameraButton('⌂', 'Fit local system', () => this.fitCamera('local'));
    cameraButton('◇', 'Fit entire system', () => this.fitCamera('system'));
    cameraButton('▱', 'Near top view', () => {
      this.camPitch = 1.35;
      this.predictionDirty = true;
    });
    const cameraHint = el('span', 'map-camera-hint', this.cameraControls, 'DRAG ORBIT · RMB PAN · WHEEL ZOOM');
    cameraHint.setAttribute('aria-hidden', 'true');

    // ---- DOM panel: floating desktop window, bottom sheet on touch layouts
    this.panel = el('div', 'map-panel', uiRoot);
    injectUiStyles();
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', 'Maneuver planner');
    const panelBar = el('div', 'map-panel-bar', this.panel);
    el('div', 'map-title', panelBar, 'MANEUVER PLANNER');
    const collapse = el('button', 'k-window-btn map-panel-collapse', panelBar, '▾') as HTMLButtonElement;
    collapse.type = 'button';
    collapse.title = 'Collapse maneuver planner';
    collapse.setAttribute('aria-label', 'Collapse maneuver planner');
    this.panelContent = el('div', 'map-panel-content', this.panel);
    this.nodeQueue = el('div', 'map-node-queue', this.panelContent);
    const btnRow = el('div', 'map-row map-node-actions', this.panelContent);
    const addBtn = el('button', 'hud-btn map-action-primary', btnRow, '+ Node') as HTMLButtonElement;
    addBtn.title = 'Add node in 2 minutes';
    addBtn.setAttribute('aria-label', 'Add node in 2 minutes');
    addBtn.onclick = () => this.createNode(120);
    const delBtn = el('button', 'hud-btn map-icon-btn', btnRow, '⌫') as HTMLButtonElement;
    delBtn.title = 'Delete selected node';
    delBtn.setAttribute('aria-label', 'Delete selected node');
    delBtn.onclick = () => {
      cb.onDeleteManeuverNode();
      this.predictionDirty = true;
      this.refreshNodePanel();
    };
    const warpBtn = el('button', 'hud-btn map-icon-btn', btnRow, '≫') as HTMLButtonElement;
    warpBtn.title = 'Warp to selected node';
    warpBtn.setAttribute('aria-label', 'Warp to selected node');
    warpBtn.onclick = () => {
      if (this.node) cb.onWarpToNode(this.node);
    };
    const alarmBtn = el('button', 'hud-btn map-icon-btn', btnRow, '⌁') as HTMLButtonElement;
    alarmBtn.title = 'Create maneuver alarm';
    alarmBtn.setAttribute('aria-label', 'Create maneuver alarm');
    alarmBtn.onclick = () => {
      const alarmTime = this.node?.time;
      if (alarmTime !== undefined && alarmTime > (this.gameRef?.time ?? 0)) {
        cb.onCreateAlarm(alarmTime, 'Maneuver node', 'maneuver');
      }
    };

    this.nodePanel = el('div', 'map-node-panel', this.panelContent);
    const readoutRow = el('div', 'map-node-summary', this.panelContent);
    this.dvReadout = el('div', 'map-readout', readoutRow);
    this.etaReadout = el('div', 'map-readout map-readout-eta', readoutRow);
    this.encounterInfo = el('div', 'map-encounter', this.panelContent);
    const analysis = el('details', 'map-analysis', this.panelContent) as HTMLDetailsElement;
    el('summary', '', analysis, 'TRAJECTORY DETAILS');
    this.postReadout = el('div', 'map-orbit-after', analysis);
    this.budgetReadout = el('div', 'map-budget', analysis);
    this.entryInfo = el('div', 'map-entry-info', analysis);
    const resizeHandle = el('div', 'k-window-resize-handle map-panel-resize', this.panel);
    resizeHandle.setAttribute('role', 'separator');
    resizeHandle.setAttribute('aria-label', 'Resize maneuver planner');
    resizeHandle.tabIndex = 0;
    this.installPanelInteractions(panelBar, collapse, resizeHandle);
    this.refreshNodePanel();
    this.setVisible(false);
  }

  private installPanelInteractions(
    bar: HTMLElement,
    collapse: HTMLButtonElement,
    resizeHandle: HTMLElement,
  ): void {
    const compact = () => window.matchMedia('(max-width: 820px), (pointer: coarse)').matches;
    const clampPosition = (x: number, y: number) => ({
      x: Math.max(48 - this.panel.offsetWidth, Math.min(window.innerWidth - 48, x)),
      y: Math.max(0, Math.min(window.innerHeight - 32, y)),
    });
    collapse.onclick = () => {
      const collapsed = !this.panel.classList.contains('collapsed');
      this.panel.classList.toggle('collapsed', collapsed);
      collapse.textContent = collapsed ? '▸' : '▾';
      collapse.setAttribute('aria-expanded', String(!collapsed));
    };
    collapse.setAttribute('aria-expanded', 'true');

    bar.addEventListener('pointerdown', (event) => {
      if (compact() || event.button !== 0 || event.target === collapse) return;
      event.preventDefault();
      const bounds = this.panel.getBoundingClientRect();
      const offsetX = event.clientX - bounds.left;
      const offsetY = event.clientY - bounds.top;
      const move = (moveEvent: PointerEvent) => {
        const position = clampPosition(moveEvent.clientX - offsetX, moveEvent.clientY - offsetY);
        this.panel.style.left = `${position.x}px`;
        this.panel.style.top = `${position.y}px`;
        this.panel.style.right = 'auto';
        this.panel.style.bottom = 'auto';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });

    const resizeBy = (dx: number, dy: number, startWidth: number, startHeight: number) => {
      if (compact()) return;
      const bounds = this.panel.getBoundingClientRect();
      const maxWidth = Math.max(300, window.innerWidth - bounds.left - 8);
      const maxHeight = Math.max(180, window.innerHeight - bounds.top - 8);
      this.panel.style.width = `${Math.max(300, Math.min(maxWidth, startWidth + dx))}px`;
      this.panel.style.height = `${Math.max(180, Math.min(maxHeight, startHeight + dy))}px`;
    };
    resizeHandle.addEventListener('pointerdown', (event) => {
      if (compact() || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startY = event.clientY;
      const startWidth = this.panel.offsetWidth;
      const startHeight = this.panel.offsetHeight;
      resizeHandle.setPointerCapture?.(event.pointerId);
      const move = (moveEvent: PointerEvent) => {
        resizeBy(moveEvent.clientX - startX, moveEvent.clientY - startY, startWidth, startHeight);
      };
      const up = () => {
        resizeHandle.removeEventListener('pointermove', move);
        resizeHandle.removeEventListener('pointerup', up);
        resizeHandle.removeEventListener('pointercancel', up);
      };
      resizeHandle.addEventListener('pointermove', move);
      resizeHandle.addEventListener('pointerup', up);
      resizeHandle.addEventListener('pointercancel', up);
    });
    resizeHandle.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 24 : 8;
      const dx = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
      const dy = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
      if (!dx && !dy) return;
      event.preventDefault();
      resizeBy(dx, dy, this.panel.offsetWidth, this.panel.offsetHeight);
    });
  }

  setVisible(vis: boolean): void {
    this.visible = vis;
    this.panel.style.display = vis ? '' : 'none';
    this.cameraControls.style.display = vis ? '' : 'none';
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
    this.camPitch = Math.max(-1.48, Math.min(1.48, this.camPitch + dy * 0.005));
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
    this.camDist = Math.max(1, Math.min(3e6, this.camDist * factor));
    this.predictionDirty = true;
  }

  recenterCamera(): void {
    this.camFocus.copy(this.desiredFocus);
    this.predictionDirty = true;
  }

  fitCamera(scope: 'local' | 'system'): void {
    if (!this.gameRef) return;
    const active = this.gameRef.active;
    if (!active) return;
    const anchor = this.gameRef.bodyOf(active);
    const focus = this.gameRef.universe.get(this.focusBodyId);
    const bodies = scope === 'system'
      ? [...this.gameRef.universe.bodies.values()]
      : [focus, ...focus.children];
    const position = new Vec3();
    let radius = Math.max(focus.radius * SCALE * 2.5, 18);
    for (const body of bodies) {
      this.gameRef.universe.relativePosition(body, anchor, this.gameRef.time, position);
      const scenePosition = new THREE.Vector3(position.x * SCALE, position.y * SCALE, position.z * SCALE);
      radius = Math.max(radius, scenePosition.distanceTo(this.desiredFocus) + body.radius * SCALE);
    }
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov * 0.5);
    this.camDist = Math.max(8, Math.min(3e6, radius / Math.tan(halfFov) * 1.18));
    this.camFocus.copy(this.desiredFocus);
    this.predictionDirty = true;
  }

  resetCamera(): void {
    this.camYaw = 0.8;
    this.camPitch = 0.65;
    this.camDist = 400;
    this.camFocus.copy(this.desiredFocus);
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
    const material = this.vesselLine.material;
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
      const markerHitRadius = marker.userData.labelMarker ? (this.orbitPointerCoarse ? 38 : 28) : 18;
      if (
        marker !== this.nodeMarker && marker.visible &&
        this.screenDistanceTo(marker, clientX, clientY) <= markerHitRadius
      ) {
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
    const afterQueue = this.cb.getManeuverPlans().reduce(
      (latest, plan) => Math.max(latest, plan.node.time),
      t,
    );
    this.cb.onCreateManeuverNode({ time: afterQueue + inSeconds, prograde: 0, normal: 0, radial: 0 });
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
    const positions = linePositions(this.vesselLine);
    const count = positions.length / 3;
    const next = Math.min(count - 1, pick.segmentIndex + 1);
    const currentOffset = pick.segmentIndex * 3;
    const nextOffset = next * 3;
    out.set(
      positions[currentOffset] + (positions[nextOffset] - positions[currentOffset]) * pick.segmentT,
      positions[currentOffset + 1] + (positions[nextOffset + 1] - positions[currentOffset + 1]) * pick.segmentT,
      positions[currentOffset + 2] + (positions[nextOffset + 2] - positions[currentOffset + 2]) * pick.segmentT,
    );
  }

  private refreshOrbitScreenPoints(): void {
    this.camera.updateMatrixWorld();
    const positions = linePositions(this.vesselLine);
    const count = Math.min(positions.length / 3, this.orbitScreenPoints.length);
    for (let index = 0; index < count; index++) {
      const point = this.orbitScreenPoints[index];
      const offset = index * 3;
      this.projectedPoint
        .set(positions[offset], positions[offset + 1], positions[offset + 2])
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

  cameraState(): { distance: number; yaw: number; pitch: number; focusX: number; focusY: number; focusZ: number } {
    return {
      distance: this.camDist,
      yaw: this.camYaw,
      pitch: this.camPitch,
      focusX: this.camFocus.x,
      focusY: this.camFocus.y,
      focusZ: this.camFocus.z,
    };
  }

  /** Projected labeled markers used by browser checks and interaction diagnostics. */
  markerInteractionSamples(): Record<'craft' | 'ap' | 'pe', {
    x: number;
    y: number;
    visible: boolean;
    width: number;
    height: number;
  }> {
    const sample = (marker: THREE.Sprite) => {
      const point = this.projectObject(marker);
      return { x: point.x, y: point.y, visible: marker.visible, width: marker.scale.x, height: marker.scale.y };
    };
    return {
      craft: sample(this.vesselMarker),
      ap: sample(this.orbitMarkers.get('ap')!),
      pe: sample(this.orbitMarkers.get('pe')!),
    };
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
    const plans = this.cb.getManeuverPlans();
    this.nodeQueue.innerHTML = '';
    if (plans.length) {
      for (let index = 0; index < plans.length; index++) {
        const plan = plans[index];
        const button = el('button', 'map-node-chip', this.nodeQueue) as HTMLButtonElement;
        button.classList.toggle('active', plan.id === this.cb.getManeuverPlan()?.id);
        button.classList.toggle('overdue', plan.phase === 'overdue');
        const eta = plan.node.time - (this.gameRef?.time ?? 0);
        el('span', 'map-node-chip-index', button, String(index + 1).padStart(2, '0'));
        const copy = el('span', 'map-node-chip-copy', button);
        el('strong', '', copy, `${nodeDeltaV(plan.node).toFixed(0)} m/s`);
        el('small', '', copy, eta >= 0 ? `T−${eta.toFixed(0)}s` : 'OVERDUE');
        button.title = `Select maneuver ${index + 1}`;
        button.onclick = () => {
          this.cb.onSelectManeuverNode(plan.id);
          this.predictionDirty = true;
          this.refreshNodePanel();
        };
      }
    }
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
      const row = el('div', `map-axis map-axis-${ax.key}`, this.nodePanel);
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
      input.setAttribute('aria-label', `${ax.label} value`);
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
      input.oninput = () => {
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
    const place = (b: Body, pos: THREE.Vector3) => {
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
      mesh.position.copy(pos);
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

    const zero = new THREE.Vector3();
    place(body, zero);
    const candidatePos = new THREE.Vector3();
    const parentOffset = new Vec3();
    for (const candidate of game.universe.bodies.values()) {
      if (candidate === body) continue;
      mapBodyScenePosition(game.universe, candidate, body, t, candidatePos);
      place(candidate, candidatePos);
      if (!candidate.orbit || !candidate.parent) continue;
      let line = this.bodyOrbits.get(candidate.id);
      if (!line) {
        line = orbitLine('#4a6072', false, 1.8);
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
    this.vesselLine.material.opacity = this.orbitHover
      ? 0.72
      : node ? 0.32 : 0.85;
    this.vesselMarker.position.set(v.pos.x * SCALE, v.pos.y * SCALE, v.pos.z * SCALE);
    const markerScale = this.camDist * 0.014;
    this.vesselMarker.scale.set(markerScale * 3, markerScale * 1.02, 1);
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
      const radialDirection = nodePosition.clone().normalize();
      const normalDirection = Vec3.cross(nodePosition, nodeVelocity, new Vec3()).normalize();
      const directions: Record<NodeAxis, Vec3> = {
        radial: radialDirection,
        normal: normalDirection,
        prograde: Vec3.cross(normalDirection, radialDirection, new Vec3()).normalize(),
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
      : predictionOrbitSignature(body.id, elements);
    const predictionNow = performance.now();
    const transitionTime = this.prediction?.encounter?.entryTime ?? this.prediction?.escape?.exitTime;
    const hasFutureTransition = transitionTime !== undefined && transitionTime > t;
    const predictionSpan = this.prediction
      ? this.prediction.endTime - this.prediction.startTime
      : 0;
    const horizonNeedsExtension = !!this.prediction && !hasFutureTransition &&
      t >= this.prediction.startTime + predictionSpan * 0.1;
    const orbitChanged = signature !== this.lastElSig || this.predictionDirty || !this.prediction;
    const predictionChanged = orbitChanged || horizonNeedsExtension;
    const refreshInterval = orbitChanged ? (this.dragControl ? 150 : 250) : 1_000;
    const predictionAllowed = predictionNow - this.lastPredictionRefreshAt >= refreshInterval;
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
      marker.scale.set(markerScale * 1.48, markerScale * 0.9, 1);
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
    const vertices = linePositions(this.vesselLine);
    const closest = (direction: Readonly<Vec3>): THREE.Vector3 => {
      let best = new THREE.Vector3();
      let bestDot = -Infinity;
      for (let index = 0; index < vertices.length / 3; index++) {
        const offset = index * 3;
        const candidate = new THREE.Vector3(vertices[offset], vertices[offset + 1], vertices[offset + 2]);
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
    an.scale.set(markerScale * 1.48, markerScale * 0.9, 1);
    dn.scale.set(markerScale * 1.48, markerScale * 0.9, 1);
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
    this.cameraControls?.remove();
    this.orbitHoverLabel?.remove();
    this.handleHoverLabel?.remove();
    this.gameRef = null;
  }
}
