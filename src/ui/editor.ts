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
import { Quat } from '../core/quat';
import {
  ACTION_GROUP_IDS,
  addPart,
  analyzeCraft,
  Craft,
  createCraft,
  craftPart,
  defOf,
  PartInstance,
  type PartAction,
  removeSubtree,
  buildAutoStages,
} from '../sim/vessel';
import { PARTS, PartDef, partById } from '../content/parts';
import { buildAeroModel } from '../sim/aero';
import { computeMassProperties } from '../sim/vessel';
import { buildVesselVisual, disposeVesselVisual, VesselVisual, type VesselVisualSource } from '../render/vesselMesh';
import type { PartModelLibrary } from '../render/partModelLibrary';
import { deleteCraftFile, listCraftFiles, readCraftFile, writeCraftFile } from '../save/persistence';
import { el, injectUiStyles } from './kit';

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

const SNAP_ANGLES = [0, 5, 15, 45, 90] as const;

function partThumbnail(def: PartDef): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 56;
  canvas.height = 56;
  canvas.className = 'ed-part-thumb';
  const context = canvas.getContext('2d')!;
  context.translate(28, 28);
  context.fillStyle = def.color ?? '#b9c4ca';
  context.strokeStyle = def.accent ?? '#4f7186';
  context.lineWidth = 3;
  const height = Math.min(42, Math.max(16, def.shape.height * 18));
  const width = Math.min(38, Math.max(10, (def.shape.width ?? (def.shape.radiusBottom ?? 0.4) * 2) * 15));
  context.beginPath();
  if (def.shape.kind === 'cone') {
    const top = Math.max(3, (def.shape.radiusTop ?? 0.1) * 15);
    context.moveTo(-top, -height / 2);
    context.lineTo(top, -height / 2);
    context.lineTo(width / 2, height / 2);
    context.lineTo(-width / 2, height / 2);
    context.closePath();
  } else if (def.shape.kind === 'capsule' || def.shape.kind === 'dome') {
    context.ellipse(0, 0, width / 2, height / 2, 0, 0, Math.PI * 2);
  } else {
    context.rect(-width / 2, -height / 2, width, height);
  }
  context.fill();
  context.stroke();
  return canvas;
}

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
  /** Ghost's visual wrapper and its temporary translucent materials, released on drop. */
  private ghostVisual: VesselVisual | null = null;
  private ghostMaterials: THREE.Material[] = [];
  private holdingDef: PartDef | null = null;
  private holdingRotation = new Quat();
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
  private camFocusOffset = new Vec3();
  private cb: EditorCallbacks;

  private partListEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private stagesEl!: HTMLElement;
  private warningsEl!: HTMLElement;
  private nameInput!: HTMLInputElement;
  private envSelect!: HTMLSelectElement;
  private symmetryBtn!: HTMLElement;
  private snapBtn!: HTMLElement;
  private searchInput!: HTMLInputElement;
  private sortSelect!: HTMLSelectElement;
  private craftListEl!: HTMLElement;
  private statsDirty = true;
  private activeCategory: PartDef['category'] = 'pods';
  private snapIndex = 2;
  private symmetryMode: 'radial' | 'mirror' = 'radial';
  private history: Craft[] = [];
  private redoHistory: Craft[] = [];
  private moveSnapshot: Craft | null = null;
  private partContextEl: HTMLElement | null = null;
  /** Ghost attach candidate this frame. */
  private candidate:
    | { kind: 'stack'; spot: StackNodeSpot; pos: Vec3 }
    | { kind: 'surface'; parentKey: number; pos: Vec3; normal: Vec3 }
    | { kind: 'root'; pos: Vec3 }
    | null = null;

  constructor(uiRoot: HTMLElement, cb: EditorCallbacks, private readonly partModels?: PartModelLibrary) {
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
    injectUiStyles();
    this.buildDom();
    this.rebuildVisual();
    this.setVisible(false);
  }

  private buildDom(): void {
    // Left: palette
    const left = el('div', 'ed-left', this.root);
    el('div', 'ed-title', left, 'WORKSHOP');
    const cats = el('div', 'ed-cats', left);
    for (const c of CATEGORIES) {
      const b = el('button', 'hud-btn ed-cat', cats, c.label);
      b.dataset.cat = c.id;
      b.onclick = () => {
        this.activeCategory = c.id;
        this.renderPartList();
        for (const child of cats.children) child.classList.toggle('active', child === b);
      };
      if (c.id === this.activeCategory) b.classList.add('active');
    }
    const paletteTools = el('div', 'ed-palette-tools', left);
    this.searchInput = el('input', 'ed-search', paletteTools) as HTMLInputElement;
    this.searchInput.placeholder = 'Search parts';
    this.searchInput.oninput = () => this.renderPartList();
    this.sortSelect = el('select', 'ed-sort', paletteTools) as HTMLSelectElement;
    for (const [value, label] of [['category', 'Catalog'], ['mass', 'Mass'], ['thrust', 'Thrust'], ['name', 'Name']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      this.sortSelect.appendChild(option);
    }
    this.sortSelect.onchange = () => this.renderPartList();
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
    this.snapBtn = el('button', 'hud-btn', top, `SNAP ${SNAP_ANGLES[this.snapIndex]}°`);
    this.snapBtn.title = 'Cycle angle snap (C)';
    this.snapBtn.onclick = () => this.cycleSnap();
    const clear = el('button', 'hud-btn', top, 'New');
    clear.onclick = () => {
      this.pushHistory();
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
    autoBtn.dataset.action = 'auto-stage';
    autoBtn.onclick = () => {
      this.autoStage();
      this.statsDirty = true;
    };
    const addStage = el('button', 'hud-btn', stageBtns, '+ Stage');
    addStage.onclick = () => {
      this.pushHistory();
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
      'drag parts to build · drag stage chips to reorder · Ctrl+Z/Y history · C angle snap · X symmetry · ? controls',
    );
  }

  private async refreshCraftList(): Promise<void> {
    const names = await listCraftFiles();
    this.craftListEl.innerHTML = '';
    for (const name of names.slice(0, 12)) {
      const saved = await readCraftFile(name);
      if (!saved) continue;
      const row = el('div', 'ed-craft-item', this.craftListEl);
      const copy = el('div', 'ed-craft-copy', row);
      el('strong', '', copy, name);
      const analysis = analyzeCraft(saved, 9.42, 101_325);
      el('span', '', copy, `${saved.parts.length} parts · ${(analysis.mass / 1000).toFixed(1)} t · ${analysis.totalDeltaV.toFixed(0)} m/s`);
      const loadBtn = el('button', 'hud-btn', row, 'Load');
      loadBtn.setAttribute('aria-label', name);
      loadBtn.title = `Load ${name}`;
      loadBtn.onclick = async () => {
        const c = await readCraftFile(name);
        if (c) {
          this.pushHistory();
          this.craft = c;
          this.nameInput.value = c.name;
          this.selectedKey = null;
          this.statsDirty = true;
          this.rebuildVisual();
        }
      };
      const duplicate = el('button', 'k-window-btn', row, '⧉');
      duplicate.title = 'Duplicate';
      duplicate.onclick = async () => {
        const nextName = `${name} Copy`;
        await writeCraftFile(nextName, { ...structuredClone(saved), name: nextName });
        await this.refreshCraftList();
      };
      const rename = el('button', 'k-window-btn', row, '✎');
      rename.title = 'Rename';
      rename.onclick = async () => {
        const nextName = window.prompt('Rename saved craft', name)?.trim();
        if (!nextName || nextName === name) return;
        await writeCraftFile(nextName, { ...structuredClone(saved), name: nextName });
        await deleteCraftFile(name);
        await this.refreshCraftList();
      };
      const remove = el('button', 'k-window-btn', row, '×');
      remove.title = 'Delete';
      remove.onclick = async () => {
        if (!window.confirm(`Delete saved craft “${name}”?`)) return;
        await deleteCraftFile(name);
        await this.refreshCraftList();
      };
    }
    if (!names.length) el('div', 'ed-part-info', this.craftListEl, 'none yet');
  }

  private renderPartList(): void {
    this.partListEl.innerHTML = '';
    const query = this.searchInput?.value.trim().toLowerCase() ?? '';
    const parts = PARTS.filter((part) => (
      (!query && part.category === this.activeCategory)
      || (query && `${part.name} ${part.blurb} ${part.category}`.toLowerCase().includes(query))
    ));
    if (this.sortSelect?.value === 'mass') parts.sort((a, b) => a.massDry - b.massDry);
    else if (this.sortSelect?.value === 'thrust') parts.sort((a, b) => (b.engine?.thrustVac ?? 0) - (a.engine?.thrustVac ?? 0));
    else if (this.sortSelect?.value === 'name') parts.sort((a, b) => a.name.localeCompare(b.name));
    for (const def of parts) {
      const card = el('div', 'ed-part', this.partListEl);
      card.draggable = true;
      card.appendChild(partThumbnail(def));
      const copy = el('div', 'ed-part-copy', card);
      el('div', 'ed-part-name', copy, def.name);
      const stats = [
        `${def.massDry} kg`,
        `${def.cost} funds`,
        def.engine ? `${(def.engine.thrustVac / 1000).toFixed(0)} kN` : '',
      ].filter(Boolean).join(' · ');
      el('div', 'ed-part-info', copy, stats);
      el('div', 'ed-part-blurb', copy, def.blurb);
      card.title = [
        def.name,
        def.blurb,
        `Dry mass: ${def.massDry} kg`,
        `Max temperature: ${def.maxTemp} K`,
        `Crash tolerance: ${def.crashTolerance} m/s`,
        def.engine ? `Thrust: ${(def.engine.thrustVac / 1000).toFixed(1)} kN · Isp ${def.engine.ispSea}/${def.engine.ispVac} s` : '',
        def.resources ? `Resources: ${Object.entries(def.resources).map(([key, value]) => `${key} ${value}`).join(', ')}` : '',
      ].filter(Boolean).join('\n');
      card.onclick = () => this.pickUp(def);
      card.ondragstart = (event) => {
        this.pickUp(def);
        event.dataTransfer?.setData('text/plain', def.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
      };
    }
    if (!parts.length) el('div', 'mission-empty', this.partListEl, 'No matching parts');
  }

  cycleSymmetry(direction = 1): void {
    const order = [1, 2, 3, 4, 6, 8];
    this.symmetry = order[(order.indexOf(this.symmetry) + direction + order.length) % order.length];
    this.symmetryBtn.textContent = `${this.symmetryMode === 'radial' ? 'RAD' : 'MIR'} ×${this.symmetry}`;
  }

  cycleSnap(): void {
    this.snapIndex = (this.snapIndex + 1) % SNAP_ANGLES.length;
    this.snapBtn.textContent = `SNAP ${SNAP_ANGLES[this.snapIndex] ? `${SNAP_ANGLES[this.snapIndex]}°` : 'OFF'}`;
  }

  toggleSymmetryMode(): void {
    this.symmetryMode = this.symmetryMode === 'radial' ? 'mirror' : 'radial';
    this.symmetryBtn.textContent = `${this.symmetryMode === 'radial' ? 'RAD' : 'MIR'} ×${this.symmetry}`;
  }

  private pickUp(def: PartDef): void {
    this.holdingDef = def;
    this.holdingRotation.set(0, 0, 0, 1);
    if (this.ghost) this.scene.remove(this.ghost);
    const tmpCraft = createCraft('ghost');
    addPart(tmpCraft, def.id, null, 'root', { x: 0, y: 0, z: 0 });
    const vis = buildVesselVisual(tmpCraft, this.partModels);
    // Give the clone its own translucent materials; never mutate shared model
    // materials. Track them so drop can dispose exactly what pickup created.
    this.ghostMaterials = [];
    vis.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        const material = new THREE.MeshStandardMaterial({
          color: '#6db3d6',
          transparent: true,
          opacity: 0.55,
          depthWrite: false,
        });
        mesh.material = material;
        this.ghostMaterials.push(material);
      }
    });
    this.ghostVisual = vis;
    this.ghost = vis.group;
    this.scene.add(this.ghost);
  }

  private dropHolding(): void {
    this.holdingDef = null;
    this.holdingRotation.set(0, 0, 0, 1);
    if (this.ghost) {
      this.scene.remove(this.ghost);
      this.ghost = null;
    }
    if (this.ghostVisual) {
      disposeVesselVisual(this.ghostVisual);
      this.ghostVisual = null;
    }
    for (const material of this.ghostMaterials) material.dispose();
    this.ghostMaterials = [];
  }

  get selectedPartKey(): number | null {
    return this.selectedKey;
  }

  get hasPartSelection(): boolean {
    return this.selectedKey !== null || this.holdingDef !== null;
  }

  private pushHistory(snapshot: Craft = this.craft): void {
    this.history.push(structuredClone(snapshot));
    if (this.history.length > 50) this.history.shift();
    this.redoHistory = [];
  }

  undo(): void {
    const previous = this.history.pop();
    if (!previous) return;
    this.redoHistory.push(structuredClone(this.craft));
    this.restoreCraftSnapshot(previous);
  }

  redo(): void {
    const next = this.redoHistory.pop();
    if (!next) return;
    this.history.push(structuredClone(this.craft));
    this.restoreCraftSnapshot(next);
  }

  private restoreCraftSnapshot(snapshot: Craft): void {
    this.dropHolding();
    this.craft = structuredClone(snapshot);
    this.nameInput.value = this.craft.name;
    this.setSelected(null);
    this.statsDirty = true;
    this.rebuildVisual();
  }

  focusSearch(): void {
    this.searchInput.focus();
    this.searchInput.select();
  }

  cycleCategory(direction: number): void {
    const index = CATEGORIES.findIndex((category) => category.id === this.activeCategory);
    this.activeCategory = CATEGORIES[(index + direction + CATEGORIES.length) % CATEGORIES.length].id;
    this.searchInput.value = '';
    for (const button of this.root.querySelectorAll<HTMLElement>('.ed-cat')) {
      button.classList.toggle('active', button.dataset.cat === this.activeCategory);
    }
    this.renderPartList();
  }

  cancelHolding(): void {
    this.dropHolding();
  }

  /**
   * Read-only test probe: how a placed part is currently rendered — an imported
   * checked model or the procedural fallback — or null if no such part. Does not
   * mutate editor state.
   */
  visualSourceForPart(key: number): VesselVisualSource | null {
    const source = this.visual?.partMeshes.get(key)?.userData.visualSource;
    return source === 'model' || source === 'procedural' ? source : null;
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
    this.refreshPartContext();
  }

  private refreshPartContext(): void {
    this.partContextEl?.remove();
    this.partContextEl = null;
    if (this.selectedKey === null) return;
    const part = craftPart(this.craft, this.selectedKey);
    if (!part) return;
    const definition = defOf(part);
    const panel = el('div', 'ed-part-context', this.root);
    this.partContextEl = panel;
    const heading = el('div', 'hud-part-heading', panel);
    el('strong', '', heading, definition.name);
    const close = el('button', 'k-window-btn', heading, '×');
    close.onclick = () => this.setSelected(null);
    el('div', 'ed-part-context-meta', panel, `${part.attach} · symmetry ${part.symmetry || 'none'} · ${definition.crossfeed ? 'crossfeed' : 'isolated'}`);
    const actions = el('div', 'ed-part-context-actions', panel);
    const remove = el('button', 'hud-btn', actions, 'Remove');
    remove.onclick = () => this.deleteSelected();
    const frame = el('button', 'hud-btn', actions, 'Frame');
    frame.onclick = () => this.frameSelected();
    const reroot = el('button', 'hud-btn', actions, 'Re-root');
    reroot.onclick = () => this.rerootSelected();
    if (part.attach === 'surface') {
      const align = el('button', 'hud-btn', actions, 'Center Y');
      align.onclick = () => this.verticalAlignSelected();
    }
    const actionRow = el('div', 'mission-section-title', panel, 'ACTION GROUP');
    const actionSelect = document.createElement('select');
    actionSelect.className = 'ed-action-select';
    for (const action of ['toggle', 'activate', 'deactivate'] as const) {
      const option = document.createElement('option');
      option.value = action;
      option.textContent = action.toUpperCase();
      actionSelect.appendChild(option);
    }
    actionRow.appendChild(actionSelect);
    const groups = el('div', 'ed-action-groups', panel);
    for (const group of ACTION_GROUP_IDS) {
      const assignment = this.craft.actionGroups[group]?.find((candidate) => candidate.partKey === part.key);
      const assigned = Boolean(assignment);
      const button = el('button', 'hud-btn', groups, String(group === 10 ? 0 : group));
      button.classList.toggle('active', assigned);
      button.title = assignment ? `Assigned: ${assignment.action}` : 'Not assigned';
      button.onclick = () => {
        this.pushHistory();
        const assignments = this.craft.actionGroups[group] ?? [];
        this.craft.actionGroups[group] = assigned
          ? assignments.filter((assignment) => assignment.partKey !== part.key)
          : [...assignments, { partKey: part.key, action: actionSelect.value as PartAction }];
        if (!this.craft.actionGroups[group]?.length) delete this.craft.actionGroups[group];
        this.refreshPartContext();
      };
    }
  }

  rotateSelected(axis: 'x' | 'y' | 'z', direction: number, fine = false): void {
    const snap = SNAP_ANGLES[this.snapIndex] || 1;
    const angle = snap * (fine ? 0.2 : 1) * direction * Math.PI / 180;
    const axisVector = axis === 'x' ? new Vec3(1, 0, 0) : axis === 'y' ? new Vec3(0, 1, 0) : new Vec3(0, 0, 1);
    if (this.holdingDef) {
      this.holdingRotation.multiply(new Quat().setFromAxisAngle(axisVector, angle)).normalize();
      this.applyGhostRotation();
      return;
    }
    if (this.selectedKey === null) return;
    const part = craftPart(this.craft, this.selectedKey);
    if (!part || part.attach !== 'surface') return;
    this.pushHistory();
    const rotation = new Quat(part.rotation.x, part.rotation.y, part.rotation.z, part.rotation.w);
    rotation.multiply(new Quat().setFromAxisAngle(axisVector, angle)).normalize();
    part.rotation = { ...rotation };
    this.statsDirty = true;
    this.rebuildVisual();
  }

  resetSelectedRotation(): void {
    if (this.holdingDef) {
      this.holdingRotation.set(0, 0, 0, 1);
      this.applyGhostRotation();
      return;
    }
    if (this.selectedKey === null) return;
    const part = craftPart(this.craft, this.selectedKey);
    if (!part || part.attach !== 'surface') return;
    this.pushHistory();
    part.rotation = { x: 0, y: 0, z: 0, w: 1 };
    this.rebuildVisual();
  }

  private applyGhostRotation(baseYaw = 0): void {
    if (!this.ghost) return;
    const base = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), baseYaw);
    base.multiply(this.holdingRotation).normalize();
    this.ghost.quaternion.set(base.x, base.y, base.z, base.w);
  }

  verticalAlignSelected(): void {
    if (this.selectedKey === null) return;
    const part = craftPart(this.craft, this.selectedKey);
    const parent = part?.parentKey !== null && part?.parentKey !== undefined
      ? craftPart(this.craft, part.parentKey)
      : null;
    if (!part || part.attach !== 'surface' || !parent) return;
    this.pushHistory();
    part.position.y = parent.position.y;
    this.statsDirty = true;
    this.rebuildVisual();
  }

  rerootSelected(): void {
    if (this.selectedKey === null) return;
    const selected = craftPart(this.craft, this.selectedKey);
    if (!selected || selected.parentKey === null) return;
    const path: PartInstance[] = [];
    let current: PartInstance | undefined = selected;
    while (current) {
      path.push(current);
      current = current.parentKey === null ? undefined : craftPart(this.craft, current.parentKey);
    }
    this.pushHistory();
    const oldAttach = path.map((part) => part.attach);
    path[0].parentKey = null;
    path[0].attach = 'root';
    for (let index = 1; index < path.length; index++) {
      path[index].parentKey = path[index - 1].key;
      const previousAttach = oldAttach[index - 1];
      path[index].attach = previousAttach === 'stack-top'
        ? 'stack-bottom'
        : previousAttach === 'stack-bottom'
          ? 'stack-top'
          : 'surface';
    }
    this.statsDirty = true;
    this.rebuildVisual();
  }

  fitCamera(): void {
    this.camFocusOffset.set(0, 0, 0);
    if (!this.craft.parts.length) {
      this.camDist = 16;
      return;
    }
    const ys = this.craft.parts.map((part) => part.position.y);
    const span = Math.max(4, Math.max(...ys) - Math.min(...ys) + 4);
    this.camDist = Math.max(8, Math.min(80, span * 1.4));
  }

  frameSelected(): void {
    if (this.selectedKey === null) return;
    const part = craftPart(this.craft, this.selectedKey);
    if (!part) return;
    const mid = this.craft.parts.length
      ? (Math.min(...this.craft.parts.map((candidate) => candidate.position.y)) + Math.max(...this.craft.parts.map((candidate) => candidate.position.y))) / 2
      : 3;
    this.camFocusOffset.set(part.position.x, part.position.y - mid, part.position.z);
    this.camDist = Math.max(5, Math.min(this.camDist, 12));
  }

  panCameraLocal(x: number, y: number, z: number): void {
    this.camFocusOffset.x += x;
    this.camFocusOffset.y += y;
    this.camFocusOffset.z += z;
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
  beginPartDrag(nx: number, ny: number, duplicate = false): boolean {
    if (this.holdingDef || !this.visual) return false;
    this.pointer.set(nx, ny);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects([...this.visual.partMeshes.values()], true)[0];
    if (!hit) return false;
    const key = this.partKeyForObject(hit.object);
    if (key === null) return false;
    this.moveSnapshot = structuredClone(this.craft);

    let movingRoot = key;
    if (duplicate) movingRoot = this.duplicateSubtree(key);
    this.setSelected(movingRoot);

    const moving = new Set<number>([movingRoot]);
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
    const part = craftPart(this.craft, movingRoot)!;
    const point = new THREE.Vector3(part.position.x, part.position.y, part.position.z);
    const normal = this.camera.getWorldDirection(new THREE.Vector3());
    this.movePlane.setFromNormalAndCoplanarPoint(normal, point);
    this.raycaster.ray.intersectPlane(this.movePlane, this.lastMovePoint);
    return true;
  }

  private duplicateSubtree(rootKey: number): number {
    const sourceKeys = new Set<number>([rootKey]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const part of this.craft.parts) {
        if (part.parentKey !== null && sourceKeys.has(part.parentKey) && !sourceKeys.has(part.key)) {
          sourceKeys.add(part.key);
          grew = true;
        }
      }
    }
    const keyMap = new Map<number, number>();
    for (const source of this.craft.parts.filter((part) => sourceKeys.has(part.key))) {
      const copy = structuredClone(source);
      copy.key = this.craft.nextKey++;
      keyMap.set(source.key, copy.key);
      copy.parentKey = source.parentKey !== null && sourceKeys.has(source.parentKey)
        ? keyMap.get(source.parentKey) ?? source.parentKey
        : source.parentKey;
      copy.symmetry = 0;
      this.craft.parts.push(copy);
    }
    this.statsDirty = true;
    this.rebuildVisual();
    return keyMap.get(rootKey)!;
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
    if (this.moveSnapshot) this.pushHistory(this.moveSnapshot);
    this.moveSnapshot = null;
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
      this.applyGhostRotation();
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
          this.applyGhostRotation(yaw);
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
    this.pushHistory();
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
        const radialAngle = baseAngle + (i / this.symmetry) * Math.PI * 2;
        const a = this.symmetryMode === 'mirror' && i % 2 === 1
          ? -baseAngle + (Math.floor(i / 2) / Math.max(1, Math.ceil(this.symmetry / 2))) * Math.PI * 2
          : radialAngle;
        const rotQuat = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), a);
        rotQuat.multiply(this.holdingRotation).normalize();
        const rot = { x: rotQuat.x, y: rotQuat.y, z: rotQuat.z, w: rotQuat.w };
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
      this.pushHistory();
      removeSubtree(this.craft, this.selectedKey);
      this.setSelected(null);
      this.statsDirty = true;
      this.rebuildVisual();
    }
  }

  /** Generate a sensible staging sequence from the craft layout. */
  autoStage(): void {
    this.pushHistory();
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
    this.visual = buildVesselVisual(this.craft, this.partModels);
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
    this.camHeight = midY + this.camFocusOffset.y;
    const cx = Math.cos(this.camYaw) * Math.cos(this.camPitch) * this.camDist;
    const cz = Math.sin(this.camYaw) * Math.cos(this.camPitch) * this.camDist;
    const cy = this.camHeight + Math.sin(this.camPitch) * this.camDist;
    this.camera.position.set(cx + this.camFocusOffset.x, cy, cz + this.camFocusOffset.z);
    this.camera.lookAt(this.camFocusOffset.x, this.camHeight, this.camFocusOffset.z);

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

    const stability = aero.copY - props.com.y;
    this.statsEl.innerHTML = '';
    const totals = el('div', 'ed-engineering-grid', this.statsEl);
    const stat = (label: string, value: string) => {
      el('span', 'ed-engineering-key', totals, label);
      el('span', 'ed-engineering-value', totals, value);
    };
    stat('Parts', String(a.partCount));
    stat('Wet mass', `${(a.mass / 1000).toFixed(2)} t`);
    stat('Dry mass', `${(a.dryMass / 1000).toFixed(2)} t`);
    stat('Crew', String(a.crewCapacity));
    stat('Total Δv', `${a.totalDeltaV.toFixed(0)} m/s`);
    stat('CoM height', `${props.com.y.toFixed(2)} m`);
    stat('Stability', `${stability >= 0 ? '+' : ''}${stability.toFixed(2)} m · ${stability < -0.15 ? 'stable' : stability > 0.15 ? 'unstable' : 'neutral'}`);
    const stageTable = el('div', 'ed-engineering-stages', this.statsEl);
    for (const stage of [...a.stages].reverse()) {
      const row = el('div', 'ed-engineering-stage', stageTable);
      el('strong', '', row, `S${stage.stageIndex}`);
      el('span', '', row, stage.thrust || stage.deltaV
        ? `Δv ${stage.deltaV.toFixed(0)} · TWR ${stage.twrStart.toFixed(2)} · ${stage.burnTime.toFixed(0)}s`
        : '—');
    }

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
    for (const w of warnings) {
      const warning = el('div', 'ed-warn', this.warningsEl, `⚠ ${w}`);
      const suspect = w.toLowerCase().includes('twr') || w.toLowerCase().includes('staging')
        ? this.craft.parts.find((part) => defOf(part).engine || defOf(part).decoupler)
        : w.toLowerCase().includes('pressure') || w.toLowerCase().includes('stability')
          ? this.craft.parts.find((part) => defOf(part).wing)
          : undefined;
      if (suspect) {
        warning.classList.add('linked');
        warning.title = `Select ${defOf(suspect).name}`;
        warning.onclick = () => this.setSelected(suspect.key);
      }
    }
    if (!warnings.length) el('div', 'ed-part-info', this.warningsEl, 'no complaints — impressive');
  }

  private refreshStages(): void {
    this.stagesEl.innerHTML = '';
    const env = this.envSelect.value;
    const analysis = analyzeCraft(this.craft, env === 'palla' ? 1.51 : 9.42, env === 'veyra-sl' ? 101_325 : 0);
    const assigned = new Set(this.craft.stages.flatMap((stage) => stage.partKeys));
    const unstaged = el('div', 'ed-stage ed-unstaged', this.stagesEl);
    el('div', 'ed-stage-title', unstaged, 'UNSTAGED');
    const unstagedParts = el('div', 'ed-stage-parts', unstaged);
    this.addStageDropTarget(unstaged, null);
    for (const part of this.craft.parts.filter((candidate) => !assigned.has(candidate.key))) {
      this.renderStagePart(unstagedParts, part);
    }
    [...this.craft.stages].map((stage, index) => ({ stage, index })).reverse().forEach(({ stage, index: i }) => {
      const div = el('div', 'ed-stage', this.stagesEl);
      div.draggable = true;
      div.ondragstart = (event) => event.dataTransfer?.setData('application/x-perilune-stage', String(i));
      this.addStageDropTarget(div, i);
      const head = el('div', 'ed-stage-head', div);
      el('span', '', head, `STAGE ${i}`);
      const metrics = analysis.stages[i];
      el('span', 'ed-stage-metrics', head, metrics
        ? `Δv ${metrics.deltaV.toFixed(0)} · TWR ${metrics.twrStart.toFixed(2)} · ${metrics.burnTime.toFixed(0)}s`
        : '—');
      const del = el('button', 'hud-btn', head, '×');
      del.onclick = () => {
        this.pushHistory();
        this.craft.stages.splice(i, 1);
        this.statsDirty = true;
      };
      const parts = el('div', 'ed-stage-parts', div);
      for (const key of stage.partKeys) {
        const part = craftPart(this.craft, key);
        if (part) this.renderStagePart(parts, part);
      }
      if (!stage.partKeys.length) el('span', 'ed-part-info', parts, 'drop staged parts here');
    });
  }

  private renderStagePart(parent: HTMLElement, part: PartInstance): void {
    const definition = defOf(part);
    const icon = definition.engine ? '▲' : definition.decoupler ? '║' : definition.parachute ? '▽' : '◆';
    const chip = el('div', 'ed-stage-part', parent, `${icon} ${definition.name}`);
    chip.draggable = true;
    chip.dataset.partKey = String(part.key);
    chip.ondragstart = (event) => {
      event.stopPropagation();
      event.dataTransfer?.setData('application/x-perilune-part', String(part.key));
    };
    chip.onclick = () => this.setSelected(part.key);
  }

  private addStageDropTarget(element: HTMLElement, targetIndex: number | null): void {
    element.ondragover = (event) => {
      if (
        event.dataTransfer?.types.includes('application/x-perilune-part')
        || event.dataTransfer?.types.includes('application/x-perilune-stage')
      ) event.preventDefault();
    };
    element.ondrop = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const rawPart = event.dataTransfer?.getData('application/x-perilune-part');
      if (rawPart) {
        const key = Number(rawPart);
        if (!Number.isInteger(key)) return;
        this.pushHistory();
        for (const stage of this.craft.stages) stage.partKeys = stage.partKeys.filter((candidate) => candidate !== key);
        if (targetIndex !== null) this.craft.stages[targetIndex].partKeys.push(key);
        this.statsDirty = true;
        return;
      }
      const rawStage = event.dataTransfer?.getData('application/x-perilune-stage');
      if (rawStage && targetIndex !== null) {
        const sourceIndex = Number(rawStage);
        if (!Number.isInteger(sourceIndex) || sourceIndex === targetIndex) return;
        this.pushHistory();
        const [stage] = this.craft.stages.splice(sourceIndex, 1);
        const insertion = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
        this.craft.stages.splice(insertion, 0, stage);
        this.statsDirty = true;
      }
    };
  }
}
