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
import { FlightHud } from './ui/flightHud';
import { MapView } from './ui/mapView';
import { Tutorial } from './ui/tutorial';
import { GpuSubmissionProfiler, PerfOverlay } from './ui/perfOverlay';
import { GpuTimerRing } from './render/gpuTimer';
import { readSave, restoreGame, serializeGame, writeSave } from './save/persistence';
import {
  experimentKey,
  experimentValue,
  EXPERIMENT_INDEX,
  scienceSituation,
} from './content/science';
import { logEvent } from './sim/flight';
import { CommsStatus, evaluateComms, needsCommsForControl } from './sim/comms';
import { estimateBurnTime, nodeBurnDirection, nodeDeltaV, type ManeuverNode } from './sim/maneuver';
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

type Screen = 'menu' | 'editor' | 'flight';

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
  private menuEl!: HTMLElement;
  private uiRoot!: HTMLElement;
  private keys = new Set<string>();
  private dragging = false;
  private draggingPart = false;
  private draggingMapControl = false;
  private dragMoved = 0;
  private dragButton = 0;
  private lastX = 0;
  private lastY = 0;
  private lastFrame = performance.now();
  private launchedCraft: Craft | null = null;
  private missionStart = 0;
  private nodeRemainingDv = 0;
  private precisionControl = false;
  private paused = false;
  private uiHidden = false;
  private lastAutosave = 0;
  private comms: CommsStatus = { connected: true, path: [], strength: 1 };
  private lastCommsCheck = 0;
  private controlBlocked = false;
  private nodeBurnDir = new Vec3(1, 0, 0);
  private dialogEl: HTMLElement | null = null;
  private input = new InputService();
  private cheatSheet!: CheatSheet;
  private windows!: WindowManager;
  private instruments!: FlightInstruments;
  private missionTools!: MissionTools;
  private utilityTools!: UtilityTools;
  private uiSettings: UiSettings | null = null;
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
      data: { quality: options.quality, renderDebug: options.renderDebug },
    });
  }

  private readonly onPageHide = (event: PageTransitionEvent): void => {
    if (event.persisted) return;
    window.removeEventListener('pagehide', this.onPageHide);
    this.unsubscribeGpuRestoration?.();
    this.unsubscribeGpuRestoration = null;
    this.gpuProfiler.dispose();
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
      resolveAssetUrl: (path) => `${baseUrl}parts/${path}`,
    });
    await this.partModels.preload();
    this.world = new WorldScene(this.ctx, this.partModels, {
      quality: this.renderOptions.quality,
      diagnostics: this.diagnostics,
    });
    this.perf = new PerfOverlay(this.uiRoot);
    this.editor = new Editor(this.uiRoot, {
      onLaunch: (craft) => this.launch(craft),
      onExit: () => this.showMenu(),
    }, this.partModels);
    this.hud = new FlightHud(this.uiRoot, {
      onStage: () => this.stage(),
      onToggleMap: () => this.toggleMap(),
      onQuickSave: () => this.quickSave(),
      onQuickLoad: () => void this.quickLoad(),
      onRevert: () => this.revert(),
      onRunScience: () => this.runScience(),
      onRecover: () => this.recover(),
      onSetSas: (m) => {
        const gv = this.game.active;
        if (gv) gv.runtime.sas = m;
      },
      onSetWarp: (i, rails) => this.game.setWarp(i, rails),
      onExitToEditor: () => this.toEditor(),
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
      onWarpToNode: (node) => this.warpToNode(node),
      onCreateAlarm: (time, label, kind) => {
        this.missionTools.addAlarm(time, label, kind);
      },
      onSetTarget: (bodyId) => {
        if (this.game.active) this.game.active.target = bodyId;
      },
      onWarpToTime: (time, margin) => this.warpToTime(time, margin),
    });
    this.tutorial = new Tutorial(this.uiRoot);
    window.addEventListener('pagehide', this.onPageHide);
    this.buildMenu();
    this.cheatSheet = new CheatSheet(this.uiRoot, this.input);
    const profile = browserProfileStore();
    this.windows = new WindowManager(this.uiRoot, profile);
    this.instruments = new FlightInstruments(this.windows, () => this.game);
    this.missionTools = new MissionTools(this.windows, () => this.game, {
      onSwitchVessel: (vesselId) => this.activateVessel(vesselId),
      onSketchNode: (plan) => {
        this.map.setNode({
          time: plan.windowTime,
          prograde: plan.departureDv,
          normal: 0,
          radial: 0,
        });
        if (!this.map.visible) this.toggleMap();
      },
      onSetTarget: (bodyId) => {
        if (this.game.active) this.game.active.target = bodyId;
      },
      onFocusBody: (bodyId) => {
        this.map.focusBody(bodyId);
        if (!this.map.visible) this.toggleMap();
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
      onSave: (slot, label) => writeSave(this.game, slot, label),
      onLoad: (slot) => this.loadSlot(slot),
      onSettings: (settings) => this.applySettings(settings),
    });
    this.windows.addAction('⌨ Keys', 'Keyboard reference (?)', () => {
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
      partCount: () => this.editor.craft.parts.length,
      stageCount: () => this.editor.craft.stages.length,
      parts: () => this.editor.craft.parts.map((p) => ({ defId: p.defId, x: p.position.x, y: p.position.y, z: p.position.z })),
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
      warpRate: () => this.game.warpRate,
      target: () => this.game.active?.target ?? null,
      maneuverNode: () => this.map.node ? { ...this.map.node } : null,
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
        selectionHighlighted: this.editor.selectionHighlighted,
      }),
    };
  }

  // ------------------------------------------------------------------ menu
  private buildMenu(): void {
    this.menuEl = document.createElement('div');
    this.menuEl.style.cssText = `
      position: absolute; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 14px;
      background: radial-gradient(ellipse at 50% 65%, #0a1826 0%, #04070a 75%);
      pointer-events: auto; z-index: 40;
    `;
    this.menuEl.innerHTML = `
      <div style="font-size:54px;letter-spacing:16px;color:#6db3d6;font-weight:300">PERILUNE</div>
      <div style="font-size:12px;letter-spacing:3px;color:#7d8b96;margin-bottom:20px">A SPACE PROGRAM OF THE SKYWARD COOPERATIVE</div>
    `;
    const mkBtn = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.className = 'hud-btn';
      b.textContent = label;
      b.style.cssText = 'width:260px;padding:10px;font-size:15px;';
      b.onclick = fn;
      this.menuEl.appendChild(b);
      return b;
    };
    mkBtn('Begin — First Light (tutorial)', () => {
      this.newGame();
      this.tutorial.start();
      this.toEditor();
    });
    mkBtn('Sandbox — just build and fly', () => {
      this.newGame();
      this.toEditor();
    });
    mkBtn('Save & Load', () => this.utilityTools.openSaves());
    mkBtn('Settings', () => this.utilityTools.openSettings());
    const cont = mkBtn('Continue from last save', async () => {
      const save = await readSave('auto');
      if (save) {
        this.game = restoreGame(save);
        if (this.game.active) this.toFlight(false);
        else this.toEditor();
      }
    });
    readSave('auto').then((s) => {
      if (!s) cont.style.opacity = '0.4';
    });
    this.uiRoot.appendChild(this.menuEl);
  }

  private newGame(): void {
    this.game = new GameState();
  }

  private showMenu(): void {
    this.screen = 'menu';
    this.menuEl.style.display = 'flex';
    this.editor.setVisible(false);
    this.hud.root.style.display = 'none';
    this.map.setVisible(false);
    this.perf.setMiniVisible(false);
    this.windows.setScreen('menu');
  }

  private toEditor(): void {
    this.paused = false;
    this.screen = 'editor';
    this.menuEl.style.display = 'none';
    this.editor.setVisible(true);
    this.hud.root.style.display = 'none';
    this.map.setVisible(false);
    this.perf.setMiniVisible(false);
    this.windows.setScreen('editor');
    void writeSave(this.game, 'auto', 'autosave');
  }

  private toFlight(spawn = true): void {
    this.paused = false;
    this.screen = 'flight';
    this.menuEl.style.display = 'none';
    this.editor.setVisible(false);
    this.hud.root.style.display = '';
    this.map.setVisible(false);
    this.map.visible = false;
    this.perf.setMiniVisible(true);
    this.windows.setScreen('flight');
    this.missionStart = this.game.time;
    this.hud.setMissionStart(this.missionStart);
  }

  private launch(craft: Craft): void {
    this.launchedCraft = structuredClone(craft);
    this.game.clearFlightVessels();
    this.game.spawnOnPad(craft, craft.name);
    this.toFlight();
    logEvent(this.game.active!.runtime, this.game.time, `${craft.name} on the pad. Throttle up (Shift) and stage (Space) when ready.`);
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
    this.map.setVisible(this.map.visible);
  }

  private quickSave(): void {
    void writeSave(this.game, 'quick', 'quicksave').then((ok) => {
      const gv = this.game.active;
      if (gv) logEvent(gv.runtime, this.game.time, ok ? 'Quicksaved.' : 'Quicksave FAILED', ok ? 'info' : 'danger');
    });
  }

  private async quickLoad(): Promise<void> {
    await this.loadSlot('quick');
  }

  private async loadSlot(slot: string): Promise<void> {
    const save = await readSave(slot);
    if (!save) return;
    this.game = restoreGame(save);
    this.world.dispose();
    this.world = new WorldScene(this.ctx, this.partModels, {
      quality: this.renderOptions.quality,
      diagnostics: this.diagnostics,
    });
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
    const body = this.game.bodyOf(gv);
    const alt = v.pos.length() - body.radius;
    const situation = scienceSituation(v.situation, alt, body.radius, body.def.atmosphere?.height ?? 0);
    if (!situation) {
      logEvent(v, this.game.time, 'No valid science situation right now.', 'warning');
      return;
    }
    let gained = 0;
    for (const p of v.craft.parts) {
      const sci = defOf(p).science;
      if (!sci) continue;
      const exp = EXPERIMENT_INDEX.get(sci.experimentId);
      if (!exp) continue;
      if (!exp.validSituations.includes(situation)) continue;
      if (exp.needsAtmosphere && !body.hasAtmosphere()) continue;
      const key = experimentKey(exp.id, body.id, situation);
      if (this.game.completedExperiments.has(key) || v.scienceData.has(key)) continue;
      const value = experimentValue(exp, body.def.scienceValue);
      v.scienceData.set(key, value);
      gained += value;
      logEvent(v, this.game.time, `${exp.name}: +${value} science stored (${situation} at ${body.name})`);
    }
    if (gained === 0) {
      logEvent(v, this.game.time, 'Nothing new to record here — try a different situation or world.', 'warning');
    }
  }

  private recover(): void {
    const gv = this.game.active;
    if (!gv) return;
    const v = gv.runtime;
    let points = 0;
    for (const val of v.scienceData.values()) points += val;
    for (const key of v.scienceData.keys()) this.game.completedExperiments.add(key);
    this.game.sciencePoints += points;
    this.game.flags.recoveredOnce = true;
    this.game.vessels = this.game.vessels.filter((x) => x !== gv);
    this.game.activeVesselId = null;
    this.world.invalidateVessel(v.id);
    this.showDialog(
      'Vessel recovered',
      `${v.name} is home. Science recovered: ${points} points (total ${this.game.sciencePoints}).` +
        (v.crew.length ? ` Crew ${v.crew.join(', ')} return to a hero's welcome.` : ''),
      [{ label: 'Back to the Workshop', fn: () => this.toEditor() }],
    );
    void writeSave(this.game, 'auto', 'autosave');
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
    d.style.cssText = `
      position: absolute; left: 50%; top: 40%; transform: translate(-50%,-50%);
      background: rgba(14,24,32,0.97); border: 1px solid var(--ui-accent);
      border-radius: 10px; padding: 18px 22px; max-width: 420px; z-index: 80; pointer-events: auto;
    `;
    // textContent, not innerHTML: title/text include user-authored names.
    const heading = document.createElement('div');
    heading.style.cssText = 'font-size:17px;color:#fff;margin-bottom:8px';
    heading.textContent = title;
    const message = document.createElement('div');
    message.style.cssText = 'font-size:13px;color:#c4d2dd;line-height:1.5;margin-bottom:12px';
    message.textContent = text;
    d.append(heading, message);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
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
      if (this.screen === 'flight' && this.map.visible && e.button === 0 && this.map.beginPointer(e.clientX, e.clientY)) {
        this.draggingMapControl = true;
        this.dragging = false;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        e.preventDefault();
        return;
      }
      if (this.screen === 'editor' && e.button === 0) {
        const nx = (e.clientX / window.innerWidth) * 2 - 1;
        const ny = -(e.clientY / window.innerHeight) * 2 + 1;
        if (this.editor.beginPartDrag(nx, ny, e.altKey)) {
          this.draggingPart = true;
          this.dragging = false;
          e.preventDefault();
          return;
        }
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
      if (this.screen === 'flight' && this.map.visible) e.preventDefault();
    });
    window.addEventListener('pointermove', (e) => {
      const nx = (e.clientX / window.innerWidth) * 2 - 1;
      const ny = -(e.clientY / window.innerHeight) * 2 + 1;
      if (this.screen === 'editor') this.editor.updatePointer(nx, ny);
      if (this.draggingPart) {
        this.editor.dragSelectedPart(nx, ny);
        return;
      }
      if (this.draggingMapControl) {
        const dx = e.clientX - this.lastX;
        const dy = e.clientY - this.lastY;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.map.dragPointer(dx, dy);
        return;
      }
      if (!this.dragging) return;
      const sensitivity = this.uiSettings?.dragSensitivity ?? 1;
      const dx = (e.clientX - this.lastX) * sensitivity * (this.uiSettings?.invertX ? -1 : 1);
      const dy = (e.clientY - this.lastY) * sensitivity * (this.uiSettings?.invertY ? -1 : 1);
      this.dragMoved += Math.abs(dx) + Math.abs(dy);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (this.screen === 'editor') {
        if (this.dragButton === 1) this.editor.panCameraLocal(-dx * 0.012, dy * 0.012, 0);
        else this.editor.orbitCamera(dx, dy);
      }
      else if (this.screen === 'flight' && this.map.visible) {
        if (this.dragButton === 1 || this.dragButton === 2) this.map.panCamera(dx, dy);
        else this.map.orbitCamera(dx, dy);
      }
      else if (this.screen === 'flight') {
        this.world.camYaw -= dx * 0.005;
        this.world.camPitch = Math.max(-1.4, Math.min(1.4, this.world.camPitch + dy * 0.005));
      }
    });
    window.addEventListener('pointerup', (e) => {
      if (this.draggingMapControl) {
        this.map.endPointer();
        this.draggingMapControl = false;
        return;
      }
      if (this.draggingPart) {
        this.editor.endPartDrag();
        this.draggingPart = false;
        this.dragging = false;
        return;
      }
      if (this.dragging && this.dragMoved < 6 && this.screen === 'editor') {
        this.editor.click();
      }
      if (this.dragging && this.dragMoved < 6 && this.screen === 'flight' && !this.map.visible) {
        const partKey = this.world.pickActivePart(e.clientX, e.clientY);
        if (partKey !== null) this.hud.showPartActions(this.game, partKey, e.clientX, e.clientY);
      }
      this.dragging = false;
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
      { code: 'Escape', screen: editor, group: 'Workshop', label: 'Drop held part', keyLabel: 'Esc', handler: () => this.editor.cancelHolding() },
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
    this.hud.setMissionStart(this.game.time);
  }

  private stepWarp(dir: number): void {
    const g = this.game;
    if (dir > 0) {
      if (!g.railsWarp && g.warpIndex >= PHYSICS_WARP_RATES.length - 1) {
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
    c.pitch = ((this.keys.has('KeyS') ? 1 : 0) - (this.keys.has('KeyW') ? 1 : 0)) * authority;
    c.yaw = ((this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0)) * authority;
    c.roll = ((this.keys.has('KeyE') ? 1 : 0) - (this.keys.has('KeyQ') ? 1 : 0)) * authority;
    c.translate.set(
      ((this.keys.has('KeyL') ? 1 : 0) - (this.keys.has('KeyJ') ? 1 : 0)) * authority,
      ((this.keys.has('KeyI') ? 1 : 0) - (this.keys.has('KeyK') ? 1 : 0)) * authority,
      ((this.keys.has('KeyO') ? 1 : 0) - (this.keys.has('KeyU') ? 1 : 0)) * authority,
    );
  }

  // ------------------------------------------------------------------ loop
  private frame(): void {
    const now = performance.now();
    const dtMs = now - this.lastFrame;
    this.lastFrame = now;
    const dt = Math.min(0.1, dtMs / 1000);

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
        this.game.update(dt);
        for (const alarm of this.game.consumeFiredAlarms()) {
          const vessel = (alarm.vesselId
            ? this.game.vessels.find((candidate) => candidate.runtime.id === alarm.vesselId)
            : this.game.active)?.runtime;
          if (vessel) logEvent(vessel, this.game.time, `Alarm: ${alarm.label}`, 'warning');
          this.missionTools.showFiredAlarm(alarm);
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
        void writeSave(this.game, 'auto', 'autosave');
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
        this.world.update(this.game, dt);
        if (!this.ctx.renderPaused) {
          this.gpuProfiler.submit('flight', () => this.ctx.renderer.render(this.world.scene, this.world.camera));
        }
      }
      this.hud.update(this.game, this.map.node, {
        nodeRemainingDv: this.nodeRemainingDv,
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
    const node = this.map.node;
    if (!gv || !node) return;
    const v = gv.runtime;
    if (v.sas !== 'node') {
      this.nodeRemainingDv = nodeDeltaV(node);
      return;
    }
    const body = this.game.bodyOf(gv);
    if (v.controls.throttle <= 0.001) {
      // Not burning yet: keep the direction current.
      const els = stateToElements(body.mu, v.pos, v.vel, this.game.time);
      nodeBurnDirection(els, node, this.nodeBurnDir);
      this.nodeRemainingDv = nodeDeltaV(node);
    } else {
      this.nodeRemainingDv -= v.properAccel * dt;
      if (this.nodeRemainingDv <= 0.5) {
        v.controls.throttle = 0;
        logEvent(v, this.game.time, 'Maneuver complete.');
        this.map.node = null;
      }
    }
    v.sasCustomDir.copy(this.nodeBurnDir);
  }
}

export async function startGame(options: Readonly<RenderStartupOptions>): Promise<void> {
  const game = new PeriluneGame(options);
  await game.start();
}
