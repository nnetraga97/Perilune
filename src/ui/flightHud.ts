/**
 * Flight HUD: navball, velocity/altitude readouts, throttle, SAS modes,
 * staging list, resources, warp controls, and the event feed.
 *
 * All elements are plain DOM updated by direct mutation each frame —
 * no framework re-rendering (ADR: UI layer).
 */
import { Vec3 } from '../core/vec3';
import { GameState, PHYSICS_WARP_RATES, RAILS_WARP_RATES } from '../sim/state';
import { defOf, analyzeCraft } from '../sim/vessel';
import type { SasMode } from '../sim/flight';
import { nodeBurnDirection, nodeDeltaV, type ManeuverNode } from '../sim/maneuver';
import { stateToElements, periapsisOf, apoapsisOf, periodOf } from '../core/orbit';

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

function el(tag: string, cls: string, parent: HTMLElement, text = ''): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}

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
  private warpEl: HTMLElement;
  private throttleFill: HTMLElement;
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

  constructor(uiRoot: HTMLElement, cb: HudCallbacks) {
    this.cb = cb;
    this.root = el('div', 'hud', uiRoot);
    this.root.style.pointerEvents = 'none'; // beat #ui-root > * specificity
    this.root.innerHTML = '';
    this.injectStyles();

    // ---- top bar: MET, situation, warp
    const top = el('div', 'hud-top', this.root);
    this.metEl = el('div', 'hud-met', top, 'T+ 0s');
    this.situationEl = el('div', 'hud-situation', top, 'PRELAUNCH');
    this.warpEl = el('div', 'hud-warp', top);
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
    this.navCanvas.width = 220;
    this.navCanvas.height = 220;
    this.navCanvas.className = 'hud-navball';
    navWrap.appendChild(this.navCanvas);
    this.navCtx = this.navCanvas.getContext('2d')!;
    const thrWrap = el('div', 'hud-throttle', left);
    el('div', 'hud-throttle-label', thrWrap, 'THR');
    const thrTrack = el('div', 'hud-throttle-track', thrWrap);
    this.throttleFill = el('div', 'hud-throttle-fill', thrTrack);

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
    el('span', 'hud-key', apRow, 'Ap');
    this.apEl = el('span', 'hud-val', apRow, '—');
    this.apTimeEl = el('span', 'hud-eta', apRow, '');
    const peRow = el('div', 'hud-row', orbitBox);
    el('span', 'hud-key', peRow, 'Pe');
    this.peEl = el('span', 'hud-val', peRow, '—');
    this.peTimeEl = el('span', 'hud-eta', peRow, '');
    this.nodeInfoEl = el('div', 'hud-node-info', orbitBox);

    const resBox = el('div', 'hud-panel', right);
    for (const res of ['propellant', 'monoprop', 'charge'] as const) {
      const row = el('div', 'hud-gauge', resBox);
      el('span', 'hud-key', row, res === 'propellant' ? 'FUEL' : res === 'monoprop' ? 'MONO' : 'CHG');
      const track = el('div', 'hud-gauge-track', row);
      this.gaugeFills.set(res, el('div', 'hud-gauge-fill', track));
      this.gaugeTexts.set(res, el('span', 'hud-gauge-text', row, ''));
    }

    const stagePanel = el('div', 'hud-panel hud-stages', right);
    const stageBtn = el('button', 'hud-btn hud-stage-btn', stagePanel, 'STAGE (Space)');
    stageBtn.onclick = cb.onStage;
    this.stageListEl = el('div', 'hud-stage-list', stagePanel);

    // ---- event feed
    this.eventFeed = el('div', 'hud-events', this.root);
  }

  private warpStep(dir: number): void {
    this.pendingWarpStep = dir;
  }
  pendingWarpStep = 0;

  private injectStyles(): void {
    if (document.getElementById('hud-style')) return;
    const style = document.createElement('style');
    style.id = 'hud-style';
    style.textContent = `
      .hud { position: absolute; inset: 0; pointer-events: none; font-family: var(--ui-font); }
      .hud button { pointer-events: auto; }
      .hud-btn {
        background: var(--ui-bg); color: var(--ui-fg); border: 1px solid #2a3d4d;
        border-radius: 5px; padding: 4px 10px; font-size: 12px; cursor: pointer;
      }
      .hud-btn:hover { border-color: var(--ui-accent); color: #fff; }
      .hud-top { position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
        display: flex; gap: 14px; align-items: center; background: var(--ui-bg);
        border: 1px solid #223240; border-radius: 8px; padding: 6px 16px; pointer-events: auto; }
      .hud-met { font-family: var(--ui-mono); font-size: 14px; color: var(--ui-accent); min-width: 90px; }
      .hud-situation { font-size: 12px; letter-spacing: 2px; color: #9fb4c4; min-width: 90px; text-align: center; }
      .hud-warp { font-family: var(--ui-mono); font-size: 13px; color: var(--ui-warn); min-width: 60px; text-align: right; }
      .hud-warp-btns { display: flex; gap: 4px; }
      .hud-sys { position: absolute; top: 10px; right: 12px; display: flex; gap: 6px; }
      .hud-recover { border-color: var(--ui-good); }
      .hud-left { position: absolute; left: 50%; transform: translateX(-50%); bottom: 12px;
        display: flex; align-items: flex-end; gap: 10px; pointer-events: auto; }
      .hud-navwrap { position: relative; }
      .hud-navball { display: block; }
      .hud-sas { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; align-content: end; }
      .hud-sas-btn { width: 34px; height: 30px; padding: 2px; font-size: 14px; }
      .hud-sas-btn.active { border-color: var(--ui-accent); background: #16303f; color: #fff; }
      .hud-throttle { display: flex; flex-direction: column; align-items: center; gap: 4px; }
      .hud-throttle-label { font-size: 10px; color: #9fb4c4; }
      .hud-throttle-track { width: 14px; height: 150px; background: #101c26; border: 1px solid #2a3d4d;
        border-radius: 4px; position: relative; overflow: hidden; }
      .hud-throttle-fill { position: absolute; bottom: 0; left: 0; right: 0; background: var(--ui-warn); height: 0%; }
      .hud-readouts { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
      .hud-readout { background: var(--ui-bg); border: 1px solid #223240; border-radius: 6px; padding: 4px 10px; min-width: 110px; }
      .hud-readout-label { font-size: 9px; letter-spacing: 1.5px; color: #7d8b96; }
      .hud-readout-value { font-family: var(--ui-mono); font-size: 15px; }
      .hud-right { position: absolute; right: 12px; top: 56px; display: flex; flex-direction: column; gap: 8px;
        width: 230px; pointer-events: auto; }
      .hud-panel { background: var(--ui-bg); border: 1px solid #223240; border-radius: 8px; padding: 8px 10px; }
      .hud-row { display: flex; align-items: baseline; gap: 8px; font-size: 13px; padding: 1px 0; }
      .hud-key { color: #7d8b96; font-size: 11px; min-width: 34px; }
      .hud-val { font-family: var(--ui-mono); }
      .hud-eta { margin-left: auto; color: #7d8b96; font-size: 11px; font-family: var(--ui-mono); }
      .hud-node-info { font-family: var(--ui-mono); font-size: 12px; color: var(--ui-accent); margin-top: 4px; white-space: pre-line; }
      .hud-gauge { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
      .hud-gauge-track { flex: 1; height: 8px; background: #101c26; border-radius: 4px; overflow: hidden; }
      .hud-gauge-fill { height: 100%; width: 0%; background: var(--ui-accent); }
      .hud-gauge-text { font-family: var(--ui-mono); font-size: 10px; color: #9fb4c4; min-width: 50px; text-align: right; }
      .hud-stages { max-height: 40vh; overflow-y: auto; }
      .hud-stage-btn { width: 100%; margin-bottom: 6px; border-color: var(--ui-warn); }
      .hud-stage-list { display: flex; flex-direction: column-reverse; gap: 4px; }
      .hud-stage { border: 1px solid #223240; border-radius: 5px; padding: 3px 8px; font-size: 11px; }
      .hud-stage.next { border-color: var(--ui-warn); }
      .hud-stage.spent { opacity: 0.35; }
      .hud-stage-title { color: #9fb4c4; font-size: 10px; letter-spacing: 1px; }
      .hud-events { position: absolute; left: 12px; top: 56px; display: flex; flex-direction: column; gap: 4px; max-width: 320px; }
      .hud-event { background: var(--ui-bg); border-left: 3px solid var(--ui-accent); border-radius: 4px;
        padding: 5px 10px; font-size: 12px; animation: hudfade 6s forwards; }
      .hud-event.warning { border-left-color: var(--ui-warn); }
      .hud-event.danger { border-left-color: var(--ui-danger); }
      @keyframes hudfade { 0% { opacity: 0; } 5% { opacity: 1; } 80% { opacity: 1; } 100% { opacity: 0; } }
    `;
    document.head.appendChild(style);
  }

  setMissionStart(t: number): void {
    this.missionStart = t;
  }

  /** Per-frame update; all DOM mutation is direct and cheap. */
  update(game: GameState, node: ManeuverNode | null): void {
    const gv = game.active;
    if (!gv) return;
    const v = gv.runtime;
    const body = game.bodyOf(gv);
    const r = v.pos.length();
    const alt = r - body.radius;

    // Speed: surface-relative in atmosphere / near ground, orbital above.
    const om = body.def.rotationPeriod !== 0 ? (Math.PI * 2) / body.def.rotationPeriod : 0;
    const surfSpeed = Math.hypot(v.vel.x + om * v.pos.y, v.vel.y - om * v.pos.x, v.vel.z);
    const orbSpeed = v.vel.length();
    const surfaceMode =
      alt < (body.def.atmosphere?.height ?? Math.max(10_000, body.radius * 0.08));
    this.speedModeEl.textContent = surfaceMode ? 'SURFACE' : 'ORBIT';
    this.speedEl.textContent = `${(surfaceMode ? surfSpeed : orbSpeed).toFixed(surfaceMode && surfSpeed < 100 ? 1 : 0)} m/s`;
    this.altEl.textContent = fmtDistance(alt);
    const vs = v.vel.dot(new Vec3().copy(v.pos).normalize());
    this.vsEl.textContent = `${vs > 0 ? '+' : ''}${vs.toFixed(1)} m/s`;

    this.metEl.textContent = `T+ ${fmtTime(game.time - this.missionStart)}`;
    this.situationEl.textContent = v.situation.toUpperCase();
    this.warpEl.textContent = `${game.warpRate}×`;

    // Orbit readouts.
    const el0 = stateToElements(body.mu, v.pos, v.vel, game.time);
    if (el0.e < 1) {
      const ap = apoapsisOf(el0) - body.radius;
      this.apEl.textContent = fmtDistance(ap);
      const T = periodOf(el0);
      this.apTimeEl.textContent = '';
      this.peTimeEl.textContent = '';
    } else {
      this.apEl.textContent = '(escape)';
    }
    const pe = periapsisOf(el0) - body.radius;
    this.peEl.textContent = fmtDistance(pe);

    // Node info.
    if (node) {
      const eta = node.time - game.time;
      this.nodeInfoEl.textContent = `node Δv ${nodeDeltaV(node).toFixed(1)} m/s\nT−${fmtTime(eta)}`;
    } else {
      this.nodeInfoEl.textContent = '';
    }

    // Throttle + gauges.
    this.throttleFill.style.height = `${(v.controls.throttle * 100).toFixed(0)}%`;
    let fuel = 0,
      fuelMax = 0,
      mono = 0,
      monoMax = 0;
    for (const p of v.craft.parts) {
      fuel += p.resources.propellant ?? 0;
      mono += p.resources.monoprop ?? 0;
      const d = defOf(p);
      fuelMax += d.resources?.propellant ?? 0;
      monoMax += d.resources?.monoprop ?? 0;
    }
    this.setGauge('propellant', fuel, fuelMax);
    this.setGauge('monoprop', mono, monoMax);
    this.setGauge('charge', v.charge.amount, v.charge.capacity);

    // SAS highlight.
    for (const [mode, btn] of this.sasButtons) {
      btn.classList.toggle('active', v.sas === mode);
    }

    // Staging list (re-render only when it changes).
    const stageSig = `${v.currentStage}:${v.craft.stages.map((s) => s.partKeys.join('.')).join('|')}`;
    if (stageSig !== this.lastStageRender) {
      this.lastStageRender = stageSig;
      this.stageListEl.innerHTML = '';
      v.craft.stages.forEach((stage, i) => {
        const div = document.createElement('div');
        div.className = `hud-stage ${i < v.currentStage ? 'spent' : i === v.currentStage ? 'next' : ''}`;
        const names = stage.partKeys
          .map((k) => v.craft.parts.find((p) => p.key === k))
          .filter(Boolean)
          .map((p) => defOf(p!).name);
        div.innerHTML = `<div class="hud-stage-title">STAGE ${i}</div>${names.join(', ') || '(empty)'}`;
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

    this.drawNavball(game, node);
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
  private drawNavball(game: GameState, node: ManeuverNode | null): void {
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

    const pitch = Math.asin(Math.max(-1, Math.min(1, nose.dot(up))));
    const noseFlat = new Vec3().copy(nose).addScaled(up, -nose.dot(up));
    let heading = 0;
    if (noseFlat.lengthSq() > 1e-10) {
      noseFlat.normalize();
      heading = Math.atan2(noseFlat.dot(east), noseFlat.dot(north));
      if (heading < 0) heading += Math.PI * 2;
    }
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

    // Markers: prograde/retrograde/node projected into view space.
    const drawMarker = (dir: Vec3, color: string, glyph: string) => {
      const f = dir.dot(nose);
      const x = dir.dot(right);
      const yUp = dir.dot(v.att.rotate(new Vec3(0, 0, 1), new Vec3()));
      // Project: angular offset from nose (clamped to ball edge).
      const ang = Math.acos(Math.max(-1, Math.min(1, f)));
      const edge = Math.min(1, ang / (Math.PI / 2));
      const norm = Math.hypot(x, yUp) || 1;
      const px = cx + (x / norm) * edge * R * 0.92;
      const py = cy + (yUp / norm) * edge * R * 0.92;
      ctx.globalAlpha = f > 0 ? 1 : 0.35;
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
    if (node) {
      const body = game.bodyOf(gv);
      const els = stateToElements(body.mu, v.pos, v.vel, game.time);
      const burnDir = nodeBurnDirection(els, node, new Vec3());
      drawMarker(burnDir, '#6bd0e8', '✦');
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
    ctx.fillText(`${((heading * 180) / Math.PI).toFixed(0).padStart(3, '0')}°`, cx, 14);
  }
}
