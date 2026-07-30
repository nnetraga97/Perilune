/**
 * Perilune game shell: main menu → workshop (editor) → flight, the master
 * loop, input handling, and mission actions (staging, science, recovery,
 * quicksave/load, maneuver execution, time warp).
 */
import * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { Vec3 } from './core/vec3';
import { Quat } from './core/quat';
import { GameState, PHYSICS_WARP_RATES, RAILS_WARP_RATES } from './sim/state';
import {
  ACTION_GROUP_IDS,
  Craft,
  analyzeCraft,
  craftAxialVisualBounds,
  craftVisualRadius,
  defOf,
  type ActionGroupId,
} from './sim/vessel';
import { createRenderContext, RenderContext } from './render/context';
import { WorldScene } from './render/worldScene';
import { checkPartModelManifest } from './render/partModelManifest';
import { createBrowserPartModelLibrary, type PartModelLibrary } from './render/partModelLibrary';
import checkedPartArtifact from './generated/checked-part-manifest.json';
import { Editor, type EditorDisplayVisual } from './ui/editor';
import type { AeroLab } from './ui/aeroLab';
import { resolveAeroLabEnvironment } from './sim/aeroLab';
import { aeroLabFingerprint } from './render/aeroLabGeometry';
import { FlightHud, type FlightControlAxis } from './ui/flightHud';
import { MapView } from './ui/mapView';
import { Tutorial } from './ui/tutorial';
import {
  ArtemisIvGuide,
  type ArtemisIvGuideContextualAction,
  type ArtemisIvGuidePresentation,
} from './ui/artemisIvGuide';
import { GpuSubmissionProfiler, PerfOverlay } from './ui/perfOverlay';
import { GpuTimerRing } from './render/gpuTimer';
import { restoreGame, serializeGame } from './save/persistence';
import {
  igniteManeuverEngines,
  logEvent,
  maxThrust,
  setExternalLandingFootprint,
} from './sim/flight';
import { CommsStatus, evaluateComms, needsCommsForControl } from './sim/comms';
import { estimateBurnTime, nodeDeltaV, type ManeuverNode } from './sim/maneuver';
import { ManeuverPlanController, type ManeuverPlan } from './sim/maneuverPlan';
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
import {
  bindMenuContinueSave,
  MainMenu,
  type ArtemisIvMenuAction,
  type ArtemisIvMenuState,
} from './ui/mainMenu';
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
import { GAMEPLAY_PROFILES } from './content/gameplayProfiles';
import {
  createFirstLightRocket,
  createSecondLightCraft,
  createStarshipConceptDisplayCraft,
  isStarshipConceptDisplayCraft,
  STARSHIP_CONCEPT_DEFAULT_BODY_ID,
  STARSHIP_CONCEPT_DEFAULT_ORBIT_ALTITUDE,
  STARSHIP_CONCEPT_DEFAULT_VESSEL_NAME,
  type BuiltInCraftVisualId,
} from './content/crafts';
import { maneuverAutomationCommand } from './sim/maneuverAutomation';
import { planMoonCourseCorrection, planTransfer } from './sim/transfer';
import {
  artemisIvHighTierRendererBaseBytes,
  createBrowserArtemisIvAssetLoader,
  preflightArtemisIvAssets,
  recheckArtemisIvPreparedSceneBudget,
  type ArtemisIvAssetLoader,
} from './missions/artemisIv/assets';
import {
  ARTEMIS_IV_POST_TLI_START_NODE,
  ARTEMIS_IV_PREPARED,
  ARTEMIS_IV_PREPARED_MANEUVER_IDS,
  ARTEMIS_IV_SOUTH_POLE_TRAINING_ANALOGUE,
  assessArtemisIvDescentSetup,
  assessArtemisIvLunarOrbitInsertion,
  assessArtemisIvPostTliCorrection,
  assessArtemisIvTransEarthInjection,
  artemisIvCheckpointForChapter,
  completeArtemisIvAutomatedLanding,
  initializeArtemisIvCheckpoint,
  prepareArtemisIvEarthApproach,
  prepareArtemisIvLunarInsertion,
} from './missions/artemisIv/checkpoints';
import {
  bindArtemisIvRole,
  recordArtemisIvDocking,
  recordArtemisIvUndocking,
  setActiveArtemisIvRole,
  vesselForArtemisIvRole,
  type ArtemisIvMissionState,
} from './missions/artemisIv/mission';
import {
  artemisIvGuideViewModel,
  continueArtemisIvGuide,
  createArtemisIvGuideProgress,
  currentArtemisIvGuideStep,
  updateArtemisIvGuide,
  type ArtemisIvGuideProgress,
} from './missions/artemisIv/guide';
import {
  ARTEMIS_IV_ACKNOWLEDGEMENTS,
  ARTEMIS_IV_MISSION_VERSION,
  ARTEMIS_IV_SESSION_DOCUMENT_VERSION,
  ArtemisIvSessionStore,
  browserArtemisIvSessionStore,
  type ArtemisIvChapter,
} from './missions/artemisIv/session';
import {
  ARTEMIS_IV_CAMERA_FRAMING_RADII,
  createArtemisIvVisualComposite,
  type ArtemisIvVisualComposite,
} from './missions/artemisIv/visuals';
import {
  applyArtemisIvRenderScale,
  type ArtemisIvRenderScaleLease,
} from './missions/artemisIv/renderScale';
import { drawingBufferResourceBytes } from './render/resourceAccounting';
import {
  artemisIvGuideReadouts,
  createArtemisIvRendererResourceLedger,
  prepareArtemisIvDockingCapture,
  syncArtemisIvLiveTelemetry,
} from './missions/artemisIv/runtime';

type Screen = 'menu' | 'editor' | 'aero-lab' | 'flight';
type SessionKind = 'standard' | 'first-light' | 'artemis-iv';

function isBindingScreen(screen: Screen): screen is BindingScreen {
  return screen !== 'menu';
}

const ARTEMIS_IV_MENU_ENABLED = import.meta.env.DEV
  || import.meta.env.VITE_ARTEMIS_IV_MENU_ENABLED === 'true';

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
  private game = new GameState('sandbox', GAMEPLAY_PROFILES.sol);
  private world!: WorldScene;
  private partModels!: PartModelLibrary;
  private ktx2Loader: KTX2Loader | null = null;
  private editor!: Editor;
  private aeroLab: AeroLab | null = null;
  private aeroLabLoadingEl!: HTMLElement;
  private aeroLabLoadingMessage!: HTMLElement;
  private aeroLabSnapshotFingerprint = '';
  private hud!: FlightHud;
  private map!: MapView;
  private tutorial!: Tutorial;
  private artemisIvGuide!: ArtemisIvGuide;
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
  private readonly conceptVisualPending = new Set<string>();
  private readonly conceptVisualFailed = new Set<string>();
  private sessionKind: SessionKind = 'standard';
  private artemisIvSessionStore: ArtemisIvSessionStore | null = null;
  private artemisIvMission: ArtemisIvMissionState | null = null;
  private artemisIvGuideProgress: ArtemisIvGuideProgress | null = null;
  private artemisIvAssetLoader: ArtemisIvAssetLoader | null = null;
  private artemisIvVisuals: ArtemisIvVisualComposite | null = null;
  private artemisIvRestoreQuality: 'low' | 'medium' | 'high' | null = null;
  private artemisIvRenderScaleLease: ArtemisIvRenderScaleLease | null = null;
  private artemisIvTransitionGeneration = 0;
  private artemisIvActiveTransition: number | null = null;
  private readonly artemisIvManeuverIds = new Map<string, string>();
  private readonly artemisIvRendererLedger = createArtemisIvRendererResourceLedger(
    () => this.artemisIvRendererBaseBytes(),
  );
  private firstLightMoonCorrectionApplied = false;
  private missionStart = 0;
  private maneuver = new ManeuverPlanController();
  private autoManeuverPlanId: string | null = null;
  private autoManeuverPauseLoggedFor: string | null = null;
  private precisionControl = false;
  private paused = false;
  private uiHidden = false;
  private uiHideHeld = false;
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
  private launchPreparation: {
    readonly game: GameState;
    readonly bodyId: string;
    readonly promise: Promise<void>;
  } | null = null;
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
    this.cancelArtemisIvTransition();
    window.removeEventListener('pagehide', this.onPageHide);
    this.unsubscribeGpuRestoration?.();
    this.unsubscribeGpuRestoration = null;
    this.unsubscribeMenuSave?.();
    this.unsubscribeMenuSave = null;
    this.gpuProfiler.dispose();
    this.saveSync.dispose();
    this.auth.dispose();
    this.missionTools.dispose();
    this.map.dispose();
    this.disposeArtemisIvVisualResources(false);
    // Remove vessel visuals first, then release shared model resources once.
    this.world.dispose();
    this.partModels.dispose();
    this.ktx2Loader?.dispose();
    this.ktx2Loader = null;
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
    this.ktx2Loader = new KTX2Loader()
      .setTranscoderPath(`${baseUrl}basis/`)
      .detectSupport(this.ctx.renderer);
    this.partModels = createBrowserPartModelLibrary(this.ctx.renderer, checkedParts, {
      transcoderPath: `${baseUrl}basis/`,
      ktx2: this.ktx2Loader,
      // Content-address the request so a regenerated GLB cannot be confused with
      // an older browser-cached response at the same public path.
      resolveAssetUrl: (path, sha256) => `${baseUrl}parts/${path}?v=${sha256}`,
    });
    await this.partModels.preload();
    this.world = new WorldScene(this.ctx, this.partModels, {
      quality: this.renderOptions.quality,
      diagnostics: this.diagnostics,
      reentryEffectsEnabled: this.renderOptions.reentryVfx,
      ktx2Loader: this.ktx2Loader,
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
      onLaunch: (craft, displayVisual) => this.launch(craft, displayVisual),
      onSimulateAirflow: (craft, environment) => void this.enterAeroLab(craft, environment),
      canSimulateAirflow: () => this.sessionKind === 'standard',
      onExit: () => this.showMenu(),
      loadBuiltInVisual: (id) => this.loadEditorBuiltInVisual(id),
      campaign: () => this.game.campaign,
      flightTuning: () => this.game.flightTuning,
      systemId: () => this.game.systemId,
    }, this.partModels, this.ctx.renderer);
    this.aeroLabLoadingEl = el('div', 'aero-lab-loading', this.uiRoot);
    this.aeroLabLoadingMessage = el('div', '', this.aeroLabLoadingEl, 'LOADING AERODYNAMICS LAB');
    const cancelAeroLabLoad = el('button', 'hud-btn', this.aeroLabLoadingEl, '← BACK TO WORKSHOP');
    cancelAeroLabLoad.onclick = () => this.restoreEditorFromAeroLab();
    this.aeroLabLoadingEl.style.display = 'none';
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
        if (gv && !this.controlBlocked) {
          this.clearHeldThrottleInput();
          gv.runtime.controls.throttle = Math.max(0, Math.min(1, value));
        }
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
      onDeleteManeuverNode: () => {
        const selected = this.maneuver.current?.id ?? null;
        if (selected === this.autoManeuverPlanId) this.autoManeuverPlanId = null;
        if (selected) this.artemisIvManeuverIds.delete(selected);
        this.maneuver.clear();
      },
      onWarpToNode: (node) => this.warpToNode(node),
      isManeuverAutoExecutionEnabled: (id) => this.autoManeuverPlanId === id,
      onToggleManeuverAutoExecution: (id) => this.toggleManeuverAutoExecution(id),
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
    this.tutorial = new Tutorial(this.uiRoot, {
      onComplete: (phase) => {
        this.game.flags[phase === 'earth' ? 'tutorialDone' : 'tutorialMoonDone'] = true;
        this.scheduleAutosave();
      },
      onRevert: () => this.revert(),
      onContinueToMoon: () => this.planFirstLightMoonTransfer(),
      onStartSecondLight: () => this.startSecondLight(),
    });
    this.artemisIvGuide = new ArtemisIvGuide(this.uiRoot, {
      onContinue: () => this.continueArtemisIvTextStep(),
      onContextualAction: (action) => this.handleArtemisIvContextualAction(action),
      onRetryChapter: () => void this.retryArtemisIvChapter(),
      onSkipChapter: () => this.confirmSkipArtemisIvChapter(),
      onExit: () => this.confirmExitArtemisIv(),
    });
    this.artemisIvSessionStore = browserArtemisIvSessionStore();
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
      persistenceStatus: () => this.sessionKind === 'artemis-iv'
        ? { enabled: false, reason: 'Artemis IV uses a local chapter checkpoint. Normal saves and sync are unavailable during the mission.' }
        : this.game.persistence === 'enabled'
          ? { enabled: true }
          : { enabled: false, reason: 'Legacy Auren is session-only. Save, load, sync, and Continue are unavailable.' },
      onSave: (slot, label) => this.writeSave(slot, label),
      onLoad: (slot) => this.loadSlot(slot),
      onListSaves: () => this.sessionKind !== 'artemis-iv' && this.game.persistence === 'enabled'
        ? this.saveSync.list() : Promise.resolve([]),
      onRefreshSaves: () => this.sessionKind !== 'artemis-iv' && this.game.persistence === 'enabled'
        ? this.saveSync.refresh() : Promise.resolve(),
      onDeleteSave: (slot) => this.sessionKind !== 'artemis-iv' && this.game.persistence === 'enabled'
        ? this.saveSync.delete(slot) : Promise.resolve(false),
      onResolveConflict: (slot, choice) => this.sessionKind !== 'artemis-iv' && this.game.persistence === 'enabled'
        ? this.saveSync.resolveConflict(slot, choice)
        : Promise.resolve(false),
      onSavesChanged: (listener) => this.saveSync.subscribe(listener),
      onSettings: (settings) => this.applySettings(settings),
      onTelemetry: (enabled) => telemetry.setEnabled(enabled),
      onCampaignChanged: () => {
        this.editor.refreshCampaign();
        void this.writeSave('auto', 'autosave');
      },
    });
    this.menu = new MainMenu(this.uiRoot, {
      onArtemisIv: (action) => this.openArtemisIv(action),
      onFirstLight: () => this.startFirstLight(),
      onRestart: (mission) => {
        if (mission === 'artemis-iv') this.confirmRestartArtemisIv();
        else this.confirmRestartFirstLight();
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
    }, {
      artemisIvEnabled: ARTEMIS_IV_MENU_ENABLED,
      artemisIvState: this.artemisIvMenuState(),
    });
    this.unsubscribeMenuSave = bindMenuContinueSave(this.saveSync, this.menu);
    void this.auth.start();
    this.windows.addAction('keyboard', 'Keyboard reference (?)', () => {
      if (isBindingScreen(this.screen)) {
        this.cheatSheet.toggle(this.screen);
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
      aeroLab: () => this.aeroLab?.testState() ?? null,
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
      vessels: () => this.game.vessels.map((vessel) => ({
        id: vessel.runtime.id,
        name: vessel.runtime.name,
        bodyId: vessel.runtime.bodyId,
        situation: vessel.runtime.situation,
        active: vessel.runtime.id === this.game.activeVesselId,
      })),
      fleetOrbitCount: () => this.map.fleetOrbitCount(),
      externalVisualAttached: (vesselId: string) => this.world.hasExternalVesselVisual(vesselId),
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
        editorCameraPitch: this.editor.cameraPitch,
        editorUndoDepth: this.editor.undoDepth,
      }),
    };
  }

  // ------------------------------------------------------------------ menu
  private beginArtemisIvTransition(): number | null {
    if (this.artemisIvActiveTransition !== null) return null;
    const generation = ++this.artemisIvTransitionGeneration;
    this.artemisIvActiveTransition = generation;
    return generation;
  }

  private isCurrentArtemisIvTransition(
    generation: number,
    mission?: ArtemisIvMissionState,
  ): boolean {
    return this.artemisIvActiveTransition === generation
      && this.artemisIvTransitionGeneration === generation
      && (mission === undefined || this.artemisIvMission === mission);
  }

  private finishArtemisIvTransition(generation: number): void {
    if (this.artemisIvActiveTransition === generation) {
      this.artemisIvActiveTransition = null;
    }
  }

  private cancelArtemisIvTransition(): void {
    this.artemisIvTransitionGeneration++;
    this.artemisIvActiveTransition = null;
    if (this.dialogEl?.dataset.artemisIvTransition !== undefined) {
      this.dialogEl.remove();
      this.dialogEl = null;
    }
  }

  private showArtemisIvPreparing(
    generation: number,
    title: string,
    message: string,
  ): void {
    this.showDialog(title, message, []);
    if (this.dialogEl) this.dialogEl.dataset.artemisIvTransition = String(generation);
  }

  private dismissArtemisIvPreparing(generation: number): void {
    if (this.dialogEl?.dataset.artemisIvTransition !== String(generation)) return;
    this.dialogEl.remove();
    this.dialogEl = null;
  }

  private artemisIvMenuState(): ArtemisIvMenuState {
    const result = this.artemisIvSessionStore?.read();
    if (result?.status !== 'ready') return { status: 'new' };
    return result.document.completed
      ? { status: 'complete' }
      : { status: 'resume', chapter: result.document.currentChapter };
  }

  private refreshArtemisIvMenuState(): void {
    if (this.menu) this.menu.setArtemisIvState(this.artemisIvMenuState());
  }

  private async openArtemisIv(action: ArtemisIvMenuAction): Promise<void> {
    if (this.artemisIvActiveTransition !== null) return;
    const stored = this.artemisIvSessionStore?.read();
    if (action === 'resume' && stored?.status === 'ready' && !stored.document.completed) {
      await this.beginArtemisIv(stored.document.currentChapter);
      return;
    }
    if (action === 'fly-again') this.artemisIvSessionStore?.clear();
    if (stored?.status === 'corrupt' || stored?.status === 'incompatible') {
      this.artemisIvSessionStore?.clear();
      this.refreshArtemisIvMenuState();
    }
    this.showArtemisIvBriefing();
  }

  private showArtemisIvBriefing(): void {
    this.showDialog(
      'Artemis IV · Guided Lunar Landing',
      'NASA currently describes Artemis IV as the first crewed lunar landing in the revised Artemis sequence: four astronauts launch in Orion, two land near the lunar South Pole, and all four return for splashdown. Launch and the long TLI coast are summarized so this mission can focus on the craft operations.\n\nNASA has not yet assigned the Artemis IV lander. This scenario uses an unchanged artist-made 2019 generic Starship model as its visual stand-in. It is not a Starship HLS model or an official NASA or SpaceX flight configuration.',
      [
        { label: 'BEGIN MISSION', fn: () => void this.beginArtemisIv(1) },
        { label: 'OPEN FIRST LIGHT', fn: () => this.startFirstLight() },
        { label: 'EXIT', fn: () => {} },
      ],
    );
    if (!this.dialogEl) return;
    this.dialogEl.classList.add('game-dialog-mission-profile');
    const message = this.dialogEl.querySelector('.game-dialog-message');
    if (!message) return;
    const figure = document.createElement('figure');
    figure.className = 'artiv-flight-plan';
    const fullSizeLink = document.createElement('a');
    fullSizeLink.href = '/ui/artemis-iv-flight-plan.svg';
    fullSizeLink.target = '_blank';
    fullSizeLink.rel = 'noopener';
    fullSizeLink.setAttribute('aria-label', 'Open the Artemis IV flight plan at full size');
    const image = document.createElement('img');
    image.src = '/ui/artemis-iv-flight-plan.svg';
    image.alt = 'Artemis IV representative flight plan: launch from Earth, travel to lunar orbit, dock with a provider-neutral lander, send two crew to the lunar South Pole, reunite in orbit, and return in Orion for Pacific splashdown.';
    image.width = 1600;
    image.height = 900;
    const caption = document.createElement('figcaption');
    caption.textContent = 'OPEN FULL-SIZE FLIGHT PLAN ↗';
    fullSizeLink.append(image, caption);
    figure.appendChild(fullSizeLink);
    message.before(figure);
  }

  private async beginArtemisIv(chapter: ArtemisIvChapter): Promise<void> {
    const generation = this.beginArtemisIvTransition();
    if (generation === null) return;
    if (this.sessionKind === 'artemis-iv') {
      this.paused = true;
      this.game.setWarp(0, false);
    }
    this.showArtemisIvPreparing(
      generation,
      'Preparing Artemis IV',
      `Preparing the checked craft and terrain for Chapter ${chapter}…`,
    );
    try {
      if (!await this.ensureArtemisIvVisualResources(chapter, generation)) return;
      if (!this.isCurrentArtemisIvTransition(generation)) return;
      await this.loadArtemisIvChapter(chapter, generation);
    } finally {
      this.finishArtemisIvTransition(generation);
    }
  }

  private artemisIvRendererBaseBytes(): number {
    const size = new THREE.Vector2();
    this.ctx.renderer.getDrawingBufferSize(size);
    const framebuffer = drawingBufferResourceBytes(
      Math.max(1, Math.floor(size.x)),
      Math.max(1, Math.floor(size.y)),
      this.ctx.caps.drawingBufferSamples,
    ).totalBytes;
    return artemisIvHighTierRendererBaseBytes({
      residentPackGpuBytes: this.world.renderStats().residentPackGpuBytes,
      drawingBufferBytes: framebuffer,
    });
  }

  private async loadEditorBuiltInVisual(id: BuiltInCraftVisualId) {
    if (id !== 'starship-2019-concept') throw new Error(`Unknown built-in visual ${id}`);
    const decision = preflightArtemisIvAssets({
      currentTier: this.world.qualityTier(),
      supportsHighTier: this.ctx.caps.backend === 'webgl2',
      caps: this.ctx.caps,
      ledger: this.artemisIvRendererLedger,
    });
    if (!decision.ok) throw new Error(decision.reason);
    const baseUrl = import.meta.env.BASE_URL.endsWith('/')
      ? import.meta.env.BASE_URL
      : `${import.meta.env.BASE_URL}/`;
    const loader = createBrowserArtemisIvAssetLoader(this.ctx.renderer, {
      ledger: this.artemisIvRendererLedger,
      transcoderPath: `${baseUrl}basis/`,
      ktx2: this.ktx2Loader ?? undefined,
    });
    try {
      const loaded = await loader.loadStarship();
      return {
        object: loaded.object,
        dispose: () => loader.dispose(),
      };
    } catch (error) {
      loader.dispose();
      throw error;
    }
  }

  private ensureDefaultConceptLander(): void {
    if (this.sessionKind === 'artemis-iv') return;
    if (!this.game.universe.bodies.has(STARSHIP_CONCEPT_DEFAULT_BODY_ID)) return;
    const existing = this.game.vessels.find((vessel) => (
      !vessel.launchId && isStarshipConceptDisplayCraft(vessel.runtime.craft)
    ));
    if (existing) return;
    const previousActiveId = this.game.activeVesselId;
    const craft = createStarshipConceptDisplayCraft();
    const lander = this.game.spawnInOrbit(
      craft,
      STARSHIP_CONCEPT_DEFAULT_VESSEL_NAME,
      STARSHIP_CONCEPT_DEFAULT_BODY_ID,
      STARSHIP_CONCEPT_DEFAULT_ORBIT_ALTITUDE,
    );
    lander.runtime.sas = 'stability';
    lander.runtime.crew = [];
    this.game.activeVesselId = previousActiveId;
  }

  private ensureActiveConceptVisual(): void {
    const vessel = this.game.active;
    if (
      !vessel || !isStarshipConceptDisplayCraft(vessel.runtime.craft)
      || this.world.hasExternalVesselVisual(vessel.runtime.id)
      || this.conceptVisualPending.has(vessel.runtime.id)
      || this.conceptVisualFailed.has(vessel.runtime.id)
    ) return;
    const vesselId = vessel.runtime.id;
    this.conceptVisualPending.add(vesselId);
    void this.loadEditorBuiltInVisual('starship-2019-concept').then((visual) => {
      const current = this.game.vessels.find((candidate) => candidate.runtime.id === vesselId);
      if (!current || !isStarshipConceptDisplayCraft(current.runtime.craft)) {
        visual.dispose();
        return;
      }
      this.world.attachExternalVesselVisual(current, visual);
      if (this.game.activeVesselId === vesselId) {
        this.world.resetCamera(false);
        this.world.frameCameraForVisualRadius(55, -20);
      }
    }).catch((error) => {
      this.conceptVisualFailed.add(vesselId);
      clientLog.warn('sim.boundary.error', {
        boundary: 'starship-concept-visual',
        errorType: 'ExternalVisualUnavailable',
        vesselId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      this.conceptVisualPending.delete(vesselId);
    });
  }

  private confirmArtemisIvPreparedSceneBudget(retryChapter: ArtemisIvChapter): boolean {
    const decision = recheckArtemisIvPreparedSceneBudget(this.artemisIvRendererLedger);
    if (decision.ok) return true;
    this.disposeArtemisIvVisualResources(true);
    this.showArtemisIvAssetFailure(
      `${decision.reason} Measured ${(decision.currentRendererBytes / 1_048_576).toFixed(0)} MiB against the ${(decision.combinedSceneGpuCapBytes / 1_048_576).toFixed(0)} MiB ceiling.`,
      retryChapter,
    );
    return false;
  }

  private async ensureArtemisIvVisualResources(
    retryChapter: ArtemisIvChapter,
    generation: number,
  ): Promise<boolean> {
    if (this.artemisIvVisuals) return true;
    this.artemisIvRenderScaleLease ??= applyArtemisIvRenderScale(this.ctx.renderer);
    const decision = preflightArtemisIvAssets({
      currentTier: this.world.qualityTier(),
      supportsHighTier: this.ctx.caps.backend === 'webgl2',
      caps: this.ctx.caps,
      ledger: this.artemisIvRendererLedger,
    });
    if (!decision.ok) {
      this.artemisIvRenderScaleLease.restore();
      this.artemisIvRenderScaleLease = null;
      if (this.isCurrentArtemisIvTransition(generation)) {
        this.showArtemisIvAssetFailure(decision.reason, retryChapter);
      }
      return false;
    }

    this.artemisIvRestoreQuality = decision.restoreTierOnExit;
    this.world.setQuality('high');
    const baseUrl = import.meta.env.BASE_URL.endsWith('/')
      ? import.meta.env.BASE_URL
      : `${import.meta.env.BASE_URL}/`;
    const loader = createBrowserArtemisIvAssetLoader(this.ctx.renderer, {
      ledger: this.artemisIvRendererLedger,
      transcoderPath: `${baseUrl}basis/`,
      ktx2: this.ktx2Loader ?? undefined,
    });
    this.artemisIvAssetLoader = loader;
    try {
      const starship = await loader.loadStarship();
      if (!this.isCurrentArtemisIvTransition(generation)) {
        loader.dispose();
        if (this.artemisIvAssetLoader === loader) this.artemisIvAssetLoader = null;
        return false;
      }
      this.artemisIvVisuals = createArtemisIvVisualComposite(this.partModels, starship.object);
      this.world.scene.add(this.artemisIvVisuals.root);
      return true;
    } catch (error) {
      if (!this.isCurrentArtemisIvTransition(generation)) {
        loader.dispose();
        if (this.artemisIvAssetLoader === loader) this.artemisIvAssetLoader = null;
        return false;
      }
      const reason = error instanceof Error ? error.message : String(error);
      this.disposeArtemisIvVisualResources(true);
      this.showArtemisIvAssetFailure(reason, retryChapter);
      return false;
    }
  }

  private showArtemisIvAssetFailure(reason: string, retryChapter: ArtemisIvChapter): void {
    this.showDialog(
      'Artemis IV visual unavailable',
      `${reason}\n\nThe selected unchanged model requires the certified High-quality path. No substitute model was loaded.`,
      [
        {
          label: 'OPEN FIRST LIGHT',
          fn: () => {
            this.disposeArtemisIvVisualResources(true);
            this.startFirstLight();
          },
        },
        { label: 'RETRY', fn: () => void this.beginArtemisIv(retryChapter) },
        {
          label: 'EXIT',
          fn: () => {
            this.disposeArtemisIvVisualResources(true);
            this.showMenu();
          },
        },
      ],
    );
  }

  private async loadArtemisIvChapter(
    chapter: ArtemisIvChapter,
    generation: number,
  ): Promise<void> {
    if (!this.isCurrentArtemisIvTransition(generation)) return;
    const descriptor = artemisIvCheckpointForChapter(chapter);
    const checkpointGame = new GameState('sandbox', { persistence: 'session-only' });
    this.world.resetDynamicState();
    try {
      if (descriptor.bodyId) {
        const body = checkpointGame.universe.get(descriptor.bodyId);
        const authority = await checkpointGame.prepareFlightAuthority(
          body,
          descriptor.terrainAuthorityRequest,
        );
        if (!this.isCurrentArtemisIvTransition(generation)) return;
        if (descriptor.terrainAuthorityRequest === 'moon-site01' && authority.fallbackReason) {
          throw new Error(`South Pole training terrain unavailable: ${authority.fallbackReason}`);
        }
        await this.world.prepareFlightBody(body, authority);
        if (!this.isCurrentArtemisIvTransition(generation)) return;
        if (!this.confirmArtemisIvPreparedSceneBudget(chapter)) return;
      }
      const mission = initializeArtemisIvCheckpoint(chapter, checkpointGame);
      if (!this.isCurrentArtemisIvTransition(generation)) return;
      this.game = mission.game;
      this.artemisIvMission = mission;
      this.artemisIvGuideProgress = createArtemisIvGuideProgress(chapter);
      this.sessionKind = 'artemis-iv';
      this.maneuver = new ManeuverPlanController();
      this.artemisIvManeuverIds.clear();
      this.autoManeuverPlanId = null;
      this.autoManeuverPauseLoggedFor = null;
      this.pendingWarpStop = null;
      this.firstLightMoonCorrectionApplied = false;
      this.tutorial.dismiss();
      this.editor.refreshCampaign();
      this.toFlight(false);
      this.artemisIvGuide.setVisible(true);
      this.configureArtemisIvChapterStart();
      this.frameArtemisIvChapterCamera(chapter);
      this.persistArtemisIvChapter(false);
      this.dismissArtemisIvPreparing(generation);
      telemetry.track('game_started', { mode: 'artemis-iv', chapter, system: 'sol' });
      clientLog.info('game.start', { mode: 'artemis-iv', chapter, system: 'sol' });
    } catch (error) {
      if (!this.isCurrentArtemisIvTransition(generation)) return;
      const reason = error instanceof Error ? error.message : String(error);
      this.showDialog('Artemis IV checkpoint unavailable', reason, [
        { label: 'RETRY', fn: () => void this.beginArtemisIv(chapter) },
        { label: 'EXIT MISSION', fn: () => this.showMenu() },
      ]);
    }
  }

  private configureArtemisIvChapterStart(): void {
    const state = this.artemisIvMission;
    if (!state) return;
    this.map.setLandingTarget(
      state.chapter === 5 ? ARTEMIS_IV_SOUTH_POLE_TRAINING_ANALOGUE : null,
    );
    if (state.chapter === 1) {
      const orion = vesselForArtemisIvRole(state, 'orion-cm');
      if (orion) orion.target = 'moon';
      const prepared = ARTEMIS_IV_PREPARED.maneuvers.postTliCorrection;
      this.installArtemisIvManeuver({
        ...prepared,
        node: { ...ARTEMIS_IV_POST_TLI_START_NODE },
      });
      if (!this.map.visible) this.toggleMap();
    }
    if (state.chapter === 5) {
      const lander = vesselForArtemisIvRole(state, 'hls');
      if (lander) lander.runtime.sas = 'retrograde';
    }
    if (state.chapter === 10) {
      const orion = vesselForArtemisIvRole(state, 'orion-cm');
      if (orion) orion.runtime.sas = 'retrograde';
    }
  }

  private frameArtemisIvChapterCamera(chapter: ArtemisIvChapter): void {
    const descriptor = artemisIvCheckpointForChapter(chapter);
    const radius = chapter === 10
      ? ARTEMIS_IV_CAMERA_FRAMING_RADII.recovery
      : descriptor.topology === 'docked'
        ? ARTEMIS_IV_CAMERA_FRAMING_RADII.docked
        : descriptor.activeRole === 'hls'
          ? ARTEMIS_IV_CAMERA_FRAMING_RADII.hls
          : ARTEMIS_IV_CAMERA_FRAMING_RADII.orionCmEsm;
    this.world.resetCamera(false);
    this.world.frameCameraForVisualRadius(radius);
  }

  private installArtemisIvManeuver(
    prepared: Readonly<{ id: string; bodyId: 'earth' | 'moon'; node: ManeuverNode }>,
  ): void {
    const active = this.game.active;
    if (!active || active.runtime.bodyId !== prepared.bodyId) return;
    const body = this.game.bodyOf(active);
    const reference = stateToElements(
      body.mu,
      active.runtime.pos,
      active.runtime.vel,
      this.game.time,
    );
    const plan = this.maneuver.create(active.runtime.id, body.id, reference, { ...prepared.node });
    this.artemisIvManeuverIds.set(plan.id, prepared.id);
  }

  private persistArtemisIvChapter(completed: boolean): void {
    const state = this.artemisIvMission;
    if (!state || !this.artemisIvSessionStore) return;
    this.artemisIvSessionStore.write({
      documentVersion: ARTEMIS_IV_SESSION_DOCUMENT_VERSION,
      missionVersion: ARTEMIS_IV_MISSION_VERSION,
      currentChapter: state.chapter,
      completedAcknowledgements: ARTEMIS_IV_ACKNOWLEDGEMENTS.filter(
        (acknowledgement) => state.acknowledgements[acknowledgement],
      ),
      completed,
      chapterStartSave: serializeGame(state.game, `Artemis IV · Chapter ${state.chapter}`),
    });
    this.refreshArtemisIvMenuState();
  }

  private continueArtemisIvTextStep(): void {
    if (!this.artemisIvMission || !this.artemisIvGuideProgress) return;
    try {
      const update = continueArtemisIvGuide(
        this.artemisIvGuideProgress,
        this.artemisIvMission,
        performance.now(),
      );
      this.artemisIvGuideProgress = update.progress;
    } catch (error) {
      const vessel = this.game.active?.runtime;
      if (vessel) logEvent(vessel, this.game.time, error instanceof Error ? error.message : String(error), 'warning');
    }
  }

  private handleArtemisIvContextualAction(
    action: Readonly<ArtemisIvGuideContextualAction>,
  ): void {
    const state = this.artemisIvMission;
    if (!state) return;
    switch (action.id) {
      case 'next-chapter':
        void this.advanceArtemisIvChapter();
        break;
      case 'finish-mission':
        this.completeArtemisIvMission();
        break;
      case 'target-hls':
        state.telemetry.selectedTargetRole = 'hls';
        break;
      case 'target-orion':
        state.telemetry.selectedTargetRole = 'orion-cm';
        break;
      case 'guided-intercept':
        this.compressArtemisIvRendezvous();
        break;
      case 'guided-docking':
        this.completeArtemisIvDockingApproach();
        break;
      case 'automated-landing':
        this.completeArtemisIvLanding();
        break;
      case 'switch-hls':
        setActiveArtemisIvRole(state, 'hls');
        this.game.setWarp(0, false);
        break;
      case 'switch-orion':
        setActiveArtemisIvRole(state, 'orion-cm');
        this.game.setWarp(0, false);
        break;
      case 'undock-hls':
        this.undockArtemisIvLander();
        break;
      case 'restore-node':
        this.restoreCurrentArtemisIvManeuver();
        break;
      case 'open-map':
        if (!this.map.visible) this.toggleMap();
        break;
      case 'ignite-lander':
      case 'jettison-esm':
      case 'arm-recovery':
        this.stage();
        break;
    }
  }

  private compressArtemisIvRendezvous(): void {
    const state = this.artemisIvMission;
    const targetRole = state?.telemetry.selectedTargetRole;
    if (!state || !targetRole || !state.activeRole || targetRole === state.activeRole) return;
    const chaser = vesselForArtemisIvRole(state, state.activeRole);
    const target = vesselForArtemisIvRole(state, targetRole);
    if (!chaser || !target || chaser.runtime.bodyId !== target.runtime.bodyId) return;
    this.game.setWarp(0, false);
    this.game.toActive(chaser);
    this.game.toActive(target);
    const corridor = target.runtime.att.rotate(new Vec3(0, 1, 0), new Vec3()).normalize();
    chaser.runtime.pos.copy(target.runtime.pos).addScaled(corridor, 220);
    chaser.runtime.vel.copy(target.runtime.vel).addScaled(corridor, -0.6);
    chaser.runtime.att.copy(target.runtime.att).multiply(new Quat(1, 0, 0, 0));
    chaser.runtime.angVel.set(0, 0, 0);
    state.telemetry.holdStableForMs = 0;
    logEvent(
      chaser.runtime,
      this.game.time,
      'Prepared phasing coast complete. Final approach remains under manual RCS control.',
    );
  }

  private completeArtemisIvDockingApproach(): void {
    const state = this.artemisIvMission;
    if (!state || (state.chapter !== 3 && state.chapter !== 8)) return;
    const returning = state.chapter === 8;
    const chaserRole = returning ? 'hls' : 'orion-cm';
    const targetRole = returning ? 'orion-cm' : 'hls';
    if (!prepareArtemisIvDockingCapture(state, chaserRole, targetRole)) return;
    const chaser = vesselForArtemisIvRole(state, chaserRole);
    if (chaser) {
      logEvent(
        chaser.runtime,
        this.game.time,
        'Automatic final approach established. Docking capture is imminent.',
      );
    }
  }

  private completeArtemisIvLanding(): void {
    const state = this.artemisIvMission;
    if (!state || !completeArtemisIvAutomatedLanding(state)) return;
    // Preserve the checked zero-speed touchdown through the guide's short
    // confirmation dwell; the next chapter reload resumes normal simulation.
    this.paused = true;
    this.clearHeldThrottleInput();
    this.resetTouchFlightControls();
    this.artemisIvGuideProgress = {
      chapter: 5,
      stepId: 'lunar-landing',
      satisfiedAtMs: null,
      complete: false,
    };
    const lander = vesselForArtemisIvRole(state, 'hls');
    if (lander) {
      logEvent(
        lander.runtime,
        this.game.time,
        'Automatic landing complete inside the South Pole training ellipse.',
      );
    }
    if (lander) this.world.invalidateVessel(lander.runtime.id);
    this.world.resetCamera(false);
    this.world.frameCameraForVisualRadius(ARTEMIS_IV_CAMERA_FRAMING_RADII.hls);
  }

  private undockArtemisIvLander(): void {
    const state = this.artemisIvMission;
    if (!state) return;
    const merged = vesselForArtemisIvRole(state, 'orion-cm');
    const joint = merged ? this.game.dockedJoints(merged)[0] : null;
    if (!merged || !joint || !this.game.undock(merged, joint.childKey)) return;
    const orion = this.game.vessels.find((vessel) =>
      vessel.runtime.craft.parts.some((part) => part.defId === 'pod-voyager'));
    const lander = this.game.vessels.find((vessel) =>
      vessel.runtime.craft.parts.some((part) => part.defId === 'pod-tandem'));
    if (!orion || !lander) throw new Error('Artemis IV undocking did not preserve both craft');
    recordArtemisIvUndocking(state, orion.runtime.id, lander.runtime.id);
    if (!lander.runtime.externalLandingFootprint) {
      setExternalLandingFootprint(lander.runtime, {
        halfWidth: 6.5,
        halfDepth: 4.5,
        footY: -26.5,
      });
    }
    const continueInLander = state.chapter === 4;
    setActiveArtemisIvRole(state, continueInLander ? 'hls' : 'orion-cm');
    for (const vessel of this.game.vessels) this.world.invalidateVessel(vessel.runtime.id);
    this.world.resetCamera(false);
    this.world.frameCameraForVisualRadius(
      continueInLander
        ? ARTEMIS_IV_CAMERA_FRAMING_RADII.hls
        : ARTEMIS_IV_CAMERA_FRAMING_RADII.orionCmEsm,
    );
    const prepared = continueInLander
      ? ARTEMIS_IV_PREPARED.maneuvers.descentSetup
      : ARTEMIS_IV_PREPARED.maneuvers.transEarthInjection;
    this.maneuver = new ManeuverPlanController();
    this.artemisIvManeuverIds.clear();
    this.installArtemisIvManeuver(prepared);
  }

  private restoreCurrentArtemisIvManeuver(): void {
    const stepId = currentArtemisIvGuideStep(this.artemisIvGuideProgress ?? {
      chapter: 0, stepId: null, satisfiedAtMs: null, complete: true,
    })?.id;
    const prepared = stepId === 'post-tli-correction'
      ? ARTEMIS_IV_PREPARED.maneuvers.postTliCorrection
      : stepId === 'lunar-orbit-insertion'
        ? ARTEMIS_IV_PREPARED.maneuvers.lunarOrbitInsertion
        : stepId === 'commit-descent'
          ? ARTEMIS_IV_PREPARED.maneuvers.descentSetup
          : stepId === 'trans-earth-injection'
            ? ARTEMIS_IV_PREPARED.maneuvers.transEarthInjection
            : null;
    if (!prepared) return;
    this.maneuver = new ManeuverPlanController();
    this.artemisIvManeuverIds.clear();
    this.autoManeuverPlanId = null;
    this.installArtemisIvManeuver(
      stepId === 'post-tli-correction'
        ? { ...prepared, node: { ...ARTEMIS_IV_POST_TLI_START_NODE } }
        : prepared,
    );
    if (!this.map.visible) this.toggleMap();
  }

  private async advanceArtemisIvChapter(): Promise<void> {
    const state = this.artemisIvMission;
    if (!state || !this.artemisIvGuideProgress?.complete) return;
    if (state.chapter === 10) {
      this.completeArtemisIvMission();
      return;
    }
    await this.beginArtemisIv((state.chapter + 1) as ArtemisIvChapter);
  }

  private completeArtemisIvMission(completedFromCheckpoint = false): void {
    if (!this.artemisIvMission || this.artemisIvMission.chapter !== 10) return;
    this.persistArtemisIvChapter(true);
    this.paused = true;
    this.game.setWarp(0, false);
    this.showDialog(
      'Artemis IV training mission complete',
      completedFromCheckpoint
        ? 'The training mission was marked complete from the Chapter 10 checkpoint. Entry and splashdown were skipped; your normal save was never changed.'
        : 'Orion and all four representative crew are safely home. The mission session is complete; your normal save was never changed.',
      [
        { label: 'BACK TO MAIN SCREEN', fn: () => { this.paused = false; this.showMenu(); } },
        {
          label: 'FLY AGAIN',
          fn: () => {
            this.paused = false;
            this.artemisIvSessionStore?.clear();
            this.showArtemisIvBriefing();
          },
        },
      ],
    );
  }

  private updateArtemisIvMission(dtMs: number): void {
    const state = this.artemisIvMission;
    const progress = this.artemisIvGuideProgress;
    if (this.sessionKind !== 'artemis-iv' || !state || !progress) return;
    this.syncArtemisIvDockingTopology();
    syncArtemisIvLiveTelemetry(
      state,
      state.telemetry.selectedTargetRole,
      this.paused ? 0 : Math.max(0, dtMs),
    );
    const update = updateArtemisIvGuide(progress, state, performance.now());
    this.artemisIvGuideProgress = update.progress;
    const step = currentArtemisIvGuideStep(update.progress);
    if (
      update.signal === 'advanced'
      && step?.id === 'lunar-orbit-insertion'
      && vesselForArtemisIvRole(state, 'orion-cm')?.runtime.bodyId === 'earth'
    ) {
      void this.prepareArtemisIvLunarInsertionPhase();
    }
    this.artemisIvGuide.update(
      artemisIvGuideViewModel(update.progress, performance.now()),
      this.artemisIvGuidePresentation(),
    );
  }

  private syncArtemisIvVisuals(): void {
    const state = this.artemisIvMission;
    const visuals = this.artemisIvVisuals;
    if (this.sessionKind !== 'artemis-iv' || !state || !visuals) return;
    const orion = vesselForArtemisIvRole(state, 'orion-cm');
    const lander = vesselForArtemisIvRole(state, 'hls');
    if (orion) {
      const proxy = this.world.visualFor(orion).group;
      const visible = proxy.visible;
      visuals.copyVesselTransform('orion', proxy);
      visuals.setRoleVisible('orion', visible);
      proxy.visible = false;
    } else {
      visuals.setRoleVisible('orion', false);
    }
    if (lander && lander.runtime.id !== orion?.runtime.id) {
      const proxy = this.world.visualFor(lander).group;
      const visible = proxy.visible;
      visuals.copyVesselTransform('hls', proxy);
      visuals.setRoleVisible('hls', visible);
      proxy.visible = false;
    } else if (lander && orion) {
      visuals.copyDockedHlsTransformFromOrion();
      visuals.setRoleVisible('hls', visuals.orionRoot.visible);
    } else {
      visuals.setRoleVisible('hls', false);
    }
    const esmAttached = state.roles['orion-esm'] !== null
      && state.roles['orion-esm'] === state.roles['orion-cm'];
    visuals.setTopology(
      esmAttached ? 'cm-esm' : state.telemetry.parachutesDeployed ? 'recovery' : 'cm-only',
    );
  }

  private syncArtemisIvDockingTopology(): void {
    const state = this.artemisIvMission;
    if (!state || state.roles['orion-cm'] === state.roles.hls || !state.roles.hls) return;
    const orionLive = this.game.vessels.some((vessel) => vessel.runtime.id === state.roles['orion-cm']);
    const landerLive = this.game.vessels.some((vessel) => vessel.runtime.id === state.roles.hls);
    if (orionLive && landerLive) return;
    const merged = this.game.vessels.find((vessel) =>
      this.game.dockedJoints(vessel).length > 0
      && vessel.runtime.craft.parts.some((part) => part.defId === 'pod-voyager')
      && vessel.runtime.craft.parts.some((part) => part.defId === 'pod-tandem'));
    if (!merged) return;
    recordArtemisIvDocking(state, merged.runtime.id);
    this.world.invalidateVessel(merged.runtime.id);
    this.world.resetCamera(false);
    this.world.frameCameraForVisualRadius(ARTEMIS_IV_CAMERA_FRAMING_RADII.docked);
  }

  private artemisIvGuidePresentation(): ArtemisIvGuidePresentation {
    const state = this.artemisIvMission;
    const progress = this.artemisIvGuideProgress;
    if (!state || !progress) return {};
    const step = currentArtemisIvGuideStep(progress);
    let contextualAction: ArtemisIvGuideContextualAction | null = null;
    const active = this.game.active;
    const hasPlan = Boolean(active && this.maneuver.nextFor(active.runtime.id, active.runtime.bodyId));
    const range = state.telemetry.relativeRangeMeters;

    if (progress.complete) {
      contextualAction = state.chapter === 10
        ? { id: 'finish-mission', label: 'COMPLETE MISSION' }
        : { id: 'next-chapter', label: `CONTINUE TO CHAPTER ${state.chapter + 1}` };
    } else if (step?.id === 'post-tli-correction' || step?.id === 'lunar-orbit-insertion'
      || step?.id === 'trans-earth-injection') {
      contextualAction = !hasPlan
        ? { id: 'restore-node', label: 'RESTORE PREPARED NODE' }
        : !this.map.visible ? { id: 'open-map', label: 'OPEN MANEUVER PLANNER' } : null;
    } else if (step?.id === 'outbound-rendezvous-hold' || step?.id === 'rejoin-orion') {
      const target = step.id === 'outbound-rendezvous-hold' ? 'hls' : 'orion-cm';
      contextualAction = state.telemetry.selectedTargetRole !== target
        ? { id: target === 'hls' ? 'target-hls' : 'target-orion', label: `TARGET ${target === 'hls' ? 'LANDER' : 'ORION'}` }
        : range !== null && range > 500
          ? { id: 'guided-intercept', label: 'RUN PREPARED PHASING' }
          : step.id === 'rejoin-orion'
            ? { id: 'guided-docking', label: 'AUTO-DOCK' }
            : null;
    } else if (step?.id === 'dock') {
      contextualAction = state.telemetry.selectedTargetRole !== 'hls'
        ? { id: 'target-hls', label: 'TARGET LANDER' }
        : { id: 'guided-docking', label: 'AUTO-DOCK' };
    } else if (step?.id === 'commit-descent') {
      contextualAction = state.activeRole !== 'hls'
        ? { id: 'switch-hls', label: 'TAKE CONTROL OF LANDER' }
        : state.roles['orion-cm'] === state.roles.hls
          ? { id: 'undock-hls', label: 'UNDOCK LANDER' }
          : !hasPlan
            ? { id: 'restore-node', label: 'PREPARE DESCENT NODE' }
            : !this.map.visible ? { id: 'open-map', label: 'OPEN MANEUVER PLANNER' } : null;
    } else if (step?.id === 'descent-braking' || step?.id === 'descent-coast'
      || step?.id === 'lunar-landing') {
      contextualAction = { id: 'automated-landing', label: 'AUTO-LAND' };
    } else if (step?.id === 'lunar-ascent') {
      const lander = vesselForArtemisIvRole(state, 'hls');
      const engineActive = lander?.runtime.craft.parts.some(
        (part) => part.defId === 'eng-aspen' && part.activated,
      );
      contextualAction = engineActive ? null : { id: 'ignite-lander', label: 'IGNITE LANDER ENGINE' };
    } else if (step?.id === 'separate-lander') {
      contextualAction = state.roles['orion-cm'] === state.roles.hls
        ? { id: 'undock-hls', label: 'UNDOCK LANDER' }
        : state.activeRole !== 'orion-cm'
          ? { id: 'switch-orion', label: 'TAKE CONTROL OF ORION' }
          : null;
    } else if (step?.id === 'separate-service-module') {
      contextualAction = state.roles['orion-cm'] === state.roles['orion-esm']
        ? { id: 'jettison-esm', label: 'JETTISON SERVICE MODULE' }
        : null;
    } else if (step?.id === 'splashdown') {
      contextualAction = state.telemetry.parachutesDeployed
        ? null
        : { id: 'arm-recovery', label: 'ARM RECOVERY SYSTEM' };
    }
    return { contextualAction, readouts: artemisIvGuideReadouts(state) };
  }

  private async prepareArtemisIvLunarInsertionPhase(): Promise<void> {
    const state = this.artemisIvMission;
    if (!state || state.chapter !== 1) return;
    const generation = this.beginArtemisIvTransition();
    if (generation === null) return;
    this.paused = true;
    state.game.setWarp(0, false);
    this.showArtemisIvPreparing(
      generation,
      'Preparing lunar approach',
      'Loading the checked South Pole terrain and placing Orion at lunar arrival…',
    );
    try {
      state.game.clearFlightVessels();
      this.world.resetDynamicState();
      const moon = state.game.universe.get('moon');
      const authority = await state.game.prepareFlightAuthority(moon, 'moon-site01');
      if (!this.isCurrentArtemisIvTransition(generation, state)) return;
      if (authority.fallbackReason) throw new Error(authority.fallbackReason);
      await this.world.prepareFlightBody(moon, authority);
      if (!this.isCurrentArtemisIvTransition(generation, state)) return;
      if (!this.confirmArtemisIvPreparedSceneBudget(state.chapter)) return;
      prepareArtemisIvLunarInsertion(state);
      this.game = state.game;
      this.maneuver = new ManeuverPlanController();
      this.artemisIvManeuverIds.clear();
      this.autoManeuverPlanId = null;
      this.installArtemisIvManeuver(ARTEMIS_IV_PREPARED.maneuvers.lunarOrbitInsertion);
      this.toFlight(false);
      if (!this.map.visible) this.toggleMap();
      this.dismissArtemisIvPreparing(generation);
    } catch (error) {
      if (!this.isCurrentArtemisIvTransition(generation, state)) return;
      this.showDialog(
        'Lunar approach unavailable',
        error instanceof Error ? error.message : String(error),
        [
          { label: 'RETRY CHAPTER', fn: () => void this.retryArtemisIvChapter() },
          { label: 'EXIT MISSION', fn: () => this.showMenu() },
        ],
      );
    } finally {
      this.finishArtemisIvTransition(generation);
    }
  }

  private async prepareArtemisIvEarthApproachPhase(): Promise<void> {
    const state = this.artemisIvMission;
    if (!state || state.chapter !== 9) return;
    const generation = this.beginArtemisIvTransition();
    if (generation === null) return;
    this.paused = true;
    state.game.setWarp(0, false);
    this.showArtemisIvPreparing(
      generation,
      'Preparing Earth approach',
      'Loading Earth entry terrain and placing Orion on the checked recovery corridor…',
    );
    try {
      state.game.clearFlightVessels();
      this.world.resetDynamicState();
      const earth = state.game.universe.get('earth');
      const authority = await state.game.prepareFlightAuthority(earth, 'parent');
      if (!this.isCurrentArtemisIvTransition(generation, state)) return;
      await this.world.prepareFlightBody(earth, authority);
      if (!this.isCurrentArtemisIvTransition(generation, state)) return;
      if (!this.confirmArtemisIvPreparedSceneBudget(state.chapter)) return;
      prepareArtemisIvEarthApproach(state);
      this.game = state.game;
      this.maneuver = new ManeuverPlanController();
      this.artemisIvManeuverIds.clear();
      this.autoManeuverPlanId = null;
      this.toFlight(false);
      this.dismissArtemisIvPreparing(generation);
    } catch (error) {
      if (!this.isCurrentArtemisIvTransition(generation, state)) return;
      this.showDialog(
        'Earth approach unavailable',
        error instanceof Error ? error.message : String(error),
        [
          { label: 'RETRY CHAPTER', fn: () => void this.retryArtemisIvChapter() },
          { label: 'EXIT MISSION', fn: () => this.showMenu() },
        ],
      );
    } finally {
      this.finishArtemisIvTransition(generation);
    }
  }

  private async retryArtemisIvChapter(): Promise<void> {
    const chapter = this.artemisIvMission?.chapter;
    if (chapter === undefined) return;
    await this.beginArtemisIv(chapter);
  }

  private confirmSkipArtemisIvChapter(): void {
    const state = this.artemisIvMission;
    if (!state) return;
    const isFinalChapter = state.chapter === 10;
    this.paused = true;
    this.game.setWarp(0, false);
    this.showDialog(
      isFinalChapter ? 'Finish Artemis IV from checkpoint?' : `Skip Artemis IV Chapter ${state.chapter}?`,
      isFinalChapter
        ? 'This marks the training mission complete without requiring entry and splashdown. Your normal save is unchanged.'
        : `This loads the prepared checkpoint for Chapter ${state.chapter + 1}. Actions in the current chapter will not be counted.`,
      [
        { label: 'KEEP FLYING', fn: () => { this.paused = false; } },
        {
          label: isFinalChapter ? 'FINISH MISSION' : `SKIP TO CHAPTER ${state.chapter + 1}`,
          fn: () => {
            if (isFinalChapter) this.completeArtemisIvMission(true);
            else void this.beginArtemisIv((state.chapter + 1) as ArtemisIvChapter);
          },
        },
      ],
    );
  }

  private confirmExitArtemisIv(): void {
    this.paused = true;
    this.game.setWarp(0, false);
    this.showDialog(
      'Exit Artemis IV?',
      'Your progress resumes from the beginning of this chapter checkpoint.',
      [
        { label: 'KEEP FLYING', fn: () => { this.paused = false; } },
        { label: 'EXIT MISSION', fn: () => { this.paused = false; this.showMenu(); } },
      ],
    );
  }

  private disposeArtemisIvVisualResources(restoreQuality: boolean): void {
    if (this.artemisIvVisuals) {
      this.world?.scene.remove(this.artemisIvVisuals.root);
      this.artemisIvVisuals.dispose();
      this.artemisIvVisuals = null;
    }
    this.artemisIvAssetLoader?.dispose();
    this.artemisIvAssetLoader = null;
    this.artemisIvRenderScaleLease?.restore();
    this.artemisIvRenderScaleLease = null;
    if (restoreQuality && this.artemisIvRestoreQuality && this.world) {
      this.world.setQuality(this.artemisIvRestoreQuality);
    }
    this.artemisIvRestoreQuality = null;
  }

  private startFirstLight(): void {
    this.cancelArtemisIvTransition();
    this.artemisIvGuide?.setVisible(false);
    this.map?.setLandingTarget(null);
    this.disposeArtemisIvVisualResources(true);
    this.newGame('sandbox', 'sol');
    this.sessionKind = 'first-light';
    this.editor.loadCraft(createFirstLightRocket(), false);
    this.tutorial.start();
    this.toEditor();
  }

  private confirmRestartFirstLight(): void {
    this.showDialog(
      'Restart First Light?',
      'This starts First Light again with a fresh vehicle on the launch path. The new mission will replace the current autosave.',
      [
        { label: 'KEEP CURRENT MISSION', fn: () => {} },
        { label: 'RESTART FROM LAUNCH', fn: () => this.startFirstLight() },
      ],
    );
  }

  private confirmRestartArtemisIv(): void {
    this.showDialog(
      'Restart Artemis IV?',
      'This clears the saved Artemis IV chapter checkpoint and starts again from Chapter 1. Your normal save is unchanged.',
      [
        { label: 'KEEP CHECKPOINT', fn: () => {} },
        {
          label: 'RESTART FROM CHAPTER 1',
          fn: () => {
            this.artemisIvSessionStore?.clear();
            this.refreshArtemisIvMenuState();
            void this.beginArtemisIv(1);
          },
        },
      ],
    );
  }

  private async continueAutosave(): Promise<void> {
    const save = await this.saveSync.read('auto');
    if (!save) {
      this.menu.setContinueSave(null);
      return;
    }
    this.game = restoreGame(save, GAMEPLAY_PROFILES.sol);
    this.launchPreparation = null;
    this.sessionKind = 'standard';
    this.ensureDefaultConceptLander();
    this.editor.refreshCampaign();
    if (this.game.active) this.toFlight(false);
    else this.toEditor();
  }

  private newGame(mode: GameMode, systemOverride?: keyof typeof GAMEPLAY_PROFILES): void {
    this.cancelArtemisIvTransition();
    const profile = GAMEPLAY_PROFILES[systemOverride ?? this.uiSettings?.gameSystem ?? 'sol'];
    this.game = new GameState(mode, profile);
    this.launchPreparation = null;
    this.sessionKind = 'standard';
    this.firstLightMoonCorrectionApplied = false;
    this.conceptVisualPending.clear();
    this.conceptVisualFailed.clear();
    this.maneuver = new ManeuverPlanController();
    this.autoManeuverPlanId = null;
    this.autoManeuverPauseLoggedFor = null;
    this.editor.refreshCampaign();
    telemetry.track('game_started', {
      mode,
      system: profile.id,
      account: this.auth.state.kind === 'signed-in' ? 'signed-in' : 'guest',
    });
    clientLog.info('game.start', { mode, system: profile.id });
  }

  private showMenu(): void {
    this.cancelArtemisIvTransition();
    const exitingArtemis = this.sessionKind === 'artemis-iv'
      || this.artemisIvVisuals !== null
      || this.artemisIvAssetLoader !== null;
    if (exitingArtemis) {
      this.artemisIvGuide?.setVisible(false);
      this.map.setLandingTarget(null);
      this.disposeArtemisIvVisualResources(true);
      this.artemisIvMission = null;
      this.artemisIvGuideProgress = null;
      this.artemisIvManeuverIds.clear();
      this.sessionKind = 'standard';
      this.game = new GameState('sandbox', GAMEPLAY_PROFILES.sol);
      this.launchPreparation = null;
      this.world.resetCamera(false);
      this.world.resetDynamicState();
      this.refreshArtemisIvMenuState();
    }
    this.resetTouchFlightControls();
    this.paused = false;
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
    if (this.sessionKind === 'artemis-iv') {
      this.confirmExitArtemisIv();
      return;
    }
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
    this.warmEditorLaunch();
    void this.writeSave('auto', 'autosave');
  }

  private async enterAeroLab(
    craft: Craft,
    environmentToken: import('./sim/aeroLab').AeroLabEnvironmentToken,
  ): Promise<void> {
    if (this.sessionKind !== 'standard' || craft.parts.length === 0) return;
    this.resetTouchFlightControls();
    this.paused = false;
    this.screen = 'aero-lab';
    document.getElementById('game-canvas')?.classList.remove('vab-active');
    this.menu.setVisible(false);
    this.editor.setVisible(false);
    this.hud.root.style.display = 'none';
    this.map.setVisible(false);
    this.perf.setMiniVisible(false);
    this.windows.setLauncherHost(null);
    this.windows.setScreen('aero-lab');
    if (this.rendererFailureEl) this.rendererFailureEl.hidden = true;
    this.aeroLabSnapshotFingerprint = aeroLabFingerprint(craft);
    this.aeroLabLoadingMessage.textContent = 'LOADING AERODYNAMICS LAB';
    this.aeroLabLoadingEl.style.display = '';
    try {
      if (!this.aeroLab) {
        const { AeroLab } = await import('./ui/aeroLab');
        this.aeroLab = new AeroLab(this.uiRoot, this.partModels, this.ctx.renderer, {
          onBack: () => this.restoreEditorFromAeroLab(),
          onAnalysisError: (errorType) => clientLog.warn('sim.boundary.error', {
            boundary: 'aero-lab-worker',
            errorType,
          }),
        });
      }
      if (this.screen !== 'aero-lab') return;
      this.aeroLabLoadingEl.style.display = 'none';
      const bodyIds = this.game.systemId === 'sol' ? ['earth', 'moon'] : ['veyra', 'palla'];
      this.aeroLab.open(
        craft,
        resolveAeroLabEnvironment(this.game.universe, environmentToken),
        bodyIds.map((id) => this.game.universe.get(id)),
      );
    } catch (error) {
      this.aeroLabLoadingMessage.textContent = 'THE AERODYNAMICS LAB COULD NOT LOAD';
      clientLog.warn('sim.boundary.error', {
        boundary: 'aero-lab-load',
        errorType: error instanceof Error ? error.name : 'AeroLabLoadError',
      });
    }
  }

  private restoreEditorFromAeroLab(): void {
    if (this.screen !== 'aero-lab') return;
    if (this.aeroLabSnapshotFingerprint !== aeroLabFingerprint(this.editor.craft)) {
      clientLog.warn('sim.boundary.error', {
        boundary: 'aero-lab-editor-restore',
        errorType: 'CraftChangedWhileReadOnly',
      });
    }
    this.aeroLab?.close();
    this.aeroLabLoadingEl.style.display = 'none';
    this.screen = 'editor';
    document.getElementById('game-canvas')?.classList.add('vab-active');
    this.editor.setVisible(true);
    this.hud.root.style.display = 'none';
    this.map.setVisible(false);
    this.perf.setMiniVisible(false);
    this.windows.setLauncherHost(this.editor.utilityHost);
    this.windows.setScreen('editor');
  }

  private ensureEditorLaunchPreparation(): Promise<void> {
    const game = this.game;
    const home = game.universe.get(game.universe.homeBodyId);
    const active = this.launchPreparation;
    if (active?.game === game && active.bodyId === home.id) return active.promise;
    const promise = (async () => {
      const authority = game.vessels.length === 0
        ? await game.prepareFlightAuthority(home, home.id === 'earth' ? 'ksc-launch' : 'parent')
        : game.frozenFlightAuthority(home.id);
      if (this.game !== game) return;
      await this.world.prepareFlightBody(home, authority);
    })();
    this.launchPreparation = { game, bodyId: home.id, promise };
    void promise.catch(() => {
      if (this.launchPreparation?.promise === promise) this.launchPreparation = null;
    });
    return promise;
  }

  private warmEditorLaunch(): void {
    void this.ensureEditorLaunchPreparation().catch((error) => {
      clientLog.warn('sim.boundary.error', {
        boundary: `editor-launch-warmup:${this.game.universe.homeBodyId}`,
        errorType: error instanceof Error ? error.name : 'LaunchWarmupFailure',
      });
    });
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
    this.ensureActiveConceptVisual();
  }

  private frameActiveCraft(keepEngineClearOfHud = false): void {
    const active = this.game.active;
    if (!active) return;
    const craft = active.runtime.craft;
    const com = active.runtime.massProps.com;
    const bounds = craftAxialVisualBounds(craft);
    const axialSpan = bounds.maximum - bounds.minimum;
    const focusAlongNose = bounds.center - com.y
      - (keepEngineClearOfHud ? axialSpan * 0.08 : 0);
    const radius = craftVisualRadius(craft, new Vec3(com.x, bounds.center, com.z));
    this.world.resetCamera(false);
    this.world.frameCameraForVisualRadius(
      radius * (keepEngineClearOfHud ? 1.55 : 1),
      focusAlongNose,
    );
  }

  private async launch(craft: Craft, displayVisual?: EditorDisplayVisual): Promise<string | null> {
    const locked = displayVisual ? [] : lockedCraftParts(this.game.campaign, craft);
    if (locked.length) {
      return `Unlock required technology for ${locked.map((part) => part.name).join(', ')}.`;
    }
    const cost = displayVisual ? 0 : craftCost(craft);
    if (this.game.campaign.mode === 'program') {
      if (cost > this.game.campaign.funds) {
        return `Launch requires ${cost.toLocaleString()} funds; ${this.game.campaign.funds.toLocaleString()} available.`;
      }
    }
    const home = this.game.universe.get(this.game.universe.homeBodyId);
    const firstFleetLaunch = this.game.vessels.length === 0;
    try {
      if (firstFleetLaunch) this.game.warpToLaunchDaylight(home);
      // The first launch reuses the same local authority and renderer warmup
      // started on VAB entry. Later fleet launches retain that frozen authority.
      const preparation = firstFleetLaunch
        ? this.ensureEditorLaunchPreparation()
        : this.world.prepareFlightBody(home, this.game.frozenFlightAuthority(home.id));
      await Promise.all([
        preparation,
        new Promise<void>((resolve) => window.setTimeout(resolve, 650)),
      ]);
      const authority = this.game.frozenFlightAuthority(home.id);
      if (authority.fallbackReason) {
        clientLog.warn('terrain.authority.fallback', {
          bodyId: authority.bodyId,
          generation: authority.generation,
          reason: authority.fallbackReason,
        });
      }
    } catch (error) {
      clientLog.error('sim.boundary.error', error, {
        boundary: `launch-authority-preload:${home.id}`,
        errorType: 'FlightAuthorityPreparationFailure',
      });
      return `Could not prepare ${home.name} terrain. Retry launch.`;
    }
    if (this.game.campaign.mode === 'program') this.game.campaign.funds -= cost;
    const vessel = this.game.spawnOnPad(craft, craft.name);
    if (displayVisual) {
      this.world.attachExternalVesselVisual(vessel, displayVisual);
      this.world.resetCamera(false);
      this.world.frameCameraForVisualRadius(55, -20);
    } else {
      this.frameActiveCraft(this.sessionKind === 'first-light');
    }
    this.ensureDefaultConceptLander();
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
    if (!this.game.fireStage(gv)) return;
    this.world.invalidateVessel(gv.runtime.id);
    if (this.sessionKind === 'first-light') this.frameActiveCraft(true);
    if (this.sessionKind === 'artemis-iv') this.syncArtemisIvStageTopology();
  }

  private syncArtemisIvStageTopology(): void {
    const state = this.artemisIvMission;
    if (!state || state.chapter !== 10) return;
    const crewModule = this.game.vessels.find((vessel) => vessel.runtime.craft.parts.some(
      (part) => part.defId === 'pod-voyager',
    ));
    const serviceModule = this.game.vessels.find((vessel) => vessel.runtime.craft.parts.some(
      (part) => part.defId === 'eng-ember',
    ));
    if (crewModule) {
      bindArtemisIvRole(state, 'orion-cm', crewModule.runtime.id);
      setActiveArtemisIvRole(state, 'orion-cm');
    }
    bindArtemisIvRole(state, 'orion-esm', serviceModule?.runtime.id ?? null);
    for (const vessel of this.game.vessels) this.world.invalidateVessel(vessel.runtime.id);
  }

  private toggleMap(): void {
    if (this.screen !== 'flight') return;
    this.map.visible = !this.map.visible;
    if (this.map.visible) this.map.focusActiveVessel(this.game);
    this.map.setVisible(this.map.visible);
  }

  private quickSave(): void {
    if (this.sessionKind === 'artemis-iv') {
      const gv = this.game.active;
      if (gv) logEvent(gv.runtime, this.game.time, 'Artemis IV resumes from its checked chapter checkpoint.', 'warning');
      return;
    }
    if (this.game.persistence !== 'enabled') {
      const gv = this.game.active;
      if (gv) logEvent(gv.runtime, this.game.time, 'Legacy Auren is session-only; quicksave is unavailable.', 'warning');
      return;
    }
    void this.writeSave('quick', 'quicksave').then((ok) => {
      const gv = this.game.active;
      if (gv) logEvent(gv.runtime, this.game.time, ok ? 'Quicksaved.' : 'Quicksave FAILED', ok ? 'info' : 'danger');
    });
  }

  private writeSave(slot: string, label: string): Promise<boolean> {
    // Artemis owns one local chapter checkpoint document. Its temporary craft
    // must never enter normal autosaves, named saves, or cloud sync.
    if (this.sessionKind === 'artemis-iv' || this.game.persistence !== 'enabled') {
      return Promise.resolve(false);
    }
    return this.saveSync.write(this.game, slot, label);
  }

  private scheduleAutosave(): void {
    if (this.sessionKind === 'artemis-iv' || this.game.persistence !== 'enabled') return;
    if (this.autosaveScheduled) return;
    this.autosaveScheduled = true;
    const run = () => {
      this.autosaveScheduled = false;
      void this.writeSave('auto', 'autosave');
    };
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(run, { timeout: 5_000 });
    } else {
      globalThis.setTimeout(run, 0);
    }
  }

  private async quickLoad(): Promise<void> {
    if (this.sessionKind === 'artemis-iv') {
      const gv = this.game.active;
      if (gv) logEvent(gv.runtime, this.game.time, 'Use Retry Chapter to restore the Artemis IV checkpoint.', 'warning');
      return;
    }
    if (this.game.persistence !== 'enabled') {
      const gv = this.game.active;
      if (gv) logEvent(gv.runtime, this.game.time, 'Legacy Auren is session-only; quickload is unavailable.', 'warning');
      return;
    }
    await this.loadSlot('quick');
  }

  private async loadSlot(slot: string): Promise<void> {
    if (this.sessionKind === 'artemis-iv' || this.game.persistence !== 'enabled') return;
    const save = await this.saveSync.read(slot);
    if (!save) return;
    this.game = restoreGame(save, GAMEPLAY_PROFILES.sol);
    this.launchPreparation = null;
    this.ensureDefaultConceptLander();
    this.conceptVisualPending.clear();
    this.conceptVisualFailed.clear();
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
    if (this.sessionKind === 'artemis-iv') {
      void this.retryArtemisIvChapter();
      return;
    }
    const reverted = this.game.revertDestroyedLaunch()
      ?? (this.game.active ? this.game.revertLaunch(this.game.active) : null);
    if (!reverted) return;
    for (const vesselId of reverted.removedVesselIds) {
      this.world.invalidateVessel(vesselId);
      this.maneuver.removeVessel(vesselId);
      this.conceptVisualPending.delete(vesselId);
      this.conceptVisualFailed.delete(vesselId);
    }
    this.autoManeuverPlanId = null;
    this.autoManeuverPauseLoggedFor = null;
    this.pendingWarpStop = null;
    this.firstLightMoonCorrectionApplied = false;
    this.frameActiveCraft();
    this.game.setWarp(0, false);
    this.toFlight();
    if (this.sessionKind === 'first-light') this.tutorial.restartAfterRevert();
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
    void this.writeSave('auto', 'autosave');
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
    void this.writeSave('auto', 'autosave');
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
    void this.writeSave('auto', 'autosave');
  }

  private recover(): void {
    const gv = this.game.active;
    if (!gv) return;
    if (this.sessionKind === 'artemis-iv') {
      logEvent(
        gv.runtime,
        this.game.time,
        'Artemis IV recovery is confirmed automatically after safe splashdown.',
      );
      return;
    }
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
    void this.writeSave('auto', 'autosave');
  }

  private warpToNode(node: ManeuverNode): void {
    const gv = this.game.active;
    if (!gv) return;
    const body = this.game.bodyOf(gv);
    const v = gv.runtime;
    const analysis = analyzeCraft(
      v.craft,
      body.surfaceGravity,
      body.pressureAt(v.pos.length() - body.radius),
      this.game.flightTuning,
      body.def.atmosphere?.seaLevelPressure,
    );
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
    if (this.sessionKind === 'artemis-iv') {
      this.showDialog('Artemis IV paused', 'Simulation time is stopped. Progress resumes from this chapter checkpoint.', [
        { label: 'Resume', fn: () => { this.paused = false; } },
        { label: 'Retry chapter', fn: () => { this.paused = false; void this.retryArtemisIvChapter(); } },
        { label: 'Settings', fn: () => { this.utilityTools.openSettings(); } },
        { label: 'Exit mission', fn: () => { this.paused = false; this.showMenu(); } },
      ]);
      return;
    }
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
    this.syncUiHidden();
  }

  private setUiHideHeld(held: boolean): void {
    if (this.uiHideHeld === held) return;
    this.uiHideHeld = held;
    this.syncUiHidden();
  }

  private syncUiHidden(): void {
    this.uiRoot.classList.toggle('k-ui-hidden', this.uiHidden || this.uiHideHeld);
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
      if (isBindingScreen(this.screen)) {
        this.input.dispatch(e, this.screen);
      }
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'KeyH') this.setUiHideHeld(false);
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.setUiHideHeld(false);
      this.resetTouchFlightControls();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.keys.clear();
        this.setUiHideHeld(false);
        this.resetTouchFlightControls();
      }
    });
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
            this.map.zoomCamera(this.mapPinchDistance / distance);
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
        this.world.orbitCamera(dx, dy);
      } else if (this.screen === 'aero-lab') {
        this.aeroLab?.orbitCamera(dx, dy);
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
      else if (this.screen === 'aero-lab') this.aeroLab?.zoomCamera(factor);
      else if (this.screen === 'flight' && this.map.visible) this.map.zoomCamera(factor);
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
    const aeroLab = 'aero-lab' as const;
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
      { code: 'KeyZ', screen: flight, group: 'Control', label: 'Full throttle', handler: vessel((v) => {
        this.clearHeldThrottleInput();
        v.controls.throttle = 1;
      }) },
      { code: 'KeyX', screen: flight, group: 'Control', label: 'Cut throttle', handler: vessel((v) => {
        this.clearHeldThrottleInput();
        v.controls.throttle = 0;
      }) },
      { code: 'CapsLock', screen: flight, group: 'Control', label: 'Precision control', keyLabel: 'CapsLock', handler: (e) => {
        this.precisionControl = e.getModifierState('CapsLock');
      } },
      { code: 'KeyV', screen: flight, group: 'Camera', label: 'Cycle camera mode', handler: act(() => this.world.cycleCameraMode()) },
      { code: 'Home', screen: flight, group: 'Camera', label: 'Reset/recenter camera', handler: act(() => {
        if (this.map.visible) this.map.resetCamera();
        else this.world.resetCamera();
      }) },
      { code: 'F2', screen: flight, group: 'Camera', label: 'Hide screenshot UI', preventDefault: true, handler: () => this.toggleUi() },
      { code: 'KeyH', screen: flight, group: 'Camera', label: 'Hold to hide all HUD', handler: () => this.setUiHideHeld(true) },
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
      // ---- aerodynamics lab
      { code: 'Escape', screen: aeroLab, group: 'Lab', label: 'Back to Workshop', keyLabel: 'Esc', handler: () => this.restoreEditorFromAeroLab() },
      { code: 'Space', screen: aeroLab, group: 'Lab', label: 'Pause / resume airflow', keyLabel: 'Space', handler: () => this.aeroLab?.togglePaused() },
      { code: '', screen: aeroLab, group: 'Camera', label: 'Orbit camera', keyLabel: 'Drag' },
      { code: '', screen: aeroLab, group: 'Camera', label: 'Zoom', keyLabel: 'Wheel' },
      // ---- help
      { code: 'Slash', shift: true, screen: 'any', group: 'Help', label: 'Show this cheat sheet', keyLabel: '?', handler: () => {
        if (isBindingScreen(this.screen)) this.cheatSheet.toggle(this.screen);
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
    const mission = this.artemisIvMission;
    if (mission) {
      if (mission.roles.hls === id && mission.roles['orion-cm'] !== id) mission.activeRole = 'hls';
      else if (mission.roles['orion-cm'] === id && mission.roles.hls !== id) mission.activeRole = 'orion-cm';
    }
    this.map.focusActiveVessel(this.game);
    this.hud.setMissionStart(this.game.time);
    this.ensureActiveConceptVisual();
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

  private clearHeldThrottleInput(): void {
    this.keys.delete('ShiftLeft');
    this.keys.delete('ShiftRight');
    this.keys.delete('ControlLeft');
    this.keys.delete('ControlRight');
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
        this.showDialog(
          'Flight over',
          `${reason}. The review board recommends... adjustments.`,
          this.sessionKind === 'artemis-iv'
            ? [
              { label: 'Retry chapter', fn: () => void this.retryArtemisIvChapter() },
              { label: 'Exit mission', fn: () => this.showMenu() },
            ]
            : [
              { label: 'Revert to launch', fn: () => this.revert() },
              { label: 'Back to Workshop', fn: () => this.toEditor() },
            ],
        );
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
        this.syncArtemisIvVisuals();
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
    } else if (this.screen === 'aero-lab') {
      this.aeroLab?.update(dt);
      if (!this.ctx.renderPaused) {
        if (this.aeroLab) this.aeroLab.render();
        else this.ctx.renderer.clear();
      }
    } else {
      // Menu: idle starfield via world scene if available.
      if (!this.ctx.renderPaused) this.ctx.renderer.clear();
    }
    this.perf.endRender(renderStart);
    this.perf.frame(dtMs, this.ctx.renderer);
    this.windows.update();

    const tutorialVessel = this.game.active;
    const tutorialManeuver = tutorialVessel
      ? this.maneuver.nextFor(tutorialVessel.runtime.id, tutorialVessel.runtime.bodyId)
      : null;
    this.tutorial.update({
      game: this.game,
      editor: this.editor,
      screen: this.screen,
      mapVisible: this.map.visible,
      maneuverPlanned: tutorialManeuver !== null,
      maneuverAutoExecution: tutorialManeuver !== null
        && this.autoManeuverPlanId === tutorialManeuver.id,
      warpRate: this.game.warpRate,
    });
    this.updateArtemisIvMission(dtMs);

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

    const pressure = body.pressureAt(v.pos.length() - body.radius);
    const analysis = analyzeCraft(
      v.craft,
      body.surfaceGravity,
      pressure,
      this.game.flightTuning,
      body.def.atmosphere?.seaLevelPressure,
    );
    const powered = analysis.stages.find((stage) => stage.stageIndex >= v.currentStage && stage.thrust > 0)
      ?? [...analysis.stages].reverse().find((stage) => stage.thrust > 0);
    const burnDuration = powered
      ? estimateBurnTime(plan.initialDeltaV, powered.thrust, v.massProps.mass, powered.isp)
      : 0;
    const burnStart = plan.node.time - (Number.isFinite(burnDuration) ? burnDuration / 2 : 0);
    const autoEnabled = this.autoManeuverPlanId === plan.id;
    if (autoEnabled) {
      v.sas = 'node';
      v.sasCustomDir.copy(plan.burnDirection);
      const thrustDirection = v.att.rotate(new Vec3(0, 1, 0), new Vec3());
      const alignment = Vec3.dot(thrustDirection, plan.burnDirection);
      let availableThrust = maxThrust(
        v,
        pressure,
        this.game.flightTuning,
        body.def.atmosphere?.seaLevelPressure,
      );
      if (this.game.time >= burnStart && alignment >= 0.985 && availableThrust <= 1) {
        const ignited = igniteManeuverEngines(v);
        if (ignited.length) {
          for (const name of ignited) logEvent(v, this.game.time, `${name} automatic ignition`);
          availableThrust = maxThrust(
            v,
            pressure,
            this.game.flightTuning,
            body.def.atmosphere?.seaLevelPressure,
          );
        }
      }
      const command = maneuverAutomationCommand({
        burnReady: this.game.time >= burnStart,
        controlBlocked: this.controlBlocked,
        availableThrust,
        alignment,
        remainingDeltaV: plan.remainingDeltaV,
        vesselMass: v.massProps.mass,
      });
      v.controls.throttle = command.throttle;
      if (command.state === 'aborted') {
        this.autoManeuverPlanId = null;
        logEvent(v, this.game.time, 'Automatic maneuver aborted: flight controls unavailable.', 'warning');
      } else if (command.state === 'waiting-for-stage') {
        if (this.autoManeuverPauseLoggedFor !== plan.id) {
          logEvent(v, this.game.time, 'Automatic maneuver paused: stage manually, then execution will resume.', 'warning');
          this.autoManeuverPauseLoggedFor = plan.id;
        }
      } else if (command.beginExecution) {
        this.maneuver.beginExecution(plan.id);
        this.autoManeuverPauseLoggedFor = null;
      }
    }
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
        dt * (this.game.railsWarp ? 1 : this.game.warpRate),
        0.5,
        activePlan.id,
      );
      if (remaining <= 0) {
        v.controls.throttle = 0;
        logEvent(v, this.game.time, 'Maneuver complete.');
        const artemisManeuverId = this.artemisIvManeuverIds.get(activePlan.id) ?? null;
        if (artemisManeuverId && this.artemisIvMission) {
          if (this.isArtemisIvManeuverAccepted(artemisManeuverId, activePlan)) {
            if (!this.artemisIvMission.telemetry.completedManeuverIds.includes(artemisManeuverId)) {
              this.artemisIvMission.telemetry.completedManeuverIds.push(artemisManeuverId);
            }
          } else {
            logEvent(
              v,
              this.game.time,
              'The burn completed outside the guided corridor. Retry the chapter to restore its checked approach.',
              'warning',
            );
          }
          this.artemisIvManeuverIds.delete(activePlan.id);
        }
        if (this.autoManeuverPlanId === activePlan.id) this.autoManeuverPlanId = null;
        this.autoManeuverPauseLoggedFor = null;
        this.maneuver.clear(activePlan.id);
        const achieved = stateToElements(body.mu, v.pos, v.vel, this.game.time);
        this.maneuver.rebaseFirst(v.id, body.id, achieved);
        if (
          artemisManeuverId === ARTEMIS_IV_PREPARED_MANEUVER_IDS.transEarthInjection
          && this.artemisIvMission?.telemetry.completedManeuverIds.includes(artemisManeuverId)
        ) {
          void this.prepareArtemisIvEarthApproachPhase();
        }
        if (
          this.sessionKind === 'first-light'
          && !this.firstLightMoonCorrectionApplied
          && body.id === 'earth'
          && gv.target === 'moon'
        ) {
          this.firstLightMoonCorrectionApplied = true;
          const moon = this.game.universe.bodies.get('moon');
          const correction = moon ? planMoonCourseCorrection(
            this.game.universe,
            this.game.time,
            body,
            moon,
            v.pos,
            v.vel,
          ) : null;
          if (correction) {
            this.createManeuverNode(correction.node);
            const correctionPlan = this.maneuver.current;
            if (correctionPlan) this.autoManeuverPlanId = correctionPlan.id;
            logEvent(
              v,
              this.game.time,
              `Finite-burn correction planned: ${Math.hypot(
                correction.node.prograde,
                correction.node.normal,
                correction.node.radial,
              ).toFixed(0)} m/s for a ${(correction.approachAltitude / 1000).toFixed(0)} km lunar approach.`,
            );
          }
        }
      }
    }
  }

  private toggleManeuverAutoExecution(id: string): void {
    const gv = this.game.active;
    const plan = this.maneuver.all.find((candidate) => candidate.id === id);
    if (!gv || !plan || plan.vesselId !== gv.runtime.id) return;
    if (this.autoManeuverPlanId === id) {
      this.autoManeuverPlanId = null;
      gv.runtime.controls.throttle = 0;
      logEvent(gv.runtime, this.game.time, 'Automatic maneuver disarmed.');
      return;
    }
    const artemisManeuverId = this.artemisIvManeuverIds.get(id);
    if (
      artemisManeuverId
      && !this.isArtemisIvManeuverAccepted(artemisManeuverId, plan)
    ) {
      logEvent(
        gv.runtime,
        this.game.time,
        'Adjust the prepared node into the highlighted training corridor before arming automatic execution.',
        'warning',
      );
      return;
    }
    this.autoManeuverPlanId = id;
    this.autoManeuverPauseLoggedFor = null;
    gv.runtime.sas = 'node';
    gv.runtime.controls.throttle = 0;
    logEvent(gv.runtime, this.game.time, 'Automatic maneuver armed. Engine ignition is automatic; separation remains manual.');
  }

  private isArtemisIvManeuverAccepted(
    missionId: string,
    plan: Readonly<ManeuverPlan>,
  ): boolean {
    const { node } = plan;
    if (missionId === ARTEMIS_IV_PREPARED_MANEUVER_IDS.postTliCorrection) {
      return assessArtemisIvPostTliCorrection(
        this.game.universe,
        plan.referenceOrbit,
        node,
      ).accepted;
    }
    if (missionId === ARTEMIS_IV_PREPARED_MANEUVER_IDS.lunarOrbitInsertion) {
      return assessArtemisIvLunarOrbitInsertion(
        this.game.universe,
        plan.referenceOrbit,
        node,
      ).accepted;
    }
    if (missionId === ARTEMIS_IV_PREPARED_MANEUVER_IDS.descentSetup) {
      return assessArtemisIvDescentSetup(
        this.game.universe,
        plan.referenceOrbit,
        node,
      ).accepted;
    }
    if (missionId === ARTEMIS_IV_PREPARED_MANEUVER_IDS.transEarthInjection) {
      return assessArtemisIvTransEarthInjection(
        this.game.universe,
        plan.referenceOrbit,
        node,
      ).accepted;
    }
    return false;
  }

  private createManeuverNode(node: ManeuverNode): void {
    const gv = this.game.active;
    if (!gv) return;
    const body = this.game.bodyOf(gv);
    const reference = stateToElements(body.mu, gv.runtime.pos, gv.runtime.vel, this.game.time);
    this.maneuver.create(gv.runtime.id, body.id, reference, node);
  }

  private planFirstLightMoonTransfer(): boolean {
    const gv = this.game.active;
    const moon = this.game.universe.bodies.get('moon');
    if (!gv || !moon || gv.runtime.bodyId !== 'earth' || gv.runtime.situation !== 'orbit') return false;
    const earth = this.game.bodyOf(gv);
    const orbit = stateToElements(earth.mu, gv.runtime.pos, gv.runtime.vel, this.game.time);
    if (!(orbit.e < 1) || periapsisOf(orbit) <= earth.radius) return false;
    const parkingOrbitDirection = gv.runtime.pos.x * gv.runtime.vel.y
      - gv.runtime.pos.y * gv.runtime.vel.x >= 0 ? 1 : -1;
    const plan = planTransfer(this.game.universe, this.game.time, earth, moon, {
      parkRadius: gv.runtime.pos.length(),
      vesselAngle: Math.atan2(gv.runtime.pos.y, gv.runtime.pos.x),
      parkingOrbitDirection,
      vesselPosition: gv.runtime.pos,
      vesselVelocity: gv.runtime.vel,
    });
    if (
      !plan
      || plan.accuracy !== 'refined-intercept'
      || plan.approachAltitude === undefined
      || plan.approachAltitude > 500_000
    ) return false;

    this.maneuver = new ManeuverPlanController();
    this.autoManeuverPlanId = null;
    this.autoManeuverPauseLoggedFor = null;
    this.firstLightMoonCorrectionApplied = false;
    gv.target = moon.id;
    this.createManeuverNode(plan.suggestedNode);
    if (!this.map.visible) this.toggleMap();
    logEvent(
      gv.runtime,
      this.game.time,
      `Moon intercept planned: ${plan.departureDv.toFixed(0)} m/s, predicted approach ${(plan.approachAltitude! / 1000).toFixed(0)} km.`,
    );
    return true;
  }

  private startSecondLight(): boolean {
    const preserved = this.game.vessels.filter((vessel) => (
      isStarshipConceptDisplayCraft(vessel.runtime.craft) && !vessel.launchId
    ));
    const removed = this.game.vessels.filter((vessel) => !preserved.includes(vessel));
    for (const vessel of removed) this.world.invalidateVessel(vessel.runtime.id);
    this.game.vessels = preserved;
    this.game.activeVesselId = null;
    this.maneuver = new ManeuverPlanController();
    this.autoManeuverPlanId = null;
    this.autoManeuverPauseLoggedFor = null;
    this.pendingWarpStop = null;
    this.firstLightMoonCorrectionApplied = false;
    this.sessionKind = 'first-light';
    const craft = createSecondLightCraft();
    const vessel = this.game.spawnInOrbit(craft, craft.name, 'earth', 200_000);
    vessel.launchId = vessel.runtime.id;
    vessel.launchCraft = createFirstLightRocket();
    vessel.runtime.currentStage = 1;
    vessel.runtime.controls.throttle = 0;
    vessel.runtime.sas = 'stability';
    this.game.setWarp(0, false);
    this.ensureDefaultConceptLander();
    this.toFlight(false);
    return this.planFirstLightMoonTransfer();
  }
}

export async function startGame(options: Readonly<RenderStartupOptions>): Promise<void> {
  const game = new PeriluneGame(options);
  await game.start();
}
