/**
 * Perilune game shell: main menu → workshop (editor) → flight, the master
 * loop, input handling, and mission actions (staging, science, recovery,
 * quicksave/load, maneuver execution, time warp).
 */
import * as THREE from 'three';
import { Vec3 } from './core/vec3';
import { GameState, PHYSICS_WARP_RATES, RAILS_WARP_RATES } from './sim/state';
import { ACTION_GROUP_IDS, Craft, analyzeCraft, defOf, type ActionGroupId } from './sim/vessel';
import { createRenderContext, RenderContext } from './render/context';
import { WorldScene } from './render/worldScene';
import { checkPartModelManifest } from './render/partModelManifest';
import { createBrowserPartModelLibrary, type PartModelLibrary } from './render/partModelLibrary';
import checkedPartArtifact from './generated/checked-part-manifest.json';
import { Editor } from './ui/editor';
import { FlightHud, type FlightControlAxis } from './ui/flightHud';
import { MapView } from './ui/mapView';
import { Tutorial } from './ui/tutorial';
import { GpuSubmissionProfiler, PerfOverlay } from './ui/perfOverlay';
import { GpuTimerRing } from './render/gpuTimer';
import { restoreGame } from './save/persistence';
import { logEvent } from './sim/flight';
import { CommsStatus, evaluateComms, needsCommsForControl } from './sim/comms';
import { estimateBurnTime, nodeDeltaV, type ManeuverNode } from './sim/maneuver';
import { ManeuverPlanController } from './sim/maneuverPlan';
import { apoapsisOf, periapsisOf, stateToElements } from './core/orbit';
import { RenderDiagnostics } from './render/renderDiagnostics';
import type { RenderStartupOptions } from './render/renderStartupOptions';
import { surfaceVelocity } from './sim/bodyOrientation';
import { InputService, type BindingScreen } from './ui/input';
import { CheatSheet } from './ui/cheatSheet';
import { WindowManager } from './ui/window';
import { browserProfileStore } from './ui/profileStore';
import { FlightInstruments } from './ui/flightInstruments';
import { MissionTools } from './ui/missionTools';
import { UtilityTools, type UiSettings } from './ui/utilityTools';
import { AuthService } from './cloud/auth';
import { CloudSaveClient } from './cloud/client';
import { SaveSyncService } from './cloud/saveSync';
import { SyncStore } from './cloud/syncStore';
import { AccountWindow } from './ui/account';
import { telemetry } from './telemetry/service';
import { clientLog } from './telemetry/log';
import { bindMenuContinueSave, MainMenu } from './ui/mainMenu';
import { el, injectUiStyles } from './ui/kit';
import {
  craftCost,
  lockedCraftParts,
  settleContracts,
  type GameMode,
} from './sim/campaign';
import {
  autoCollectScience,
  collectScience,
  recoverScience,
  transmitScience as transmitBufferedScience,
} from './sim/science';
import type { CollectOutcome } from './sim/science';

type Screen = 'menu' | 'editor' | 'flight';

type EditorGestureKind = 'part-press' | 'canvas-press' | 'part-drag' | 'orbit' | 'pan' | 'secondary-press' | 'secondary-orbit' | 'pinch';

interface EditorGesture {
  kind: EditorGestureKind;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  partKey: number | null;
  additive: boolean;
  duplicate: boolean;
  longPressOpened: boolean;
}

class PeriluneGame {
  private ctx!: RenderContext;
  private game = new GameState();
  private world!: WorldScene;
  private partModels!: PartModelLibrary;
  private editor!: Editor;
  private hud!: FlightHud;
  private map!: MapView;
  private tutorial!: Tutorial;
  private perf!: PerfOverlay;
  private gpuProfiler!: GpuSubmissionProfiler;
  private unsubscribeGpuRestoration: (() => void) | null = null;
  private screen: Screen = 'menu';
  private menu!: MainMenu;
  private uiRoot!: HTMLElement;
  private keys = new Set<string>();
  private readonly touchFlightControl: Record<FlightControlAxis, number> = {
    pitch: 0,
    yaw: 0,
    roll: 0,
    'translate-x': 0,
    'translate-y': 0,
    'translate-z': 0,
  };
  private dragging = false;
  private draggingMapControl = false;
  private dragMoved = 0;
  private dragButton = 0;
  private lastX = 0;
  private lastY = 0;
  private editorGesture: EditorGesture | null = null;
  private editorPointers = new Map<number, { x: number; y: number }>();
  private editorPinchDistance = 0;
  private mapPointers = new Map<number, { x: number; y: number }>();
  private mapPinchDistance = 0;
  private mapPinchMidpoint = { x: 0, y: 0 };
  private editorLongPressTimer: number | null = null;
  private lastFrame = performance.now();
  private launchedCraft: Craft | null = null;
  private missionStart = 0;
  private maneuver = new ManeuverPlanController();
  private precisionControl = false;
  private paused = false;
  private uiHidden = false;
  private lastAutosave = 0;
  private autosaveScheduled = false;
  private comms: CommsStatus = { connected: true, path: [], strength: 1 };
  private lastCommsCheck = 0;
  private lastAutoScienceCheck = 0;
  private controlBlocked = false;
  private dialogEl: HTMLElement | null = null;
  private input = new InputService();
  private cheatSheet!: CheatSheet;
  private windows!: WindowManager;
  private instruments!: FlightInstruments;
  private missionTools!: MissionTools;
  private utilityTools!: UtilityTools;
  private auth!: AuthService;
  private saveSync!: SaveSyncService;
  private unsubscribeMenuSave: (() => void) | null = null;
  private account!: AccountWindow;
  private uiSettings: UiSettings | null = null;
  private rendererFailureEl: HTMLElement | null = null;
  private rendererFailureMessage: HTMLElement | null = null;
  private reportedRendererFailure = '';
  private readonly diagnostics: RenderDiagnostics;
  private readonly renderOptions: RenderStartupOptions;

  constructor(options: Readonly<RenderStartupOptions>) {
    this.renderOptions = Object.freeze({ ...options });
    this.diagnostics = new RenderDiagnostics({
      quality: options.quality,
      detailed: options.renderDebug,
    });
    window.__RENDER_DIAGNOSTICS__ = this.diagnostics.browserApi();
    this.diagnostics.record({
      subsystem: 'renderer',
      event: 'render-startup-options',
      severity: 'state',
      data: { quality: options.quality, renderDebug: options.renderDebug, reentryVfx: options.reentryVfx },
    });
  }

  private readonly onPageHide = (event: PageTransitionEvent): void => {
    if (event.persisted) return;
    window.removeEventListener('pagehide', this.onPageHide);
    this.unsubscribeGpuRestoration?.();
    this.unsubscribeGpuRestoration = null;
    this.unsubscribeMenuSave?.();
    this.unsubscribeMenuSave = null;
    this.gpuProfiler.dispose();
    this.saveSync.dispose();
    this.auth.dispose();
    this.map.dispose();
    // Remove vessel visuals first, then release shared model resources once.
    this.world.dispose();
    this.partModels.dispose();
    if (window.__RENDER_DIAGNOSTICS__) delete window.__RENDER_DIAGNOSTICS__;
  };

  async start(): Promise<void> {
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    this.uiRoot = document.getElementById('ui-root') as HTMLElement;
    this.ctx = await createRenderContext(canvas);
    const drawingBuffer = new THREE.Vector2();
    this.ctx.renderer.getDrawingBufferSize(drawingBuffer);
    this.diagnostics.record({
      subsystem: 'renderer',
      event: 'render-context-created',
      severity: 'state',
      data: {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        drawingBufferWidth: drawingBuffer.x,
        drawingBufferHeight: drawingBuffer.y,
        backend: this.ctx.caps.backend,
        maxTextureSize: this.ctx.caps.maxTextureSize,
        maxAnisotropy: this.ctx.caps.maxAnisotropy,
        drawingBufferSamples: this.ctx.caps.drawingBufferSamples,
        compressedTextureFormats: Object.values(this.ctx.caps.compressedTextures).filter(Boolean).length,
      },
    });
    this.gpuProfiler = new GpuSubmissionProfiler(
      () => new GpuTimerRing(this.ctx.renderer.getContext() as WebGL2RenderingContext, 12),
    );
    this.unsubscribeGpuRestoration = this.ctx.lifecycle.subscribeRestoration(async () => {
      // Context loss invalidated old queries. Drop references now; allocate lazily on a renderable draw.
      this.gpuProfiler.invalidateAfterContextLoss();
    });
    // One shared, preloaded part-model library backs both flight and the editor.
    // Procedural geometry remains the fallback if any model fails to load.
    const configuredBaseUrl = import.meta.env.BASE_URL;
    const baseUrl = configuredBaseUrl.endsWith('/') ? configuredBaseUrl : `${configuredBaseUrl}/`;
    const checkedParts = checkPartModelManifest(checkedPartArtifact);
    this.partModels = createBrowserPartModelLibrary(this.ctx.renderer, checkedParts, {
      transcoderPath: `${baseUrl}basis/`,
      // Content-address the request so a regenerated GLB cannot be confused with
      // an older browser-cached response at the same public path.
      resolveAssetUrl: (path, sha256) => `${baseUrl}parts/${path}?v=${sha256}`,
    });
    await this.partModels.preload();
    this.world = new WorldScene(this.ctx, this.partModels, {
      quality: this.renderOptions.quality,
      diagnostics: this.diagnostics,
      reentryEffectsEnabled: this.renderOptions.reentryVfx,
    });
    injectUiStyles();
    this.rendererFailureEl = el('div', 'k-render-failure', this.uiRoot);
    this.rendererFailureMessage = el('span', 'k-render-failure-message', this.rendererFailureEl);
    const retryRenderer = el('button', 'k-render-failure-retry', this.rendererFailureEl, 'Retry visuals');
    retryRenderer.setAttribute('type', 'button');
    retryRenderer.addEventListener('click', () => this.world.retryActiveBodyRenderer());
    if (this.rendererFailureEl) this.rendererFailureEl.hidden = true;
    this.perf = new PerfOverlay(this.uiRoot);
    this.editor = new Editor(this.uiRoot, {
      onLaunch: (craft) => this.launch(craft),
      onExit: () => this.showMenu(),
      campaign: () => this.game.campaign,
    }, this.partModels, this.ctx.renderer);
    this.hud = new FlightHud(this.uiRoot, {
      onStage: () => this.stage(),
      onToggleMap: () => this.toggleMap(),
      onQuickSave: () => this.quickSave(),
      onQuickLoad: () => void this.quickLoad(),
      onRevert: () => this.revert(),
      onRunScience: () => this.runScience(),
      onTransmitScience: () => this.transmitScience(),
      onRecover: () => this.recover(),
      onSetSas: (m) => {
        const gv = this.game.active;
        if (gv) gv.runtime.sas = m;
      },
      onToggleSas: () => {
        const gv = this.game.active;
        if (gv) gv.runtime.sas = gv.runtime.sas === 'off' ? 'stability' : 'off';
      },
      onToggleRcs: () => {
        const gv = this.game.active;
        if (gv) gv.runtime.controls.rcs = !gv.runtime.controls.rcs;
      },
      onSetThrottle: (value) => {
        const gv = this.game.active;
        if (gv && !this.controlBlocked) gv.runtime.controls.throttle = Math.max(0, Math.min(1, value));
      },
      onSetFlightControl: (axis, value) => {
        this.touchFlightControl[axis] = Math.max(-1, Math.min(1, value));
      },
      onSetActiveVessel: (id) => this.activateVessel(id),
      onSetWarp: (i, rails) => this.game.setWarp(i, rails),
      onExitToEditor: () => this.toEditor(),
      onExitToMenu: () => this.showMenu(),
      onToggleSystem: (partKey) => {
        const gv = this.game.active;
        if (!gv) return;
        const p = gv.runtime.craft.parts.find((q) => q.key === partKey);
        if (!p) return;
        p.activated = !p.activated;
        logEvent(
          gv.runtime,
          this.game.time,
          `${defOf(p).name} ${p.activated ? 'started' : 'stopped'}`,
        );
      },
      onSurvey: () => {
        const gv = this.game.active;
        if (!gv) return;
        const res = this.game.performScan(gv);
        if (!res.ok && res.reason) {
          logEvent(gv.runtime, this.game.time, res.reason, 'warning');
        }
      },
    });
    this.hud.root.style.display = 'none';
    this.map = new MapView(this.uiRoot, {
      getManeuverPlan: () => {
        const active = this.game.active;
        if (!active) return null;
        return this.maneuver.selectedFor(active.runtime.id, active.runtime.bodyId);
      },
      getManeuverPlans: () => {
        const active = this.game.active;
        if (!active) return [];
        return this.maneuver.scheduledFor(active.runtime.id, active.runtime.bodyId);
      },
      onSelectManeuverNode: (id) => this.maneuver.select(id),
      onCreateManeuverNode: (node) => this.createManeuverNode(node),
      onUpdateManeuverNode: (node) => this.maneuver.update(node),
      onDeleteManeuverNode: () => this.maneuver.clear(),
      onWarpToNode: (node) => this.warpToNode(node),
      onCreateAlarm: (time, label, kind) => {
        this.missionTools.addAlarm(time, label, kind);
      },
      onSetTarget: (bodyId) => {
        if (this.game.active) this.game.active.target = bodyId;
      },
      onWarpToTime: (time, margin) => this.warpToTime(time, margin),
      getBodyAssetPack: (bodyId) => this.world.bodyAssetPack(bodyId),
      getQualityTier: () => this.world.qualityTier(),
      maxAnisotropy: this.ctx.caps.maxAnisotropy,
    });
    this.tutorial = new Tutorial(this.uiRoot);
    window.addEventListener('pagehide', this.onPageHide);
    this.cheatSheet = new CheatSheet(this.uiRoot, this.input);
    const profile = browserProfileStore();
    this.windows = new WindowManager(this.uiRoot, profile);
    this.auth = new AuthService();
    this.saveSync = new SaveSyncService(
      this.auth,
      new CloudSaveClient(this.auth),
      new SyncStore(profile),
    );
    this.saveSync.initialize();
    this.account = new AccountWindow(this.windows, this.auth);
    this.auth.subscribe((state) => telemetry.setUser(state.kind === 'signed-in' ? state.session.userId : null));
    this.instruments = new FlightInstruments(this.windows, () => this.game);
    this.missionTools = new MissionTools(this.windows, () => this.game, {
      onSwitchVessel: (vesselId) => this.activateVessel(vesselId),
      onSketchNode: (plan) => {
        this.createManeuverNode(plan.suggestedNode);
        if (!this.map.visible) this.toggleMap();
      },
      onSetTarget: (bodyId) => {
        if (this.game.active) this.game.active.target = bodyId;
      },
      onOrbitTarget: (bodyId) => {
        if (this.game.placeActiveInOrbit(bodyId)) {
          this.hud.setMissionStart(this.game.time);
        }
      },
      onFocusBody: (bodyId) => {
        if (!this.map.visible) this.toggleMap();
        this.map.focusBody(bodyId);
      },
      onRenameVessel: (vesselId, name) => {
        const vessel = this.game.vessels.find((candidate) => candidate.runtime.id === vesselId);
        if (vessel) vessel.runtime.name = name;
      },
      onTerminateVessel: (vesselId) => {
        const vessel = this.game.vessels.find((candidate) => candidate.runtime.id === vesselId);
        if (!vessel?.runtime.isDebris) return;
        this.game.vessels = this.game.vessels.filter((candidate) => candidate.runtime.id !== vesselId);
        this.world.invalidateVessel(vesselId);
        if (this.game.activeVesselId === vesselId) {
          this.game.activeVesselId = this.game.vessels.find((candidate) => !candidate.runtime.isDebris)?.runtime.id ?? null;
        }
      },
      onRecoverVessel: (vesselId) => {
        this.activateVessel(vesselId);
        this.recover();
      },
    }, this.uiRoot);
    this.utilityTools = new UtilityTools(this.windows, profile, this.input, () => this.game, {
      onSave: (slot, label) => this.saveSync.write(this.game, slot, label),
      onLoad: (slot) => this.loadSlot(slot),
      onListSaves: () => this.saveSync.list(),
      onRefreshSaves: () => this.saveSync.refresh(),
      onDeleteSave: (slot) => this.saveSync.delete(slot),
      onResolveConflict: (slot, choice) => this.saveSync.resolveConflict(slot, choice),
      onSavesChanged: (listener) => this.saveSync.subscribe(listener),
      onSettings: (settings) => this.applySettings(settings),
      onTelemetry: (enabled) => telemetry.setEnabled(enabled),
      onCampaignChanged: () => {
        this.editor.refreshCampaign();
        void this.saveSync.write(this.game, 'auto', 'autosave');
      },
    });
    this.menu = new MainMenu(this.uiRoot, {
      onFirstLight: () => {
        this.newGame('sandbox');
        this.tutorial.start();
        this.toEditor();
      },
      onSandbox: () => {
        this.newGame('sandbox');
        this.toEditor();
      },
      onExploration: () => {
        this.newGame('exploration');
        this.toEditor();
      },
      onProgram: () => {
        this.newGame('program');
        this.toEditor();
      },
      onContinue: () => this.continueAutosave(),
      onSaves: () => this.utilityTools.openSaves(),
      onAccount: () => this.account.open(),
      onSettings: () => this.utilityTools.openSettings(),
    });
    this.unsubscribeMenuSave = bindMenuContinueSave(this.saveSync, this.menu);
    void this.auth.start();
    this.windows.addAction('keyboard', 'Keyboard reference (?)', () => {
      if (this.screen === 'flight' || this.screen === 'editor') {
        this.cheatSheet.toggle(this.screen as BindingScreen);
      }
    });
    this.registerBindings();
    this.bindInput(canvas);
    document.getElementById('boot')?.remove();
    requestAnimationFrame(() => this.frame());
    // Expose for the e2e harness: read-only state probes + a screen-space
    // projection helper so tests can aim real mouse clicks at 3D nodes.
    // All ACTIONS in tests go through real UI events.
    (window as unknown as Record<string, unknown>).__TEST__ = {
      screen: () => this.screen,
      partVisualSource: (key: number) => this.editor.visualSourceForPart(key),
      plumeCount: (key: number) => this.world.plumeCountForPart(key),
      plumeState: (key: number) => this.world.plumeStateForPart(key),
      smokeParticleCount: () => this.world.smokeParticleCount(),
      reentryStats: () => this.world.reentryStats(),
      reentryOcclusionSample: () => Array.from(this.world.reentryOcclusionPixel(192, 192) ?? []),
      partCount: () => this.editor.craft.parts.length,
      stageCount: () => this.editor.craft.stages.length,
      parts: () => this.editor.craft.parts.map((p) => ({ key: p.key, parentKey: p.parentKey, defId: p.defId, x: p.position.x, y: p.position.y, z: p.position.z })),
      projectEditor: (x: number, y: number, z: number) => {
        const v = new THREE.Vector3(x, y, z).project(this.editor.camera);
        return {
          x: ((v.x + 1) / 2) * window.innerWidth,
          y: ((1 - v.y) / 2) * window.innerHeight,
        };
      },
      stackSpots: () =>
        this.editor.freeStackSpots().map((s) => ({
          kind: s.kind,
          x: s.pos.x,
          y: s.pos.y,
          z: s.pos.z,
        })),
      altitude: () => {
        const gv = this.game.active;
        if (!gv) return null;
        return gv.runtime.pos.length() - this.game.bodyOf(gv).radius;
      },
      verticalSpeed: () => {
        const gv = this.game.active;
        if (!gv) return null;
        const radial = gv.runtime.pos.clone().normalize();
        return gv.runtime.vel.dot(radial);
      },
      flightVector: () => {
        const gv = this.game.active;
        if (!gv) return null;
        const body = this.game.bodyOf(gv);
        const radial = gv.runtime.pos.clone().normalize();
        const nose = gv.runtime.att.rotate(new Vec3(0, 1, 0), new Vec3());
        const relativeVelocity = gv.runtime.vel.clone().sub(surfaceVelocity(body, gv.runtime.pos, new Vec3()));
        const verticalSpeed = relativeVelocity.dot(radial);
        return {
          noseUpCos: nose.dot(radial),
          verticalSpeed,
          horizontalSpeed: Math.sqrt(Math.max(0, relativeVelocity.lengthSq() - verticalSpeed * verticalSpeed)),
        };
      },
      orbit: () => {
        const gv = this.game.active;
        if (!gv) return null;
        const body = this.game.bodyOf(gv);
        const elements = stateToElements(body.mu, gv.runtime.pos, gv.runtime.vel, this.game.time);
        return {
          apoapsisAltitude: apoapsisOf(elements) - body.radius,
          periapsisAltitude: periapsisOf(elements) - body.radius,
          eccentricity: elements.e,
        };
      },
      currentStage: () => this.game.active?.runtime.currentStage ?? null,
      activeBody: () => this.game.active?.runtime.bodyId ?? null,
      renderCheckpoint: () => {
        const size = new THREE.Vector2();
        this.ctx.renderer.getDrawingBufferSize(size);
        return {
          canvasWidth: this.ctx.renderer.domElement.clientWidth,
          canvasHeight: this.ctx.renderer.domElement.clientHeight,
          drawingBufferWidth: size.x,
          drawingBufferHeight: size.y,
          stats: this.world.renderStats(),
        };
      },
      situation: () => this.game.active?.runtime.situation ?? null,
      speed: () => this.game.active?.runtime.vel.length() ?? 0,
      properAcceleration: () => this.game.active?.runtime.properAccel ?? 0,
      throttle: () => this.game.active?.runtime.controls.throttle ?? 0,
      vesselCount: () => this.game.vessels.length,
      time: () => this.game.time,
      sciencePoints: () => this.game.sciencePoints,
      campaign: () => ({
        mode: this.game.campaign.mode,
        funds: this.game.campaign.funds,
        reputation: this.game.campaign.reputation,
        unlockedTech: [...this.game.campaign.unlockedTech],
        activeContracts: [...this.game.campaign.activeContracts],
        completedContracts: [...this.game.campaign.completedContracts],
      }),
      warpRate: () => this.game.warpRate,
      target: () => this.game.active?.target ?? null,
      maneuverNode: () => this.maneuver.current ? { ...this.maneuver.current.node } : null,
      mapOrbitSamples: () => this.map.orbitInteractionSamples(),
      mapMarkerSamples: () => this.map.markerInteractionSamples(),
      mapCameraState: () => this.map.cameraState(),
      maneuverNodes: () => this.maneuver.all.map((plan) => ({ id: plan.id, ...plan.node })),
      alarmCount: () => this.game.alarms.length,
      fuel: () => {
        const gv = this.game.active;
        if (!gv) return 0;
        return gv.runtime.craft.parts.reduce((s, p) => s + (p.resources.propellant ?? 0), 0);
      },
      debug: () => ({
        holding:
          (this.editor as unknown as { holdingDef?: { id: string } }).holdingDef?.id ?? null,
        candidate:
          (this.editor as unknown as { candidate?: { kind: string } }).candidate?.kind ?? null,
        selected: this.editor.selectedPartKey,
        selectedKeys: this.editor.selectedPartKeys,
        hovered: this.editor.hoveredPartKey,
        selectionHighlighted: this.editor.selectionHighlighted,
        rootIndicatorVisible: this.editor.rootIndicatorVisible,
        contextMenuOpen: this.editor.contextMenuOpen,
        mobilePanel: this.editor.activeMobilePanel,
        editorCameraDistance: this.editor.cameraDistance,
        editorCameraYaw: this.editor.cameraYaw,
        editorUndoDepth: this.editor.undoDepth,
      }),
    };
  }

  // ------------------------------------------------------------------ menu
  private async continueAutosave(): Promise<void> {
    const save = await this.saveSync.read('auto');
    if (!save) {
      this.menu.setContinueSave(null);
      return;
    }
    this.game = restoreGame(save);
    this.editor.refreshCampaign();
    if (this.game.active) this.toFlight(false);
    else this.toEditor();
  }

  private newGame(mode: GameMode): void {
    this.game = new GameState(mode);
    this.editor.refreshCampaign();
    telemetry.track('game_started', {
      mode,
      account: this.auth.state.kind === 'signed-in' ? 'signed-in' : 'guest',
    });
    clientLog.info('game.start', { mode });
  }

  private showMenu(): void {
    this.resetTouchFlightControls();
    this.screen = 'menu';
    document.getElementById('game-canvas')?.classList.remove('vab-active');
    this.menu.setVisible(true);
    this.editor.setVisible(false);
    this.hud.root.style.display = 'none';
    this.map.setVisible(false);
    this.perf.setMiniVisible(false);
    this.windows.setLauncherHost(null);
    this.windows.setScreen('menu');
    if (this.rendererFailureEl) this.rendererFailureEl.hidden = true;
  }

  private toEditor(): void {
    this.resetTouchFlightControls();
    this.paused = false;
    this.screen = 'editor';
    document.getElementById('game-canvas')?.classList.add('vab-active');
    this.menu.setVisible(false);
    this.editor.setVisible(true);
    this.hud.root.style.display = 'none';
    this.map.setVisible(false);
    this.perf.setMiniVisible(false);
    this.windows.setLauncherHost(this.editor.utilityHost);
    this.windows.setScreen('editor');
    this.editor.refreshCampaign();
    if (this.rendererFailureEl) this.rendererFailureEl.hidden = true;
    void this.saveSync.write(this.game, 'auto', 'autosave');
  }

  private toFlight(spawn = true): void {
    this.paused = false;
    this.screen = 'flight';
    document.getElementById('game-canvas')?.classList.remove('vab-active');
    this.menu.setVisible(false);
    this.editor.setVisible(false);
    this.hud.root.style.display = '';
    this.map.setVisible(false);
    this.map.visible = false;
    this.perf.setMiniVisible(true);
    this.windows.setLauncherHost(this.hud.utilityHost);
    this.windows.setScreen('flight');
    this.missionStart = this.game.time;
    this.hud.setMissionStart(this.missionStart);
  }

  private launch(craft: Craft): string | null {
    const locked = lockedCraftParts(this.game.campaign, craft);
    if (locked.length) {
      return `Unlock required technology for ${locked.map((part) => part.name).join(', ')}.`;
    }
    const cost = craftCost(craft);
    if (this.game.campaign.mode === 'program') {
      if (cost > this.game.campaign.funds) {
        return `Launch requires ${cost.toLocaleString()} funds; ${this.game.campaign.funds.toLocaleString()} available.`;
      }
      this.game.campaign.funds -= cost;
    }
    this.launchedCraft = structuredClone(craft);
    this.game.clearFlightVessels();
    this.game.spawnOnPad(craft, craft.name);
    this.toFlight();
    telemetry.track('launch');
    clientLog.info('launch', { mode: this.game.campaign.mode });
    logEvent(this.game.active!.runtime, this.game.time, `${craft.name} on the pad. Throttle up (Shift) and stage (Space) when ready.`);
    this.game.flags['campaign:launched'] = true;
    this.completeCampaignContracts();
    return null;
  }

  // --------------------------------------------------------------- actions
  private stage(): void {
    const gv = this.game.active;
    if (!gv) return;
    if (this.controlBlocked) {
      logEvent(gv.runtime, this.game.time, 'No signal: cannot command staging.', 'warning');
      return;
    }
    this.game.fireStage(gv);
    this.world.invalidateVessel(gv.runtime.id);
  }

  private toggleMap(): void {
    if (this.screen !== 'flight') return;
    this.map.visible = !this.map.visible;
    if (this.map.visible) this.map.focusActiveVessel(this.game);
    this.map.setVisible(this.map.visible);
  }

  private quickSave(): void {
    void this.saveSync.write(this.game, 'quick', 'quicksave').then((ok) => {
      const gv = this.game.active;
      if (gv) logEvent(gv.runtime, this.game.time, ok ? 'Quicksaved.' : 'Quicksave FAILED', ok ? 'info' : 'danger');
    });
  }

  private scheduleAutosave(): void {
    if (this.autosaveScheduled) return;
    this.autosaveScheduled = true;
    const run = () => {
      this.autosaveScheduled = false;
      void this.saveSync.write(this.game, 'auto', 'autosave');
    };
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(run, { timeout: 5_000 });
    } else {
      globalThis.setTimeout(run, 0);
    }
  }

  private async quickLoad(): Promise<void> {
    await this.loadSlot('quick');
  }

  private async loadSlot(slot: string): Promise<void> {
    const save = await this.saveSync.read(slot);
    if (!save) return;
    this.game = restoreGame(save);
    this.editor.refreshCampaign();
    this.world.resetDynamicState();
    if (this.game.active) this.toFlight(false);
    else this.toEditor();
  }

  private applySettings(settings: UiSettings): void {
    this.uiSettings = settings;
    this.uiRoot.style.setProperty('zoom', String(settings.uiScale));
    document.documentElement.classList.toggle('k-reduced-motion', settings.reducedMotion);
    document.documentElement.classList.toggle('k-simple-terms', settings.simplifiedTerms);
    const accents = {
      cyan: ['#6db3d6', '#e2b13c'],
      amber: ['#e2b13c', '#6db3d6'],
      violet: ['#a993e8', '#e2b13c'],
    } as const;
    document.documentElement.style.setProperty('--ui-accent', accents[settings.accent][0]);
    document.documentElement.style.setProperty('--ui-warn', accents[settings.accent][1]);
    this.world.camera.fov = settings.fov;
    this.world.cameraSmoothing = settings.cameraSmoothing && !settings.reducedMotion;
    this.world.setReducedMotion(settings.reducedMotion);
    this.world.camera.updateProjectionMatrix();
    this.editor.camera.fov = settings.fov;
    this.editor.camera.updateProjectionMatrix();
  }

  private revert(): void {
    if (!this.launchedCraft) return;
    this.game.clearFlightVessels();
    this.game.spawnOnPad(structuredClone(this.launchedCraft), this.launchedCraft.name);
    this.game.setWarp(0, false);
    this.toFlight();
  }

  private runScience(): void {
    const gv = this.game.active;
    if (!gv) return;
    const v = gv.runtime;
    const outcome = collectScience(this.game, gv);
    if (!outcome.site) {
      logEvent(v, this.game.time, 'No valid science situation right now.', 'warning');
      return;
    }
    this.announceCollectedScience(v, outcome);
    if (outcome.collected.length === 0) {
      logEvent(v, this.game.time, 'No collectable science here — the site is exhausted or its result is already aboard.', 'warning');
      return;
    }
    void this.saveSync.write(this.game, 'auto', 'autosave');
  }

  private announceCollectedScience(v: import('./sim/flight').VesselRuntime, outcome: CollectOutcome): void {
    if (!outcome.site) return;
    for (const result of outcome.collected) {
      logEvent(
        v,
        this.game.time,
        `${result.experiment.name}: ${result.collectValue} science aboard (${outcome.site.biome.name}, ${outcome.site.situation})`,
      );
    }
  }

  /** Run every valid experiment the moment the active vessel reaches a new site. */
  private runAutoScience(): void {
    const gv = this.game.active;
    if (!gv) return;
    const outcome = autoCollectScience(this.game, gv);
    if (!outcome || outcome.collected.length === 0) return;
    this.announceCollectedScience(gv.runtime, outcome);
    void this.saveSync.write(this.game, 'auto', 'autosave');
  }

  private transmitScience(): void {
    const gv = this.game.active;
    if (!gv) return;
    const outcome = transmitBufferedScience(this.game, gv);
    if (!outcome.accepted) {
      logEvent(gv.runtime, this.game.time, 'Science downlink unavailable — no route to a ground station.', 'warning');
      return;
    }
    logEvent(
      gv.runtime,
      this.game.time,
      outcome.delivered > 0
        ? `Science downlink complete: ${outcome.delivered} points delivered via ${outcome.link.path.join(' → ')}.`
        : 'No additional science can be transmitted from the results aboard.',
      outcome.delivered > 0 ? 'info' : 'warning',
    );
    this.completeCampaignContracts();
    this.editor.refreshCampaign();
    void this.saveSync.write(this.game, 'auto', 'autosave');
  }

  private recover(): void {
    const gv = this.game.active;
    if (!gv) return;
    const v = gv.runtime;
    const science = recoverScience(this.game, gv);
    if (!science.accepted) {
      logEvent(v, this.game.time, 'Recovery denied: vessel must be intact and landed at the home world.', 'warning');
      return;
    }
    const points = science.deliveredByRecovery;
    const recoveryRefund = this.game.campaign.mode === 'program' ? Math.round(craftCost(v.craft) * 0.35) : 0;
    if (recoveryRefund) this.game.campaign.funds += recoveryRefund;
    if (points > 0) this.game.flags['campaign:science-return'] = true;
    this.game.flags.recoveredOnce = true;
    this.game.vessels = this.game.vessels.filter((x) => x !== gv);
    this.game.activeVesselId = null;
    this.world.invalidateVessel(v.id);
    this.showDialog(
      'Vessel recovered',
      `${v.name} is home. Science recovered: ${points} points (total ${this.game.sciencePoints}).` +
        (recoveryRefund ? ` Hardware recovery returned ${recoveryRefund.toLocaleString()} funds.` : '') +
        (v.crew.length ? ` Crew ${v.crew.join(', ')} return to a hero's welcome.` : ''),
      [{ label: 'Back to the Workshop', fn: () => this.toEditor() }],
    );
    this.completeCampaignContracts();
    this.editor.refreshCampaign();
    void this.saveSync.write(this.game, 'auto', 'autosave');
  }

  private warpToNode(node: ManeuverNode): void {
    const gv = this.game.active;
    if (!gv) return;
    const body = this.game.bodyOf(gv);
    const v = gv.runtime;
    const analysis = analyzeCraft(v.craft, body.surfaceGravity, body.pressureAt(v.pos.length() - body.radius));
    const candidates = analysis.stages.filter((stage) => stage.thrust > 0);
    const stage = candidates.find((candidate) => candidate.stageIndex >= v.currentStage)
      ?? [...candidates].reverse().find((candidate) => candidate.stageIndex < v.currentStage);
    const burnDuration = stage
      ? estimateBurnTime(nodeDeltaV(node), stage.thrust, v.massProps.mass, stage.isp)
      : 0;
    const stopTime = node.time - burnDuration / 2 - 30;
    this.warpToTime(stopTime, 0);
  }

  private warpToTime(eventTime: number, margin = 30): void {
    const stopTime = eventTime - margin;
    const eta = stopTime - this.game.time;
    if (eta < 45) return;
    const active = this.game.active;
    const check = active ? this.game.canRailsWarp(active) : { ok: true };
    if (!check.ok) {
      if (active && check.reason) logEvent(active.runtime, this.game.time, check.reason, 'warning');
      return;
    }
    // Pick the highest rails rate that stops 30 s before finite-burn ignition.
    for (let i = RAILS_WARP_RATES.length - 1; i >= 1; i--) {
      if (eta / RAILS_WARP_RATES[i] > 3) {
        this.game.setWarp(i, true);
        this.pendingWarpStop = stopTime;
        return;
      }
    }
  }
  private pendingWarpStop: number | null = null;

  private executeActionGroup(group: ActionGroupId): void {
    const gv = this.game.active;
    if (!gv) return;
    if (this.controlBlocked) {
      logEvent(gv.runtime, this.game.time, `No signal: action group ${group} blocked.`, 'warning');
      this.hud.showActionGroup(group, 0);
      return;
    }
    const executed = this.game.executeActionGroup(gv, group);
    this.hud.showActionGroup(group, executed);
  }

  private togglePause(): void {
    if (this.paused) {
      this.dialogEl?.remove();
      this.dialogEl = null;
      this.paused = false;
      return;
    }
    if (this.dialogEl) return;
    this.paused = true;
    this.game.setWarp(0, false);
    this.showDialog('Flight paused', 'Simulation time is stopped.', [
      { label: 'Resume', fn: () => { this.paused = false; } },
      { label: 'Settings', fn: () => { this.utilityTools.openSettings(); } },
      { label: 'Save & Load', fn: () => { this.utilityTools.openSaves(); } },
      { label: 'Quicksave & resume', fn: () => { this.quickSave(); this.paused = false; } },
      { label: 'Quickload', fn: () => { this.paused = false; void this.quickLoad(); } },
      { label: 'Back to Workshop', fn: () => { this.paused = false; this.toEditor(); } },
    ]);
  }

  private toggleUi(): void {
    this.uiHidden = !this.uiHidden;
    this.uiRoot.classList.toggle('k-ui-hidden', this.uiHidden);
  }

  private showDialog(title: string, text: string, actions: Array<{ label: string; fn: () => void }>): void {
    this.dialogEl?.remove();
    const d = document.createElement('div');
    d.className = 'game-dialog';
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-modal', 'true');
    d.setAttribute('aria-labelledby', 'game-dialog-title');
    // textContent, not innerHTML: title/text include user-authored names.
    const heading = document.createElement('div');
    heading.id = 'game-dialog-title';
    heading.className = 'game-dialog-title';
    heading.textContent = title;
    const message = document.createElement('div');
    message.className = 'game-dialog-message';
    message.textContent = text;
    d.append(heading, message);
    const row = document.createElement('div');
    row.className = 'game-dialog-actions';
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = 'hud-btn';
      b.textContent = a.label;
      b.onclick = () => {
        d.remove();
        this.dialogEl = null;
        a.fn();
      };
      row.appendChild(b);
    }
    d.appendChild(row);
    this.uiRoot.appendChild(d);
    this.dialogEl = d;
  }

  // ----------------------------------------------------------------- input
  private editorNdc(clientX: number, clientY: number): { x: number; y: number } {
    return {
      x: (clientX / window.innerWidth) * 2 - 1,
      y: -(clientY / window.innerHeight) * 2 + 1,
    };
  }

  private cancelEditorLongPress(): void {
    if (this.editorLongPressTimer !== null) window.clearTimeout(this.editorLongPressTimer);
    this.editorLongPressTimer = null;
  }

  private editorPointerDown(canvas: HTMLCanvasElement, event: PointerEvent): void {
    const point = this.editorNdc(event.clientX, event.clientY);
    this.editor.updatePointer(point.x, point.y, event.pointerType === 'mouse');
    this.editorPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic test events and older browsers may not expose capture.
    }

    if (this.editorPointers.size >= 2) {
      this.cancelEditorLongPress();
      if (this.editorGesture?.longPressOpened) this.editor.closePartContext();
      if (this.editorGesture?.kind === 'part-drag') this.editor.endPartDrag(true);
      const pointers = [...this.editorPointers.values()].slice(0, 2);
      this.editorPinchDistance = Math.hypot(pointers[0].x - pointers[1].x, pointers[0].y - pointers[1].y);
      this.editorGesture = {
        kind: 'pinch', pointerId: event.pointerId, pointerType: event.pointerType,
        startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY,
        partKey: null, additive: false, duplicate: false, longPressOpened: false,
      };
      event.preventDefault();
      return;
    }

    const partKey = this.editor.isHoldingPart ? null : this.editor.pickPart(point.x, point.y);
    const secondary = event.button === 2 || (event.button === 0 && event.ctrlKey && event.pointerType === 'mouse');
    const kind: EditorGestureKind = event.button === 1
      ? 'pan'
      : secondary
        ? 'secondary-press'
        : partKey !== null
          ? 'part-press'
          : 'canvas-press';
    this.editorGesture = {
      kind,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      partKey,
      additive: event.shiftKey || event.metaKey || (event.pointerType !== 'mouse' && this.editor.touchMultiSelectEnabled),
      duplicate: event.altKey,
      longPressOpened: false,
    };
    if (event.pointerType !== 'mouse' && partKey !== null) {
      this.editorLongPressTimer = window.setTimeout(() => {
        const gesture = this.editorGesture;
        if (!gesture || gesture.kind !== 'part-press' || gesture.partKey === null || this.editorPointers.size !== 1) return;
        gesture.longPressOpened = true;
        this.editor.openPartContext(gesture.startX, gesture.startY, true, gesture.partKey);
      }, 450);
    }
    event.preventDefault();
  }

  private editorPointerMove(event: PointerEvent): void {
    const point = this.editorNdc(event.clientX, event.clientY);
    const tracked = this.editorPointers.get(event.pointerId);
    if (tracked) {
      tracked.x = event.clientX;
      tracked.y = event.clientY;
    }
    const gesture = this.editorGesture;
    if (!gesture) {
      this.editor.updatePointer(point.x, point.y, event.pointerType === 'mouse');
      return;
    }
    if (gesture.kind === 'pinch') {
      if (this.editorPointers.size >= 2) {
        const pointers = [...this.editorPointers.values()].slice(0, 2);
        const distance = Math.hypot(pointers[0].x - pointers[1].x, pointers[0].y - pointers[1].y);
        if (distance > 0 && this.editorPinchDistance > 0) this.editor.zoomCamera(this.editorPinchDistance / distance);
        this.editorPinchDistance = distance;
      }
      return;
    }
    if (gesture.pointerId !== event.pointerId) return;
    this.editor.updatePointer(point.x, point.y, event.pointerType === 'mouse');
    const moved = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
    if (moved > 8 && (gesture.kind === 'part-press' || gesture.kind === 'canvas-press' || gesture.kind === 'secondary-press')) {
      this.cancelEditorLongPress();
      if (gesture.kind === 'secondary-press') {
        gesture.kind = 'secondary-orbit';
        this.editor.closePartContext();
      } else if (gesture.kind === 'part-press' && gesture.partKey !== null) {
        gesture.kind = this.editor.beginPartDrag(point.x, point.y, gesture.duplicate, gesture.partKey) ? 'part-drag' : 'orbit';
      } else {
        gesture.kind = 'orbit';
      }
    }
    const sensitivity = this.uiSettings?.dragSensitivity ?? 1;
    const dx = (event.clientX - gesture.lastX) * sensitivity * (this.uiSettings?.invertX ? -1 : 1);
    const dy = (event.clientY - gesture.lastY) * sensitivity * (this.uiSettings?.invertY ? -1 : 1);
    gesture.lastX = event.clientX;
    gesture.lastY = event.clientY;
    if (gesture.kind === 'part-drag') this.editor.dragSelectedPart(point.x, point.y);
    else if (gesture.kind === 'orbit' || gesture.kind === 'secondary-orbit') this.editor.orbitCamera(dx, dy);
    else if (gesture.kind === 'pan') this.editor.panCameraLocal(-dx * 0.012, dy * 0.012, 0);
  }

  private editorPointerUp(event: PointerEvent, cancel = false): void {
    this.editorPointers.delete(event.pointerId);
    const gesture = this.editorGesture;
    if (!gesture) return;
    if (gesture.kind === 'pinch') {
      if (this.editorPointers.size < 2) {
        this.editorGesture = null;
        this.editorPinchDistance = 0;
      }
      return;
    }
    if (gesture.pointerId !== event.pointerId) return;
    this.cancelEditorLongPress();
    if (gesture.kind === 'part-drag') this.editor.endPartDrag(cancel);
    else if (!cancel && !gesture.longPressOpened && gesture.kind === 'part-press') {
      this.editor.click(gesture.additive, gesture.partKey);
    } else if (!cancel && gesture.kind === 'canvas-press') {
      this.editor.click(false, null);
    } else if (!cancel && gesture.kind === 'secondary-press') {
      if (gesture.partKey === null) this.editor.closePartContext();
      else this.editor.openPartContext(event.clientX, event.clientY, false, gesture.partKey);
    }
    this.editorGesture = null;
  }

  private bindInput(canvas: HTMLCanvasElement): void {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.keys.add(e.code);
      if (this.cheatSheet.visible && (e.code === 'Escape' || e.code === 'Slash')) {
        this.cheatSheet.hide();
        return;
      }
      if (this.screen === 'flight' || this.screen === 'editor') {
        this.input.dispatch(e, this.screen as BindingScreen);
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    canvas.addEventListener('pointerdown', (e) => {
      if (this.screen === 'editor') {
        this.editorPointerDown(canvas, e);
        return;
      }
      if (this.screen === 'flight' && this.map.visible && e.pointerType !== 'mouse') {
        this.mapPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.mapPointers.size >= 2) {
          const pointers = [...this.mapPointers.values()].slice(0, 2);
          this.mapPinchDistance = Math.hypot(pointers[0].x - pointers[1].x, pointers[0].y - pointers[1].y);
          this.mapPinchMidpoint = {
            x: (pointers[0].x + pointers[1].x) / 2,
            y: (pointers[0].y + pointers[1].y) / 2,
          };
          this.map.cancelPointer();
          this.draggingMapControl = false;
          this.dragging = false;
          canvas.setPointerCapture?.(e.pointerId);
          e.preventDefault();
          return;
        }
      }
      if (
        this.screen === 'flight' && this.map.visible && e.button === 0 &&
        this.map.beginPointer(e.clientX, e.clientY, e.pointerType)
      ) {
        this.draggingMapControl = true;
        this.dragging = false;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        canvas.setPointerCapture?.(e.pointerId);
        e.preventDefault();
        return;
      }
      this.dragging = true;
      this.dragButton = e.button;
      this.dragMoved = 0;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    canvas.addEventListener('dragover', (e) => {
      if (this.screen !== 'editor') return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = -(e.clientY / window.innerHeight) * 2 + 1;
      this.editor.updatePointer(nx, ny);
    });
    canvas.addEventListener('drop', (e) => {
      if (this.screen !== 'editor') return;
      e.preventDefault();
      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = -(e.clientY / window.innerHeight) * 2 + 1;
      this.editor.updatePointer(nx, ny);
      this.editor.click();
    });
    canvas.addEventListener('contextmenu', (e) => {
      if (this.screen === 'editor') {
        e.preventDefault();
      } else if (this.screen === 'flight' && this.map.visible) {
        e.preventDefault();
        this.map.openOrbitContext(e.clientX, e.clientY, 'mouse');
      }
    });
    window.addEventListener('pointermove', (e) => {
      if (this.screen === 'editor') {
        this.editorPointerMove(e);
        return;
      }
      if (this.screen === 'flight' && this.map.visible && this.mapPointers.has(e.pointerId)) {
        this.mapPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.mapPointers.size >= 2) {
          const pointers = [...this.mapPointers.values()].slice(0, 2);
          const distance = Math.hypot(pointers[0].x - pointers[1].x, pointers[0].y - pointers[1].y);
          const midpoint = {
            x: (pointers[0].x + pointers[1].x) / 2,
            y: (pointers[0].y + pointers[1].y) / 2,
          };
          if (distance > 0 && this.mapPinchDistance > 0) {
            this.map.zoomCamera(this.mapPinchDistance / distance, midpoint.x, midpoint.y);
            this.map.panCamera(this.mapPinchMidpoint.x - midpoint.x, this.mapPinchMidpoint.y - midpoint.y);
          }
          this.mapPinchDistance = distance;
          this.mapPinchMidpoint = midpoint;
          return;
        }
      }
      if (this.screen === 'flight' && this.map.visible && !this.draggingMapControl && e.target === canvas) {
        this.map.updatePointer(e.clientX, e.clientY, e.pointerType);
      }
      if (this.draggingMapControl) {
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.map.dragPointer(e.clientX, e.clientY, e.shiftKey);
        return;
      }
      if (!this.dragging) return;
      const sensitivity = this.uiSettings?.dragSensitivity ?? 1;
      const dx = (e.clientX - this.lastX) * sensitivity * (this.uiSettings?.invertX ? -1 : 1);
      const dy = (e.clientY - this.lastY) * sensitivity * (this.uiSettings?.invertY ? -1 : 1);
      this.dragMoved += Math.abs(dx) + Math.abs(dy);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (this.screen === 'flight' && this.map.visible) {
        if (this.dragButton === 1 || this.dragButton === 2) this.map.panCamera(dx, dy);
        else this.map.orbitCamera(dx, dy);
      }
      else if (this.screen === 'flight') {
        this.world.camYaw -= dx * 0.005;
        this.world.camPitch = Math.max(-1.4, Math.min(1.4, this.world.camPitch + dy * 0.005));
      }
    });
    window.addEventListener('pointerup', (e) => {
      if (this.screen === 'editor') {
        this.editorPointerUp(e);
        return;
      }
      this.mapPointers.delete(e.pointerId);
      if (this.mapPointers.size < 2) this.mapPinchDistance = 0;
      if (this.draggingMapControl) {
        this.map.endPointer();
        this.draggingMapControl = false;
        if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
        return;
      }
      if (this.dragging && this.dragMoved < 6 && this.screen === 'flight' && !this.map.visible) {
        const partKey = this.world.pickActivePart(e.clientX, e.clientY);
        if (partKey !== null) this.hud.showPartActions(this.game, partKey, e.clientX, e.clientY);
      }
      this.dragging = false;
    });
    window.addEventListener('pointercancel', (e) => {
      if (this.screen === 'editor') this.editorPointerUp(e, true);
      this.mapPointers.delete(e.pointerId);
      if (this.mapPointers.size < 2) this.mapPinchDistance = 0;
    });
    canvas.addEventListener('pointerleave', (e) => {
      if (this.screen === 'editor' && !this.editorGesture) {
        const point = this.editorNdc(e.clientX, e.clientY);
        this.editor.updateHover(point.x, point.y, false);
      }
    });
    canvas.addEventListener('wheel', (e) => {
      const factor = e.deltaY > 0 ? 1.12 : 0.9;
      if (this.screen === 'editor') this.editor.zoomCamera(factor);
      else if (this.screen === 'flight' && this.map.visible) this.map.zoomCamera(factor, e.clientX, e.clientY);
      else if (this.screen === 'flight' && e.shiftKey) this.world.zoomFov(e.deltaY > 0 ? 3 : -3);
      else if (this.screen === 'flight') {
        this.world.camDist = Math.max(4, Math.min(2000, this.world.camDist * factor));
      }
      e.preventDefault();
    }, { passive: false });
  }

  /** Register every keyboard binding; the same table renders the ? cheat sheet. */
  private registerBindings(): void {
    const flight = 'flight' as const;
    const editor = 'editor' as const;
    const vessel = (fn: (v: import('./sim/flight').VesselRuntime) => void) => () => {
      const gv = this.game.active;
      if (gv) fn(gv.runtime);
    };
    // Every flight action requires an active vessel (matches the old switch).
    const act = (fn: () => void) => () => {
      if (this.game.active) fn();
    };
    this.input.add(
      // ---- flight: mission
      { code: 'Escape', screen: flight, group: 'Mission', label: 'Pause / resume', keyLabel: 'Esc', preventDefault: true, handler: () => this.togglePause() },
      { code: 'Space', screen: flight, group: 'Mission', label: 'Fire next stage', keyLabel: 'Space', handler: act(() => this.stage()) },
      { code: 'KeyM', screen: flight, group: 'Mission', label: 'Toggle map view', handler: act(() => this.toggleMap()) },
      { code: 'F5', screen: flight, group: 'Mission', label: 'Quicksave', preventDefault: true, handler: act(() => this.quickSave()) },
      { code: 'F9', screen: flight, group: 'Mission', label: 'Quickload', preventDefault: true, handler: act(() => void this.quickLoad()) },
      { code: 'BracketLeft', screen: flight, group: 'Mission', label: 'Previous vessel', handler: act(() => this.cycleVessel(-1)) },
      { code: 'BracketRight', screen: flight, group: 'Mission', label: 'Next vessel', handler: act(() => this.cycleVessel(1)) },
      { code: 'Backspace', screen: flight, group: 'Mission', label: 'Abort group (reserved)', keyLabel: 'Bksp', handler: act(() => {
        const gv = this.game.active!;
        logEvent(gv.runtime, this.game.time, 'Abort action group is not assigned.', 'warning');
      }) },
      // ---- flight: control
      { code: 'KeyT', screen: flight, group: 'Control', label: 'Toggle SAS', handler: vessel((v) => (v.sas = v.sas === 'off' ? 'stability' : 'off')) },
      { code: 'KeyR', screen: flight, group: 'Control', label: 'Toggle RCS', handler: vessel((v) => (v.controls.rcs = !v.controls.rcs)) },
      { code: 'KeyZ', screen: flight, group: 'Control', label: 'Full throttle', handler: vessel((v) => (v.controls.throttle = 1)) },
      { code: 'KeyX', screen: flight, group: 'Control', label: 'Cut throttle', handler: vessel((v) => (v.controls.throttle = 0)) },
      { code: 'CapsLock', screen: flight, group: 'Control', label: 'Precision control', keyLabel: 'CapsLock', handler: (e) => {
        this.precisionControl = e.getModifierState('CapsLock');
      } },
      { code: 'KeyV', screen: flight, group: 'Camera', label: 'Cycle camera mode', handler: act(() => this.world.cycleCameraMode()) },
      { code: 'Home', screen: flight, group: 'Camera', label: 'Reset/recenter camera', handler: act(() => {
        if (this.map.visible) this.map.resetCamera();
        else this.world.resetCamera();
      }) },
      { code: 'F2', screen: flight, group: 'Camera', label: 'Hide screenshot UI', preventDefault: true, handler: () => this.toggleUi() },
      // ---- flight: held keys (polled in the frame loop; listed for the cheat sheet)
      { code: '', screen: flight, group: 'Control', label: 'Pitch', keyLabel: 'W / S' },
      { code: '', screen: flight, group: 'Control', label: 'Yaw', keyLabel: 'A / D' },
      { code: '', screen: flight, group: 'Control', label: 'Roll', keyLabel: 'Q / E' },
      { code: '', screen: flight, group: 'Control', label: 'Throttle up / down', keyLabel: 'Shift / Ctrl' },
      { code: '', screen: flight, group: 'Control', label: 'RCS translate', keyLabel: 'I J K L U O' },
      // ---- flight: time
      { code: 'Comma', screen: flight, group: 'Time', label: 'Warp slower', handler: act(() => this.stepWarp(-1)) },
      { code: 'Period', screen: flight, group: 'Time', label: 'Warp faster', handler: act(() => this.stepWarp(1)) },
      { code: 'Period', alt: true, screen: flight, group: 'Time', label: 'Force physics warp', handler: act(() => {
        const index = this.game.railsWarp ? 1 : Math.min(PHYSICS_WARP_RATES.length - 1, this.game.warpIndex + 1);
        this.game.setWarp(index, false);
      }) },
      { code: 'Slash', screen: flight, group: 'Time', label: 'Cancel warp', keyLabel: '/', handler: act(() => {
        this.pendingWarpStop = null;
        this.game.setWarp(0, false);
      }) },
      // ---- editor
      { code: 'Delete', screen: editor, group: 'Workshop', label: 'Delete selected part / drop held', keyLabel: 'Del', handler: () => this.editor.deleteSelected() },
      { code: 'Backspace', screen: editor, group: 'Workshop', label: 'Delete selected part / drop held', keyLabel: 'Bksp', handler: () => this.editor.deleteSelected() },
      { code: 'Escape', screen: editor, group: 'Workshop', label: 'Close context / drop held / clear selection', keyLabel: 'Esc', handler: () => this.editor.escape() },
      { code: 'KeyZ', ctrl: true, screen: editor, group: 'Workshop', label: 'Undo craft edit', handler: () => this.editor.undo() },
      { code: 'KeyY', ctrl: true, screen: editor, group: 'Workshop', label: 'Redo craft edit', handler: () => this.editor.redo() },
      { code: 'KeyX', screen: editor, group: 'Workshop', label: 'Cycle radial symmetry', handler: () => this.editor.cycleSymmetry() },
      { code: 'KeyX', shift: true, screen: editor, group: 'Workshop', label: 'Cycle symmetry backward', handler: () => this.editor.cycleSymmetry(-1) },
      { code: 'KeyR', screen: editor, group: 'Workshop', label: 'Toggle radial / mirror symmetry', handler: () => this.editor.toggleSymmetryMode() },
      { code: 'KeyC', screen: editor, group: 'Workshop', label: 'Cycle angle snap', handler: () => this.editor.cycleSnap() },
      { code: 'KeyV', screen: editor, group: 'Workshop', label: 'Align selected part vertically', handler: () => this.editor.verticalAlignSelected() },
      { code: 'Digit4', screen: editor, group: 'Workshop', label: 'Re-root at selected part', handler: () => this.editor.rerootSelected() },
      { code: 'Space', screen: editor, group: 'Workshop', label: 'Reset part rotation', handler: () => this.editor.resetSelectedRotation() },
      { code: 'Home', screen: editor, group: 'Camera', label: 'Fit craft in view', handler: () => this.editor.fitCamera() },
      { code: 'KeyF', screen: editor, group: 'Camera', label: 'Frame selected part', handler: () => this.editor.frameSelected() },
      { code: 'KeyF', ctrl: true, screen: editor, group: 'Palette', label: 'Focus part search', handler: () => this.editor.focusSearch() },
      { code: 'Slash', screen: editor, group: 'Palette', label: 'Focus part search', keyLabel: '/', handler: () => this.editor.focusSearch() },
      { code: 'BracketLeft', screen: editor, group: 'Palette', label: 'Previous part category', handler: () => this.editor.cycleCategory(-1) },
      { code: 'BracketRight', screen: editor, group: 'Palette', label: 'Next part category', handler: () => this.editor.cycleCategory(1) },
      { code: 'KeyW', screen: editor, group: 'Part / camera', label: 'Pitch part / raise camera', handler: (e) => this.editor.hasPartSelection ? this.editor.rotateSelected('x', 1, e.shiftKey) : this.editor.panCameraLocal(0, 0.25, 0) },
      { code: 'KeyS', screen: editor, group: 'Part / camera', label: 'Pitch part / lower camera', handler: (e) => this.editor.hasPartSelection ? this.editor.rotateSelected('x', -1, e.shiftKey) : this.editor.panCameraLocal(0, -0.25, 0) },
      { code: 'KeyA', screen: editor, group: 'Part / camera', label: 'Yaw part / pan left', handler: (e) => this.editor.hasPartSelection ? this.editor.rotateSelected('y', -1, e.shiftKey) : this.editor.panCameraLocal(-0.25, 0, 0) },
      { code: 'KeyD', screen: editor, group: 'Part / camera', label: 'Yaw part / pan right', handler: (e) => this.editor.hasPartSelection ? this.editor.rotateSelected('y', 1, e.shiftKey) : this.editor.panCameraLocal(0.25, 0, 0) },
      { code: 'KeyQ', screen: editor, group: 'Part / camera', label: 'Roll part / pan inward', handler: (e) => this.editor.hasPartSelection ? this.editor.rotateSelected('z', -1, e.shiftKey) : this.editor.panCameraLocal(0, 0, -0.25) },
      { code: 'KeyE', screen: editor, group: 'Part / camera', label: 'Roll part / pan outward', handler: (e) => this.editor.hasPartSelection ? this.editor.rotateSelected('z', 1, e.shiftKey) : this.editor.panCameraLocal(0, 0, 0.25) },
      { code: 'KeyW', shift: true, screen: editor, group: 'Part / camera', label: 'Fine pitch part', handler: () => this.editor.rotateSelected('x', 1, true) },
      { code: 'KeyS', shift: true, screen: editor, group: 'Part / camera', label: 'Fine pitch part backward', handler: () => this.editor.rotateSelected('x', -1, true) },
      { code: 'KeyA', shift: true, screen: editor, group: 'Part / camera', label: 'Fine yaw part left', handler: () => this.editor.rotateSelected('y', -1, true) },
      { code: 'KeyD', shift: true, screen: editor, group: 'Part / camera', label: 'Fine yaw part right', handler: () => this.editor.rotateSelected('y', 1, true) },
      { code: 'KeyQ', shift: true, screen: editor, group: 'Part / camera', label: 'Fine roll part left', handler: () => this.editor.rotateSelected('z', -1, true) },
      { code: 'KeyE', shift: true, screen: editor, group: 'Part / camera', label: 'Fine roll part right', handler: () => this.editor.rotateSelected('z', 1, true) },
      { code: '', screen: editor, group: 'Workshop', label: 'Orbit camera', keyLabel: 'Drag' },
      { code: '', screen: editor, group: 'Workshop', label: 'Pan camera', keyLabel: 'Middle-drag' },
      { code: '', screen: editor, group: 'Workshop', label: 'Duplicate subtree', keyLabel: 'Alt+click' },
      { code: '', screen: editor, group: 'Workshop', label: 'Zoom', keyLabel: 'Wheel' },
      // ---- help (both screens)
      { code: 'Slash', shift: true, screen: 'any', group: 'Help', label: 'Show this cheat sheet', keyLabel: '?', handler: () => {
        if (this.screen === 'flight' || this.screen === 'editor') this.cheatSheet.toggle(this.screen as BindingScreen);
      } },
    );
    for (const group of ACTION_GROUP_IDS) {
      this.input.add({
        code: group === 10 ? 'Digit0' : `Digit${group}`,
        screen: flight,
        group: 'Action groups',
        label: `Execute action group ${group === 10 ? 0 : group}`,
        handler: act(() => this.executeActionGroup(group)),
      });
    }
  }

  private cycleVessel(dir: number): void {
    const list = this.game.vessels.filter((gv) => !gv.runtime.isDebris);
    if (list.length < 2) return;
    const idx = list.findIndex((gv) => gv.runtime.id === this.game.activeVesselId);
    const next = list[(idx + dir + list.length) % list.length];
    this.activateVessel(next.runtime.id);
  }

  private activateVessel(id: string): void {
    if (!this.game.vessels.some((vessel) => vessel.runtime.id === id)) return;
    this.game.setActive(id);
    this.map.focusActiveVessel(this.game);
    this.hud.setMissionStart(this.game.time);
  }

  private stepWarp(dir: number): void {
    const g = this.game;
    if (dir > 0) {
      if (!g.railsWarp && g.warpIndex >= PHYSICS_WARP_RATES.length - 1) {
        const active = g.active;
        const check = active ? g.canRailsWarp(active) : { ok: true };
        if (!check.ok) {
          if (active && check.reason) logEvent(active.runtime, g.time, check.reason, 'warning');
          return;
        }
        g.setWarp(1, true);
      } else {
        g.setWarp(g.warpIndex + 1, g.railsWarp);
      }
    } else {
      if (g.railsWarp && g.warpIndex <= 1) g.setWarp(PHYSICS_WARP_RATES.length - 1, false);
      else g.setWarp(g.warpIndex - 1, g.railsWarp);
    }
  }

  private applyContinuousInput(dt: number): void {
    const gv = this.game.active;
    if (!gv || this.screen !== 'flight') return;
    const c = gv.runtime.controls;
    const t = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 1 : 0;
    const b = this.keys.has('ControlLeft') || this.keys.has('ControlRight') ? 1 : 0;
    c.throttle = Math.max(0, Math.min(1, c.throttle + (t - b) * dt * 0.6));
    const authority = this.precisionControl ? 0.35 : 1;
    const clampControl = (value: number) => Math.max(-1, Math.min(1, value)) * authority;
    c.pitch = clampControl(
      (this.keys.has('KeyS') ? 1 : 0) - (this.keys.has('KeyW') ? 1 : 0) + this.touchFlightControl.pitch,
    );
    c.yaw = clampControl(
      (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0) + this.touchFlightControl.yaw,
    );
    c.roll = clampControl(
      (this.keys.has('KeyE') ? 1 : 0) - (this.keys.has('KeyQ') ? 1 : 0) + this.touchFlightControl.roll,
    );
    c.translate.set(
      clampControl((this.keys.has('KeyL') ? 1 : 0) - (this.keys.has('KeyJ') ? 1 : 0) + this.touchFlightControl['translate-x']),
      clampControl((this.keys.has('KeyI') ? 1 : 0) - (this.keys.has('KeyK') ? 1 : 0) + this.touchFlightControl['translate-y']),
      clampControl((this.keys.has('KeyO') ? 1 : 0) - (this.keys.has('KeyU') ? 1 : 0) + this.touchFlightControl['translate-z']),
    );
  }

  private resetTouchFlightControls(): void {
    for (const axis of Object.keys(this.touchFlightControl) as FlightControlAxis[]) {
      this.touchFlightControl[axis] = 0;
    }
    const controls = this.game.active?.runtime.controls;
    if (!controls) return;
    controls.pitch = 0;
    controls.yaw = 0;
    controls.roll = 0;
    controls.translate.set(0, 0, 0);
  }

  private updateCampaignAchievements(): void {
    const gv = this.game.active;
    if (!gv) return;
    const vessel = gv.runtime;
    if (
      vessel.bodyId === 'veyra'
      && vessel.situation === 'orbit'
      && !this.game.flags['campaign:veyra-orbit']
    ) {
      const body = this.game.bodyOf(gv);
      const orbit = stateToElements(body.mu, vessel.pos, vessel.vel, this.game.time);
      if (periapsisOf(orbit) > body.radius) this.game.flags['campaign:veyra-orbit'] = true;
    }
    if (
      vessel.bodyId === 'palla'
      && (vessel.situation === 'landed' || vessel.situation === 'prelaunch')
    ) {
      this.game.flags['campaign:palla-landed'] = true;
    }
    const body = this.game.bodyOf(gv);
    if (
      body.parent?.id === 'tyran'
      && (vessel.situation === 'landed' || vessel.situation === 'prelaunch')
    ) {
      this.game.flags['campaign:outer-moon-landed'] = true;
    }
    this.completeCampaignContracts();
  }

  private completeCampaignContracts(): void {
    const completed = settleContracts(this.game.campaign, this.game.flags);
    if (!completed.length) return;
    const vessel = this.game.active?.runtime;
    if (vessel) {
      for (const contract of completed) {
        logEvent(
          vessel,
          this.game.time,
          `Contract fulfilled: ${contract.name}. +${contract.rewardFunds.toLocaleString()} funds, +${contract.rewardReputation} reputation.`,
        );
      }
    }
    this.editor.refreshCampaign();
    this.scheduleAutosave();
  }

  // ------------------------------------------------------------------ loop
  private frame(): void {
    const now = performance.now();
    const dtMs = now - this.lastFrame;
    this.lastFrame = now;
    const realDt = dtMs > 1_000 ? 0 : Math.max(0, dtMs / 1000);
    const dt = Math.min(0.1, realDt);

    const simStart = this.perf.beginSim();
    if (this.screen === 'flight') {
      // Comms: re-evaluate twice a second; probes need a link for control.
      if (now - this.lastCommsCheck > 500) {
        this.lastCommsCheck = now;
        const gv = this.game.active;
        if (gv) {
          this.comms = evaluateComms(this.game, gv);
          this.controlBlocked = needsCommsForControl(gv) && !this.comms.connected;
          this.hud.setComms(this.comms, this.controlBlocked);
        }
      }
      if (!this.paused) {
        if (!this.controlBlocked) this.applyContinuousInput(dt);
        this.updateNodeAssist(dt);
        // Keep short browser/UI stalls from looking like a player-requested
        // warp cancel. GameState still advances at the selected rate, but the
        // per-frame catch-up request is bounded to what physics warp can run.
        this.game.update(dt);
        this.updateCampaignAchievements();
        if (now - this.lastAutoScienceCheck > 500) {
          this.lastAutoScienceCheck = now;
          this.runAutoScience();
        }
        for (const alarm of this.game.consumeFiredAlarms()) {
          const vessel = (alarm.vesselId
            ? this.game.vessels.find((candidate) => candidate.runtime.id === alarm.vesselId)
            : this.game.active)?.runtime;
          if (vessel) logEvent(vessel, this.game.time, `Alarm: ${alarm.label}`, 'warning');
          this.missionTools.showFiredAlarm(alarm);
        }
      }

      const rendererFailure = this.world.rendererFailure();
      if (this.rendererFailureEl && this.rendererFailureMessage) {
        this.rendererFailureEl.hidden = !rendererFailure;
        if (rendererFailure) {
          this.rendererFailureMessage.textContent =
            `Detailed planet visuals for ${rendererFailure.bodyId} could not load. Procedural fallback active.`;
          const signature = `${rendererFailure.bodyId}:${rendererFailure.message}`;
          if (signature !== this.reportedRendererFailure) {
            this.reportedRendererFailure = signature;
            clientLog.error('sim.boundary.error', new Error(`Planet renderer degraded: ${signature}`), {
              boundary: 'planet-renderer',
              errorType: 'RenderDegradation',
            });
          }
        }
      }

      // Auto warp stop at node.
      if (!this.paused && this.pendingWarpStop !== null && this.game.time >= this.pendingWarpStop) {
        this.game.setWarp(0, false);
        this.pendingWarpStop = null;
      }

      // Periodic autosave (wall-clock; skips high warp to avoid stutter).
      if (!this.paused && now - this.lastAutosave > 120_000 && this.game.warpRate <= 5) {
        this.lastAutosave = now;
        this.scheduleAutosave();
      }

      // Destruction dialog.
      if (this.game.lastDestruction) {
        const reason = this.game.lastDestruction.reason;
        this.showDialog('Flight over', `${reason}. The review board recommends... adjustments.`, [
          { label: 'Revert to launch', fn: () => this.revert() },
          { label: 'Back to Workshop', fn: () => this.toEditor() },
        ]);
      }
    }
    this.perf.endSim(simStart);

    const renderStart = performance.now();
    if (this.screen === 'flight') {
      if (this.map.visible) {
        this.map.update(this.game);
        if (!this.ctx.renderPaused) {
          this.gpuProfiler.submit('map', () => this.ctx.renderer.render(this.map.scene, this.map.camera));
        }
      } else {
        this.world.update(this.game, dt, this.paused ? 0 : realDt);
        if (!this.ctx.renderPaused) {
          this.gpuProfiler.submit('flight', () => this.world.render());
        }
      }
      const active = this.game.active;
      const maneuver = active
        ? this.maneuver.nextFor(active.runtime.id, active.runtime.bodyId)
        : null;
      this.hud.update(this.game, maneuver?.node ?? null, {
        nodeRemainingDv: maneuver?.remainingDeltaV ?? 0,
        nodeBurnDirection: maneuver?.burnDirection ?? null,
        cameraMode: this.world.cameraMode,
        precision: this.precisionControl,
        entryPrediction: this.map.entryPrediction,
        landingTargetDirBF: this.map.landingTargetDirBF,
      });
      if (this.hud.pendingWarpStep !== 0) {
        this.stepWarp(this.hud.pendingWarpStep);
        this.hud.pendingWarpStep = 0;
      }
      const stats = this.world.renderStats();
      this.perf.setRendererMetrics(stats);
      if (!this.ctx.renderPaused) this.gpuProfiler.poll();
      this.perf.setGpuMetrics(this.gpuProfiler.metrics());
    } else if (this.screen === 'editor') {
      this.editor.update();
      if (!this.ctx.renderPaused) this.ctx.renderer.render(this.editor.scene, this.editor.camera);
    } else {
      // Menu: idle starfield via world scene if available.
      if (!this.ctx.renderPaused) this.ctx.renderer.clear();
    }
    this.perf.endRender(renderStart);
    this.perf.frame(dtMs, this.ctx.renderer);
    this.windows.update();

    this.tutorial.update({ game: this.game, editor: this.editor, screen: this.screen });

    if (this.keys.has('F3')) {
      this.keys.delete('F3');
      this.perf.toggle();
    }

    requestAnimationFrame(() => this.frame());
  }

  /** SAS 'node' mode: aim at the planned burn and track remaining Δv. */
  private updateNodeAssist(dt: number): void {
    const gv = this.game.active;
    if (!gv) return;
    const v = gv.runtime;
    const body = this.game.bodyOf(gv);
    const plan = this.maneuver.nextFor(v.id, body.id);
    if (!plan) return;

    const analysis = analyzeCraft(v.craft, body.surfaceGravity, body.pressureAt(v.pos.length() - body.radius));
    const powered = analysis.stages.find((stage) => stage.stageIndex >= v.currentStage && stage.thrust > 0)
      ?? [...analysis.stages].reverse().find((stage) => stage.thrust > 0);
    const burnDuration = powered
      ? estimateBurnTime(plan.initialDeltaV, powered.thrust, v.massProps.mass, powered.isp)
      : 0;
    const burnStart = plan.node.time - (Number.isFinite(burnDuration) ? burnDuration / 2 : 0);
    if ((plan.phase === 'planned' || plan.phase === 'overdue') && v.controls.throttle > 0.001 && this.game.time >= burnStart) {
      this.maneuver.beginExecution(plan.id);
    }
    this.maneuver.markOverdue(this.game.time, burnDuration, 3, plan.id);

    const activePlan = this.maneuver.nextFor(v.id, body.id);
    if (!activePlan) return;
    if (v.sas === 'node') v.sasCustomDir.copy(activePlan.burnDirection);
    if (activePlan.phase === 'executing' && v.controls.throttle > 0.001) {
      const thrustDirection = v.att.rotate(new Vec3(0, 1, 0), new Vec3());
      const remaining = this.maneuver.consumeDeliveredDeltaV(
        v.properAccel,
        thrustDirection,
        dt,
        0.5,
        activePlan.id,
      );
      if (remaining <= 0) {
        if (v.sas === 'node') v.controls.throttle = 0;
        logEvent(v, this.game.time, 'Maneuver complete.');
        this.maneuver.clear(activePlan.id);
        const achieved = stateToElements(body.mu, v.pos, v.vel, this.game.time);
        this.maneuver.rebaseFirst(v.id, body.id, achieved);
      }
    }
  }

  private createManeuverNode(node: ManeuverNode): void {
    const gv = this.game.active;
    if (!gv) return;
    const body = this.game.bodyOf(gv);
    const reference = stateToElements(body.mu, gv.runtime.pos, gv.runtime.vel, this.game.time);
    this.maneuver.create(gv.runtime.id, body.id, reference, node);
  }
}

export async function startGame(options: Readonly<RenderStartupOptions>): Promise<void> {
  const game = new PeriluneGame(options);
  await game.start();
}
