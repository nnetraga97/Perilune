/**
 * Flight HUD: navball, velocity/altitude readouts, throttle, SAS modes,
 * staging list, resources, warp controls, and the event feed.
 *
 * All elements are plain DOM updated by direct mutation each frame —
 * no framework re-rendering (ADR: UI layer).
 */
import { Vec3 } from '../core/vec3';
import { GameState, PHYSICS_WARP_RATES, RAILS_WARP_RATES } from '../sim/state';
import { G0, defOf, analyzeCraft } from '../sim/vessel';
import { oreConcentration, oreCapacityOf } from '../sim/resources';
import type { SasMode } from '../sim/flight';
import type { CommsStatus } from '../sim/comms';
import { estimateBurnTime, nodeBurnDirection, nodeDeltaV, type ManeuverNode } from '../sim/maneuver';
import { stateToElements, periapsisOf, apoapsisOf, timeToTrueAnomaly } from '../core/orbit';
import { navHeading, projectNavDirection } from './navball';
import { inertialToBodyFixed, surfaceVelocity } from '../sim/bodyOrientation';
import { el, injectUiStyles } from './kit';
import type { EntryPrediction } from '../sim/entry';

export interface HudCallbacks {
  onStage(): void;
  onToggleMap(): void;
  onQuickSave(): void;
  onQuickLoad(): void;
  onRevert(): void;
  onRunScience(): void;
  onRecover(): void;
  onSetSas(mode: SasMode): void;
  onSetWarp(index: number, rails: boolean): void;
  onExitToEditor(): void;
  /** Toggle an ISRU system part (drill/converter) on the active vessel. */
  onToggleSystem(partKey: number): void;
  /** Run an orbital resource survey. */
  onSurvey(): void;
}

export interface HudTelemetry {
  nodeRemainingDv: number;
  cameraMode: string;
  precision: boolean;
  entryPrediction: EntryPrediction | null;
  landingTargetDirBF: Vec3 | null;
}

const SAS_MODES: Array<{ mode: SasMode; label: string; title: string }> = [
  { mode: 'stability', label: '◎', title: 'Stability assist' },
  { mode: 'prograde', label: '⬆', title: 'Prograde' },
  { mode: 'retrograde', label: '⬇', title: 'Retrograde' },
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
  private utEl: HTMLElement;
  private nextAlarmEl: HTMLElement;
  private warpEl: HTMLElement;
  private throttleFill: HTMLElement;
  private gFill: HTMLElement;
  private qFill: HTMLElement;
  private atmosphereFill: HTMLElement;
  private gText: HTMLElement;
  private qText: HTMLElement;
  private atmosphereText: HTMLElement;
  private crewEl: HTMLElement;
  private cameraModeEl: HTMLElement;
  private precisionEl: HTMLElement;
  private actionGroupEl: HTMLElement;
  private entryCard: HTMLElement;
  private gaugeFills = new Map<string, HTMLElement>();
  private gaugeTexts = new Map<string, HTMLElement>();
  private stageListEl: HTMLElement;
  private eventFeed: HTMLElement;
  private sasButtons = new Map<SasMode, HTMLElement>();
  private cb: HudCallbacks;
  private lastEventCount = 0;
  private recoverBtn: HTMLElement;
  private scienceBtn: HTMLElement;
  private nodeInfoEl: HTMLElement;
  private lastStageRender = '';
  private missionStart = 0;
  private oreRow!: HTMLElement;
  private sysPanel!: HTMLElement;
  private lastSysRender = '';
  private oreHereEl: HTMLElement | null = null;
  private peakQ = 0;
  private peakQVesselId: string | null = null;
  private partPopup: HTMLElement | null = null;

  constructor(uiRoot: HTMLElement, cb: HudCallbacks) {
    this.cb = cb;
    this.root = el('div', 'hud', uiRoot);
    this.root.style.pointerEvents = 'none'; // beat #ui-root > * specificity
    this.root.innerHTML = '';
    injectUiStyles();
    this.utilityHost = el('div', 'hud-utility-host', this.root);

    // ---- top bar: MET, situation, warp
    const top = el('div', 'hud-top', this.root);
    this.utEl = el('div', 'hud-ut', top, 'UT 0s');
    this.metEl = el('div', 'hud-met', top, 'T+ 0s');
    this.situationEl = el('div', 'hud-situation', top, 'PRELAUNCH');
    this.crewEl = el('div', 'hud-crew', top, 'CREW —');
    this.warpEl = el('div', 'hud-warp', top);
    this.nextAlarmEl = el('div', 'hud-next-alarm', top, 'ALM —');
    const warpBtns = el('div', 'hud-warp-btns', top);
    const slower = el('button', 'hud-btn', warpBtns, '◀◀');
    slower.title = 'Warp slower (,)';
    slower.onclick = () => this.warpStep(-1);
    const faster = el('button', 'hud-btn', warpBtns, '▶▶');
    faster.title = 'Warp faster (.)';
    faster.onclick = () => this.warpStep(1);

    // ---- top-right: system buttons
    const sys = el('div', 'hud-sys', this.root);
    const mk = (label: string, title: string, fn: () => void) => {
      const b = el('button', 'hud-btn', sys, label);
      b.title = title;
      b.onclick = fn;
      return b;
    };
    mk('Map', 'Toggle map view (M)', cb.onToggleMap);
    mk('QS', 'Quicksave (F5)', cb.onQuickSave);
    mk('QL', 'Quickload (F9)', cb.onQuickLoad);
    mk('Revert', 'Revert to launch', cb.onRevert);
    mk('Editor', 'Back to the workshop', cb.onExitToEditor);
    this.scienceBtn = mk('Science', 'Run experiments here', cb.onRunScience);
    this.scienceBtn.dataset.action = 'science';
    this.recoverBtn = mk('Recover', 'Recover vessel (ends flight)', cb.onRecover);
    this.recoverBtn.classList.add('hud-recover');

    // ---- left cluster: navball + throttle + SAS
    const left = el('div', 'hud-left', this.root);
    const sasCol = el('div', 'hud-sas', left);
    for (const { mode, label, title } of SAS_MODES) {
      const b = el('button', 'hud-btn hud-sas-btn', sasCol, label);
      b.title = title;
      b.onclick = () => cb.onSetSas(mode);
      this.sasButtons.set(mode, b);
    }
    const navWrap = el('div', 'hud-navwrap', left);
    this.navCanvas = document.createElement('canvas');
    this.navCanvas.width = 260;
    this.navCanvas.height = 260;
    this.navCanvas.className = 'hud-navball';
    navWrap.appendChild(this.navCanvas);
    this.navCtx = this.navCanvas.getContext('2d')!;
    const thrWrap = el('div', 'hud-throttle', left);
    el('div', 'hud-throttle-label', thrWrap, 'THR');
    const thrTrack = el('div', 'hud-throttle-track', thrWrap);
    this.throttleFill = el('div', 'hud-throttle-fill', thrTrack);

    const status = el('div', 'hud-status-strip', left);
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
    this.cameraModeEl = el('div', 'hud-mode-badge', status, 'CAM ORBIT');
    this.precisionEl = el('div', 'hud-mode-badge precision', status, 'PRECISION');
    this.precisionEl.style.display = 'none';
    this.actionGroupEl = el('div', 'hud-action-group', status, '');
    this.actionGroupEl.style.display = 'none';

    // ---- speed/alt readouts above navball
    const readouts = el('div', 'hud-readouts', left);
    const spdBox = el('div', 'hud-readout', readouts);
    this.speedModeEl = el('div', 'hud-readout-label', spdBox, 'SURFACE');
    this.speedEl = el('div', 'hud-readout-value', spdBox, '0 m/s');
    const altBox = el('div', 'hud-readout', readouts);
    el('div', 'hud-readout-label', altBox, 'ALTITUDE');
    this.altEl = el('div', 'hud-readout-value', altBox, '0 m');
    const vsBox = el('div', 'hud-readout', readouts);
    el('div', 'hud-readout-label', vsBox, 'V/S');
    this.vsEl = el('div', 'hud-readout-value', vsBox, '0');

    // ---- right: orbit info + resources + staging
    const right = el('div', 'hud-right', this.root);
    const orbitBox = el('div', 'hud-panel', right);
    const apRow = el('div', 'hud-row', orbitBox);
    el('span', 'hud-key hud-key-ap', apRow, 'Ap');
    this.apEl = el('span', 'hud-val', apRow, '—');
    this.apTimeEl = el('span', 'hud-eta', apRow, '');
    const peRow = el('div', 'hud-row', orbitBox);
    el('span', 'hud-key hud-key-pe', peRow, 'Pe');
    this.peEl = el('span', 'hud-val', peRow, '—');
    this.peTimeEl = el('span', 'hud-eta', peRow, '');
    this.nodeInfoEl = el('div', 'hud-node-info', orbitBox);

    this.entryCard = el('div', 'hud-panel hud-entry-card', right);
    this.entryCard.style.display = 'none';

    const resBox = el('div', 'hud-panel', right);
    for (const res of ['propellant', 'monoprop', 'charge', 'ore'] as const) {
      const row = el('div', 'hud-gauge', resBox);
      el(
        'span',
        'hud-key',
        row,
        res === 'propellant' ? 'FUEL' : res === 'monoprop' ? 'MONO' : res === 'charge' ? 'CHG' : 'ORE',
      );
      const track = el('div', 'hud-gauge-track', row);
      this.gaugeFills.set(res, el('div', 'hud-gauge-fill', track));
      this.gaugeTexts.set(res, el('span', 'hud-gauge-text', row, ''));
      if (res === 'ore') this.oreRow = row;
    }

    // ---- ISRU systems panel (drills/converters/survey), shown when present
    this.sysPanel = el('div', 'hud-panel hud-systems', right);
    this.sysPanel.style.display = 'none';

    const stagePanel = el('div', 'hud-panel hud-stages', right);
    const stageBtn = el('button', 'hud-btn hud-stage-btn', stagePanel, 'STAGE (Space)');
    stageBtn.onclick = cb.onStage;
    this.stageListEl = el('div', 'hud-stage-list', stagePanel);

    // ---- event feed
    this.eventFeed = el('div', 'hud-events', this.root);

    // ---- comms indicator (top bar)
    this.commsEl = el('div', 'hud-comms', top, '⇅ —');
  }

  private commsEl!: HTMLElement;

  setComms(status: CommsStatus, blocked: boolean): void {
    if (blocked) {
      this.commsEl.textContent = '⇅ NO SIGNAL';
      this.commsEl.style.color = 'var(--ui-danger)';
      this.commsEl.title = 'Probe control requires a comms link';
    } else if (status.connected) {
      this.commsEl.textContent = `⇅ ${(status.strength * 100).toFixed(0)}%`;
      this.commsEl.style.color = 'var(--ui-good)';
      this.commsEl.title = status.path.join(' → ');
    } else {
      this.commsEl.textContent = '⇅ local';
      this.commsEl.style.color = '#7d8b96';
      this.commsEl.title = 'Crewed vessel: no link needed';
    }
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
    const v = gv.runtime;
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

    this.metEl.textContent = `T+ ${fmtTime(game.time - this.missionStart)}`;
    this.utEl.textContent = `UT ${fmtTime(game.time)}`;
    const nextAlarm = game.alarms[0];
    this.nextAlarmEl.textContent = nextAlarm ? `ALM T−${fmtTime(nextAlarm.time - game.time)}` : 'ALM —';
    this.nextAlarmEl.title = nextAlarm?.label ?? 'No scheduled alarms';
    this.situationEl.textContent = v.situation.toUpperCase();
    this.warpEl.textContent = `${game.warpRate}×`;
    this.crewEl.textContent = v.crew.length ? `CREW ${v.crew.length} · ${v.crew.join(', ')}` : 'CREW —';
    this.crewEl.title = v.crew.length ? v.crew.join(', ') : 'Uncrewed vessel';
    this.cameraModeEl.textContent = `CAM ${telemetry.cameraMode.toUpperCase()}`;
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
    if (node) {
      const eta = node.time - game.time;
      const burnDuration = this.estimateNodeBurn(game, telemetry.nodeRemainingDv || nodeDeltaV(node));
      const burnStartEta = eta - burnDuration / 2;
      const cue = burnStartEta <= 0 && eta > -burnDuration / 2 ? 'START BURN' : `burn T−${fmtTime(burnStartEta)}`;
      this.nodeInfoEl.textContent = `NODE  ${telemetry.nodeRemainingDv.toFixed(1)} m/s REM\n${cue} · ${burnDuration.toFixed(1)} s`;
    } else {
      this.nodeInfoEl.textContent = '';
    }
    this.updateEntryCard(body.radius, game.time, telemetry.entryPrediction, telemetry.landingTargetDirBF);

    // Throttle + gauges.
    this.throttleFill.style.height = `${(v.controls.throttle * 100).toFixed(0)}%`;
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
    this.oreRow.style.display = oreMax > 0 ? '' : 'none';
    if (oreMax > 0) this.setGauge('ore', ore, oreMax);

    this.updateSystems(game);

    // SAS highlight.
    for (const [mode, btn] of this.sasButtons) {
      btn.classList.toggle('active', v.sas === mode);
    }

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
    const landedHome =
      (v.situation === 'landed' || v.situation === 'splashed' || v.situation === 'prelaunch') &&
      v.bodyId === 'veyra';
    this.recoverBtn.style.display = landedHome ? '' : 'none';

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

    this.drawNavball(game, node, telemetry.nodeRemainingDv);
  }

  showActionGroup(group: number, executed: number): void {
    this.actionGroupEl.textContent = `AG ${group === 10 ? 0 : group} · ${executed || 'NO'} ACTION${executed === 1 ? '' : 'S'}`;
    this.actionGroupEl.style.display = '';
    window.setTimeout(() => {
      this.actionGroupEl.style.display = 'none';
    }, 1400);
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

  private setGauge(key: string, value: number, max: number): void {
    const fill = this.gaugeFills.get(key);
    const text = this.gaugeTexts.get(key);
    if (!fill || !text) return;
    const frac = max > 0 ? value / max : 0;
    fill.style.width = `${(frac * 100).toFixed(1)}%`;
    fill.style.background = frac < 0.15 ? 'var(--ui-danger)' : 'var(--ui-accent)';
    text.textContent = `${value.toFixed(0)}`;
  }

  // ------------------------------------------------------------- navball
  private drawNavball(game: GameState, node: ManeuverNode | null, remainingDv: number): void {
    const gv = game.active!;
    const v = gv.runtime;
    const ctx = this.navCtx;
    const W = this.navCanvas.width;
    const R = W / 2 - 6;
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

    ctx.clearRect(0, 0, W, W);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();

    // Sky/ground split with pitch offset + roll rotation.
    ctx.translate(cx, cy);
    ctx.rotate(roll);
    const pitchPx = (pitch / (Math.PI / 2)) * R * 1.4;
    ctx.fillStyle = '#2c5f7d';
    ctx.fillRect(-W, -W * 2 + pitchPx, W * 2, W * 2); // sky
    ctx.fillStyle = '#7d5a34';
    ctx.fillRect(-W, pitchPx, W * 2, W * 2); // ground
    ctx.strokeStyle = '#e8ecef';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-R, pitchPx);
    ctx.lineTo(R, pitchPx);
    ctx.stroke();
    // Pitch ladder.
    ctx.strokeStyle = 'rgba(232,236,239,0.55)';
    ctx.fillStyle = 'rgba(232,236,239,0.8)';
    ctx.lineWidth = 1;
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    for (let deg = -80; deg <= 80; deg += 20) {
      if (deg === 0) continue;
      const y = pitchPx - (deg / 90) * R * 1.4;
      if (Math.abs(y) > R) continue;
      ctx.beginPath();
      ctx.moveTo(-26, y);
      ctx.lineTo(26, y);
      ctx.stroke();
      ctx.fillText(`${Math.abs(deg)}`, 38, y + 3);
    }
    ctx.restore();

    // Full flight marker set projected into view space.
    const drawMarker = (dir: Vec3, color: string, glyph: string) => {
      const marker = projectNavDirection(dir, nose, right, screenUp);
      const px = cx + marker.x * R * 0.92;
      const py = cy + marker.y * R * 0.92;
      ctx.globalAlpha = marker.behind ? 0.35 : 1;
      ctx.fillStyle = color;
      ctx.font = 'bold 16px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(glyph, px, py + 5);
      ctx.globalAlpha = 1;
    };
    const om = game.bodyOf(gv).def.rotationPeriod !== 0 ? (Math.PI * 2) / game.bodyOf(gv).def.rotationPeriod : 0;
    const alt = v.pos.length() - game.bodyOf(gv).radius;
    const surfaceMode = alt < (game.bodyOf(gv).def.atmosphere?.height ?? Math.max(10_000, game.bodyOf(gv).radius * 0.08));
    const velRef = new Vec3().copy(v.vel);
    if (surfaceMode && om !== 0) {
      velRef.x += om * v.pos.y;
      velRef.y -= om * v.pos.x;
    }
    if (velRef.lengthSq() > 1) {
      const pro = velRef.normalize();
      drawMarker(pro, '#c8e86b', '⊕');
      drawMarker(new Vec3().copy(pro).negate(), '#e8a06b', '⊖');
    }
    const radial = v.pos.clone().normalize();
    const normal = Vec3.cross(v.pos, v.vel, new Vec3()).normalize();
    drawMarker(radial, '#e8c76b', 'R+');
    drawMarker(radial.clone().negate(), '#d79253', 'R−');
    if (normal.lengthSq() > 0) {
      drawMarker(normal, '#b98ce8', 'N+');
      drawMarker(normal.clone().negate(), '#8f70c2', 'N−');
    }
    if (node) {
      const body = game.bodyOf(gv);
      const els = stateToElements(body.mu, v.pos, v.vel, game.time);
      const burnDir = nodeBurnDirection(els, node, new Vec3());
      drawMarker(burnDir, '#6bd0e8', '✦');
      const burnDuration = this.estimateNodeBurn(game, remainingDv || nodeDeltaV(node));
      const eta = node.time - game.time;
      const progress = burnDuration > 0 ? Math.max(0, Math.min(1, 1 - (eta - burnDuration / 2) / Math.max(1, burnDuration))) : 0;
      ctx.strokeStyle = eta <= burnDuration / 2 ? '#e2b13c' : '#6bd0e8';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(cx, cy, R - 4, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.stroke();
    }
    if (gv.target) {
      const targetBody = game.universe.get(gv.target);
      const targetDirection = new Vec3();
      game.universe.relativePosition(targetBody, game.bodyOf(gv), game.time, targetDirection);
      targetDirection.sub(v.pos);
      if (targetDirection.lengthSq() > 1) drawMarker(targetDirection.normalize(), '#ef7dc2', 'T');
    }

    // Bezel + heading.
    ctx.strokeStyle = '#3a4f61';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    // Center reticle.
    ctx.strokeStyle = '#ffd75e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 16, cy);
    ctx.lineTo(cx - 5, cy);
    ctx.lineTo(cx, cy + 5);
    ctx.lineTo(cx + 5, cy);
    ctx.lineTo(cx + 16, cy);
    ctx.stroke();
    ctx.fillStyle = '#d8e2ea';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    const headingDeg = ((heading * 180) / Math.PI + 360) % 360;
    ctx.fillStyle = 'rgba(6,12,18,0.88)';
    ctx.fillRect(cx - 58, 2, 116, 24);
    ctx.strokeStyle = '#6f8798';
    ctx.lineWidth = 1;
    for (let offset = -40; offset <= 40; offset += 10) {
      const x = cx + offset * 1.15;
      ctx.beginPath();
      ctx.moveTo(x, 18);
      ctx.lineTo(x, offset % 20 === 0 ? 23 : 21);
      ctx.stroke();
    }
    ctx.fillStyle = '#d8e2ea';
    ctx.fillText(`${headingDeg.toFixed(0).padStart(3, '0')}°`, cx, 14);
    // Fixed roll/level cue above the reticle.
    ctx.strokeStyle = '#ffd75e';
    ctx.beginPath();
    ctx.moveTo(cx - 12, cy - 25);
    ctx.lineTo(cx, cy - 31);
    ctx.lineTo(cx + 12, cy - 25);
    ctx.stroke();
  }
}
