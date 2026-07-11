/**
 * The Workshop — Perilune's vehicle construction editor.
 *
 * Features (M1): part palette with categories, stack-node snapping, surface
 * attachment with radial symmetry, subtree removal, staging editor with
 * auto-stage, live engineering readouts (per-stage Δv / TWR / burn time,
 * mass, CoM/CoP stability hint), advisor warnings, craft save/load, launch.
 */
import * as THREE from 'three';
import { Vec3 } from '../core/vec3';
import {
  addPart,
  analyzeCraft,
  Craft,
  createCraft,
  craftPart,
  defOf,
  PartInstance,
  removeSubtree,
  buildAutoStages,
} from '../sim/vessel';
import { PARTS, PartDef, partById } from '../content/parts';
import { buildAeroModel } from '../sim/aero';
import { computeMassProperties } from '../sim/vessel';
import { buildVesselVisual, VesselVisual } from '../render/vesselMesh';
import { listCraftFiles, readCraftFile, writeCraftFile } from '../save/persistence';

function el(tag: string, cls: string, parent: HTMLElement, text = ''): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}

interface StackNodeSpot {
  parentKey: number;
  kind: 'stack-top' | 'stack-bottom';
  pos: Vec3;
}

const CATEGORIES: Array<{ id: PartDef['category']; label: string }> = [
  { id: 'pods', label: 'Pods' },
  { id: 'tanks', label: 'Tanks' },
  { id: 'engines', label: 'Engines' },
  { id: 'coupling', label: 'Coupling' },
  { id: 'structural', label: 'Struct' },
  { id: 'aero', label: 'Aero' },
  { id: 'utility', label: 'Utility' },
  { id: 'science', label: 'Science' },
  { id: 'thermal', label: 'Thermal' },
  { id: 'ground', label: 'Ground' },
];

export interface EditorCallbacks {
  onLaunch(craft: Craft): void;
  onExit(): void;
}

export class Editor {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly root: HTMLElement;
  craft: Craft = createCraft('Untitled Craft');

  private visual: VesselVisual | null = null;
  private ghost: THREE.Object3D | null = null;
  private holdingDef: PartDef | null = null;
  private selectedKey: number | null = null;
  private selectionHelper: THREE.BoxHelper | null = null;
  private movingKeys: Set<number> | null = null;
  private readonly movePlane = new THREE.Plane();
  private readonly lastMovePoint = new THREE.Vector3();
  private symmetry = 1;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private camYaw = 0.7;
  private camPitch = 0.25;
  private camDist = 16;
  private camHeight = 4;
  private cb: EditorCallbacks;

  private partListEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private stagesEl!: HTMLElement;
  private warningsEl!: HTMLElement;
  private nameInput!: HTMLInputElement;
  private envSelect!: HTMLSelectElement;
  private symmetryBtn!: HTMLElement;
  private craftListEl!: HTMLElement;
  private statsDirty = true;
  private activeCategory: PartDef['category'] = 'pods';
  /** Ghost attach candidate this frame. */
  private candidate:
    | { kind: 'stack'; spot: StackNodeSpot; pos: Vec3 }
    | { kind: 'surface'; parentKey: number; pos: Vec3; normal: Vec3 }
    | { kind: 'root'; pos: Vec3 }
    | null = null;

  constructor(uiRoot: HTMLElement, cb: EditorCallbacks) {
    this.cb = cb;
    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 500);
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    });
    this.scene.background = new THREE.Color('#10171e');
    this.scene.add(new THREE.AmbientLight('#5a6d7d', 1.1));
    const key = new THREE.DirectionalLight('#fff2e0', 1.9);
    key.position.set(6, 10, 4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#6db3d6', 0.7);
    rim.position.set(-6, 3, -6);
    this.scene.add(rim);
    // Floor grid.
    const grid = new THREE.GridHelper(60, 30, 0x2a3d4d, 0x1a2833);
    grid.position.y = -0.01;
    this.scene.add(grid);
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(6, 6.4, 0.3, 32),
      new THREE.MeshStandardMaterial({ color: '#3a444d', roughness: 0.9 }),
    );
    pad.position.y = -0.2;
    this.scene.add(pad);

    this.root = el('div', 'ed-root', uiRoot);
    // Inline style: #ui-root > * { pointer-events: auto } would override the
    // class rule by specificity; inline always wins.
    this.root.style.pointerEvents = 'none';
    this.injectStyles();
    this.buildDom();
    this.rebuildVisual();
    this.setVisible(false);
  }

  private injectStyles(): void {
    if (document.getElementById('ed-style')) return;
    const style = document.createElement('style');
    style.id = 'ed-style';
    style.textContent = `
      .ed-root { position: absolute; inset: 0; pointer-events: none; }
      .ed-root button, .ed-root input, .ed-root select { pointer-events: auto; }
      .ed-left { position: absolute; left: 0; top: 0; bottom: 0; width: 244px;
        background: rgba(10,16,22,0.94); border-right: 1px solid #223240;
        display: flex; flex-direction: column; pointer-events: auto; }
      .ed-title { padding: 10px 12px 4px; font-size: 15px; letter-spacing: 3px; color: var(--ui-accent); }
      .ed-cats { display: flex; flex-wrap: wrap; gap: 3px; padding: 6px 8px; }
      .ed-cat { font-size: 10px; padding: 3px 7px; }
      .ed-cat.active { border-color: var(--ui-accent); background: #16303f; }
      .ed-parts { flex: 1; overflow-y: auto; padding: 4px 8px; display: flex; flex-direction: column; gap: 4px; }
      .ed-part { border: 1px solid #223240; border-radius: 6px; padding: 6px 8px; cursor: pointer;
        background: rgba(20,30,40,0.6); }
      .ed-part:hover { border-color: var(--ui-accent); }
      .ed-part-name { font-size: 12px; color: #d8e2ea; }
      .ed-part-info { font-size: 10px; color: #7d8b96; }
      .ed-right { position: absolute; right: 0; top: 0; bottom: 0; width: 268px;
        background: rgba(10,16,22,0.94); border-left: 1px solid #223240;
        display: flex; flex-direction: column; gap: 8px; padding: 10px; overflow-y: auto; pointer-events: auto; }
      .ed-panel { border: 1px solid #223240; border-radius: 8px; padding: 8px 10px; }
      .ed-panel h3 { font-size: 10px; letter-spacing: 2px; color: #9fb4c4; margin-bottom: 6px; font-weight: normal; }
      .ed-stats { font-family: var(--ui-mono); font-size: 11.5px; line-height: 1.55; white-space: pre; }
      .ed-warn { color: var(--ui-warn); font-size: 11px; padding: 2px 0; }
      .ed-stage { border: 1px solid #223240; border-radius: 5px; padding: 4px 6px; margin-bottom: 4px; font-size: 11px; }
      .ed-stage-head { display: flex; gap: 4px; align-items: center; color: #9fb4c4; font-size: 10px; }
      .ed-stage-head button { padding: 0 6px; font-size: 10px; }
      .ed-topbar { position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
        display: flex; gap: 8px; align-items: center; pointer-events: auto;
        background: var(--ui-bg); border: 1px solid #223240; border-radius: 8px; padding: 6px 12px; }
      .ed-name { background: #101c26; border: 1px solid #2a3d4d; color: var(--ui-fg);
        border-radius: 5px; padding: 4px 8px; width: 190px; font-size: 13px; }
      .ed-launch { border-color: var(--ui-good) !important; color: var(--ui-good) !important; font-weight: bold; }
      .ed-hint { position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%);
        background: var(--ui-bg); border-radius: 6px; padding: 4px 14px; font-size: 11px; color: #9fb4c4; }
      .ed-craft-list { display: flex; flex-direction: column; gap: 3px; }
      .ed-craft-item { display: flex; gap: 4px; }
      .ed-craft-item button { font-size: 11px; }
    `;
    document.head.appendChild(style);
  }

  private buildDom(): void {
    // Left: palette
    const left = el('div', 'ed-left', this.root);
    el('div', 'ed-title', left, 'WORKSHOP');
    const cats = el('div', 'ed-cats', left);
    for (const c of CATEGORIES) {
      const b = el('button', 'hud-btn ed-cat', cats, c.label);
      b.onclick = () => {
        this.activeCategory = c.id;
        this.renderPartList();
        for (const child of cats.children) child.classList.toggle('active', child === b);
      };
      if (c.id === this.activeCategory) b.classList.add('active');
    }
    this.partListEl = el('div', 'ed-parts', left);
    this.renderPartList();

    // Top bar
    const top = el('div', 'ed-topbar', this.root);
    this.nameInput = el('input', 'ed-name', top) as HTMLInputElement;
    this.nameInput.value = this.craft.name;
    this.nameInput.onchange = () => {
      this.craft.name = this.nameInput.value || 'Untitled Craft';
    };
    this.symmetryBtn = el('button', 'hud-btn', top, 'SYM ×1');
    this.symmetryBtn.title = 'Radial symmetry (X)';
    this.symmetryBtn.onclick = () => this.cycleSymmetry();
    const clear = el('button', 'hud-btn', top, 'New');
    clear.onclick = () => {
      this.craft = createCraft('Untitled Craft');
      this.nameInput.value = this.craft.name;
      this.selectedKey = null;
      this.statsDirty = true;
      this.rebuildVisual();
    };
    const save = el('button', 'hud-btn', top, 'Save');
    save.onclick = async () => {
      await writeCraftFile(this.craft.name, this.craft);
      this.refreshCraftList();
    };
    const launch = el('button', 'hud-btn ed-launch', top, '▲ LAUNCH');
    launch.onclick = () => {
      if (this.craft.parts.length > 0) this.cb.onLaunch(structuredClone(this.craft));
    };

    // Right: stats, staging, warnings, craft files
    const right = el('div', 'ed-right', this.root);
    const envPanel = el('div', 'ed-panel', right);
    envPanel.innerHTML = '<h3>ENVIRONMENT</h3>';
    this.envSelect = document.createElement('select');
    this.envSelect.className = 'ed-name';
    this.envSelect.style.width = '100%';
    for (const [val, label] of [
      ['veyra-sl', 'Veyra · sea level'],
      ['veyra-vac', 'Veyra · vacuum'],
      ['palla', 'Palla · surface'],
    ]) {
      const o = document.createElement('option');
      o.value = val;
      o.textContent = label;
      this.envSelect.appendChild(o);
    }
    this.envSelect.onchange = () => (this.statsDirty = true);
    envPanel.appendChild(this.envSelect);

    const statsPanel = el('div', 'ed-panel', right);
    statsPanel.innerHTML = '<h3>ENGINEERING</h3>';
    this.statsEl = el('div', 'ed-stats', statsPanel);

    const stagePanel = el('div', 'ed-panel', right);
    stagePanel.innerHTML = '<h3>STAGING (fires bottom-up)</h3>';
    const stageBtns = el('div', 'map-row', stagePanel);
    const autoBtn = el('button', 'hud-btn', stageBtns, 'Auto-stage');
    autoBtn.onclick = () => {
      this.autoStage();
      this.statsDirty = true;
    };
    const addStage = el('button', 'hud-btn', stageBtns, '+ Stage');
    addStage.onclick = () => {
      this.craft.stages.push({ partKeys: [] });
      this.statsDirty = true;
    };
    this.stagesEl = el('div', '', stagePanel);

    const warnPanel = el('div', 'ed-panel', right);
    warnPanel.innerHTML = '<h3>ADVISOR</h3>';
    this.warningsEl = el('div', '', warnPanel);

    const craftPanel = el('div', 'ed-panel', right);
    craftPanel.innerHTML = '<h3>SAVED CRAFT</h3>';
    this.craftListEl = el('div', 'ed-craft-list', craftPanel);
    this.refreshCraftList();

    el(
      'div',
      'ed-hint',
      this.root,
      'drag from palette to place · click a placed part to highlight · drag it again to move freely · Del removes · X symmetry · drag empty space to orbit · wheel zooms',
    );
  }

  private async refreshCraftList(): Promise<void> {
    const names = await listCraftFiles();
    this.craftListEl.innerHTML = '';
    for (const name of names.slice(0, 12)) {
      const row = el('div', 'ed-craft-item', this.craftListEl);
      const loadBtn = el('button', 'hud-btn', row, name);
      loadBtn.style.flex = '1';
      loadBtn.onclick = async () => {
        const c = await readCraftFile(name);
        if (c) {
          this.craft = c;
          this.nameInput.value = c.name;
          this.selectedKey = null;
          this.statsDirty = true;
          this.rebuildVisual();
        }
      };
    }
    if (!names.length) el('div', 'ed-part-info', this.craftListEl, 'none yet');
  }

  private renderPartList(): void {
    this.partListEl.innerHTML = '';
    for (const def of PARTS.filter((p) => p.category === this.activeCategory)) {
      const card = el('div', 'ed-part', this.partListEl);
      card.draggable = true;
      el('div', 'ed-part-name', card, def.name);
      el('div', 'ed-part-info', card, `${def.massDry} kg · ${def.blurb}`);
      card.onclick = () => this.pickUp(def);
      card.ondragstart = (event) => {
        this.pickUp(def);
        event.dataTransfer?.setData('text/plain', def.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
      };
    }
  }

  private cycleSymmetry(): void {
    const order = [1, 2, 3, 4, 6, 8];
    this.symmetry = order[(order.indexOf(this.symmetry) + 1) % order.length];
    this.symmetryBtn.textContent = `SYM ×${this.symmetry}`;
  }

  private pickUp(def: PartDef): void {
    this.holdingDef = def;
    if (this.ghost) this.scene.remove(this.ghost);
    const tmpCraft = createCraft('ghost');
    addPart(tmpCraft, def.id, null, 'root', { x: 0, y: 0, z: 0 });
    const vis = buildVesselVisual(tmpCraft);
    vis.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.material = new THREE.MeshStandardMaterial({
          color: '#6db3d6',
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
        });
      }
    });
    this.ghost = vis.group;
    this.scene.add(this.ghost);
  }

  private dropHolding(): void {
    this.holdingDef = null;
    if (this.ghost) {
      this.scene.remove(this.ghost);
      this.ghost = null;
    }
  }

  get selectedPartKey(): number | null {
    return this.selectedKey;
  }

  get selectionHighlighted(): boolean {
    return this.selectionHelper !== null && this.selectionHelper.visible;
  }

  private setSelected(key: number | null): void {
    this.selectedKey = key;
    if (this.selectionHelper) {
      this.scene.remove(this.selectionHelper);
      this.selectionHelper.geometry.dispose();
      this.selectionHelper = null;
    }
    if (key !== null && this.visual) {
      const mesh = this.visual.partMeshes.get(key);
      if (mesh) {
        const helper = new THREE.BoxHelper(mesh, 0x6db3d6);
        const material = helper.material as THREE.LineBasicMaterial;
        material.depthTest = false;
        material.transparent = true;
        material.opacity = 0.95;
        helper.renderOrder = 100;
        this.selectionHelper = helper;
        this.scene.add(helper);
      }
    }
    this.statsDirty = true;
  }

  private partKeyForObject(object: THREE.Object3D): number | null {
    let current: THREE.Object3D | null = object;
    while (current) {
      for (const [key, mesh] of this.visual?.partMeshes ?? []) {
        if (mesh === current) return key;
      }
      current = current.parent;
    }
    return null;
  }

  /** Select a placed part and begin free movement on a camera-facing plane. */
  beginPartDrag(nx: number, ny: number): boolean {
    if (this.holdingDef || !this.visual) return false;
    this.pointer.set(nx, ny);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects([...this.visual.partMeshes.values()], true)[0];
    if (!hit) return false;
    const key = this.partKeyForObject(hit.object);
    if (key === null) return false;
    this.setSelected(key);

    const moving = new Set<number>([key]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const part of this.craft.parts) {
        if (part.parentKey !== null && moving.has(part.parentKey) && !moving.has(part.key)) {
          moving.add(part.key);
          grew = true;
        }
      }
    }
    this.movingKeys = moving;
    const part = craftPart(this.craft, key)!;
    const point = new THREE.Vector3(part.position.x, part.position.y, part.position.z);
    const normal = this.camera.getWorldDirection(new THREE.Vector3());
    this.movePlane.setFromNormalAndCoplanarPoint(normal, point);
    this.raycaster.ray.intersectPlane(this.movePlane, this.lastMovePoint);
    return true;
  }

  dragSelectedPart(nx: number, ny: number): void {
    if (!this.movingKeys || !this.visual) return;
    this.pointer.set(nx, ny);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const point = this.raycaster.ray.intersectPlane(this.movePlane, new THREE.Vector3());
    if (!point) return;
    const delta = point.sub(this.lastMovePoint);
    this.lastMovePoint.add(delta);
    for (const key of this.movingKeys) {
      const part = craftPart(this.craft, key);
      if (!part) continue;
      part.position.x += delta.x;
      part.position.y += delta.y;
      part.position.z += delta.z;
      this.visual.partMeshes.get(key)?.position.set(part.position.x, part.position.y, part.position.z);
    }
    this.selectionHelper?.update();
    this.statsDirty = true;
  }

  endPartDrag(): void {
    this.movingKeys = null;
  }

  // ------------------------------------------------------ attachment logic
  /** Free stack node spots on the current craft (public: used by tests). */
  freeStackSpots(): StackNodeSpot[] {
    const spots: StackNodeSpot[] = [];
    for (const p of this.craft.parts) {
      const def = defOf(p);
      const half = def.shape.height / 2;
      const topUsedByParent = p.attach === 'stack-bottom'; // this part hangs below its parent → its top is used
      const bottomUsedByParent = p.attach === 'stack-top';
      const topChild = this.craft.parts.some((c) => c.parentKey === p.key && c.attach === 'stack-top');
      const bottomChild = this.craft.parts.some((c) => c.parentKey === p.key && c.attach === 'stack-bottom');
      if (def.stackTop && !topUsedByParent && !topChild) {
        spots.push({ parentKey: p.key, kind: 'stack-top', pos: new Vec3(p.position.x, p.position.y + half, p.position.z) });
      }
      if (def.stackBottom && !bottomUsedByParent && !bottomChild) {
        spots.push({ parentKey: p.key, kind: 'stack-bottom', pos: new Vec3(p.position.x, p.position.y - half, p.position.z) });
      }
    }
    return spots;
  }

  /** Update ghost position from pointer; compute the attach candidate. */
  updatePointer(nx: number, ny: number): void {
    this.pointer.set(nx, ny);
    if (!this.holdingDef || !this.ghost) {
      this.candidate = null;
      return;
    }
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const def = this.holdingDef;
    const halfH = def.shape.height / 2;

    if (this.craft.parts.length === 0) {
      // Root placement: intersect the y=3 plane.
      const t = (3 - this.raycaster.ray.origin.y) / this.raycaster.ray.direction.y;
      const pos = new Vec3(0, 3, 0);
      this.candidate = { kind: 'root', pos };
      this.ghost.position.set(pos.x, pos.y, pos.z);
      return;
    }

    // Stack node snapping in screen pixels so targets remain usable at every
    // camera zoom. A fixed world-space radius made distant nodes nearly
    // impossible to acquire.
    const spots = this.freeStackSpots();
    let best: { spot: StackNodeSpot; d: number } | null = null;
    const sp = new THREE.Vector3();
    for (const spot of spots) {
      // Held part must have the opposite node.
      if (spot.kind === 'stack-top' && !def.stackBottom) continue;
      if (spot.kind === 'stack-bottom' && !def.stackTop) continue;
      sp.set(spot.pos.x, spot.pos.y, spot.pos.z).project(this.camera);
      if (sp.z < -1 || sp.z > 1) continue;
      const dx = (sp.x - this.pointer.x) * window.innerWidth * 0.5;
      const dy = (sp.y - this.pointer.y) * window.innerHeight * 0.5;
      const d = Math.hypot(dx, dy);
      if (d < 36 && (!best || d < best.d)) best = { spot, d };
    }
    if (best) {
      const { spot } = best;
      const y = spot.kind === 'stack-top' ? spot.pos.y + halfH : spot.pos.y - halfH;
      const pos = new Vec3(spot.pos.x, y, spot.pos.z);
      this.candidate = { kind: 'stack', spot, pos };
      this.ghost.position.set(pos.x, pos.y, pos.z);
      this.ghost.rotation.set(0, 0, 0);
      return;
    }

    // Surface attach: raycast against part meshes.
    if (def.surfaceAttach && this.visual) {
      const hits = this.raycaster.intersectObjects([...this.visual.partMeshes.values()], true);
      if (hits.length) {
        const hit = hits[0];
        // Find which part was hit.
        let obj: THREE.Object3D | null = hit.object;
        let parentKey: number | null = null;
        outer: while (obj) {
          for (const [key, mesh] of this.visual.partMeshes) {
            if (mesh === obj) {
              parentKey = key;
              break outer;
            }
          }
          obj = obj.parent;
        }
        const parentPart = parentKey !== null ? craftPart(this.craft, parentKey) : undefined;
        if (parentPart && defOf(parentPart).acceptsSurfaceAttach) {
          const n = hit.face?.normal
            ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld)
            : new THREE.Vector3(1, 0, 0);
          n.y = 0; // radial attachments stay horizontal
          if (n.lengthSq() < 1e-6) n.set(1, 0, 0);
          n.normalize();
          const depth = (def.shape.depth ?? def.shape.width ?? (def.shape.radiusBottom ?? 0.3) * 2) / 2;
          const pos = new Vec3(
            hit.point.x + n.x * depth,
            hit.point.y,
            hit.point.z + n.z * depth,
          );
          this.candidate = { kind: 'surface', parentKey: parentPart.key, pos, normal: new Vec3(n.x, n.y, n.z) };
          this.ghost.position.set(pos.x, pos.y, pos.z);
          // Face outward.
          const yaw = Math.atan2(n.x, n.z);
          this.ghost.rotation.set(0, yaw, 0);
          return;
        }
      }
    }
    this.candidate = null;
    this.ghost.position.set(0, -100, 0); // hide off-screen
  }

  /** Left click: place held part / select existing part. */
  click(): void {
    if (this.holdingDef && this.candidate) {
      this.placeHeld();
      return;
    }
    // Selection.
    if (!this.visual) return;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects([...this.visual.partMeshes.values()], true);
    if (hits.length) {
      let obj: THREE.Object3D | null = hits[0].object;
      while (obj) {
        for (const [key, mesh] of this.visual.partMeshes) {
          if (mesh === obj) {
            this.setSelected(key);
            return;
          }
        }
        obj = obj.parent;
      }
    }
    this.setSelected(null);
  }

  private placeHeld(): void {
    if (!this.holdingDef || !this.candidate) return;
    const def = this.holdingDef;
    if (this.candidate.kind === 'root') {
      addPart(this.craft, def.id, null, 'root', this.candidate.pos);
    } else if (this.candidate.kind === 'stack') {
      addPart(this.craft, def.id, this.candidate.spot.parentKey, this.candidate.spot.kind, this.candidate.pos);
    } else {
      // Surface with symmetry around the stack (Y) axis.
      const symGroup = this.symmetry > 1 ? Date.now() % 1_000_000 : 0;
      const { pos, parentKey } = this.candidate;
      const parent = craftPart(this.craft, parentKey)!;
      const cx = parent.position.x;
      const cz = parent.position.z;
      const relX = pos.x - cx;
      const relZ = pos.z - cz;
      const baseAngle = Math.atan2(relX, relZ);
      const radius = Math.hypot(relX, relZ);
      for (let i = 0; i < this.symmetry; i++) {
        const a = baseAngle + (i / this.symmetry) * Math.PI * 2;
        const rot = { x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) };
        addPart(
          this.craft,
          def.id,
          parentKey,
          'surface',
          { x: cx + Math.sin(a) * radius, y: pos.y, z: cz + Math.cos(a) * radius },
          rot,
          symGroup,
        );
      }
    }
    // Auto-add to staging where obvious.
    const added = this.craft.parts[this.craft.parts.length - 1];
    const addedDef = defOf(added);
    if (addedDef.engine || addedDef.decoupler || addedDef.parachute) {
      // leave to auto-stage / manual for now
    }
    this.statsDirty = true;
    this.rebuildVisual();
    if (this.symmetry === 1 && !def.surfaceAttach) this.dropHolding();
    else if (this.candidate.kind !== 'surface') this.dropHolding();
    // keep holding surface parts for repeat placement
  }

  /** Delete selected subtree / cancel holding. */
  deleteSelected(): void {
    if (this.holdingDef) {
      this.dropHolding();
      return;
    }
    if (this.selectedKey !== null) {
      removeSubtree(this.craft, this.selectedKey);
      this.setSelected(null);
      this.statsDirty = true;
      this.rebuildVisual();
    }
  }

  /** Generate a sensible staging sequence from the craft layout. */
  autoStage(): void {
    this.craft.stages = buildAutoStages(this.craft);
  }

  // ------------------------------------------------------------- rendering
  rebuildVisual(): void {
    if (this.selectionHelper) {
      this.scene.remove(this.selectionHelper);
      this.selectionHelper.geometry.dispose();
      this.selectionHelper = null;
    }
    if (this.visual) this.scene.remove(this.visual.group);
    this.visual = buildVesselVisual(this.craft);
    this.scene.add(this.visual.group);
    if (this.selectedKey !== null) this.setSelected(this.selectedKey);
  }

  orbitCamera(dx: number, dy: number): void {
    this.camYaw -= dx * 0.006;
    this.camPitch = Math.max(-0.5, Math.min(1.35, this.camPitch + dy * 0.006));
  }

  zoomCamera(factor: number): void {
    this.camDist = Math.max(4, Math.min(80, this.camDist * factor));
  }

  setVisible(vis: boolean): void {
    this.root.style.display = vis ? '' : 'none';
  }

  /** Per-frame: camera + stats refresh. */
  update(): void {
    // Camera orbits the craft's vertical middle.
    let midY = 3;
    if (this.craft.parts.length) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of this.craft.parts) {
        lo = Math.min(lo, p.position.y);
        hi = Math.max(hi, p.position.y);
      }
      midY = (lo + hi) / 2;
    }
    this.camHeight = midY;
    const cx = Math.cos(this.camYaw) * Math.cos(this.camPitch) * this.camDist;
    const cz = Math.sin(this.camYaw) * Math.cos(this.camPitch) * this.camDist;
    const cy = midY + Math.sin(this.camPitch) * this.camDist;
    this.camera.position.set(cx, cy, cz);
    this.camera.lookAt(0, midY, 0);

    if (this.statsDirty) {
      this.statsDirty = false;
      this.refreshStats();
      this.refreshStages();
    }
  }

  private refreshStats(): void {
    const env = this.envSelect.value;
    const gravity = env === 'palla' ? 1.51 : 9.42;
    const pressure = env === 'veyra-sl' ? 101_325 : 0;
    const a = analyzeCraft(this.craft, gravity, pressure);
    const props = computeMassProperties(this.craft);
    const aero = buildAeroModel(this.craft);

    let text = `parts   ${a.partCount}\nmass    ${(a.mass / 1000).toFixed(2)} t (dry ${(a.dryMass / 1000).toFixed(2)})\ncrew    ${a.crewCapacity}\n`;
    text += `Δv tot  ${a.totalDeltaV.toFixed(0)} m/s\n`;
    const stability = aero.copY - props.com.y;
    text += `CoM y   ${props.com.y.toFixed(2)} m\nCoP−CoM ${stability >= 0 ? '+' : ''}${stability.toFixed(2)} m ${stability < -0.15 ? '(stable)' : stability > 0.15 ? '(UNSTABLE)' : '(neutral)'}\n`;
    text += `───────────────\n`;
    for (const s of [...a.stages].reverse()) {
      if (s.thrust === 0 && s.deltaV === 0) {
        text += `S${s.stageIndex}  —\n`;
        continue;
      }
      text += `S${s.stageIndex}  Δv ${s.deltaV.toFixed(0)}  TWR ${s.twrStart.toFixed(2)}  ${s.burnTime === 0 ? '' : `${s.burnTime.toFixed(0)}s`}\n`;
    }
    this.statsEl.textContent = text;

    this.warningsEl.innerHTML = '';
    const warnings = [...a.warnings];
    if (stability > 0.15 && aero.liftSurfaces.length === 0) {
      warnings.push('Center of pressure is ahead of center of mass: add fins near the tail.');
    }
    const s0 = a.stages.find((s) => s.thrust > 0);
    if (s0 && s0.twrStart < 1.05 && env !== 'palla') {
      warnings.push(`First firing stage TWR is ${s0.twrStart.toFixed(2)} — it will not lift off.`);
    }
    if (!this.craft.parts.some((p) => defOf(p).parachute)) {
      warnings.push('No parachute: returning crew will have a very firm arrival.');
    }
    for (const w of warnings) el('div', 'ed-warn', this.warningsEl, `⚠ ${w}`);
    if (!warnings.length) el('div', 'ed-part-info', this.warningsEl, 'no complaints — impressive');
  }

  private refreshStages(): void {
    this.stagesEl.innerHTML = '';
    this.craft.stages.forEach((stage, i) => {
      const div = el('div', 'ed-stage', this.stagesEl);
      const head = el('div', 'ed-stage-head', div);
      el('span', '', head, `STAGE ${i}`);
      const del = el('button', 'hud-btn', head, '×');
      del.onclick = () => {
        this.craft.stages.splice(i, 1);
        this.statsDirty = true;
      };
      const assign = el('button', 'hud-btn', head, '+sel');
      assign.title = 'Add selected part to this stage';
      assign.onclick = () => {
        if (this.selectedKey !== null && !stage.partKeys.includes(this.selectedKey)) {
          for (const s of this.craft.stages) {
            s.partKeys = s.partKeys.filter((k) => k !== this.selectedKey);
          }
          stage.partKeys.push(this.selectedKey);
          this.statsDirty = true;
        }
      };
      const names = stage.partKeys
        .map((k) => craftPart(this.craft, k))
        .filter(Boolean)
        .map((p) => defOf(p!).name)
        .join(', ');
      el('div', '', div, names || '(empty)');
    });
  }
}
