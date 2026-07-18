import type { GameAlarm, GameState, AlarmKind } from '../sim/state';
import { allTransferPlans, type TransferPlan } from '../sim/transfer';
import { el } from './kit';
import type { WindowManager } from './window';
import { defOf } from '../sim/vessel';
import { isRecoverable } from '../sim/science';
import { periapsisOf, stateToElements } from '../core/orbit';

export interface MissionToolCallbacks {
  onSwitchVessel(vesselId: string): void;
  onSketchNode(plan: TransferPlan): void;
  onSetTarget(bodyId: string | null): void;
  onOrbitTarget(bodyId: string): void;
  onFocusBody(bodyId: string): void;
  onRenameVessel(vesselId: string, name: string): void;
  onTerminateVessel(vesselId: string): void;
  onRecoverVessel(vesselId: string): void;
}

function duration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—';
  const sign = seconds < 0 ? '−' : '';
  seconds = Math.abs(seconds);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (days) return `${sign}${days}d ${hours}h`;
  if (hours) return `${sign}${hours}h ${minutes}m`;
  if (minutes) return `${sign}${minutes}m ${secs}s`;
  return `${sign}${secs}s`;
}

const KIND_ICON: Record<AlarmKind, string> = {
  custom: '◇',
  transfer: '↗',
  maneuver: '✦',
  entry: '▽',
};

/** Alarm and transfer windows sharing the same authoritative game state. */
export class MissionTools {
  private alarmList: HTMLElement | null = null;
  private alarmLabel: HTMLInputElement | null = null;
  private alarmEta: HTMLInputElement | null = null;
  private alarmKind: HTMLSelectElement | null = null;
  private alarmEditId: string | null = null;
  private alarmSignature = '';
  private transferList: HTMLElement | null = null;
  private transferSort: HTMLSelectElement | null = null;
  private transferSignature = '';
  private banner: HTMLElement | null = null;
  private fleetList: HTMLElement | null = null;
  private bodyList: HTMLElement | null = null;
  private showDebris = false;
  private fleetSignature = '';

  constructor(
    private readonly windows: WindowManager,
    private readonly game: () => GameState,
    private readonly callbacks: MissionToolCallbacks,
    private readonly uiRoot: HTMLElement,
  ) {
    windows.register({
      id: 'alarms',
      title: 'MISSION ALARMS',
      launcherIcon: 'alarm',
      buttonLabel: 'Alarms',
      screen: 'flight',
      defaultPos: { x: 280, y: 92 },
      build: (content) => this.buildAlarms(content),
      update: () => this.updateAlarms(),
    });
    windows.register({
      id: 'transfers',
      title: 'TRANSFER PLANNER',
      launcherIcon: 'transfer',
      buttonLabel: 'Transfers',
      screen: 'flight',
      defaultPos: { x: 520, y: 92 },
      build: (content) => this.buildTransfers(content),
      update: () => this.updateTransfers(),
    });
    windows.register({
      id: 'fleet',
      title: 'FLEET & TARGETS',
      launcherIcon: 'fleet',
      buttonLabel: 'Fleet',
      screen: 'flight',
      defaultPos: { x: window.innerWidth - 350, y: 92 },
      build: (content) => this.buildFleet(content),
      update: () => this.updateFleet(),
    });
  }

  addAlarm(time: number, label: string, kind: AlarmKind, vesselId?: string | null): GameAlarm | null {
    const game = this.game();
    try {
      const alarm = game.addAlarm(time, label, kind, vesselId ?? game.activeVesselId);
      this.alarmSignature = '';
      return alarm;
    } catch {
      return null;
    }
  }

  showFiredAlarm(alarm: GameAlarm): void {
    this.banner?.remove();
    const banner = el('div', 'mission-alarm-banner', this.uiRoot);
    this.banner = banner;
    el('div', 'mission-alarm-icon', banner, KIND_ICON[alarm.kind]);
    const copy = el('div', 'mission-alarm-copy', banner);
    el('strong', '', copy, 'WARP STOPPED');
    el('span', '', copy, alarm.label);
    const actions = el('div', 'mission-alarm-actions', banner);
    if (alarm.vesselId && this.game().vessels.some((vessel) => vessel.runtime.id === alarm.vesselId)) {
      const jump = el('button', 'hud-btn', actions, 'Jump to vessel');
      jump.onclick = () => {
        this.callbacks.onSwitchVessel(alarm.vesselId!);
        banner.remove();
        this.banner = null;
      };
    }
    const snooze = el('button', 'hud-btn', actions, 'Snooze 1m');
    snooze.onclick = () => {
      this.addAlarm(this.game().time + 60, alarm.label, alarm.kind, alarm.vesselId);
      banner.remove();
      this.banner = null;
    };
    const dismiss = el('button', 'hud-btn', actions, 'Dismiss');
    dismiss.onclick = () => {
      banner.remove();
      this.banner = null;
    };
  }

  private buildAlarms(content: HTMLElement): void {
    const form = el('div', 'mission-alarm-form', content);
    this.alarmLabel = el('input', 'mission-input', form) as HTMLInputElement;
    this.alarmLabel.placeholder = 'Alarm label';
    this.alarmEta = el('input', 'mission-input short', form) as HTMLInputElement;
    this.alarmEta.type = 'number';
    this.alarmEta.min = '1';
    this.alarmEta.value = '60';
    this.alarmEta.title = 'Seconds from now';
    this.alarmKind = el('select', 'mission-input', form) as HTMLSelectElement;
    for (const kind of ['custom', 'maneuver', 'transfer', 'entry'] as const) {
      const option = document.createElement('option');
      option.value = kind;
      option.textContent = kind;
      this.alarmKind.appendChild(option);
    }
    const save = el('button', 'hud-btn', form, 'Add');
    save.onclick = () => {
      const eta = Number(this.alarmEta!.value);
      const label = this.alarmLabel!.value.trim();
      if (!(eta > 0) || !label) return;
      if (this.alarmEditId) this.game().removeAlarm(this.alarmEditId);
      this.addAlarm(this.game().time + eta, label, this.alarmKind!.value as AlarmKind);
      this.alarmEditId = null;
      this.alarmLabel!.value = '';
      save.textContent = 'Add';
    };
    this.alarmList = el('div', 'mission-list', content);
  }

  private updateAlarms(): void {
    if (!this.alarmList) return;
    const game = this.game();
    const signature = `${Math.floor(game.time)}:${game.alarms.map((alarm) => `${alarm.id}:${alarm.time}:${alarm.label}`).join('|')}`;
    if (signature === this.alarmSignature) return;
    this.alarmSignature = signature;
    this.alarmList.innerHTML = '';
    if (!game.alarms.length) {
      el('div', 'mission-empty', this.alarmList, 'No scheduled alarms');
      return;
    }
    for (const alarm of game.alarms) {
      const row = el('div', 'mission-row', this.alarmList);
      el('span', 'mission-kind', row, KIND_ICON[alarm.kind]);
      const info = el('div', 'mission-row-info', row);
      el('strong', '', info, alarm.label);
      const vessel = alarm.vesselId
        ? game.vessels.find((candidate) => candidate.runtime.id === alarm.vesselId)?.runtime.name ?? 'missing vessel'
        : 'global';
      el('span', '', info, `T−${duration(alarm.time - game.time)} · ${vessel}`);
      const edit = el('button', 'k-window-btn', row, '✎');
      edit.title = 'Edit';
      edit.onclick = () => {
        this.alarmEditId = alarm.id;
        this.alarmLabel!.value = alarm.label;
        this.alarmEta!.value = String(Math.max(1, Math.round(alarm.time - game.time)));
        this.alarmKind!.value = alarm.kind;
        const formButton = this.alarmLabel!.parentElement!.querySelector('button');
        if (formButton) formButton.textContent = 'Save';
      };
      if (alarm.vesselId && game.vessels.some((vesselRow) => vesselRow.runtime.id === alarm.vesselId)) {
        const jump = el('button', 'k-window-btn', row, '↪');
        jump.title = 'Jump to vessel';
        jump.onclick = () => this.callbacks.onSwitchVessel(alarm.vesselId!);
      }
      const remove = el('button', 'k-window-btn', row, '×');
      remove.title = 'Delete';
      remove.onclick = () => {
        game.removeAlarm(alarm.id);
        this.alarmSignature = '';
      };
    }
  }

  private buildTransfers(content: HTMLElement): void {
    const toolbar = el('div', 'mission-toolbar', content);
    el('span', '', toolbar, 'Sort');
    this.transferSort = el('select', 'mission-input', toolbar) as HTMLSelectElement;
    for (const [value, label] of [['window', 'window'], ['dv', 'departure Δv'], ['target', 'destination']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      this.transferSort.appendChild(option);
    }
    this.transferSort.onchange = () => { this.transferSignature = ''; };
    this.transferList = el('div', 'mission-list transfer-list', content);
  }

  private updateTransfers(): void {
    if (!this.transferList || !this.transferSort) return;
    const game = this.game();
    const gv = game.active;
    if (!gv) return;
    const signature = `${gv.runtime.id}:${gv.target}:${Math.floor(game.time / 30)}:${this.transferSort.value}`;
    if (signature === this.transferSignature) return;
    this.transferSignature = signature;
    const body = game.bodyOf(gv);
    const liveOrbit = stateToElements(body.mu, gv.runtime.pos, gv.runtime.vel, game.time);
    if (gv.runtime.situation !== 'orbit' || periapsisOf(liveOrbit) <= body.radius) {
      this.transferList.innerHTML = '';
      const empty = el('div', 'mission-empty transfer-gate', this.transferList);
      el('strong', '', empty, 'STABLE ORBIT REQUIRED');
      el('span', '', empty, 'Transfer sketches use your live parking orbit. Circularize above the atmosphere first.');
      return;
    }
    const parkingOrbitDirection =
      gv.runtime.pos.x * gv.runtime.vel.y - gv.runtime.pos.y * gv.runtime.vel.x >= 0 ? 1 : -1;
    const plans = allTransferPlans(game.universe, game.time, body, {
      parkRadius: gv.runtime.pos.length(),
      vesselAngle: Math.atan2(gv.runtime.pos.y, gv.runtime.pos.x),
      parkingOrbitDirection,
      vesselPosition: gv.runtime.pos,
      vesselVelocity: gv.runtime.vel,
    });
    if (this.transferSort.value === 'dv') plans.sort((a, b) => a.departureDv - b.departureDv);
    else if (this.transferSort.value === 'target') plans.sort((a, b) => a.targetName.localeCompare(b.targetName));
    else plans.sort((a, b) => a.timeToWindow - b.timeToWindow);
    if (gv.target) plans.sort((a, b) => Number(b.targetId === gv.target) - Number(a.targetId === gv.target));
    this.transferList.innerHTML = '';
    if (parkingOrbitDirection < 0 && body.children.length) {
      el('div', 'mission-empty', this.transferList, 'Moon transfer windows require a prograde parking orbit.');
    }
    if (!plans.length) {
      if (parkingOrbitDirection >= 0 || !body.children.length) {
        el('div', 'mission-empty', this.transferList, 'No transfers from this SOI');
      }
      return;
    }
    for (const plan of plans) this.renderTransfer(plan, gv.target === plan.targetId);
  }

  private renderTransfer(plan: TransferPlan, targeted: boolean): void {
    const row = el('div', `transfer-row${targeted ? ' targeted' : ''}`, this.transferList!);
    const dial = el('div', 'phase-dial', row);
    dial.title = 'Current phase and required departure phase';
    const nowNeedle = el('i', 'phase-needle current', dial);
    const neededNeedle = el('i', 'phase-needle needed', dial);
    nowNeedle.style.transform = `rotate(${plan.phaseNow}rad)`;
    neededNeedle.style.transform = `rotate(${plan.phaseNeeded}rad)`;
    const info = el('div', 'transfer-info', row);
    const heading = el('div', 'transfer-heading', info);
    el('strong', '', heading, plan.targetName);
    el('span', 'transfer-kind', heading, plan.kind === 'moon' ? 'MOON' : 'PLANET');
    el('span', 'transfer-window', info, `DEPART T−${duration(plan.burnTime - this.game().time)}`);
    const metrics = el('div', 'transfer-metrics', info);
    const metric = (label: string, value: string) => {
      const cell = el('div', 'transfer-metric', metrics);
      el('span', '', cell, label);
      el('strong', '', cell, value);
    };
    metric('BURN', `${plan.departureDv.toFixed(0)} m/s`);
    metric('COAST', duration(plan.transferTime));
    metric('CAPTURE', `${plan.arrivalDv.toFixed(0)} m/s`);
    if (plan.approachAltitude !== undefined) {
      metric('APPROACH', `${(plan.approachAltitude / 1000).toFixed(0)} km`);
    }
    el(
      'span',
      `transfer-accuracy ${plan.accuracy === 'refined-intercept' ? 'refined' : ''}`,
      info,
      plan.accuracy === 'refined-intercept' ? 'INTERCEPT VERIFIED' : 'PHASE ESTIMATE · FINE-TUNE IN MAP',
    );
    const actions = el('div', 'transfer-actions', row);
    const target = el('button', 'hud-btn transfer-icon-action', actions, targeted ? 'Targeted' : 'Target');
    target.onclick = () => this.callbacks.onSetTarget(targeted ? null : plan.targetId);
    const alarm = el('button', 'hud-btn transfer-icon-action', actions, 'Alarm');
    alarm.onclick = () => this.addAlarm(plan.burnTime, `Burn: ${plan.targetName}`, 'transfer');
    const sketch = el(
      'button',
      `hud-btn transfer-plan-action${plan.accuracy === 'refined-intercept' ? ' verified' : ''}`,
      actions,
      plan.accuracy === 'refined-intercept' ? 'Plan intercept' : 'Sketch estimate',
    );
    sketch.setAttribute('aria-label', 'Sketch node');
    sketch.onclick = () => {
      this.callbacks.onSetTarget(plan.targetId);
      this.callbacks.onSketchNode(plan);
      this.windows.close('transfers');
    };
  }

  private buildFleet(content: HTMLElement): void {
    el('div', 'mission-section-title', content, 'BODY TARGETS');
    this.bodyList = el('div', 'mission-list body-list', content);
    const fleetHeader = el('div', 'mission-fleet-header', content);
    el('span', 'mission-section-title', fleetHeader, 'VESSELS');
    const debrisLabel = el('label', 'mission-check', fleetHeader);
    const debris = document.createElement('input');
    debris.type = 'checkbox';
    debris.onchange = () => {
      this.showDebris = debris.checked;
      this.fleetSignature = '';
    };
    debrisLabel.append(debris, document.createTextNode(' debris'));
    this.fleetList = el('div', 'mission-list fleet-list', content);
  }

  private updateFleet(): void {
    if (!this.fleetList || !this.bodyList) return;
    const game = this.game();
    const signature = `${game.activeVesselId}:${game.active?.target}:${this.showDebris}:${game.vessels.map((vessel) => `${vessel.runtime.id}:${vessel.runtime.name}:${vessel.runtime.bodyId}:${vessel.runtime.situation}:${vessel.runtime.isDebris}`).join('|')}`;
    if (signature === this.fleetSignature) return;
    this.fleetSignature = signature;
    this.bodyList.innerHTML = '';
    const currentBodyId = game.active?.runtime.bodyId;
    for (const body of game.universe.bodies.values()) {
      if (body.def.isStar) continue;
      const row = el('div', 'mission-row body-row', this.bodyList);
      const info = el('div', 'mission-row-info', row);
      el('strong', '', info, body.name);
      el('span', '', info, body.id === currentBodyId ? 'current SOI' : body.parent?.name ?? 'system body');
      const focus = el('button', 'hud-btn', row, 'Focus');
      focus.onclick = () => this.callbacks.onFocusBody(body.id);
      const targeted = game.active?.target === body.id;
      const target = el('button', 'hud-btn', row, targeted ? 'Clear' : 'Target');
      target.classList.toggle('active', targeted);
      target.onclick = () => this.callbacks.onSetTarget(targeted ? null : body.id);
      if (targeted) {
        const orbit = el('button', 'hud-btn', row, 'Orbit');
        orbit.onclick = () => this.callbacks.onOrbitTarget(body.id);
      }
    }

    this.fleetList.innerHTML = '';
    const vessels = game.vessels.filter((vessel) => this.showDebris || !vessel.runtime.isDebris);
    if (!vessels.length) el('div', 'mission-empty', this.fleetList, 'No matching vessels');
    for (const vessel of vessels) {
      const v = vessel.runtime;
      const row = el('div', `mission-row fleet-row${v.id === game.activeVesselId ? ' active' : ''}`, this.fleetList);
      const info = el('div', 'mission-row-info', row);
      const name = el('input', 'fleet-name', info) as HTMLInputElement;
      name.value = v.name;
      name.onchange = () => this.callbacks.onRenameVessel(v.id, name.value.trim() || v.name);
      const type = v.isDebris
        ? 'debris'
        : v.crew.length
          ? `crewed · ${v.crew.length}`
          : v.craft.parts.some((part) => defOf(part).probe)
            ? 'probe'
            : 'uncrewed';
      el('span', '', info, `${type} · ${game.universe.get(v.bodyId).name} · ${v.situation}`);
      const switchButton = el('button', 'hud-btn', row, v.id === game.activeVesselId ? 'Active' : 'Switch');
      switchButton.onclick = () => this.callbacks.onSwitchVessel(v.id);
      if (isRecoverable(vessel, game.universe)) {
        const recover = el('button', 'k-window-btn', row, '⌂');
        recover.title = 'Recover';
        recover.onclick = () => this.callbacks.onRecoverVessel(v.id);
      }
      if (v.isDebris) {
        const terminate = el('button', 'k-window-btn', row, '×');
        terminate.title = 'Terminate debris';
        terminate.onclick = () => this.callbacks.onTerminateVessel(v.id);
      }
    }
  }
}
