import type { GameAlarm, GameState, AlarmKind } from '../sim/state';
import { allTransferPlans, type TransferPlan } from '../sim/transfer';
import { el } from './kit';
import type { WindowManager } from './window';
import { defOf } from '../sim/vessel';
import { isRecoverable } from '../sim/science';
import { periapsisOf, stateToElements } from '../core/orbit';
import type { BodyDef } from '../sim/universe';
import type { TransferWorkerRequest, TransferWorkerResult } from '../sim/transferWorker';

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
  private transferCalculationSignature = '';
  private transferPlans: TransferPlan[] = [];
  private transferPendingTargets = new Set<string>();
  private transferWorkers: Worker[] = [];
  private transferWorkerAssignments = new Map<Worker, Readonly<{ requestId: number; targetId: string }>>();
  private transferQueuedTargets: string[] = [];
  private transferRequest: Omit<TransferWorkerRequest, 'targetId'> | null = null;
  private transferRequestId = 0;
  private transferError = '';
  private disposed = false;
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
    for (const [value, label] of [['window', 'window'], ['dv', 'total Δv'], ['target', 'destination']]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      this.transferSort.appendChild(option);
    }
    this.transferSort.onchange = () => { this.transferSignature = ''; };
    this.transferList = el('div', 'mission-list transfer-list', content);
  }

  private createTransferWorker(): Worker {
    const worker = new Worker(new URL('../sim/transferWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<TransferWorkerResult>) => {
      this.transferWorkerAssignments.delete(worker);
      const result = event.data;
      if (result.requestId === this.transferRequestId) {
        this.transferPendingTargets.delete(result.targetId);
        if (result.plan) {
          const index = this.transferPlans.findIndex((plan) => plan.targetId === result.targetId);
          if (index >= 0) this.transferPlans[index] = result.plan;
          else this.transferPlans.push(result.plan);
        }
        if (result.error) this.transferError = 'Some intercepts could not be verified; estimates remain available.';
        this.transferSignature = '';
      }
      this.dispatchTransferWork(worker);
    };
    worker.onerror = () => {
      const assignment = this.transferWorkerAssignments.get(worker);
      this.transferWorkerAssignments.delete(worker);
      this.transferWorkers = this.transferWorkers.filter((candidate) => candidate !== worker);
      worker.terminate();
      if (assignment?.requestId === this.transferRequestId) {
        this.transferPendingTargets.delete(assignment.targetId);
        this.transferError = 'Some intercepts could not be verified; estimates remain available.';
        this.transferSignature = '';
      }
      for (const idleWorker of this.ensureTransferWorkers()) this.dispatchTransferWork(idleWorker);
    };
    return worker;
  }

  private ensureTransferWorkers(): readonly Worker[] {
    if (this.disposed || typeof Worker === 'undefined') return [];
    const concurrency = Math.max(
      1,
      Math.min(2, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1),
    );
    while (this.transferWorkers.length < concurrency) {
      this.transferWorkers.push(this.createTransferWorker());
    }
    return this.transferWorkers;
  }

  /** Give an idle persistent worker one target from the newest request only. */
  private dispatchTransferWork(worker: Worker): void {
    if (this.disposed || this.transferWorkerAssignments.has(worker) || !this.transferRequest) return;
    const targetId = this.transferQueuedTargets.shift();
    if (!targetId) return;
    const request: TransferWorkerRequest = { ...this.transferRequest, targetId };
    this.transferWorkerAssignments.set(worker, { requestId: request.requestId, targetId });
    worker.postMessage(request);
  }

  private queueTransferVerification(
    game: GameState,
    fromId: string,
    targets: readonly string[],
    options: TransferWorkerRequest['options'],
  ): void {
    const requestId = ++this.transferRequestId;
    const workers = this.ensureTransferWorkers();
    if (!workers.length) {
      this.transferError = 'Background verification is unavailable; estimates remain available.';
      return;
    }
    const universe = [...game.universe.bodies.values()].map((body) => body.def) as BodyDef[];
    this.transferPendingTargets = new Set(targets);
    this.transferQueuedTargets = [...targets];
    this.transferError = '';
    this.transferRequest = {
      requestId,
      universe,
      homeBodyId: game.universe.homeBodyId,
      time: game.time,
      fromId,
      options,
    };
    for (const worker of workers) this.dispatchTransferWork(worker);
  }

  private updateTransfers(): void {
    if (!this.transferList || !this.transferSort) return;
    const game = this.game();
    const gv = game.active;
    if (!gv) return;
    const body = game.bodyOf(gv);
    const liveOrbit = stateToElements(body.mu, gv.runtime.pos, gv.runtime.vel, game.time);
    const parkingOrbitDirection =
      gv.runtime.pos.x * gv.runtime.vel.y - gv.runtime.pos.y * gv.runtime.vel.x >= 0 ? 1 : -1;
    const nodeOrientation = Math.abs(Math.sin(liveOrbit.i)) > 1e-4
      ? liveOrbit.raan.toFixed(4)
      : 'equatorial';
    const periapsisOrientation = liveOrbit.e > 1e-4
      ? liveOrbit.argPe.toFixed(4)
      : 'circular';
    const calculationSignature = [
      gv.runtime.id,
      body.id,
      Math.round(liveOrbit.a / 100),
      liveOrbit.e.toFixed(5),
      liveOrbit.i.toFixed(4),
      nodeOrientation,
      periapsisOrientation,
      parkingOrbitDirection,
      Math.floor(game.time / 300),
    ].join(':');
    const signature = [
      calculationSignature,
      gv.target,
      this.transferSort.value,
      Math.floor(game.time / 30),
      [...this.transferPendingTargets].join(','),
      this.transferPlans.map((plan) => `${plan.targetId}:${plan.accuracy}:${plan.burnTime}`).join('|'),
      this.transferError,
    ].join(':');
    if (signature === this.transferSignature) return;
    this.transferSignature = signature;
    if (gv.runtime.situation !== 'orbit' || periapsisOf(liveOrbit) <= body.radius) {
      this.transferRequestId++;
      this.transferRequest = null;
      this.transferQueuedTargets = [];
      this.transferCalculationSignature = '';
      this.transferPlans = [];
      this.transferPendingTargets.clear();
      this.transferList.innerHTML = '';
      const empty = el('div', 'mission-empty transfer-gate', this.transferList);
      el('strong', '', empty, 'STABLE ORBIT REQUIRED');
      el('span', '', empty, 'Transfer sketches use your live parking orbit. Circularize above the atmosphere first.');
      return;
    }
    if (calculationSignature !== this.transferCalculationSignature) {
      this.transferCalculationSignature = calculationSignature;
      const quickOptions = {
        parkRadius: gv.runtime.pos.length(),
        vesselAngle: Math.atan2(gv.runtime.pos.y, gv.runtime.pos.x),
        parkingOrbitDirection,
      } as const;
      // Circular phase estimates are cheap enough for the opening frame. The
      // expensive patched-conic verification runs per destination off-thread.
      this.transferPlans = allTransferPlans(game.universe, game.time, body, quickOptions);
      const targets = this.transferPlans.map((plan) => plan.targetId);
      if (gv.target && targets.includes(gv.target)) {
        targets.splice(targets.indexOf(gv.target), 1);
        targets.unshift(gv.target);
      }
      this.queueTransferVerification(game, body.id, targets, {
        ...quickOptions,
        vesselPosition: { x: gv.runtime.pos.x, y: gv.runtime.pos.y, z: gv.runtime.pos.z },
        vesselVelocity: { x: gv.runtime.vel.x, y: gv.runtime.vel.y, z: gv.runtime.vel.z },
      });
    }
    const plans = [...this.transferPlans];
    if (this.transferSort.value === 'dv') {
      plans.sort((a, b) =>
        (a.departureDv + a.arrivalDv) - (b.departureDv + b.arrivalDv),
      );
    }
    else if (this.transferSort.value === 'target') plans.sort((a, b) => a.targetName.localeCompare(b.targetName));
    else plans.sort((a, b) => a.timeToWindow - b.timeToWindow);
    if (gv.target) plans.sort((a, b) => Number(b.targetId === gv.target) - Number(a.targetId === gv.target));
    this.transferList.innerHTML = '';
    if (this.transferPendingTargets.size) {
      el(
        'div',
        'mission-empty transfer-progress',
        this.transferList,
        `VERIFYING ${this.transferPendingTargets.size} INTERCEPT${this.transferPendingTargets.size === 1 ? '' : 'S'}…`,
      );
    } else if (this.transferError) {
      el('div', 'mission-empty transfer-progress', this.transferList, this.transferError);
    }
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
    const pendingVerification = this.transferPendingTargets.has(plan.targetId);
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
    metric('CAPTURE', `${plan.arrivalDv.toFixed(0)} m/s`);
    metric('TOTAL', `${(plan.departureDv + plan.arrivalDv).toFixed(0)} m/s`);
    metric('COAST', duration(plan.transferTime));
    if (plan.approachAltitude !== undefined) {
      metric('APPROACH', `${(plan.approachAltitude / 1000).toFixed(0)} km`);
    }
    el(
      'span',
      `transfer-accuracy ${plan.accuracy === 'refined-intercept' ? 'refined' : ''}`,
      info,
      pendingVerification
        ? 'CALCULATING VERIFIED INTERCEPT'
        : plan.accuracy === 'refined-intercept' ? 'INTERCEPT VERIFIED' : 'PHASE ESTIMATE · FINE-TUNE IN MAP',
    );
    const actions = el('div', 'transfer-actions', row);
    const target = el('button', 'hud-btn transfer-icon-action', actions, targeted ? 'Targeted' : 'Target');
    target.onclick = () => this.callbacks.onSetTarget(targeted ? null : plan.targetId);
    const alarm = el('button', 'hud-btn transfer-icon-action', actions, 'Alarm') as HTMLButtonElement;
    alarm.disabled = pendingVerification;
    alarm.onclick = () => this.addAlarm(plan.burnTime, `Burn: ${plan.targetName}`, 'transfer');
    const sketch = el(
      'button',
      `hud-btn transfer-plan-action${plan.accuracy === 'refined-intercept' ? ' verified' : ''}`,
      actions,
      pendingVerification
        ? 'Verifying…'
        : plan.accuracy === 'refined-intercept' ? 'Plan intercept' : 'Sketch estimate',
    ) as HTMLButtonElement;
    sketch.setAttribute('aria-label', 'Sketch node');
    sketch.disabled = pendingVerification;
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
      const row = el('div', 'mission-row body-row', this.bodyList);
      const info = el('div', 'mission-row-info', row);
      el('strong', '', info, body.name);
      el('span', '', info, body.id === currentBodyId ? 'current SOI' : body.parent?.name ?? 'system body');
      const focus = el('button', 'hud-btn', row, 'Focus');
      focus.onclick = () => this.callbacks.onFocusBody(body.id);
      if (body.def.isStar) {
        const orbit = el('button', 'hud-btn', row, 'Orbit');
        orbit.onclick = () => this.callbacks.onOrbitTarget(body.id);
        continue;
      }
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
      // Repair the visible symptom for saves created before component names
      // followed control ownership. New splits no longer generate this suffix.
      name.value = !v.isDebris && v.name.endsWith(' debris')
        ? v.name.slice(0, -' debris'.length)
        : v.name;
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

  /** Release the long-lived transfer worker pool when the game page is torn down. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.transferRequestId++;
    this.transferRequest = null;
    this.transferQueuedTargets = [];
    this.transferPendingTargets.clear();
    this.transferWorkerAssignments.clear();
    for (const worker of this.transferWorkers) worker.terminate();
    this.transferWorkers = [];
  }
}
