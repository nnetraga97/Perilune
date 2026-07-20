/**
 * Flight HUD: navball, velocity/altitude readouts, throttle, SAS modes,
 * staging list, resources, warp controls, and the event feed.
 *
 * All elements are plain DOM updated by direct mutation each frame —
 * no framework re-rendering (ADR: UI layer).
 */
import { Vec3 } from '../core/vec3';
import { GameState } from '../sim/state';
import { G0, defOf, analyzeCraft } from '../sim/vessel';
import { oreConcentration, oreCapacityOf } from '../sim/resources';
import type { SasMode } from '../sim/flight';
import type { CommsStatus } from '../sim/comms';
import { estimateBurnTime, nodeDeltaV, type ManeuverNode } from '../sim/maneuver';
import { stateToElements, periapsisOf, apoapsisOf, timeToTrueAnomaly } from '../core/orbit';
import { navHeading, projectNavDirection } from './navball';
import { inertialToBodyFixed, surfaceVelocity } from '../sim/bodyOrientation';
import { el, injectUiStyles } from './kit';
import { appendNavballIcon, type NavballIcon } from './icons';
import type { EntryPrediction } from '../sim/entry';
import { availableHere, isRecoverable } from '../sim/science';
import { FlightCompanion, type FlightCompanionAdvisory } from './flightCompanion';
import { FlightDirectorRequestError, requestFlightDirector } from '../ai/flightDirector';
import {
  buildFlightDirectorSnapshot,
  type PreviousFlightDirectorDecision,
} from './flightDirectorSnapshot';

export interface HudCallbacks {
  onStage(): void;
  onToggleMap(): void;
  onQuickSave(): void;
  onQuickLoad(): void;
  onRevert(): void;
  onRunScience(): void;
  onTransmitScience(): void;
  onRecover(): void;
  onSetSas(mode: SasMode): void;
  onToggleSas(): void;
  onToggleRcs(): void;
  onSetThrottle(value: number): void;
  onSetFlightControl(axis: FlightControlAxis, value: number): void;
  onSetActiveVessel(id: string): void;
  onSetWarp(index: number, rails: boolean): void;
  onExitToEditor(): void;
  onExitToMenu(): void;
  /** Toggle an ISRU system part (drill/converter) on the active vessel. */
  onToggleSystem(partKey: number): void;
  /** Run an orbital resource survey. */
  onSurvey(): void;
}

export type FlightControlAxis =
  | 'pitch'
  | 'yaw'
  | 'roll'
  | 'translate-x'
  | 'translate-y'
  | 'translate-z';

export interface HudTelemetry {
  nodeRemainingDv: number;
  nodeBurnDirection: Vec3 | null;
  cameraMode: string;
  precision: boolean;
  entryPrediction: EntryPrediction | null;
  landingTargetDirBF: Vec3 | null;
}

const NAVBALL_SIZE = 224;

type HudResource = 'propellant' | 'charge' | 'monoprop' | 'ore';

const RESOURCE_META: Readonly<Record<Exclude<HudResource, 'ore'>, {
  label: string;
  paths: readonly string[];
}>> = {
  propellant: {
    label: 'Fuel',
    paths: ['M8 3h8v3l2 2v12H6V8l2-2z', 'M8 9h8', 'M8 16h8'],
  },
  charge: {
    label: 'Charge',
    paths: ['M13.5 2 6 13h5l-.5 9L18 10h-5z'],
  },
  monoprop: {
    label: 'Monopropellant',
    paths: ['M12 2S6.5 9.2 6.5 14a5.5 5.5 0 0 0 11 0C17.5 9.2 12 2 12 2z', 'M9.5 15.5c.7 1.2 1.7 1.8 3 1.8'],
  },
};

const SAS_MODES: Array<{ mode: SasMode; label?: string; icon?: NavballIcon; title: string }> = [
  { mode: 'stability', label: '◎', title: 'Stability assist' },
  { mode: 'prograde', icon: 'prograde', title: 'Prograde' },
  { mode: 'retrograde', icon: 'retrograde', title: 'Retrograde' },
  { mode: 'normal', label: '△', title: 'Normal' },
  { mode: 'antinormal', label: '▽', title: 'Anti-normal' },
  { mode: 'radial-out', label: '⊙', title: 'Radial out' },
  { mode: 'radial-in', label: '⊗', title: 'Radial in' },
  { mode: 'node', label: '✦', title: 'Maneuver node' },
];

function fmtDistance(m: number): string {
  const abs = Math.abs(m);
  if (abs >= 1e6) return `${(m / 1e6).toFixed(2)} Mm`;
  if (abs >= 1e4) return `${(m / 1e3).toFixed(1)} km`;
  if (abs >= 1e3) return `${(m / 1e3).toFixed(2)} km`;
  return `${m.toFixed(0)} m`;
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s)) return '—';
  const neg = s < 0;
  s = Math.abs(s);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const core =
    d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m ${sec}s` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  return (neg ? '-' : '') + core;
}

export class FlightHud {
  readonly root: HTMLElement;
  readonly utilityHost: HTMLElement;
  private navCanvas: HTMLCanvasElement;
  private navCtx: CanvasRenderingContext2D;
  private speedEl: HTMLElement;
  private speedModeEl: HTMLElement;
  private altEl: HTMLElement;
  private vsEl: HTMLElement;
  private apEl: HTMLElement;
  private peEl: HTMLElement;
  private apTimeEl: HTMLElement;
  private peTimeEl: HTMLElement;
  private situationEl: HTMLElement;
  private metEl: HTMLElement;
  private nextAlarmEl: HTMLElement;
  private warpEl: HTMLElement;
  private gFill: HTMLElement;
  private qFill: HTMLElement;
  private atmosphereFill: HTMLElement;
  private gText: HTMLElement;
  private qText: HTMLElement;
  private atmosphereText: HTMLElement;
  private navGEl: HTMLElement;
  private crewEl: HTMLElement;
  private precisionEl: HTMLElement;
  private actionGroupEl: HTMLElement;
  private entryCard: HTMLElement;
  private gaugeFills = new Map<HudResource, HTMLElement>();
  private gaugeTexts = new Map<HudResource, HTMLElement>();
  private gaugeHosts = new Map<HudResource, HTMLElement>();
  private gaugeTooltips = new Map<HudResource, HTMLElement>();
  private stageListEl: HTMLElement;
  private eventFeed: HTMLElement;
  private sasButtons = new Map<SasMode, HTMLElement>();
  private sasMasterBtn: HTMLElement;
  private rcsBtn: HTMLElement;
  private sasModeEl: HTMLElement;
  private guidancePanel: HTMLElement;
  private throttleInput: HTMLInputElement;
  private vesselSelect: HTMLSelectElement;
  private detailsBtn: HTMLButtonElement;
  private detailsCollapsed = false;
  private lastVesselSignature = '';
  private touchControlMode: 'attitude' | 'translation' = 'attitude';
  private touchControlButtons: HTMLButtonElement[] = [];
  private cb: HudCallbacks;
  private lastEventCount = 0;
  private recoverBtn: HTMLElement;
  private scienceBtn: HTMLElement;
  private transmitBtn: HTMLButtonElement;
  private scienceStatusEl: HTMLElement;
  private nodeInfoEl: HTMLElement;
  private nodeInfoPanel: HTMLElement;
  private lastStageRender = '';
  private missionStart = 0;
  private oreRow!: HTMLElement;
  private sysPanel!: HTMLElement;
  private lastSysRender = '';
  private oreHereEl: HTMLElement | null = null;
  private peakQ = 0;
  private peakQVesselId: string | null = null;
  private partPopup: HTMLElement | null = null;
  private lastComms: CommsStatus = { connected: false, path: [], strength: 0 };
  private commsBlocked = false;
  private lastScienceRender = '';
  private companion: FlightCompanion;
  private lastDirectorContext: { game: GameState; node: ManeuverNode | null; telemetry: HudTelemetry } | null = null;
  private lastDirectorDecision: PreviousFlightDirectorDecision | null = null;

  constructor(uiRoot: HTMLElement, cb: HudCallbacks) {
    this.cb = cb;
    this.root = el('div', 'hud', uiRoot);
    this.root.style.pointerEvents = 'none'; // beat #ui-root > * specificity
    this.root.innerHTML = '';
    injectUiStyles();
    const compactHud = window.matchMedia('(max-width: 820px), (pointer: coarse)');
    this.utilityHost = el('div', 'hud-utility-host', this.root);

    // ---- unified command deck: flight state, vessel selection, warp, and actions
    const top = el('div', 'hud-top', this.root);
    const meta = el('div', 'hud-meta', top);
    this.metEl = el('div', 'hud-met', meta, 'T+ 0s');
    this.situationEl = el('div', 'hud-situation', meta, 'PRELAUNCH');
    this.crewEl = el('div', 'hud-crew', meta, 'CREW —');
    const vesselControl = el('label', 'hud-vessel-control', meta);
    el('span', 'hud-vessel-label', vesselControl, 'ACTIVE CRAFT');
    this.vesselSelect = el('select', 'hud-vessel-select', vesselControl) as HTMLSelectElement;
    this.vesselSelect.setAttribute('aria-label', 'Active craft');
    this.vesselSelect.onchange = () => cb.onSetActiveVessel(this.vesselSelect.value);
    this.commsEl = el('span', 'hud-comms', vesselControl, '⇅ —');
    this.nextAlarmEl = el('div', 'hud-next-alarm', meta, 'ALM —');
    const warpGroup = el('div', 'hud-warp-group', meta);
    this.warpEl = el('div', 'hud-warp', warpGroup);
    const warpBtns = el('div', 'hud-warp-btns', warpGroup);
    const slower = el('button', 'hud-btn', warpBtns, '◀◀');
    slower.title = 'Warp slower (,)';
    slower.onclick = () => this.warpStep(-1);
    const faster = el('button', 'hud-btn', warpBtns, '▶▶');
    faster.title = 'Warp faster (.)';
    faster.onclick = () => this.warpStep(1);

    const sys = el('div', 'hud-sys', top);
    const mk = (label: string, title: string, fn: () => void) => {
      const b = el('button', 'hud-btn', sys, label);
      b.title = title;
      b.onclick = fn;
      return b;
    };
    const orbitStrip = el('div', 'hud-orbit-strip', sys);
    const apsisIndicator = (label: 'Ap' | 'Pe') => {
      const indicator = el('div', `hud-apsis-indicator ${label.toLowerCase()}`, orbitStrip);
      el('span', 'hud-apsis-label', indicator, label);
      const value = el('strong', 'hud-apsis-value', indicator, '—');
      const eta = el('span', 'hud-apsis-eta', indicator, '');
      return { value, eta };
    };
    ({ value: this.apEl, eta: this.apTimeEl } = apsisIndicator('Ap'));
    ({ value: this.peEl, eta: this.peTimeEl } = apsisIndicator('Pe'));
    const resourceStrip = el('div', 'hud-resource-strip', sys);
    for (const resource of ['propellant', 'charge', 'monoprop'] as const) {
      const meta = RESOURCE_META[resource];
      const indicator = el('div', `hud-resource-indicator ${resource}`, resourceStrip);
      indicator.tabIndex = 0;
      indicator.setAttribute('role', 'meter');
      indicator.setAttribute('aria-label', meta.label);
      indicator.setAttribute('aria-valuemin', '0');
      indicator.dataset.label = meta.label;
      this.appendResourceIcon(indicator, meta.paths);
      const track = el('div', 'hud-resource-track', indicator);
      this.gaugeFills.set(resource, el('div', 'hud-resource-fill', track));
      this.gaugeTexts.set(resource, el('span', 'hud-resource-value', indicator, '0'));
      this.gaugeHosts.set(resource, indicator);
      this.gaugeTooltips.set(resource, el('span', 'hud-resource-tooltip', indicator, meta.label));
    }
    mk('Map', 'Toggle map view (M)', cb.onToggleMap);
    mk('QS', 'Quicksave (F5)', cb.onQuickSave);
    mk('QL', 'Quickload (F9)', cb.onQuickLoad);
    mk('Revert', 'Revert to launch', cb.onRevert);
    mk('Workshop', 'Back to the vehicle workshop', cb.onExitToEditor);
    const mainBtn = mk('Main', 'Back to the main menu', cb.onExitToMenu);
    mainBtn.classList.add('hud-main');
    this.scienceBtn = mk('Science', 'Run experiments here', cb.onRunScience);
    this.scienceBtn.dataset.action = 'science';
    this.transmitBtn = mk('Transmit', 'Downlink science through the comms network', cb.onTransmitScience) as HTMLButtonElement;
    this.transmitBtn.dataset.action = 'transmit-science';
    this.recoverBtn = mk('Recover', 'Recover vessel (ends flight)', cb.onRecover);
    this.recoverBtn.classList.add('hud-recover');

    // ---- central flight instrument: navball + guidance + attached telemetry
    const left = el('div', 'hud-left', this.root);
    const navWrap = el('div', 'hud-navwrap', left);

    const speedPod = el('div', 'hud-nav-speed', navWrap);
    this.speedModeEl = el('div', 'hud-nav-speed-mode', speedPod, 'SURFACE');
    this.speedEl = el('div', 'hud-nav-speed-value', speedPod, '0.0 m/s');

    const sasCol = el('div', 'hud-sas', navWrap);
    this.guidancePanel = sasCol;
    el('div', 'hud-sas-heading', sasCol, 'GUIDANCE');
    for (const { mode, label, icon, title } of SAS_MODES) {
      const b = el('button', 'hud-btn hud-sas-btn', sasCol, label) as HTMLButtonElement;
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.dataset.mode = mode;
      if (icon) appendNavballIcon(b, icon);
      b.onclick = () => {
        cb.onSetSas(mode);
        if (compactHud.matches) this.setGuidanceOpen(false);
      };
      this.sasButtons.set(mode, b);
    }

    this.navCanvas = document.createElement('canvas');
    const navballScale = Math.min(window.devicePixelRatio || 1, 2);
    this.navCanvas.width = NAVBALL_SIZE * navballScale;
    this.navCanvas.height = NAVBALL_SIZE * navballScale;
    this.navCanvas.style.width = `${NAVBALL_SIZE}px`;
    this.navCanvas.style.height = `${NAVBALL_SIZE}px`;
    this.navCanvas.className = 'hud-navball';
    this.navCanvas.setAttribute('role', 'img');
    this.navCanvas.setAttribute('aria-label', 'Attitude navball');
    navWrap.appendChild(this.navCanvas);
    this.navCtx = this.navCanvas.getContext('2d')!;
    this.navCtx.scale(navballScale, navballScale);

    const navData = el('div', 'hud-nav-data', navWrap);
    const navDatum = (label: string) => {
      const item = el('div', 'hud-nav-datum', navData);
      el('span', 'hud-nav-datum-label', item, label);
      return el('strong', 'hud-nav-datum-value', item, '—');
    };
    this.altEl = navDatum('ALT');
    this.vsEl = navDatum('V/S');
    this.navGEl = navDatum('G');

    const navControls = el('div', 'hud-nav-controls', navWrap);
    this.sasMasterBtn = el('button', 'hud-nav-toggle', navControls, 'SAS');
    this.sasMasterBtn.setAttribute('type', 'button');
    this.sasMasterBtn.setAttribute('aria-label', 'Toggle stability assist');
    this.sasMasterBtn.title = 'Toggle stability assist (T)';
    this.sasMasterBtn.onclick = cb.onToggleSas;
    this.rcsBtn = el('button', 'hud-nav-toggle', navControls, 'RCS');
    this.rcsBtn.setAttribute('type', 'button');
    this.rcsBtn.setAttribute('aria-label', 'Toggle reaction control system');
    this.rcsBtn.title = 'Toggle reaction control system (R)';
    this.rcsBtn.onclick = cb.onToggleRcs;
    this.sasModeEl = el('button', 'hud-nav-guidance-mode', navControls, 'MANUAL');
    this.sasModeEl.setAttribute('type', 'button');
    this.sasModeEl.setAttribute('aria-label', 'Choose guidance mode');
    this.sasModeEl.setAttribute('aria-expanded', 'false');
    this.sasModeEl.onclick = () => this.setGuidanceOpen(!this.guidancePanel.classList.contains('open'));

    this.throttleInput = document.createElement('input');
    this.throttleInput.className = 'hud-throttle-range';
    this.throttleInput.type = 'range';
    this.throttleInput.min = '0';
    this.throttleInput.max = '100';
    this.throttleInput.step = '1';
    this.throttleInput.value = '0';
    this.throttleInput.setAttribute('aria-label', 'Throttle percentage');
    this.throttleInput.setAttribute('aria-valuetext', '0 percent throttle');
    this.throttleInput.title = 'Throttle — drag the left navball bezel';
    this.throttleInput.oninput = () => cb.onSetThrottle(Number(this.throttleInput.value) / 100);
    navWrap.appendChild(this.throttleInput);

    const status = el('div', 'hud-status-strip', navWrap);
    const statusGauge = (label: string) => {
      const row = el('div', 'hud-status-row', status);
      el('span', 'hud-status-key', row, label);
      const track = el('div', 'hud-status-track', row);
      const fill = el('div', 'hud-status-fill', track);
      const text = el('span', 'hud-status-text', row, '—');
      return { fill, text };
    };
    ({ fill: this.gFill, text: this.gText } = statusGauge('G'));
    ({ fill: this.qFill, text: this.qText } = statusGauge('Q'));
    ({ fill: this.atmosphereFill, text: this.atmosphereText } = statusGauge('ATM'));
    this.precisionEl = el('div', 'hud-mode-badge precision', status, 'PRECISION');
    this.precisionEl.style.display = 'none';
    this.actionGroupEl = el('div', 'hud-action-group', status, '');
    this.actionGroupEl.style.display = 'none';

    // ---- right: collapsible flight details + staging
    const right = el('div', 'hud-right', this.root);
    this.detailsBtn = el('button', 'hud-data-toggle', right, '▥  FLIGHT DATA') as HTMLButtonElement;
    this.detailsBtn.type = 'button';
    this.detailsBtn.onclick = () => this.setDetailsCollapsed(!this.detailsCollapsed);
    status.classList.add('hud-panel', 'hud-detail-panel');
    right.appendChild(status);
    this.nodeInfoPanel = el('div', 'hud-panel hud-node-panel hud-detail-panel', right);
    this.nodeInfoEl = el('div', 'hud-node-info', this.nodeInfoPanel);
    this.nodeInfoPanel.style.display = 'none';

    this.entryCard = el('div', 'hud-panel hud-entry-card hud-detail-panel', right);
    this.entryCard.style.display = 'none';

    const oreBox = el('div', 'hud-panel hud-resources hud-detail-panel', right);
    this.oreRow = el('div', 'hud-gauge', oreBox);
    el('span', 'hud-key', this.oreRow, 'ORE');
    const oreTrack = el('div', 'hud-gauge-track', this.oreRow);
    this.gaugeFills.set('ore', el('div', 'hud-gauge-fill', oreTrack));
    this.gaugeTexts.set('ore', el('span', 'hud-gauge-text', this.oreRow, ''));
    this.gaugeHosts.set('ore', oreBox);
    oreBox.style.display = 'none';

    this.scienceStatusEl = el('div', 'hud-panel hud-science-status hud-detail-panel', right);

    // ---- ISRU systems panel (drills/converters/survey), shown when present
    this.sysPanel = el('div', 'hud-panel hud-systems hud-detail-panel', right);
    this.sysPanel.style.display = 'none';

    const stagePanel = el('div', 'hud-panel hud-stages hud-staging', right);
    const stageBtn = el('button', 'hud-btn hud-stage-btn', stagePanel, 'STAGE');
    stageBtn.title = 'Fire next stage (Space)';
    stageBtn.onclick = cb.onStage;
    this.stageListEl = el('div', 'hud-stage-list', stagePanel);

    // ---- event feed
    this.eventFeed = el('div', 'hud-events', this.root);

    // ---- flight companion: local callouts plus on-demand structured AI advisories
    this.companion = new FlightCompanion(this.root, () => this.requestAiBriefing());

    this.buildTouchControls();
    this.setDetailsCollapsed(compactHud.matches);
    this.setGuidanceOpen(!compactHud.matches);
    compactHud.addEventListener('change', (event) => {
      this.setDetailsCollapsed(event.matches);
      this.setGuidanceOpen(!event.matches);
    });
  }

  private commsEl!: HTMLElement;

  /** Entry point for a server-backed flight-director response. */
  showCompanionAdvisory(advisory: FlightCompanionAdvisory): void {
    this.companion.present(advisory);
  }

  private async requestAiBriefing(): Promise<FlightCompanionAdvisory> {
    const context = this.lastDirectorContext;
    if (!context) {
      return {
        id: 'ai-no-flight', headline: 'No flight snapshot',
        message: 'Wait for flight telemetry, then ask Pip again.', tone: 'info', source: 'local',
      };
    }
    const snapshot = buildFlightDirectorSnapshot(
      context.game,
      this.missionStart,
      context.node,
      context.telemetry,
      this.lastComms,
      this.commsBlocked,
      this.lastDirectorDecision,
    );
    if (!snapshot) {
      return {
        id: 'ai-no-vessel', headline: 'No active spacecraft',
        message: 'Select a controllable spacecraft, then ask Pip again.', tone: 'info', source: 'local',
      };
    }
    try {
      const advisory = await requestFlightDirector(snapshot);
      this.lastDirectorDecision = {
        vesselId: snapshot.mission.flightId,
        issuedAt: context.game.time,
        actionId: advisory.nextAction.actionId,
        flightPhase: snapshot.phase.flightPhase,
      };
      const action = advisory.nextAction.actionId === 'none'
        ? undefined
        : `${advisory.nextAction.timing.toUpperCase()} — ${advisory.nextAction.instruction}`;
      const warning = advisory.warnings[0] ? ` Caution: ${advisory.warnings[0]}` : '';
      return {
        id: `ai-${Date.now()}`,
        headline: advisory.headline,
        message: `${advisory.summary}${warning}`,
        action,
        tone: advisory.tone,
        source: 'ai',
      };
    } catch (error) {
      const message = error instanceof FlightDirectorRequestError
        ? error.userMessage
        : 'Pip could not reach flight control. Local guidance is still active.';
      return {
        id: 'ai-unavailable', headline: 'Briefing unavailable', message,
        tone: 'warning', source: 'local',
      };
    }
  }

  setComms(status: CommsStatus, blocked: boolean): void {
    this.lastComms = status;
    this.commsBlocked = blocked;
    if (blocked) {
      this.commsEl.textContent = '⇅ NO SIGNAL';
      this.commsEl.style.color = 'var(--ui-danger)';
      this.commsEl.title = 'Probe control requires a comms link';
    } else if (status.connected) {
      this.commsEl.textContent = `⇅ ${(status.strength * 100).toFixed(0)}%`;
      this.commsEl.style.color = 'var(--ui-good)';
      this.commsEl.title = status.path.join(' → ');
    } else {
      this.commsEl.textContent = '⇅ LOCAL';
      this.commsEl.style.color = '#7d8b96';
      this.commsEl.title = 'Crewed vessel: no link needed';
    }
    this.transmitBtn.disabled = !status.connected;
  }

  private setGuidanceOpen(open: boolean): void {
    this.guidancePanel.classList.toggle('open', open);
    this.sasModeEl.setAttribute('aria-expanded', String(open));
  }

  private setDetailsCollapsed(collapsed: boolean): void {
    this.detailsCollapsed = collapsed;
    this.root.classList.toggle('hud-details-collapsed', collapsed);
    this.detailsBtn.setAttribute('aria-expanded', String(!collapsed));
    this.detailsBtn.textContent = collapsed ? '▥  FLIGHT DATA' : '▾  FLIGHT DATA';
  }

  private buildTouchControls(): void {
    const controls = el('div', 'hud-touch-controls', this.root);
    const mode = el('button', 'hud-touch-mode', controls, 'ATT') as HTMLButtonElement;
    mode.type = 'button';
    mode.setAttribute('aria-label', 'Switch touch controls between attitude and RCS translation');
    mode.onclick = () => {
      this.releaseTouchControls();
      this.touchControlMode = this.touchControlMode === 'attitude' ? 'translation' : 'attitude';
      mode.textContent = this.touchControlMode === 'attitude' ? 'ATT' : 'RCS';
      controls.dataset.mode = this.touchControlMode;
    };
    const addHold = (
      className: string,
      label: string,
      attitude: readonly [FlightControlAxis, number, string],
      translation: readonly [FlightControlAxis, number, string],
    ) => {
      const button = el('button', `hud-touch-btn ${className}`, controls, label) as HTMLButtonElement;
      button.type = 'button';
      this.touchControlButtons.push(button);
      const binding = () => this.touchControlMode === 'attitude' ? attitude : translation;
      const release = () => {
        if (!button.classList.contains('active')) return;
        const [axis] = binding();
        this.cb.onSetFlightControl(axis, 0);
        button.classList.remove('active');
      };
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        const [axis, value, title] = binding();
        button.setAttribute('aria-label', title);
        button.classList.add('active');
        button.setPointerCapture?.(event.pointerId);
        this.cb.onSetFlightControl(axis, value);
      });
      button.addEventListener('pointerup', release);
      button.addEventListener('pointercancel', release);
      button.addEventListener('lostpointercapture', release);
      button.setAttribute('aria-label', attitude[2]);
    };
    addHold('up', '▲', ['pitch', 1, 'Pitch up'], ['translate-y', 1, 'Translate up']);
    addHold('left', '◀', ['yaw', -1, 'Yaw left'], ['translate-x', -1, 'Translate left']);
    addHold('right', '▶', ['yaw', 1, 'Yaw right'], ['translate-x', 1, 'Translate right']);
    addHold('down', '▼', ['pitch', -1, 'Pitch down'], ['translate-y', -1, 'Translate down']);
    addHold('roll-left', '↶', ['roll', -1, 'Roll left'], ['translate-z', -1, 'Translate aft']);
    addHold('roll-right', '↷', ['roll', 1, 'Roll right'], ['translate-z', 1, 'Translate forward']);
    controls.dataset.mode = this.touchControlMode;
  }

  private releaseTouchControls(): void {
    for (const axis of ['pitch', 'yaw', 'roll', 'translate-x', 'translate-y', 'translate-z'] as const) {
      this.cb.onSetFlightControl(axis, 0);
    }
    for (const button of this.touchControlButtons) button.classList.remove('active');
  }

  private warpStep(dir: number): void {
    this.pendingWarpStep = dir;
  }
  pendingWarpStep = 0;

  setMissionStart(t: number): void {
    this.missionStart = t;
  }

  /** Per-frame update; all DOM mutation is direct and cheap. */
  update(game: GameState, node: ManeuverNode | null, telemetry: HudTelemetry): void {
    const gv = game.active;
    if (!gv) return;
    this.lastDirectorContext = { game, node, telemetry };
    const v = gv.runtime;
    this.syncVesselSelect(game);
    const throttlePercent = Math.round(v.controls.throttle * 100);
    if (document.activeElement !== this.throttleInput) this.throttleInput.value = String(throttlePercent);
    this.throttleInput.setAttribute('aria-valuetext', `${throttlePercent} percent throttle`);
    const body = game.bodyOf(gv);
    const r = v.pos.length();
    const alt = r - body.radius;

    // Speed: surface-relative in atmosphere / near ground, orbital above.
    const surfaceVel = surfaceVelocity(body, v.pos, new Vec3());
    const surfSpeed = new Vec3().copy(v.vel).sub(surfaceVel).length();
    const orbSpeed = v.vel.length();
    const surfaceMode =
      alt < (body.def.atmosphere?.height ?? Math.max(10_000, body.radius * 0.08));
    this.speedModeEl.textContent = surfaceMode ? 'SURFACE' : 'ORBIT';
    this.speedEl.textContent = `${(surfaceMode ? surfSpeed : orbSpeed).toFixed(surfaceMode && surfSpeed < 100 ? 1 : 0)} m/s`;
    this.altEl.textContent = fmtDistance(alt);
    const vs = v.vel.dot(new Vec3().copy(v.pos).normalize());
    this.vsEl.textContent = `${vs > 0 ? '+' : ''}${vs.toFixed(1)} m/s`;
    this.navGEl.textContent = `${(v.properAccel / G0).toFixed(2)} g`;

    this.metEl.textContent = `T+ ${fmtTime(game.time - this.missionStart)}`;
    const nextAlarm = game.alarms[0];
    this.nextAlarmEl.textContent = nextAlarm ? `ALM T−${fmtTime(nextAlarm.time - game.time)}` : 'ALM —';
    this.nextAlarmEl.title = nextAlarm?.label ?? 'No scheduled alarms';
    this.situationEl.textContent = v.situation.toUpperCase();
    this.warpEl.textContent = `${game.warpRate}×`;
    this.crewEl.textContent = v.crew.length ? `CREW ${v.crew.length} · ${v.crew.join(', ')}` : 'CREW —';
    this.crewEl.title = v.crew.length ? v.crew.join(', ') : 'Uncrewed vessel';
    this.precisionEl.style.display = telemetry.precision ? '' : 'none';

    // Orbit readouts with time-to-apsis ETAs.
    const el0 = stateToElements(body.mu, v.pos, v.vel, game.time);
    if (el0.e < 1) {
      const ap = apoapsisOf(el0) - body.radius;
      this.apEl.textContent = fmtDistance(ap);
      const tApo = timeToTrueAnomaly(el0, game.time, Math.PI);
      const tPe = timeToTrueAnomaly(el0, game.time, 0);
      this.apTimeEl.textContent = tApo > 1 ? `T−${fmtTime(tApo)}` : '';
      this.peTimeEl.textContent = tPe > 1 ? `T−${fmtTime(tPe)}` : '';
    } else {
      this.apEl.textContent = '(escape)';
      this.apTimeEl.textContent = '';
      this.peTimeEl.textContent = '';
    }
    const pe = periapsisOf(el0) - body.radius;
    this.peEl.textContent = fmtDistance(pe);

    // Node info.
    let nodeBurnStartEta: number | null = null;
    if (node) {
      this.nodeInfoPanel.style.display = '';
      const eta = node.time - game.time;
      const burnDuration = this.estimateNodeBurn(game, telemetry.nodeRemainingDv || nodeDeltaV(node));
      const burnStartEta = eta - burnDuration / 2;
      nodeBurnStartEta = burnStartEta;
      const cue = burnStartEta <= 0 && eta > -burnDuration / 2 ? 'START BURN' : `burn T−${fmtTime(burnStartEta)}`;
      this.nodeInfoEl.textContent = `NODE  ${telemetry.nodeRemainingDv.toFixed(1)} m/s REM\n${cue} · ${burnDuration.toFixed(1)} s`;
    } else {
      this.nodeInfoPanel.style.display = 'none';
      this.nodeInfoEl.textContent = '';
    }
    this.updateEntryCard(body.radius, game.time, telemetry.entryPrediction, telemetry.landingTargetDirBF);

    // Flight-load gauges. Throttle is rendered directly on the navball bezel.
    if (this.peakQVesselId !== v.id) {
      this.peakQVesselId = v.id;
      this.peakQ = 0;
    }
    this.peakQ = Math.max(this.peakQ, v.aero.dynamicPressure);
    const atmosphereHeight = body.def.atmosphere?.height ?? 0;
    const atmosphereDepth = atmosphereHeight > 0 ? Math.max(0, Math.min(1, 1 - alt / atmosphereHeight)) : 0;
    this.setStatus(this.gFill, this.gText, v.properAccel / G0 / 5, `${(v.properAccel / G0).toFixed(2)} g`);
    this.setStatus(this.qFill, this.qText, v.aero.dynamicPressure / 40_000, `${(v.aero.dynamicPressure / 1000).toFixed(1)} kPa`);
    this.setStatus(this.atmosphereFill, this.atmosphereText, atmosphereDepth, `${(atmosphereDepth * 100).toFixed(0)}%`);
    this.qText.title = `Peak Q ${(this.peakQ / 1000).toFixed(1)} kPa`;
    let fuel = 0,
      fuelMax = 0,
      mono = 0,
      monoMax = 0,
      ore = 0,
      oreMax = 0;
    for (const p of v.craft.parts) {
      fuel += p.resources.propellant ?? 0;
      mono += p.resources.monoprop ?? 0;
      ore += p.resources.ore ?? 0;
      const d = defOf(p);
      fuelMax += d.resources?.propellant ?? 0;
      monoMax += d.resources?.monoprop ?? 0;
      oreMax += oreCapacityOf(d);
    }
    this.setGauge('propellant', fuel, fuelMax);
    this.setGauge('monoprop', mono, monoMax);
    this.setGauge('charge', v.charge.amount, v.charge.capacity);
    const orePanel = this.gaugeHosts.get('ore');
    if (orePanel) orePanel.style.display = oreMax > 0 ? '' : 'none';
    if (oreMax > 0) this.setGauge('ore', ore, oreMax);

    this.companion.update({
      vesselId: v.id,
      situation: v.situation,
      fuelFraction: fuelMax > 0 ? fuel / fuelMax : null,
      chargeFraction: v.charge.capacity > 0 ? v.charge.amount / v.charge.capacity : null,
      dynamicPressurePa: v.aero.dynamicPressure,
      properG: v.properAccel / G0,
      commsBlocked: this.commsBlocked,
      nodeBurnStartEta,
      predictedImpactSpeed:
        telemetry.entryPrediction?.lands ? telemetry.entryPrediction.impactSpeed : null,
    });

    this.updateSystems(game);
    this.updateScienceStatus(game);

    // SAS highlight.
    for (const [mode, btn] of this.sasButtons) {
      btn.classList.toggle('active', v.sas === mode);
    }
    const sasActive = v.sas !== 'off';
    this.sasMasterBtn.classList.toggle('active', sasActive);
    this.sasMasterBtn.setAttribute('aria-pressed', `${sasActive}`);
    this.rcsBtn.classList.toggle('active', v.controls.rcs);
    this.rcsBtn.setAttribute('aria-pressed', `${v.controls.rcs}`);
    this.sasModeEl.textContent = sasActive ? v.sas.replace('-', ' ').toUpperCase() : 'MANUAL';

    // Staging list (re-render only when it changes).
    const stageSig = `${v.id}:${v.currentStage}:${Math.floor(game.time * 2)}:${v.craft.stages.map((s) => s.partKeys.join('.')).join('|')}`;
    if (stageSig !== this.lastStageRender) {
      this.lastStageRender = stageSig;
      this.stageListEl.innerHTML = '';
      const analysis = analyzeCraft(v.craft, body.surfaceGravity, body.pressureAt(alt));
      v.craft.stages.forEach((stage, i) => {
        const div = document.createElement('div');
        div.className = `hud-stage ${i < v.currentStage ? 'spent' : i === v.currentStage ? 'next' : ''}`;
        const names = stage.partKeys
          .map((k) => v.craft.parts.find((p) => p.key === k))
          .filter(Boolean)
          .map((p) => defOf(p!).name);
        const stageTitle = document.createElement('div');
        stageTitle.className = 'hud-stage-title';
        stageTitle.textContent = `STAGE ${v.craft.stages.length - 1 - i}`;
        const metrics = analysis.stages[i];
        const figures = document.createElement('div');
        figures.className = 'hud-stage-metrics';
        figures.textContent = metrics
          ? `Δv ${metrics.deltaV.toFixed(0)}  ·  TWR ${metrics.twrStart.toFixed(2)}  ·  ${metrics.burnTime.toFixed(0)}s`
          : 'Δv —  ·  TWR —';
        div.title = names.join(', ') || '(empty stage)';
        div.append(stageTitle, figures);
        this.stageListEl.appendChild(div);
      });
    }

    // Buttons visibility.
    this.recoverBtn.style.display = isRecoverable(gv, game.universe) ? '' : 'none';

    // Event feed.
    if (v.events.length !== this.lastEventCount) {
      for (let i = this.lastEventCount; i < v.events.length; i++) {
        const ev = v.events[i];
        const div = document.createElement('div');
        div.className = `hud-event ${ev.severity}`;
        div.textContent = ev.text;
        this.eventFeed.appendChild(div);
        setTimeout(() => div.remove(), 6100);
        if (this.eventFeed.children.length > 6) this.eventFeed.firstChild?.remove();
      }
      this.lastEventCount = v.events.length;
    }

    this.drawNavball(game, node, telemetry.nodeRemainingDv, telemetry.nodeBurnDirection);
  }

  private syncVesselSelect(game: GameState): void {
    const vessels = game.vessels.filter((candidate) => !candidate.runtime.isDebris);
    const signature = vessels.map((candidate) => `${candidate.runtime.id}:${candidate.runtime.name}`).join('|');
    if (signature !== this.lastVesselSignature) {
      this.lastVesselSignature = signature;
      this.vesselSelect.innerHTML = '';
      for (const candidate of vessels) {
        const option = document.createElement('option');
        option.value = candidate.runtime.id;
        option.textContent = candidate.runtime.name;
        this.vesselSelect.appendChild(option);
      }
    }
    if (game.activeVesselId && this.vesselSelect.value !== game.activeVesselId) {
      this.vesselSelect.value = game.activeVesselId;
    }
    this.vesselSelect.disabled = vessels.length < 2;
    this.vesselSelect.title = vessels.length < 2 ? 'Only one controllable craft' : 'Switch active craft';
  }

  showActionGroup(group: number, executed: number): void {
    this.actionGroupEl.textContent = `AG ${group === 10 ? 0 : group} · ${executed || 'NO'} ACTION${executed === 1 ? '' : 'S'}`;
    this.actionGroupEl.style.display = '';
    window.setTimeout(() => {
      this.actionGroupEl.style.display = 'none';
    }, 1400);
  }

  private updateScienceStatus(game: GameState): void {
    const gv = game.active;
    if (!gv) return;
    const bufferSignature = [...gv.runtime.scienceBuffer]
      .map(([key, value]) => `${key}:${value.heldValue}:${value.transmittedFromThis}`)
      .join('|');
    const signature = `${gv.runtime.id}:${gv.runtime.bodyId}:${gv.runtime.situation}:${Math.floor(game.time * 2)}:${game.sciencePoints}:${bufferSignature}:${game.scienceLedger.size}`;
    if (signature === this.lastScienceRender) return;
    this.lastScienceRender = signature;
    const preview = availableHere(game, gv);
    const aboard = [...gv.runtime.scienceBuffer].reduce((total, [keyId, result]) => {
      const ledger = game.scienceLedger.get(keyId);
      const delivered = ledger ? ledger.deliveredByRecovery + ledger.deliveredByTransmit : 0;
      const remainingCap = ledger ? Math.max(0, ledger.cap - delivered) : result.siteCapAtCollection;
      return total + Math.min(result.heldValue - result.transmittedFromThis, remainingCap);
    }, 0);
    const recoverOnly = [...gv.runtime.scienceBuffer.values()]
      .filter((result) => result.transmitTarget === 0)
      .length;
    const count = preview.results.length;
    const scienceButton = this.scienceBtn as HTMLButtonElement;
    scienceButton.disabled = count === 0;
    scienceButton.classList.toggle('active', count > 0);
    scienceButton.textContent = count > 0 ? `Science ${count}` : 'Science';
    this.transmitBtn.style.display = gv.runtime.scienceBuffer.size > 0 ? '' : 'none';
    this.transmitBtn.disabled = !this.lastComms.connected || gv.runtime.scienceBuffer.size === 0;
    this.scienceStatusEl.replaceChildren();
    el('div', 'hud-science-kicker', this.scienceStatusEl, preview.site?.biome.name.toUpperCase() ?? 'NO SCIENCE SITE');
    el(
      'div',
      'hud-science-available',
      this.scienceStatusEl,
      count > 0 ? `${count} RESULT${count === 1 ? '' : 'S'} · ${preview.totalCollectValue} SCI` : 'SITE EXHAUSTED',
    );
    el(
      'div',
      'hud-science-aboard',
      this.scienceStatusEl,
      aboard > 0
        ? `${aboard} SCI ABOARD · ${this.lastComms.connected ? 'LINK READY' : 'NO DOWNLINK'}${recoverOnly ? ` · ${recoverOnly} RECOVER ONLY` : ''}`
        : 'NO DATA ABOARD',
    );
  }

  showPartActions(game: GameState, partKey: number, clientX: number, clientY: number): void {
    this.partPopup?.remove();
    const gv = game.active;
    const part = gv?.runtime.craft.parts.find((candidate) => candidate.key === partKey);
    if (!gv || !part) return;
    const definition = defOf(part);
    const popup = el('div', 'hud-part-popup', this.root);
    this.partPopup = popup;
    popup.style.left = `${Math.min(window.innerWidth - 250, Math.max(10, clientX + 12))}px`;
    popup.style.top = `${Math.min(window.innerHeight - 260, Math.max(54, clientY - 20))}px`;
    const heading = el('div', 'hud-part-heading', popup);
    el('strong', '', heading, definition.name);
    const close = el('button', 'k-window-btn', heading, '×');
    close.onclick = () => {
      popup.remove();
      this.partPopup = null;
    };
    el('div', 'hud-part-meta', popup, `${definition.massDry.toFixed(0)} kg dry · ${part.temperature?.toFixed(0) ?? '—'} K`);
    const resourceEntries = Object.entries(part.resources).filter(([, amount]) => (amount ?? 0) > 0);
    if (resourceEntries.length) {
      el('div', 'hud-part-meta', popup, resourceEntries.map(([resource, amount]) => `${resource} ${(amount ?? 0).toFixed(1)}`).join(' · '));
    }
    const actionable = definition.engine || definition.drill || definition.converter || definition.parachute;
    if (actionable) {
      const toggle = el('button', 'hud-btn hud-part-action', popup, part.activated ? 'Deactivate' : 'Activate');
      toggle.onclick = () => {
        this.cb.onToggleSystem(part.key);
        this.showPartActions(game, partKey, clientX, clientY);
      };
    }
    if (definition.science) {
      const science = el('button', 'hud-btn hud-part-action', popup, 'Run experiment');
      science.onclick = () => this.cb.onRunScience();
    }
    if (definition.resourceScanner) {
      const survey = el('button', 'hud-btn hud-part-action', popup, 'Survey resources');
      survey.onclick = () => this.cb.onSurvey();
    }
  }

  private setStatus(fill: HTMLElement, text: HTMLElement, fraction: number, label: string): void {
    const clamped = Math.max(0, Math.min(1, fraction));
    fill.style.width = `${(clamped * 100).toFixed(1)}%`;
    fill.classList.toggle('warning', clamped >= 0.7);
    fill.classList.toggle('danger', clamped >= 0.92);
    text.textContent = label;
  }

  private estimateNodeBurn(game: GameState, deltaV: number): number {
    const gv = game.active;
    if (!gv) return 0;
    const v = gv.runtime;
    const body = game.bodyOf(gv);
    const altitude = v.pos.length() - body.radius;
    const analysis = analyzeCraft(v.craft, body.surfaceGravity, body.pressureAt(altitude));
    const candidates = analysis.stages.filter((stage) => stage.thrust > 0);
    const stage = candidates.find((candidate) => candidate.stageIndex >= v.currentStage)
      ?? [...candidates].reverse().find((candidate) => candidate.stageIndex < v.currentStage);
    if (!stage) return 0;
    return estimateBurnTime(deltaV, stage.thrust, v.massProps.mass, stage.isp);
  }

  private updateEntryCard(
    bodyRadius: number,
    time: number,
    prediction: EntryPrediction | null,
    landingTarget: Vec3 | null,
  ): void {
    if (!prediction?.willEnter) {
      this.entryCard.style.display = 'none';
      return;
    }
    this.entryCard.style.display = '';
    this.entryCard.innerHTML = '';
    el('div', 'hud-stage-title', this.entryCard, 'ENTRY PREDICTION');
    const row = (label: string, value: string) => {
      const line = el('div', 'hud-row', this.entryCard);
      el('span', 'hud-key', line, label);
      el('span', 'hud-val', line, value);
    };
    row('IFACE', prediction.entryTime > 0 ? `T−${fmtTime(prediction.entryTime - time)}` : 'inside');
    row('LAND', prediction.landingTime > 0 ? `T−${fmtTime(prediction.landingTime - time)}` : '—');
    row('HEAT', `${(prediction.peakHeatFlux / 1e6).toFixed(2)} MW/m²`);
    row('PEAK G', `${prediction.peakG.toFixed(2)} g`);
    row('IMPACT', prediction.lands ? `${prediction.impactSpeed.toFixed(1)} m/s` : 'skip / no intercept');
    if (prediction.landingDirBF) {
      const latitude = Math.asin(prediction.landingDirBF.z) * 180 / Math.PI;
      const longitude = Math.atan2(prediction.landingDirBF.y, prediction.landingDirBF.x) * 180 / Math.PI;
      row('SITE', `${latitude.toFixed(2)}°, ${longitude.toFixed(2)}°`);
      if (landingTarget) {
        const dot = Math.max(-1, Math.min(1, prediction.landingDirBF.dot(landingTarget)));
        row('MISS', fmtDistance(Math.acos(dot) * bodyRadius));
      }
    }
    this.entryCard.classList.toggle('warning', !prediction.lands);
  }

  /** ISRU systems panel: drill/converter toggles, survey, local ore. */
  private updateSystems(game: GameState): void {
    const gv = game.active!;
    const v = gv.runtime;
    const systems = v.craft.parts.filter((p) => {
      const d = defOf(p);
      return d.drill || d.converter;
    });
    const hasScanner = v.craft.parts.some((p) => defOf(p).resourceScanner);
    const landed = v.situation === 'landed' || v.situation === 'prelaunch';
    const scanned = game.scannedBodies.has(v.bodyId);

    const sig = `${systems.map((p) => `${p.key}:${p.activated ? 1 : 0}`).join('|')}~${hasScanner}~${landed}~${scanned}~${v.situation}`;
    if (sig !== this.lastSysRender) {
      this.lastSysRender = sig;
      this.sysPanel.innerHTML = '';
      this.oreHereEl = null;
      if (!systems.length && !hasScanner) {
        this.sysPanel.style.display = 'none';
      } else {
        this.sysPanel.style.display = '';
        const title = el('div', 'hud-stage-title', this.sysPanel, 'SYSTEMS');
        void title;
        for (const p of systems) {
          const d = defOf(p);
          const b = el(
            'button',
            'hud-btn hud-sys-toggle',
            this.sysPanel,
            `${d.drill ? '⛏' : '⚗'} ${d.name}: ${p.activated ? 'ON' : 'OFF'}`,
          );
          b.classList.toggle('active', !!p.activated);
          b.title = d.drill
            ? 'Drill extracts ore while landed (uses charge)'
            : 'Converter refines ore into propellant (uses charge)';
          b.onclick = () => this.cb.onToggleSystem(p.key);
        }
        if (hasScanner) {
          const b = el('button', 'hud-btn hud-sys-toggle', this.sysPanel, '🛰 Survey resources');
          b.title = scanned
            ? 'This body is already surveyed'
            : 'Survey the resource field (needs stable orbit above 25 km, 20 charge)';
          b.onclick = () => this.cb.onSurvey();
        }
        if (systems.some((p) => defOf(p).drill)) {
          this.oreHereEl = el('div', 'hud-node-info', this.sysPanel, '');
        }
      }
    }

    // Live local-ore readout (cheap noise sample; only while landed).
    if (this.oreHereEl) {
      if (!landed) {
        this.oreHereEl.textContent = '';
      } else if (!scanned) {
        this.oreHereEl.textContent = 'Ore here: ?? (survey from orbit)';
      } else {
        const body = game.bodyOf(gv);
        const dir = inertialToBodyFixed(body, game.time, v.pos, new Vec3()).normalize();
        const conc = oreConcentration(body, dir);
        this.oreHereEl.textContent = `Ore here: ${(conc * 100).toFixed(0)}%`;
      }
    }
  }

  private appendResourceIcon(parent: HTMLElement, paths: readonly string[]): void {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('hud-resource-icon');
    for (const pathData of paths) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', pathData);
      svg.appendChild(path);
    }
    parent.appendChild(svg);
  }

  private setGauge(key: HudResource, value: number, max: number): void {
    const fill = this.gaugeFills.get(key);
    const text = this.gaugeTexts.get(key);
    if (!fill || !text) return;
    const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    fill.style.width = `${(frac * 100).toFixed(1)}%`;
    fill.style.background = frac < 0.15 ? 'var(--ui-danger)' : 'var(--ui-accent)';
    text.textContent = `${value.toFixed(0)}`;
    const host = this.gaugeHosts.get(key);
    if (host) {
      const label = host.dataset.label ?? (key === 'ore' ? 'Ore' : key);
      const detail = `${label}: ${value.toFixed(0)} / ${max.toFixed(0)} (${(frac * 100).toFixed(0)}%)`;
      host.setAttribute('aria-valuemax', max.toFixed(0));
      host.setAttribute('aria-valuenow', value.toFixed(0));
      host.setAttribute('aria-valuetext', detail);
      host.title = detail;
      const tooltip = this.gaugeTooltips.get(key);
      if (tooltip) tooltip.textContent = detail;
    }
  }

  // ------------------------------------------------------------- navball
  private drawNavball(
    game: GameState,
    node: ManeuverNode | null,
    remainingDv: number,
    plannedBurnDirection: Readonly<Vec3> | null,
  ): void {
    const gv = game.active!;
    const v = gv.runtime;
    const ctx = this.navCtx;
    const W = NAVBALL_SIZE;
    const R = W / 2 - 12;
    const cx = W / 2;
    const cy = W / 2;

    // Local horizon frame.
    const up = new Vec3().copy(v.pos).normalize();
    const east = new Vec3(-up.y, up.x, 0);
    if (east.lengthSq() < 1e-9) east.set(1, 0, 0);
    east.normalize();
    const north = new Vec3();
    Vec3.cross(up, east, north);

    // Craft axes in world.
    const nose = v.att.rotate(new Vec3(0, 1, 0), new Vec3());
    const right = v.att.rotate(new Vec3(1, 0, 0), new Vec3());
    const screenUp = v.att.rotate(new Vec3(0, 0, 1), new Vec3());

    const pitch = Math.asin(Math.max(-1, Math.min(1, nose.dot(up))));
    const heading = navHeading(nose, screenUp, up, east, north);
    // Roll: angle of craft right vs horizon plane.
    const horizonRight = new Vec3();
    Vec3.cross(nose, up, horizonRight);
    let roll = 0;
    if (horizonRight.lengthSq() > 1e-10) {
      horizonRight.normalize();
      roll = Math.atan2(-right.dot(up), right.dot(horizonRight) * -1);
    }
    const pitchDeg = (pitch * 180) / Math.PI;
    const rollDeg = (roll * 180) / Math.PI;
    const headingDeg = ((heading * 180) / Math.PI + 360) % 360;

    ctx.clearRect(0, 0, W, W);

    // Deep inset bezel beneath the moving attitude sphere.
    const bezel = ctx.createRadialGradient(cx, cy - 10, R * 0.76, cx, cy, R + 12);
    bezel.addColorStop(0, '#243642');
    bezel.addColorStop(0.74, '#101c25');
    bezel.addColorStop(1, '#050a0e');
    ctx.fillStyle = bezel;
    ctx.beginPath();
    ctx.arc(cx, cy, R + 11, 0, Math.PI * 2);
    ctx.fill();

    const projectSphereComponents = (dx: number, dy: number, dz: number) => ({
      x: cx + (dx * right.x + dy * right.y + dz * right.z) * R,
      y: cy - (dx * screenUp.x + dy * screenUp.y + dz * screenUp.z) * R,
      forward: dx * nose.x + dy * nose.y + dz * nose.z,
    });
    const projectSphereDirection = (dir: Readonly<Vec3>) => projectNavDirection(dir, nose, right, screenUp);

    // Fill the projected hemisphere analytically. The horizon is the actual up=0
    // great circle, including its curved cap when the craft looks toward a pole.
    const noseUp = Vec3.dot(nose, up);
    const rightUp = Vec3.dot(right, up);
    const screenUpUp = Vec3.dot(screenUp, up);
    const skyColor = '#397f99';
    const groundColor = '#916a43';
    ctx.fillStyle = noseUp >= 0 ? skyColor : groundColor;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();

    const horizonX = rightUp;
    const horizonY = -screenUpUp;
    const horizonPlaneLength = Math.hypot(horizonX, horizonY);
    if (horizonPlaneLength > 1e-6) {
      ctx.beginPath();
      for (let step = 0; step <= 48; step++) {
        const edgeAxis = -1 + (step / 48) * 2;
        const curve = Math.sqrt(Math.max(0, 1 - edgeAxis * edgeAxis));
        const towardHorizon = -noseUp * curve;
        const sphereX = (horizonX * towardHorizon - horizonY * edgeAxis) / horizonPlaneLength;
        const sphereY = (horizonY * towardHorizon + horizonX * edgeAxis) / horizonPlaneLength;
        if (step === 0) ctx.moveTo(cx + sphereX * R, cy + sphereY * R);
        else ctx.lineTo(cx + sphereX * R, cy + sphereY * R);
      }
      const horizonAngle = Math.atan2(horizonY, horizonX);
      ctx.arc(
        cx,
        cy,
        R,
        horizonAngle + Math.PI / 2,
        horizonAngle - Math.PI / 2,
        noseUp < 0,
      );
      ctx.closePath();
      ctx.fillStyle = noseUp >= 0 ? groundColor : skyColor;
      ctx.fill();
    }

    const horizonDirection = (latitude: number, longitude: number) => {
      const cosLatitude = Math.cos(latitude);
      const northAmount = cosLatitude * Math.cos(longitude);
      const eastAmount = cosLatitude * Math.sin(longitude);
      const upAmount = Math.sin(latitude);
      return {
        x: east.x * eastAmount + north.x * northAmount + up.x * upAmount,
        y: east.y * eastAmount + north.y * northAmount + up.y * upAmount,
        z: east.z * eastAmount + north.z * northAmount + up.z * upAmount,
      };
    };
    const strokeLatitude = (latitude: number, color: string, width: number) => {
      ctx.beginPath();
      let drawing = false;
      for (let longitudeDeg = 0; longitudeDeg <= 360; longitudeDeg += 4) {
        const direction = horizonDirection(latitude, (longitudeDeg * Math.PI) / 180);
        const projected = projectSphereComponents(direction.x, direction.y, direction.z);
        if (projected.forward < 0) {
          drawing = false;
          continue;
        }
        if (drawing) ctx.lineTo(projected.x, projected.y);
        else ctx.moveTo(projected.x, projected.y);
        drawing = true;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    };
    const strokeLongitude = (longitude: number, color: string, width: number) => {
      ctx.beginPath();
      let drawing = false;
      for (let latitudeDeg = -90; latitudeDeg <= 90; latitudeDeg += 3) {
        const direction = horizonDirection((latitudeDeg * Math.PI) / 180, longitude);
        const projected = projectSphereComponents(direction.x, direction.y, direction.z);
        if (projected.forward < 0) {
          drawing = false;
          continue;
        }
        if (drawing) ctx.lineTo(projected.x, projected.y);
        else ctx.moveTo(projected.x, projected.y);
        drawing = true;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    };

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R - 1, 0, Math.PI * 2);
    ctx.clip();
    for (let latitudeDeg = -60; latitudeDeg <= 60; latitudeDeg += 30) {
      if (latitudeDeg === 0) continue;
      strokeLatitude(
        (latitudeDeg * Math.PI) / 180,
        'rgba(232, 240, 239, 0.3)',
        0.8,
      );
    }
    // Horizon gets a dark keyline beneath a bright great-circle reference.
    strokeLatitude(0, 'rgba(4, 10, 14, 0.7)', 3.4);
    strokeLatitude(0, 'rgba(238, 243, 240, 0.88)', 1.1);
    for (let longitudeDeg = 0; longitudeDeg < 360; longitudeDeg += 45) {
      const primary = longitudeDeg === 0 || longitudeDeg === 180;
      strokeLongitude(
        (longitudeDeg * Math.PI) / 180,
        primary ? 'rgba(226, 177, 60, 0.52)' : 'rgba(219, 233, 235, 0.14)',
        primary ? 1 : 0.55,
      );
    }

    // Sparse printed references rotate with the sphere instead of sliding or swapping.
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.font = '700 8px ui-monospace, SFMono-Regular, Menlo, monospace';
    for (let longitudeDeg = 0; longitudeDeg < 360; longitudeDeg += 30) {
      const direction = horizonDirection(0, (longitudeDeg * Math.PI) / 180);
      const projected = projectSphereComponents(direction.x, direction.y, direction.z);
      if (projected.forward < 0.08) continue;
      const label = longitudeDeg === 0 ? 'N' : longitudeDeg === 90 ? 'E' : longitudeDeg === 180 ? 'S' : longitudeDeg === 270 ? 'W' : `${longitudeDeg / 10}`.padStart(2, '0');
      ctx.globalAlpha = Math.min(1, projected.forward * 3);
      ctx.fillStyle = longitudeDeg === 0 ? '#ffd65a' : 'rgba(236, 243, 241, 0.78)';
      ctx.fillText(label, projected.x, projected.y + 8);
    }
    for (const latitudeDeg of [-60, -30, 30, 60]) {
      for (const longitudeDeg of [0, 180]) {
        const direction = horizonDirection((latitudeDeg * Math.PI) / 180, (longitudeDeg * Math.PI) / 180);
        const projected = projectSphereComponents(direction.x, direction.y, direction.z);
        if (projected.forward < 0.08) continue;
        ctx.globalAlpha = Math.min(1, projected.forward * 3);
        ctx.fillStyle = 'rgba(236, 243, 241, 0.72)';
        ctx.fillText(`${Math.abs(latitudeDeg)}`, projected.x + 10, projected.y);
      }
    }
    const drawPole = (direction: Readonly<Vec3>, label: string) => {
      const projected = projectSphereComponents(direction.x, direction.y, direction.z);
      if (projected.forward < 0.01) return;
      ctx.globalAlpha = Math.min(1, projected.forward * 4);
      ctx.strokeStyle = 'rgba(240, 244, 241, 0.84)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(projected.x, projected.y, 3.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(240, 244, 241, 0.84)';
      ctx.fillText(label, projected.x + 15, projected.y);
    };
    drawPole(up, '+90');
    drawPole(new Vec3().copy(up).negate(), '−90');
    ctx.globalAlpha = 1;
    ctx.restore();

    // Glass shading creates a sphere without obscuring the flight references.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    const glass = ctx.createRadialGradient(cx - R * 0.34, cy - R * 0.42, R * 0.08, cx, cy, R);
    glass.addColorStop(0, 'rgba(255, 255, 255, 0.13)');
    glass.addColorStop(0.38, 'rgba(255, 255, 255, 0.015)');
    glass.addColorStop(0.78, 'rgba(3, 8, 12, 0.08)');
    glass.addColorStop(1, 'rgba(2, 7, 10, 0.46)');
    ctx.fillStyle = glass;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    ctx.restore();

    // Full flight marker set projected into view space.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R - 2, 0, Math.PI * 2);
    ctx.clip();
    const drawDirectionMarker = (dir: Vec3, color: string, kind: NavballIcon) => {
      const marker = projectSphereDirection(dir);
      const px = cx + marker.x * (R - 15);
      const py = cy + marker.y * (R - 15);
      ctx.save();
      ctx.translate(px, py);
      ctx.globalAlpha = marker.behind ? 0.35 : 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = 'rgba(3, 9, 13, 0.9)';
      ctx.shadowBlur = 3;

      ctx.beginPath();
      ctx.arc(0, 0, 6.5, 0, Math.PI * 2);
      if (kind === 'prograde') {
        ctx.moveTo(0, -7);
        ctx.lineTo(0, -12);
        ctx.moveTo(-6.1, 3.5);
        ctx.lineTo(-10.4, 6);
        ctx.moveTo(6.1, 3.5);
        ctx.lineTo(10.4, 6);
      } else {
        ctx.moveTo(-4.2, -4.2);
        ctx.lineTo(4.2, 4.2);
        ctx.moveTo(4.2, -4.2);
        ctx.lineTo(-4.2, 4.2);
        ctx.moveTo(0, 7);
        ctx.lineTo(0, 12);
        ctx.moveTo(-6.1, -3.5);
        ctx.lineTo(-10.4, -6);
        ctx.moveTo(6.1, -3.5);
        ctx.lineTo(10.4, -6);
      }
      ctx.stroke();
      ctx.restore();
    };
    const drawMarker = (dir: Vec3, color: string, glyph: string) => {
      const marker = projectSphereDirection(dir);
      const px = cx + marker.x * (R - 15);
      const py = cy + marker.y * (R - 15);
      ctx.globalAlpha = marker.behind ? 0.35 : 1;
      ctx.fillStyle = color;
      ctx.font = '700 15px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(glyph, px, py + 5);
      ctx.globalAlpha = 1;
    };
    const body = game.bodyOf(gv);
    const alt = v.pos.length() - body.radius;
    const surfaceMode = alt < (body.def.atmosphere?.height ?? Math.max(10_000, body.radius * 0.08));
    const velRef = new Vec3().copy(v.vel);
    if (surfaceMode) velRef.sub(surfaceVelocity(body, v.pos, new Vec3()));
    if (velRef.lengthSq() > 1) {
      const pro = velRef.normalize();
      drawDirectionMarker(pro, '#c8e86b', 'prograde');
      drawDirectionMarker(new Vec3().copy(pro).negate(), '#e8a06b', 'retrograde');
    }
    const radial = v.pos.clone().normalize();
    const normal = Vec3.cross(v.pos, v.vel, new Vec3()).normalize();
    drawMarker(radial, '#e8c76b', 'R+');
    drawMarker(radial.clone().negate(), '#d79253', 'R−');
    if (normal.lengthSq() > 0) {
      drawMarker(normal, '#b98ce8', 'N+');
      drawMarker(normal.clone().negate(), '#8f70c2', 'N−');
    }
    if (node && plannedBurnDirection) {
      drawMarker(new Vec3().copy(plannedBurnDirection), '#6bd0e8', '✦');
      const burnDuration = this.estimateNodeBurn(game, remainingDv || nodeDeltaV(node));
      const eta = node.time - game.time;
      const progress = burnDuration > 0 ? Math.max(0, Math.min(1, 1 - (eta - burnDuration / 2) / Math.max(1, burnDuration))) : 0;
      ctx.strokeStyle = eta <= burnDuration / 2 ? '#e2b13c' : '#6bd0e8';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(cx, cy, R - 7, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.stroke();
    }
    if (gv.target) {
      const targetBody = game.universe.get(gv.target);
      const targetDirection = new Vec3();
      game.universe.relativePosition(targetBody, game.bodyOf(gv), game.time, targetDirection);
      targetDirection.sub(v.pos);
      if (targetDirection.lengthSq() > 1) drawMarker(targetDirection.normalize(), '#ef7dc2', 'T');
    }
    ctx.restore();

    // Machined bezel rings and bank-angle references.
    ctx.strokeStyle = '#0b151c';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.arc(cx, cy, R + 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#587181';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, R + 1, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = '#8ca0ab';
    ctx.lineCap = 'butt';
    for (let deg = -60; deg <= 60; deg += 15) {
      const angle = ((deg - 90) * Math.PI) / 180;
      const outer = R - 1;
      const inner = outer - (deg % 30 === 0 ? 9 : 5);
      ctx.lineWidth = deg === 0 ? 1.8 : 1;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
      ctx.stroke();
    }

    // The left-bezel throttle is both the only visual indicator and the hit target
    // for the transparent range input layered over this arc.
    const throttleStart = (130 * Math.PI) / 180;
    const throttleEnd = (230 * Math.PI) / 180;
    const throttleRadius = R + 6;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(9, 18, 24, 0.92)';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(cx, cy, throttleRadius, throttleStart, throttleEnd);
    ctx.stroke();
    ctx.strokeStyle = '#526c7b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, throttleRadius, throttleStart, throttleEnd);
    ctx.stroke();
    if (v.controls.throttle > 0.002) {
      ctx.strokeStyle = '#e2b13c';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(
        cx,
        cy,
        throttleRadius,
        throttleStart,
        throttleStart + (throttleEnd - throttleStart) * v.controls.throttle,
      );
      ctx.stroke();
    }
    const throttleAngle = throttleStart + (throttleEnd - throttleStart) * v.controls.throttle;
    const throttleKnobX = cx + Math.cos(throttleAngle) * throttleRadius;
    const throttleKnobY = cy + Math.sin(throttleAngle) * throttleRadius;
    ctx.fillStyle = '#f0c454';
    ctx.strokeStyle = '#2a220f';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(throttleKnobX, throttleKnobY, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = '#78909e';
    ctx.lineCap = 'butt';
    for (let step = 0; step <= 4; step++) {
      const angle = throttleStart + ((throttleEnd - throttleStart) * step) / 4;
      const inner = throttleRadius - 5;
      const outer = throttleRadius + 4;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
      ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
      ctx.stroke();
    }
    ctx.font = '7px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#78909e';
    ctx.fillText('THR', cx - R + 24, cy + 54);
    ctx.font = '700 9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = '#e5edf0';
    ctx.fillText(`${(v.controls.throttle * 100).toFixed(0)}%`, cx - R + 24, cy + 65);

    // Center reticle.
    ctx.strokeStyle = 'rgba(5, 8, 10, 0.72)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(cx - 21, cy);
    ctx.lineTo(cx - 7, cy);
    ctx.lineTo(cx, cy + 6);
    ctx.lineTo(cx + 7, cy);
    ctx.lineTo(cx + 21, cy);
    ctx.stroke();
    ctx.strokeStyle = '#ffd65a';
    ctx.lineWidth = 2.2;
    ctx.stroke();

    // Fixed roll/level cue above the reticle.
    ctx.strokeStyle = 'rgba(5, 8, 10, 0.72)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(cx - 13, cy - 28);
    ctx.lineTo(cx, cy - 35);
    ctx.lineTo(cx + 13, cy - 28);
    ctx.stroke();
    ctx.strokeStyle = '#ffd65a';
    ctx.lineWidth = 2;
    ctx.stroke();

    // One compact digital strip keeps heading, pitch, and roll together.
    const stripWidth = 96;
    const stripY = cy + R - 32;
    ctx.fillStyle = 'rgba(5, 12, 17, 0.88)';
    ctx.beginPath();
    ctx.roundRect(cx - stripWidth / 2, stripY, stripWidth, 20, 4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(83,109,124,.7)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = '6px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#75909f';
    ctx.textAlign = 'center';
    ctx.fillText('HDG', cx - 32, stripY + 6);
    ctx.fillText('PITCH', cx, stripY + 6);
    ctx.fillText('ROLL', cx + 32, stripY + 6);
    ctx.font = '700 8px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = '#d8e2ea';
    ctx.fillText(`${headingDeg.toFixed(0).padStart(3, '0')}°`, cx - 32, stripY + 14.5);
    ctx.fillText(`${pitchDeg >= 0 ? '+' : ''}${pitchDeg.toFixed(0)}°`, cx, stripY + 14.5);
    ctx.fillText(`${rollDeg >= 0 ? '+' : ''}${rollDeg.toFixed(0)}°`, cx + 32, stripY + 14.5);
  }
}
