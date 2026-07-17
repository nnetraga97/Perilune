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
  isStageablePart,
} from '../sim/vessel';
import { PARTS, PartDef, partById } from '../content/parts';
import { buildAeroModel } from '../sim/aero';
import { computeMassProperties } from '../sim/vessel';
import { buildVesselVisual, disposeVesselVisual, VesselVisual, type VesselVisualSource } from '../render/vesselMesh';
import type { PartModelLibrary } from '../render/partModelLibrary';
import { deleteCraftFile, listCraftFiles, readCraftFile, writeCraftFile } from '../save/persistence';
import { el, injectUiStyles } from './kit';
import { partPortrait } from './partPortrait';
import { BUILT_IN_CRAFTS } from '../content/crafts';
import {
  craftCost,
  isPartUnlocked,
  lockedCraftParts,
  technologyForPart,
  type CampaignState,
} from '../sim/campaign';

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

/** Remove selected descendants whose ancestor is already selected. */
export function normalizedBranchRoots(craft: Readonly<Craft>, keys: Iterable<number>): number[] {
  const selected = new Set(keys);
  const byKey = new Map(craft.parts.map((part) => [part.key, part]));
  return [...selected].filter((key) => {
    const seen = new Set<number>([key]);
    let parentKey = byKey.get(key)?.parentKey ?? null;
    while (parentKey !== null) {
      if (selected.has(parentKey)) return false;
      if (seen.has(parentKey)) break;
      seen.add(parentKey);
      parentKey = byKey.get(parentKey)?.parentKey ?? null;
    }
    return byKey.has(key);
  });
}

/** Expand one or more branch roots to every descendant, without duplicates. */
export function expandedBranchKeys(craft: Readonly<Craft>, roots: Iterable<number>): Set<number> {
  const expanded = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const part of craft.parts) {
      if (part.parentKey !== null && expanded.has(part.parentKey) && !expanded.has(part.key)) {
        expanded.add(part.key);
        changed = true;
      }
    }
  }
  return expanded;
}

export interface EditorCallbacks {
  onLaunch(craft: Craft): string | null;
  onExit(): void;
  campaign(): CampaignState;
}

export class Editor {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly root: HTMLElement;
  readonly utilityHost: HTMLElement;
  craft: Craft = createCraft('Untitled Craft');

  private visual: VesselVisual | null = null;
  private ghost: THREE.Object3D | null = null;
  /** Ghost's visual wrapper and its temporary translucent materials, released on drop. */
  private ghostVisual: VesselVisual | null = null;
  private ghostMaterials: THREE.Material[] = [];
  private holdingDef: PartDef | null = null;
  private holdingRotation = new Quat();
  private selectedKeys = new Set<number>();
  private primarySelectedKey: number | null = null;
  private hoveredKey: number | null = null;
  private selectionHelpers = new Map<number, THREE.BoxHelper>();
  private hoverHelper: THREE.BoxHelper | null = null;
  private rootHelper: THREE.BoxHelper | null = null;
  private rootLabel: THREE.Sprite | null = null;
  private movingKeys: Set<number> | null = null;
  private moveChanged = false;
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
  private launchBtn!: HTMLButtonElement;
  private campaignEl!: HTMLElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private mobileMultiBtn!: HTMLButtonElement;
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
  private contextPoint: { x: number; y: number; touch: boolean } | null = null;
  private noticeEl!: HTMLElement;
  private mobilePanel: 'parts' | 'craft' | 'stages' | 'engineer' | null = null;
  private mobileHosts = new Map<'parts' | 'craft' | 'stages' | 'engineer', HTMLElement>();
  private mobileDockButtons = new Map<'parts' | 'craft' | 'stages' | 'engineer', HTMLButtonElement>();
  private touchMultiSelect = false;
  /** Ghost attach candidate this frame. */
  private candidate:
    | { kind: 'stack'; spot: StackNodeSpot; pos: Vec3 }
    | { kind: 'surface'; parentKey: number; pos: Vec3; normal: Vec3 }
    | { kind: 'root'; pos: Vec3 }
    | null = null;

  constructor(
    uiRoot: HTMLElement,
    cb: EditorCallbacks,
    private readonly partModels?: PartModelLibrary,
    private readonly renderer?: THREE.WebGLRenderer,
  ) {
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
    this.utilityHost = this.buildDom();
    this.rebuildVisual();
    this.setVisible(false);
  }

  private buildDom(): HTMLElement {
    // Left: palette
    const left = el('div', 'ed-left ed-mobile-panel', this.root);
    left.dataset.mobilePanel = 'parts';
    left.id = 'ed-mobile-parts';
    this.mobileHosts.set('parts', left);
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
    const topPrimary = el('div', 'ed-topbar-primary', top);
    this.nameInput = el('input', 'ed-name', topPrimary) as HTMLInputElement;
    this.nameInput.value = this.craft.name;
    this.nameInput.onchange = () => {
      this.craft.name = this.nameInput.value || 'Untitled Craft';
    };
    this.campaignEl = el('div', 'ed-campaign-balance', topPrimary);
    this.launchBtn = el('button', 'hud-btn ed-launch', topPrimary, '▲ LAUNCH') as HTMLButtonElement;
    this.launchBtn.onclick = () => {
      const error = this.cb.onLaunch(structuredClone(this.craft));
      if (error) this.showNotice(error, true);
    };
    const topScroll = el('div', 'ed-topbar-scroll', top);
    this.undoBtn = el('button', 'hud-btn ed-history-btn', topScroll, 'Undo') as HTMLButtonElement;
    this.undoBtn.onclick = () => this.undo();
    this.redoBtn = el('button', 'hud-btn ed-history-btn', topScroll, 'Redo') as HTMLButtonElement;
    this.redoBtn.onclick = () => this.redo();
    this.symmetryBtn = el('button', 'hud-btn', topScroll, 'SYM ×1');
    this.symmetryBtn.title = 'Radial symmetry (X)';
    this.symmetryBtn.onclick = () => this.cycleSymmetry();
    this.snapBtn = el('button', 'hud-btn', topScroll, `SNAP ${SNAP_ANGLES[this.snapIndex]}°`);
    this.snapBtn.title = 'Cycle angle snap (C)';
    this.snapBtn.onclick = () => this.cycleSnap();
    const clear = el('button', 'hud-btn', topScroll, 'New');
    clear.onclick = () => {
      this.pushHistory();
      this.craft = createCraft('Untitled Craft');
      this.nameInput.value = this.craft.name;
      this.setSelection([], null);
      this.statsDirty = true;
      this.rebuildVisual();
    };
    const save = el('button', 'hud-btn', topScroll, 'Save');
    save.onclick = async () => {
      await writeCraftFile(this.craft.name, this.craft);
      this.refreshCraftList();
    };
    this.mobileMultiBtn = el('button', 'hud-btn ed-mobile-multi', topScroll, 'Select multiple') as HTMLButtonElement;
    this.mobileMultiBtn.setAttribute('aria-pressed', 'false');
    this.mobileMultiBtn.onclick = () => this.toggleTouchMultiSelect();
    const utilityHost = el('div', 'ed-utility-host', this.root);

    // Right: stats, staging, warnings, craft files
    const right = el('div', 'ed-right', this.root);
    const engineerGroup = el('div', 'ed-mobile-group ed-mobile-panel', right);
    engineerGroup.dataset.mobilePanel = 'engineer';
    engineerGroup.id = 'ed-mobile-engineer';
    this.mobileHosts.set('engineer', engineerGroup);
    const stagesGroup = el('div', 'ed-mobile-group ed-mobile-panel', right);
    stagesGroup.dataset.mobilePanel = 'stages';
    stagesGroup.id = 'ed-mobile-stages';
    this.mobileHosts.set('stages', stagesGroup);
    const craftGroup = el('div', 'ed-mobile-group ed-mobile-panel', right);
    craftGroup.dataset.mobilePanel = 'craft';
    craftGroup.id = 'ed-mobile-craft';
    this.mobileHosts.set('craft', craftGroup);

    const envPanel = el('div', 'ed-panel', engineerGroup);
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

    const statsPanel = el('div', 'ed-panel', engineerGroup);
    statsPanel.innerHTML = '<h3>ENGINEERING</h3>';
    this.statsEl = el('div', 'ed-stats', statsPanel);

    const stagePanel = el('div', 'ed-panel', stagesGroup);
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
      // stages[0] fires first and is displayed at the bottom of the stack.
      // Insert there so existing display numbers do not change.
      this.craft.stages.unshift({ partKeys: [] });
      this.statsDirty = true;
    };
    this.stagesEl = el('div', '', stagePanel);

    const warnPanel = el('div', 'ed-panel', engineerGroup);
    warnPanel.innerHTML = '<h3>ADVISOR</h3>';
    this.warningsEl = el('div', '', warnPanel);

    const builtInPanel = el('div', 'ed-panel ed-built-in-panel', craftGroup);
    builtInPanel.innerHTML = '<h3>BUILT-IN CRAFT</h3>';
    const builtInList = el('div', 'ed-craft-list', builtInPanel);
    builtInList.dataset.section = 'built-in-crafts';
    this.renderBuiltInCraftList(builtInList);

    const craftPanel = el('div', 'ed-panel', craftGroup);
    craftPanel.innerHTML = '<h3>SAVED CRAFT</h3>';
    this.craftListEl = el('div', 'ed-craft-list', craftPanel);
    this.refreshCraftList();

    el(
      'div',
      'ed-hint',
      this.root,
      'click to select · Shift/Command adds parts · secondary click opens actions · drag to move · ? controls',
    );
    this.noticeEl = el('div', 'ed-notice', this.root);
    this.noticeEl.hidden = true;
    const dock = el('nav', 'ed-mobile-dock', this.root);
    dock.setAttribute('aria-label', 'Workshop panels');
    for (const [id, label] of [
      ['parts', 'Parts'], ['craft', 'Craft'], ['stages', 'Stages'], ['engineer', 'Engineer'],
    ] as const) {
      const button = el('button', 'ed-mobile-dock-btn', dock, label) as HTMLButtonElement;
      button.dataset.panel = id;
      button.setAttribute('aria-controls', `ed-mobile-${id}`);
      button.setAttribute('aria-expanded', 'false');
      button.onclick = () => this.toggleMobilePanel(id);
      this.mobileDockButtons.set(id, button);
    }
    this.updateHistoryButtons();
    return utilityHost;
  }

  private renderBuiltInCraftList(parent: HTMLElement): void {
    for (const definition of BUILT_IN_CRAFTS) {
      const craft = definition.create();
      const row = el('div', 'ed-craft-item ed-built-in-craft', parent);
      row.dataset.craftId = definition.id;
      const copy = el('div', 'ed-craft-copy', row);
      el('strong', '', copy, definition.name);
      const analysis = analyzeCraft(craft, 9.42, 101_325);
      el('span', '', copy, `${craft.parts.length} parts · ${(analysis.mass / 1000).toFixed(1)} t · ${analysis.totalDeltaV.toFixed(0)} m/s`);
      const load = el('button', 'hud-btn', row, 'Load');
      load.setAttribute('aria-label', `Load built-in craft ${definition.name}`);
      load.title = definition.description;
      load.onclick = () => this.loadCraft(definition.create());
    }
  }

  private loadCraft(craft: Craft): void {
    this.pushHistory();
    this.restoreCraftSnapshot(craft);
    this.fitCamera();
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
        if (c) this.loadCraft(c);
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
    const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
    const query = this.searchInput?.value.trim().toLowerCase() ?? '';
    const parts = PARTS.filter((part) => (
      (!query && part.category === this.activeCategory)
      || (query && `${part.name} ${part.blurb} ${part.category}`.toLowerCase().includes(query))
    ));
    if (this.sortSelect?.value === 'mass') parts.sort((a, b) => a.massDry - b.massDry);
    else if (this.sortSelect?.value === 'thrust') parts.sort((a, b) => (b.engine?.thrustVac ?? 0) - (a.engine?.thrustVac ?? 0));
    else if (this.sortSelect?.value === 'name') parts.sort((a, b) => a.name.localeCompare(b.name));
    for (const def of parts) {
      const unlocked = isPartUnlocked(this.cb.campaign(), def);
      const card = el('div', unlocked ? 'ed-part' : 'ed-part ed-part-locked', this.partListEl);
      card.draggable = unlocked && !coarsePointer;
      card.setAttribute('aria-disabled', String(!unlocked));
      card.appendChild(partPortrait(def, this.partModels, this.renderer));
      const copy = el('div', 'ed-part-copy', card);
      el('div', 'ed-part-name', copy, def.name);
      const stats = [
        `${def.massDry} kg`,
        `${def.cost} funds`,
        def.engine ? `${(def.engine.thrustVac / 1000).toFixed(0)} kN` : '',
      ].filter(Boolean).join(' · ');
      el('div', 'ed-part-info', copy, stats);
      if (!unlocked) el('div', 'ed-part-tech', copy, `LOCKED · ${technologyForPart(def).name}`);
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
      card.onclick = () => {
        if (unlocked) this.pickUp(def);
        else this.showNotice(`Unlock ${technologyForPart(def).name} in Program Control.`, true);
      };
      card.ondragstart = (event) => {
        if (!unlocked) {
          event.preventDefault();
          return;
        }
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
    if (window.matchMedia('(max-width: 820px), (pointer: coarse)').matches) {
      this.closeMobilePanel();
      this.showNotice(`Holding ${def.name} · tap the craft to attach`);
    }
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
    return this.primarySelectedKey;
  }

  get selectedPartKeys(): readonly number[] {
    return [...this.selectedKeys];
  }

  get hoveredPartKey(): number | null {
    return this.hoveredKey;
  }

  get contextMenuOpen(): boolean {
    return this.partContextEl !== null;
  }

  get activeMobilePanel(): string | null {
    return this.mobilePanel;
  }

  get cameraDistance(): number {
    return this.camDist;
  }

  get cameraYaw(): number {
    return this.camYaw;
  }

  get undoDepth(): number {
    return this.history.length;
  }

  get rootIndicatorVisible(): boolean {
    return this.rootLabel?.visible === true;
  }

  get hasPartSelection(): boolean {
    return this.selectedKeys.size > 0 || this.holdingDef !== null;
  }

  get isHoldingPart(): boolean {
    return this.holdingDef !== null;
  }

  get touchMultiSelectEnabled(): boolean {
    return this.touchMultiSelect;
  }

  private pushHistory(snapshot: Craft = this.craft): void {
    this.history.push(structuredClone(snapshot));
    if (this.history.length > 50) this.history.shift();
    this.redoHistory = [];
    this.updateHistoryButtons();
  }

  undo(): void {
    const previous = this.history.pop();
    if (!previous) return;
    this.redoHistory.push(structuredClone(this.craft));
    this.restoreCraftSnapshot(previous);
    this.updateHistoryButtons();
  }

  redo(): void {
    const next = this.redoHistory.pop();
    if (!next) return;
    this.history.push(structuredClone(this.craft));
    this.restoreCraftSnapshot(next);
    this.updateHistoryButtons();
  }

  private restoreCraftSnapshot(snapshot: Craft): void {
    this.dropHolding();
    this.craft = structuredClone(snapshot);
    this.nameInput.value = this.craft.name;
    this.setSelection([], null);
    this.statsDirty = true;
    this.rebuildVisual();
  }

  private updateHistoryButtons(): void {
    if (!this.undoBtn || !this.redoBtn) return;
    this.undoBtn.disabled = this.history.length === 0;
    this.redoBtn.disabled = this.redoHistory.length === 0;
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

  escape(): void {
    if (this.partContextEl) {
      this.closePartContext();
      return;
    }
    if (this.holdingDef) {
      this.dropHolding();
      return;
    }
    this.setSelection([], null);
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
    return this.selectionHelpers.size > 0;
  }

  private disposeOutline(helper: THREE.BoxHelper | null): void {
    if (!helper) return;
    this.scene.remove(helper);
    helper.geometry.dispose();
    (helper.material as THREE.Material).dispose();
  }

  private makeOutline(mesh: THREE.Object3D, color: number, opacity: number, order: number): THREE.BoxHelper {
    const helper = new THREE.BoxHelper(mesh, color);
    const material = helper.material as THREE.LineBasicMaterial;
    material.depthTest = false;
    material.transparent = true;
    material.opacity = opacity;
    helper.renderOrder = order;
    this.scene.add(helper);
    return helper;
  }

  private clearHighlights(): void {
    for (const helper of this.selectionHelpers.values()) this.disposeOutline(helper);
    this.selectionHelpers.clear();
    this.disposeOutline(this.hoverHelper);
    this.hoverHelper = null;
    this.disposeOutline(this.rootHelper);
    this.rootHelper = null;
    if (this.rootLabel) {
      this.scene.remove(this.rootLabel);
      this.rootLabel.material.map?.dispose();
      this.rootLabel.material.dispose();
      this.rootLabel = null;
    }
  }

  private syncHighlights(): void {
    this.clearHighlights();
    if (!this.visual) return;
    const root = this.craft.parts.find((part) => part.parentKey === null);
    if (root) {
      const mesh = this.visual.partMeshes.get(root.key);
      if (mesh && !this.selectedKeys.has(root.key)) this.rootHelper = this.makeOutline(mesh, 0xe2b13c, 0.78, 98);
      if (mesh) {
        const canvas = document.createElement('canvas');
        canvas.width = 192;
        canvas.height = 64;
        const context = canvas.getContext('2d')!;
        context.fillStyle = 'rgba(20,14,4,.9)';
        context.strokeStyle = '#e2b13c';
        context.lineWidth = 4;
        context.roundRect(3, 3, 186, 58, 12);
        context.fill();
        context.stroke();
        context.fillStyle = '#ffe3a0';
        context.font = '700 30px ui-monospace, monospace';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText('ROOT', 96, 33);
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false });
        this.rootLabel = new THREE.Sprite(material);
        this.rootLabel.name = 'editor-root-label';
        const bounds = new THREE.Box3().setFromObject(mesh);
        this.rootLabel.position.set(
          (bounds.min.x + bounds.max.x) / 2,
          bounds.max.y + Math.max(0.35, (bounds.max.y - bounds.min.y) * 0.16),
          (bounds.min.z + bounds.max.z) / 2,
        );
        this.rootLabel.scale.set(1.35, 0.45, 1);
        this.rootLabel.renderOrder = 104;
        this.scene.add(this.rootLabel);
      }
    }
    for (const key of this.selectedKeys) {
      const mesh = this.visual.partMeshes.get(key);
      if (!mesh) continue;
      this.selectionHelpers.set(
        key,
        this.makeOutline(mesh, 0x6db3d6, key === this.primarySelectedKey ? 1 : 0.48, key === this.primarySelectedKey ? 102 : 101),
      );
    }
    if (this.hoveredKey !== null && !this.selectedKeys.has(this.hoveredKey)) {
      const mesh = this.visual.partMeshes.get(this.hoveredKey);
      if (mesh) this.hoverHelper = this.makeOutline(mesh, 0x8fe4ff, 0.5, 100);
    }
  }

  private setSelection(keys: Iterable<number>, primary: number | null): void {
    const valid = new Set([...keys].filter((key) => Boolean(craftPart(this.craft, key))));
    this.selectedKeys = valid;
    this.primarySelectedKey = primary !== null && valid.has(primary) ? primary : valid.values().next().value ?? null;
    this.closePartContext();
    this.syncHighlights();
    this.statsDirty = true;
  }

  selectPart(key: number | null, additive = false): void {
    if (key === null) {
      this.setSelection([], null);
      return;
    }
    if (!additive) {
      this.setSelection([key], key);
      return;
    }
    const next = new Set(this.selectedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.setSelection(next, next.has(key) ? key : this.primarySelectedKey === key ? null : this.primarySelectedKey);
  }

  isPartSelected(key: number): boolean {
    return this.selectedKeys.has(key);
  }

  pickPart(nx: number, ny: number): number | null {
    if (!this.visual) return null;
    this.pointer.set(nx, ny);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects([...this.visual.partMeshes.values()], true)[0];
    return hit ? this.partKeyForObject(hit.object) : null;
  }

  updateHover(nx: number, ny: number, enabled = true): void {
    const next = enabled && !this.holdingDef ? this.pickPart(nx, ny) : null;
    if (next === this.hoveredKey) return;
    this.hoveredKey = next;
    this.disposeOutline(this.hoverHelper);
    this.hoverHelper = null;
    if (next !== null && !this.selectedKeys.has(next) && this.visual) {
      const mesh = this.visual.partMeshes.get(next);
      if (mesh) this.hoverHelper = this.makeOutline(mesh, 0x8fe4ff, 0.5, 100);
    }
  }

  closePartContext(): void {
    this.partContextEl?.remove();
    this.partContextEl = null;
    this.contextPoint = null;
  }

  openPartContext(clientX: number, clientY: number, touch = false, key: number | null = null): void {
    if (key !== null && !this.selectedKeys.has(key)) this.setSelection([key], key);
    if (!this.selectedKeys.size) {
      this.closePartContext();
      return;
    }
    this.contextPoint = { x: clientX, y: clientY, touch };
    this.refreshPartContext();
  }

  private refreshPartContext(): void {
    const point = this.contextPoint;
    this.partContextEl?.remove();
    this.partContextEl = null;
    if (!point || this.primarySelectedKey === null) return;
    const part = craftPart(this.craft, this.primarySelectedKey);
    if (!part) return;
    const definition = defOf(part);
    const panel = el('div', 'ed-part-context', this.root);
    panel.classList.toggle('touch-sheet', point.touch);
    this.partContextEl = panel;
    const heading = el('div', 'hud-part-heading', panel);
    el('strong', '', heading, this.selectedKeys.size > 1 ? `${this.selectedKeys.size} PARTS SELECTED` : definition.name);
    const close = el('button', 'k-window-btn', heading, '×');
    close.onclick = () => this.closePartContext();
    const roots = normalizedBranchRoots(this.craft, this.selectedKeys);
    el(
      'div',
      'ed-part-context-meta',
      panel,
      this.selectedKeys.size > 1
        ? `${roots.length} movable ${roots.length === 1 ? 'branch' : 'branches'}`
        : `${part.attach} · symmetry ${part.symmetry || 'none'} · ${definition.crossfeed ? 'crossfeed' : 'isolated'}`,
    );
    const actions = el('div', 'ed-part-context-actions', panel);
    const remove = el('button', 'hud-btn', actions, 'Remove');
    remove.onclick = () => this.deleteSelected();
    const frame = el('button', 'hud-btn', actions, 'Frame');
    frame.onclick = () => this.frameSelected();
    if (this.selectedKeys.size === 1) {
      const reroot = el('button', 'hud-btn', actions, 'Make root') as HTMLButtonElement;
      reroot.disabled = part.parentKey === null;
      reroot.onclick = () => this.rerootSelected();
    }
    if (this.selectedKeys.size === 1 && part.attach === 'surface') {
      const align = el('button', 'hud-btn', actions, 'Center Y');
      align.onclick = () => this.verticalAlignSelected();
    }
    if (point.touch && this.selectedKeys.size === 1) {
      el('div', 'mission-section-title', panel, 'ROTATE PART');
      const rotate = el('div', 'ed-touch-rotate', panel);
      for (const [label, axis, direction] of [
        ['Pitch −', 'x', -1], ['Pitch +', 'x', 1],
        ['Yaw −', 'y', -1], ['Yaw +', 'y', 1],
        ['Roll −', 'z', -1], ['Roll +', 'z', 1],
      ] as const) {
        const button = el('button', 'hud-btn', rotate, label);
        button.onclick = () => this.rotateSelected(axis, direction);
      }
      const reset = el('button', 'hud-btn ed-touch-rotate-reset', rotate, 'Reset rotation');
      reset.onclick = () => this.resetSelectedRotation();
    }
    if (this.selectedKeys.size > 1) {
      this.positionPartContext(panel, point);
      return;
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
    this.positionPartContext(panel, point);
  }

  private positionPartContext(panel: HTMLElement, point: { x: number; y: number; touch: boolean }): void {
    if (point.touch) return;
    const margin = 10;
    panel.style.left = `${Math.max(margin, Math.min(point.x + 10, window.innerWidth - 270))}px`;
    panel.style.top = `${Math.max(margin, Math.min(point.y + 10, window.innerHeight - 330))}px`;
  }

  private toggleMobilePanel(panel: 'parts' | 'craft' | 'stages' | 'engineer'): void {
    this.mobilePanel = this.mobilePanel === panel ? null : panel;
    for (const [id, host] of this.mobileHosts) host.classList.toggle('mobile-open', id === this.mobilePanel);
    for (const [id, button] of this.mobileDockButtons) {
      const active = id === this.mobilePanel;
      button.classList.toggle('active', active);
      button.setAttribute('aria-expanded', String(active));
    }
  }

  private closeMobilePanel(): void {
    this.mobilePanel = null;
    for (const host of this.mobileHosts.values()) host.classList.remove('mobile-open');
    for (const button of this.mobileDockButtons.values()) {
      button.classList.remove('active');
      button.setAttribute('aria-expanded', 'false');
    }
  }

  private toggleTouchMultiSelect(): void {
    this.touchMultiSelect = !this.touchMultiSelect;
    this.mobileMultiBtn.classList.toggle('active', this.touchMultiSelect);
    this.mobileMultiBtn.setAttribute('aria-pressed', String(this.touchMultiSelect));
    this.mobileMultiBtn.textContent = this.touchMultiSelect ? 'Selecting multiple' : 'Select multiple';
    if (!this.touchMultiSelect && this.primarySelectedKey !== null && this.selectedKeys.size > 1) {
      this.setSelection([this.primarySelectedKey], this.primarySelectedKey);
    }
  }

  private showNotice(message: string, danger = false): void {
    this.noticeEl.textContent = message;
    this.noticeEl.classList.toggle('danger', danger);
    this.noticeEl.hidden = false;
    window.setTimeout(() => {
      if (this.noticeEl.textContent === message) this.noticeEl.hidden = true;
    }, 2600);
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
    if (this.selectedKeys.size !== 1 || this.primarySelectedKey === null) return;
    const part = craftPart(this.craft, this.primarySelectedKey);
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
    if (this.selectedKeys.size !== 1 || this.primarySelectedKey === null) return;
    const part = craftPart(this.craft, this.primarySelectedKey);
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
    if (this.selectedKeys.size !== 1 || this.primarySelectedKey === null) return;
    const part = craftPart(this.craft, this.primarySelectedKey);
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
    if (this.selectedKeys.size !== 1 || this.primarySelectedKey === null) return;
    const selected = craftPart(this.craft, this.primarySelectedKey);
    if (!selected || selected.parentKey === null) return;
    const before = structuredClone(this.craft);
    const path: PartInstance[] = [];
    const visited = new Set<number>();
    let current: PartInstance | undefined = selected;
    while (current) {
      if (visited.has(current.key)) {
        this.showNotice('Cannot make root: attachment cycle detected.', true);
        return;
      }
      visited.add(current.key);
      path.push(current);
      if (current.parentKey === null) current = undefined;
      else {
        const parent = craftPart(this.craft, current.parentKey);
        if (!parent) {
          this.showNotice('Cannot make root: attachment parent is missing.', true);
          return;
        }
        current = parent;
      }
    }
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
    const roots = this.craft.parts.filter((part) => part.parentKey === null);
    const keys = new Set(this.craft.parts.map((part) => part.key));
    const valid = roots.length === 1
      && roots[0].attach === 'root'
      && this.craft.parts.every((part) => part.parentKey === null || keys.has(part.parentKey));
    if (!valid) {
      this.craft = before;
      this.showNotice('Make root failed; the craft was restored.', true);
      this.rebuildVisual();
      return;
    }
    this.pushHistory(before);
    this.statsDirty = true;
    this.closePartContext();
    this.rebuildVisual();
    this.showNotice(`${defOf(selected).name} is now the root part.`);
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
    if (!this.selectedKeys.size) return;
    const framed = [...expandedBranchKeys(this.craft, normalizedBranchRoots(this.craft, this.selectedKeys))]
      .map((key) => craftPart(this.craft, key))
      .filter((part): part is PartInstance => Boolean(part));
    if (!framed.length) return;
    const mid = this.craft.parts.length
      ? (Math.min(...this.craft.parts.map((candidate) => candidate.position.y)) + Math.max(...this.craft.parts.map((candidate) => candidate.position.y))) / 2
      : 3;
    const center = framed.reduce((sum, part) => sum.add(new Vec3(part.position.x, part.position.y, part.position.z)), new Vec3()).scale(1 / framed.length);
    const span = framed.reduce((max, part) => Math.max(max, Math.hypot(part.position.x - center.x, part.position.y - center.y, part.position.z - center.z)), 0);
    this.camFocusOffset.set(center.x, center.y - mid, center.z);
    this.camDist = Math.max(5, Math.min(40, Math.max(12, span * 3)));
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

  /** Begin free movement after the shell's press-versus-drag threshold is crossed. */
  beginPartDrag(nx: number, ny: number, duplicate = false, pressedKey: number | null = null): boolean {
    if (this.holdingDef || !this.visual) return false;
    const key = pressedKey ?? this.pickPart(nx, ny);
    if (key === null) return false;
    this.moveSnapshot = structuredClone(this.craft);
    this.moveChanged = false;

    let movingRoot = key;
    if (duplicate) {
      movingRoot = this.duplicateSubtree(key);
      this.setSelection([movingRoot], movingRoot);
      this.moveChanged = true;
    } else if (!this.selectedKeys.has(key)) {
      this.setSelection([key], key);
    } else {
      this.primarySelectedKey = key;
      this.syncHighlights();
    }
    const roots = normalizedBranchRoots(this.craft, duplicate ? [movingRoot] : this.selectedKeys);
    this.movingKeys = expandedBranchKeys(this.craft, roots);
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
    if (delta.lengthSq() <= 1e-12) return;
    this.lastMovePoint.add(delta);
    for (const key of this.movingKeys) {
      const part = craftPart(this.craft, key);
      if (!part) continue;
      part.position.x += delta.x;
      part.position.y += delta.y;
      part.position.z += delta.z;
      this.visual.partMeshes.get(key)?.position.set(part.position.x, part.position.y, part.position.z);
    }
    this.moveChanged = true;
    for (const helper of this.selectionHelpers.values()) helper.update();
    this.hoverHelper?.update();
    this.rootHelper?.update();
    const rootKey = this.craft.parts.find((part) => part.parentKey === null)?.key;
    if (rootKey !== undefined && this.movingKeys.has(rootKey) && this.rootLabel) this.rootLabel.position.add(delta);
    this.statsDirty = true;
  }

  endPartDrag(cancel = false): void {
    if (cancel && this.moveSnapshot) {
      const snapshot = this.moveSnapshot;
      this.moveSnapshot = null;
      this.movingKeys = null;
      this.moveChanged = false;
      this.restoreCraftSnapshot(snapshot);
      return;
    }
    if (this.moveSnapshot && this.moveChanged) this.pushHistory(this.moveSnapshot);
    this.moveSnapshot = null;
    this.movingKeys = null;
    this.moveChanged = false;
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
  updatePointer(nx: number, ny: number, allowHover = true): void {
    this.pointer.set(nx, ny);
    if (!this.holdingDef || !this.ghost) {
      this.candidate = null;
      this.updateHover(nx, ny, allowHover);
      return;
    }
    this.updateHover(nx, ny, false);
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
  click(additive = false, keyOverride: number | null | undefined = undefined): void {
    if (this.holdingDef && this.candidate) {
      this.placeHeld();
      return;
    }
    const key = keyOverride === undefined ? this.pickPart(this.pointer.x, this.pointer.y) : keyOverride;
    this.selectPart(key, additive);
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
    if (this.selectedKeys.size) {
      this.pushHistory();
      for (const key of normalizedBranchRoots(this.craft, this.selectedKeys)) removeSubtree(this.craft, key);
      this.setSelection([], null);
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
    this.clearHighlights();
    if (this.visual) {
      this.scene.remove(this.visual.group);
      disposeVesselVisual(this.visual);
    }
    this.visual = buildVesselVisual(this.craft, this.partModels);
    this.scene.add(this.visual.group);
    const campaign = this.cb.campaign();
    const locked = lockedCraftParts(campaign, this.craft);
    const cost = craftCost(this.craft);
    const canAfford = campaign.mode !== 'program' || campaign.funds >= cost;
    const canLaunch = this.craft.parts.length > 0 && locked.length === 0 && canAfford;
    this.launchBtn.disabled = !canLaunch;
    this.launchBtn.title = canLaunch
      ? campaign.mode === 'program' ? `Commit ${cost.toLocaleString()} funds and launch` : 'Launch this craft'
      : this.craft.parts.length === 0
        ? 'Add at least one part before launch'
        : locked.length
          ? `Craft contains locked technology: ${locked.map((part) => part.name).join(', ')}`
          : `Insufficient funds: ${cost.toLocaleString()} required`;
    this.launchBtn.setAttribute('aria-label', this.launchBtn.title);
    this.selectedKeys = new Set([...this.selectedKeys].filter((key) => Boolean(craftPart(this.craft, key))));
    if (this.primarySelectedKey !== null && !this.selectedKeys.has(this.primarySelectedKey)) {
      this.primarySelectedKey = this.selectedKeys.values().next().value ?? null;
    }
    this.syncHighlights();
  }

  orbitCamera(dx: number, dy: number): void {
    this.camYaw -= dx * 0.006;
    this.camPitch = Math.max(-0.5, Math.min(1.35, this.camPitch + dy * 0.006));
  }

  zoomCamera(factor: number): void {
    this.camDist = Math.max(4, Math.min(80, this.camDist * factor));
  }

  setVisible(vis: boolean): void {
    if (!vis) {
      this.closePartContext();
      this.updateHover(this.pointer.x, this.pointer.y, false);
    }
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
    const campaign = this.cb.campaign();
    const cost = craftCost(this.craft);
    this.campaignEl.textContent = campaign.mode === 'program'
      ? `${campaign.funds.toLocaleString()} FUNDS · ${cost.toLocaleString()} COMMIT`
      : campaign.mode === 'exploration'
        ? 'EXPLORATION · TECHNOLOGY ENABLED'
        : 'SANDBOX · UNRESTRICTED';

    const stability = aero.copY - props.com.y;
    this.statsEl.innerHTML = '';
    const totals = el('div', 'ed-engineering-grid', this.statsEl);
    const stat = (label: string, value: string) => {
      el('span', 'ed-engineering-key', totals, label);
      el('span', 'ed-engineering-value', totals, value);
    };
    stat('Parts', String(a.partCount));
    stat('Craft cost', `${cost.toLocaleString()} funds`);
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
        warning.onclick = () => this.selectPart(suspect.key);
      }
    }
    if (!warnings.length) el('div', 'ed-part-info', this.warningsEl, 'no complaints — impressive');
  }

  /** Refresh palette access, campaign balance, and launch readiness after progression changes. */
  refreshCampaign(): void {
    this.renderPartList();
    this.statsDirty = true;
    this.rebuildVisual();
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
    for (const part of this.craft.parts.filter((candidate) => (
      isStageablePart(candidate) && !assigned.has(candidate.key)
    ))) {
      this.renderStagePart(unstagedParts, part);
    }
    [...this.craft.stages].map((stage, index) => ({ stage, index })).reverse().forEach(({ stage, index: i }) => {
      const div = el('div', 'ed-stage', this.stagesEl);
      div.draggable = true;
      div.ondragstart = (event) => event.dataTransfer?.setData('application/x-perilune-stage', String(i));
      this.addStageDropTarget(div, i);
      const head = el('div', 'ed-stage-head', div);
      const displayStage = this.craft.stages.length - 1 - i;
      el('span', '', head, `STAGE ${displayStage}`);
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
      let renderedParts = 0;
      for (const key of stage.partKeys) {
        const part = craftPart(this.craft, key);
        if (part && isStageablePart(part)) {
          this.renderStagePart(parts, part);
          renderedParts++;
        }
      }
      if (!renderedParts) el('span', 'ed-part-info', parts, 'drop staged parts here');
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
    chip.onclick = () => this.selectPart(part.key);
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
        const part = craftPart(this.craft, key);
        if (!part || !isStageablePart(part)) return;
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
