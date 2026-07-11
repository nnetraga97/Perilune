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
import {
  OrbitalElements,
  elementsAtTime,
  elementsToState,
  stateToElements,
  TWO_PI,
} from '../core/orbit';
import { GameState } from '../sim/state';
import type { Body } from '../sim/universe';
import {
  ManeuverNode,
  nodeDeltaV,
  orbitAfterNode,
  predictTrajectory,
  TrajectoryPrediction,
} from '../sim/maneuver';
import { makeStarfield } from '../render/starfield';
import { depositSites, DepositSite } from '../sim/resources';
import { bodyFixedToInertial } from '../sim/bodyOrientation';

const SCALE = 1e-5;

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

function el(tag: string, cls: string, parent: HTMLElement, text = ''): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
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
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    });
    this.scene.background = new THREE.Color('#05080c');
    this.scene.add(makeStarfield(2600, 777));
    this.scene.add(new THREE.AmbientLight('#8899aa', 1.6));
    const sun = new THREE.DirectionalLight('#fff4e0', 1.4);
    sun.position.set(1, 0.3, 0.5);
    this.scene.add(sun);
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
    this.injectStyles();
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

  private injectStyles(): void {
    if (document.getElementById('map-style')) return;
    const style = document.createElement('style');
    style.id = 'map-style';
    style.textContent = `
      .map-panel { position: absolute; left: 12px; bottom: 12px; width: 300px;
        background: var(--ui-bg); border: 1px solid #223240; border-radius: 8px;
        padding: 10px 12px; pointer-events: auto; }
      .map-title { font-size: 11px; letter-spacing: 2px; color: #9fb4c4; margin-bottom: 8px; }
      .map-row { display: flex; gap: 6px; margin-bottom: 8px; }
      .map-node-panel { display: flex; flex-direction: column; gap: 6px; }
      .map-axis { display: flex; align-items: center; gap: 6px; font-size: 12px; }
      .map-axis label { width: 66px; color: #9fb4c4; font-size: 11px; }
      .map-axis input[type=range] { flex: 1; }
      .map-axis .val { font-family: var(--ui-mono); width: 64px; text-align: right; }
      .map-axis button { width: 24px; padding: 2px; }
      .map-readout { font-family: var(--ui-mono); font-size: 12px; color: var(--ui-accent); padding: 2px 0; }
      .map-encounter { font-family: var(--ui-mono); font-size: 12px; color: #c88be8; white-space: pre-line; padding-top: 4px; }
    `;
    document.head.appendChild(style);
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
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(1, 24, 16),
          new THREE.MeshLambertMaterial({ color: b.def.color }),
        );
        this.bodyMeshes.set(b.id, mesh);
        this.scene.add(mesh);
      }
      mesh.scale.setScalar(Math.max(b.radius * SCALE, this.camDist * 0.008));
      mesh.position.set(pos.x * SCALE, pos.y * SCALE, pos.z * SCALE);
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
}
