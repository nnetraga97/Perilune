/**
 * Game state: universe clock, vessel registry, regime switching (active ⇄
 * rails), staging execution (with craft splitting into debris vessels), SOI
 * transitions, and time warp management.
 */
import { Vec3 } from '../core/vec3';
import { Quat } from '../core/quat';
import {
  OrbitalElements,
  elementsAtTime,
  periodOf,
  stateToElements,
  timeToTrueAnomaly,
} from '../core/orbit';
import { Body, Universe } from './universe';
import { HOME_BODY_ID, SOL_SYSTEM } from '../content/system';
import type { BodyDef } from './universe';
import {
  ACTION_GROUP_IDS,
  ActionGroupId,
  Craft,
  PartInstance,
  defOf,
  partitionActionGroups,
  projectStages,
} from './vessel';
import {
  createVesselRuntime,
  logEvent,
  refreshDerived,
  stepVessel,
  StepContext,
  VesselRuntime,
} from './flight';
import { evaluateStructure, splitAtJoint } from './structure';
import { groundRadiusInertial } from './terrain';
import { stepIsru } from './resources';
import {
  bodyFixedAttitudeToInertial,
  bodyFixedToInertial,
  inertialAttitudeToBodyFixed,
  inertialToBodyFixed,
  surfaceVelocity,
} from './bodyOrientation';
import { launchSiteDirection } from './launchSite';
import { preferredOrbitAltitude } from './orbitPlacement';
import { snapshotInterstageShrouds } from './interstage';
import { createCampaign, type CampaignState, type GameMode } from './campaign';
import type { LedgerEntry, ScienceKeyId } from './science';

export {
  LAUNCH_PAD_CONTACT_RADIUS,
  LAUNCH_PAD_DECK_HEIGHT,
  LAUNCH_PAD_FOOTPRINT_RADIUS,
  LAUNCH_PAD_TERRAIN_CLEARANCE,
  LAUNCH_SITE_LAT,
  LAUNCH_SITE_LON,
  launchSiteBodyFixedDirection,
  launchSiteDirection,
} from './launchSite';

export const PHYSICS_DT = 0.02;
export const PHYSICS_WARP_RATES = [1, 2, 4];
export const RAILS_WARP_RATES = [1, 5, 25, 100, 1000, 10_000];

export interface RailsState {
  elements: OrbitalElements | null;
  /** For landed vessels: body-fixed position + attitude. */
  landedPos: Vec3 | null;
  landedAtt: Quat | null;
}

export interface GameVessel {
  runtime: VesselRuntime;
  regime: 'active' | 'rails';
  rails: RailsState;
  /** Optional body id selected for navigation and map readouts. */
  target: string | null;
}

interface RailsEvent {
  time: number;
  kind: 'primary-exit' | 'child-entry' | 'hazard';
  child?: Body;
}

export type AlarmKind = 'custom' | 'transfer' | 'maneuver' | 'entry';

export interface GameAlarm {
  id: string;
  time: number;
  label: string;
  kind: AlarmKind;
  /** Vessel that owned the event when it was scheduled, if any. */
  vesselId: string | null;
}

export interface GameStateOptions {
  readonly bodies?: readonly BodyDef[];
  readonly homeBodyId?: string;
}

const _r = new Vec3();
const _v = new Vec3();
const _br = new Vec3();
const _bv = new Vec3();
const _sun = new Vec3();

export class GameState {
  readonly universe: Universe;
  time = 0;
  vessels: GameVessel[] = [];
  activeVesselId: string | null = null;
  /** Warp: index into physics or rails rates; railsWarp implies rails regime. */
  warpIndex = 0;
  railsWarp = false;
  private accumulator = 0;
  private nextVesselSerial = 1;
  /** Set when the active vessel was destroyed this frame (UI reacts). */
  lastDestruction: { vesselId: string; reason: string } | null = null;
  /** Spendable science balance from all delivery channels. */
  sciencePoints = 0;
  /** Persisted progression, economy, and contract state. */
  campaign: CampaignState;
  /** Delivered science by canonical experiment/body/biome/situation key. */
  scienceLedger = new Map<ScienceKeyId, LedgerEntry>();
  /** Progress/tutorial flags. */
  flags: Record<string, boolean> = {};
  /** Bodies whose resource fields have been surveyed from orbit. */
  scannedBodies = new Set<string>();
  /** Mission alarms, ordered by trigger time then stable id. */
  readonly alarms: GameAlarm[] = [];
  private readonly firedAlarms: GameAlarm[] = [];
  private nextAlarmSerial = 1;

  constructor(
    mode: GameMode = 'sandbox',
    options: Readonly<GameStateOptions> = {},
  ) {
    this.universe = new Universe([...(options.bodies ?? SOL_SYSTEM)], options.homeBodyId ?? HOME_BODY_ID);
    this.campaign = createCampaign(mode);
  }

  /** Keep the vessel id serial ahead of restored ids after loading a save. */
  noteRestoredVessel(id: string): void {
    const m = /^vessel-(\d+)$/.exec(id);
    if (m) this.nextVesselSerial = Math.max(this.nextVesselSerial, Number(m[1]) + 1);
  }

  get active(): GameVessel | null {
    return this.vessels.find((gv) => gv.runtime.id === this.activeVesselId) ?? null;
  }

  bodyOf(gv: GameVessel): Body {
    return this.universe.get(gv.runtime.bodyId);
  }

  newVesselId(): string {
    return `vessel-${this.nextVesselSerial++}`;
  }

  /** Remove all craft from the previous flight while preserving campaign state. */
  clearFlightVessels(): void {
    this.vessels = [];
    this.activeVesselId = null;
    this.lastDestruction = null;
    this.setWarp(0, false);
  }

  get warpRate(): number {
    return this.railsWarp ? RAILS_WARP_RATES[this.warpIndex] : PHYSICS_WARP_RATES[this.warpIndex];
  }

  addAlarm(
    time: number,
    label: string,
    kind: AlarmKind,
    vesselId: string | null = this.activeVesselId,
  ): GameAlarm {
    if (!Number.isFinite(time) || time <= this.time) {
      throw new Error('Alarm time must be finite and in the future');
    }
    const trimmedLabel = label.trim();
    if (!trimmedLabel) throw new Error('Alarm label is required');
    const alarm: GameAlarm = {
      id: `alarm-${this.nextAlarmSerial++}`,
      time,
      label: trimmedLabel,
      kind,
      vesselId,
    };
    this.alarms.push(alarm);
    this.sortAlarms();
    return alarm;
  }

  removeAlarm(id: string): boolean {
    const index = this.alarms.findIndex((alarm) => alarm.id === id);
    if (index < 0) return false;
    this.alarms.splice(index, 1);
    return true;
  }

  /** Drain alarms that fired since the last UI poll. */
  consumeFiredAlarms(): GameAlarm[] {
    return this.firedAlarms.splice(0, this.firedAlarms.length);
  }

  /** Replace the queue from validated save data while preserving stable ids. */
  restoreAlarms(alarms: readonly GameAlarm[]): void {
    this.alarms.splice(0, this.alarms.length);
    let maxSerial = 0;
    for (const alarm of alarms) {
      if (alarm.time <= this.time) continue;
      this.alarms.push({ ...alarm });
      const match = /^alarm-(\d+)$/.exec(alarm.id);
      if (match) maxSerial = Math.max(maxSerial, Number(match[1]));
    }
    this.nextAlarmSerial = Math.max(this.nextAlarmSerial, maxSerial + 1);
    this.sortAlarms();
  }

  private sortAlarms(): void {
    this.alarms.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  }

  /** Consume alarms due at the current time and drop all time warp. */
  private fireDueAlarms(): boolean {
    let fired = false;
    while (this.alarms.length && this.alarms[0].time <= this.time + 1e-9) {
      this.firedAlarms.push(this.alarms.shift()!);
      fired = true;
    }
    if (fired) this.setWarp(0, false);
    return fired;
  }

  /** Place a craft on the selected system's home-body launch pad. */
  spawnOnPad(craft: Craft, name: string): GameVessel {
    const home = this.universe.get(this.universe.homeBodyId);
    if (!home.def.launchSite || home.def.surfaceKind !== 'solid') {
      throw new Error(`${home.name} has no configured launch site`);
    }
    const runtime = createVesselRuntime(this.newVesselId(), name, craft, home.id);

    // Pad site: fixed longitude/latitude on the surface at current spin.
    const dirI = launchSiteDirection(home, this.time, new Vec3());
    const groundR = groundRadiusInertial(home, dirI, this.time);

    // Height so the craft's lowest part rests on ground.
    let minY = Infinity;
    for (const p of craft.parts) {
      const def = defOf(p);
      let bottom = p.position.y - def.shape.height / 2;
      if (def.leg) bottom -= def.leg.length;
      if (def.wheel) bottom = Math.min(bottom, p.position.y - def.wheel.radius);
      minY = Math.min(minY, bottom);
    }
    const comY = runtime.massProps.com.y;
    // groundRadiusInertial includes the pad's physical deck at Cape Skyward.
    const standHeight = comY - minY + 0.4;

    runtime.pos.copy(dirI).scale(groundR + standHeight);
    runtime.landedBodyFixed = inertialToBodyFixed(home, this.time, runtime.pos, new Vec3());
    // Surface rotation velocity.
    surfaceVelocity(home, runtime.pos, runtime.vel);
    // Point up.
    runtime.att.setLookRotation(
      new Vec3(-dirI.y, dirI.x, 0).normalize(), // forward: east-ish tangent
      dirI, // up
    );
    // setLookRotation points +Z forward/+Y up; craft nose is +Y so this works:
    // +Y (nose) now points along `dirI` (up).
    runtime.situation = 'prelaunch';
    runtime.crew = craftHasCrewPod(craft) ? pickCrew(craft) : [];

    const gv: GameVessel = {
      runtime,
      regime: 'active',
      rails: { elements: null, landedPos: null, landedAtt: null },
      target: null,
    };
    this.vessels.push(gv);
    this.activeVesselId = runtime.id;
    return gv;
  }

  /** Place a craft directly in a circular equatorial orbit (scenarios/tests). */
  spawnInOrbit(craft: Craft, name: string, bodyId: string, altitude: number): GameVessel {
    const body = this.universe.get(bodyId);
    const runtime = createVesselRuntime(this.newVesselId(), name, craft, bodyId);
    const r = body.radius + altitude;
    const vCirc = Math.sqrt(body.mu / r);
    runtime.pos.set(r, 0, 0);
    runtime.vel.set(0, vCirc, 0);
    runtime.att.setLookRotation(new Vec3(0, 0, 1), new Vec3(0, 1, 0));
    runtime.situation = 'orbit';
    const gv: GameVessel = {
      runtime,
      regime: 'active',
      rails: { elements: null, landedPos: null, landedAtt: null },
      target: null,
    };
    this.vessels.push(gv);
    this.activeVesselId = runtime.id;
    return gv;
  }

  /** Move the currently controlled craft into a safe circular equatorial orbit. */
  placeActiveInOrbit(bodyId: string): boolean {
    const gv = this.active;
    if (!gv) return false;
    const body = this.universe.get(bodyId);
    if (body.def.isStar) return false;

    // Resolve the old rails/landed pose before changing the vessel's primary.
    this.setWarp(0, false);

    const v = gv.runtime;
    const atmosphereTop = body.def.atmosphere?.height ?? 0;
    const terrainTop = body.def.surfaceKind === 'solid' ? body.def.terrain.amplitude : 0;
    const clearance = Math.max(atmosphereTop, terrainTop);
    const preferredAltitude = preferredOrbitAltitude(body);
    const soiAltitudeLimit = Number.isFinite(body.soiRadius)
      ? body.soiRadius * 0.25 - body.radius
      : preferredAltitude;
    const altitude = Math.min(preferredAltitude, soiAltitudeLimit);
    if (!(altitude > clearance)) return false;

    const radius = body.radius + altitude;
    const speed = Math.sqrt(body.mu / radius);
    const previousPhase = Math.atan2(v.pos.y, v.pos.x);
    const phase = Number.isFinite(previousPhase) ? previousPhase : 0;
    const cosPhase = Math.cos(phase);
    const sinPhase = Math.sin(phase);

    v.bodyId = body.id;
    v.pos.set(radius * cosPhase, radius * sinPhase, 0);
    v.vel.set(-speed * sinPhase, speed * cosPhase, 0);
    v.att.setLookRotation(new Vec3(0, 0, 1), v.vel);
    v.angVel.set(0, 0, 0);
    v.landedBodyFixed = null;
    v.situation = 'orbit';
    v.controls.pitch = 0;
    v.controls.yaw = 0;
    v.controls.roll = 0;
    v.controls.throttle = 0;
    v.controls.translate.set(0, 0, 0);
    v.controls.wheelDrive = 0;
    v.controls.wheelSteer = 0;
    v.controls.brake = false;
    v.properAccel = 0;
    v.stepResult.destroyedParts.length = 0;
    v.stepResult.crashed = false;
    v.stepResult.crashSpeed = 0;
    v.stepResult.terminalFailure = null;
    gv.regime = 'active';
    gv.rails.elements = null;
    gv.rails.landedPos = null;
    gv.rails.landedAtt = null;
    gv.target = null;
    this.lastDestruction = null;
    logEvent(v, this.time, `Placed in orbit around ${body.name}`);
    return true;
  }

  /** Fire the next stage of a vessel. Returns true if something fired. */
  fireStage(gv: GameVessel): boolean {
    const v = gv.runtime;
    const stage = v.craft.stages[v.currentStage];
    if (!stage) return false;
    let fired = false;
    const decouplersToFire: PartInstance[] = [];
    for (const key of stage.partKeys) {
      const p = v.craft.parts.find((q) => q.key === key);
      if (!p) continue;
      const def = defOf(p);
      if (def.engine) {
        p.activated = true;
        fired = true;
        logEvent(v, this.time, `${def.name} ignition`);
      } else if (def.decoupler) {
        p.activated = true;
        decouplersToFire.push(p);
        fired = true;
      } else if (def.parachute) {
        p.activated = true;
        fired = true;
        logEvent(v, this.time, `${def.name} armed`);
      } else {
        p.activated = true;
        fired = true;
      }
    }
    // Advance before splitting so every resulting vessel inherits the next
    // stage rather than replaying the separation stage.
    v.currentStage++;
    const consumedDecouplers = new Set(decouplersToFire.map((dec) => dec.key));
    for (const dec of decouplersToFire) {
      if (!v.craft.parts.some((part) => part.key === dec.key)) continue;
      const coupling = defOf(dec).decoupler!;
      if (coupling.mode === 'separator') {
        this.detachStackSeparator(gv, dec, coupling.ejection, consumedDecouplers);
      } else {
        this.detachDecouplerPayload(gv, dec, coupling.ejection, consumedDecouplers);
      }
    }
    refreshDerived(v);
    return fired;
  }

  /** Execute one player-defined craft action group. Returns resolved actions. */
  executeActionGroup(gv: GameVessel, group: ActionGroupId): number {
    const assignments = gv.runtime.craft.actionGroups[group] ?? [];
    let executed = 0;
    for (const assignment of assignments) {
      const part = gv.runtime.craft.parts.find((candidate) => candidate.key === assignment.partKey);
      if (!part) continue;
      if (assignment.action === 'toggle') part.activated = !part.activated;
      else part.activated = assignment.action === 'activate';
      executed++;
    }
    if (executed > 0) {
      logEvent(gv.runtime, this.time, `Action group ${group}: ${executed} action(s)`);
    }
    return executed;
  }

  /** Split parts at a decoupler/failed joint into a debris vessel. */
  detachSubtree(
    gv: GameVessel,
    atPart: PartInstance,
    ejectionImpulse: number,
    consumedStageKeys: ReadonlySet<number> = new Set<number>(),
  ): void {
    const v = gv.runtime;
    const keys = splitAtJoint(v.craft, atPart.key);
    if (keys.length === v.craft.parts.length) return; // would detach everything
    this.detachPartSet(gv, new Set(keys), atPart, ejectionImpulse, consumedStageKeys);
  }

  /** A one-sided decoupler stays with the parent-side craft and releases its payload branches. */
  private detachDecouplerPayload(
    gv: GameVessel,
    decoupler: PartInstance,
    ejectionImpulse: number,
    consumedStageKeys: ReadonlySet<number>,
  ): void {
    const craft = gv.runtime.craft;
    const components = this.componentsAfterCouplingFires(craft, decoupler.key, false);
    if (components.length < 2) {
      // Legacy/inverted craft may have the explosive side authored as the
      // parent edge. Preserve that orientation until attachment nodes carry
      // an explicit explosive-node id.
      this.detachSubtree(gv, decoupler, ejectionImpulse, consumedStageKeys);
      return;
    }
    const retained = components.find((component) => component.has(decoupler.key))!;
    this.separatePartComponents(gv, components, retained, ejectionImpulse, consumedStageKeys);
  }

  /**
   * An omni separator releases every edge attached to the ring. The ring is
   * retained as its own physical debris component rather than being deleted.
   */
  private detachStackSeparator(
    gv: GameVessel,
    separator: PartInstance,
    ejectionImpulse: number,
    consumedStageKeys: ReadonlySet<number>,
  ): void {
    const craft = gv.runtime.craft;
    const components = this.componentsAfterCouplingFires(craft, separator.key, true);
    if (components.length < 2) return;

    const originalRoot = craft.parts.find((part) => part.parentKey === null)?.key;
    const nonRingComponents = components.filter(
      (component) => !(component.size === 1 && component.has(separator.key)),
    );
    const retained = nonRingComponents.find(
      (component) => originalRoot !== undefined && originalRoot !== separator.key && component.has(originalRoot),
    ) ?? nonRingComponents.find((component) => this.componentHasControl(craft, component))
      ?? [...nonRingComponents].sort((a, b) => b.size - a.size)[0];
    if (!retained) return;
    this.separatePartComponents(gv, components, retained, ejectionImpulse, consumedStageKeys);
  }

  /** Connected components after cutting the configured coupling edges. */
  private componentsAfterCouplingFires(
    craft: Craft,
    couplingKey: number,
    omni: boolean,
  ): Set<number>[] {
    const adjacency = new Map<number, number[]>();
    for (const part of craft.parts) adjacency.set(part.key, []);
    let cutEdges = 0;
    for (const part of craft.parts) {
      if (part.parentKey === null || !adjacency.has(part.parentKey)) continue;
      const cut = omni
        ? part.key === couplingKey || part.parentKey === couplingKey
        : part.parentKey === couplingKey;
      if (cut) {
        cutEdges++;
        continue;
      }
      adjacency.get(part.key)!.push(part.parentKey);
      adjacency.get(part.parentKey)!.push(part.key);
    }
    if (cutEdges === 0) return [];

    const components: Set<number>[] = [];
    const visited = new Set<number>();
    for (const key of adjacency.keys()) {
      if (visited.has(key)) continue;
      const component = new Set<number>();
      const queue = [key];
      visited.add(key);
      while (queue.length) {
        const current = queue.pop()!;
        component.add(current);
        for (const neighbor of adjacency.get(current) ?? []) {
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
      components.push(component);
    }
    return components;
  }

  private componentHasControl(craft: Craft, keys: ReadonlySet<number>): boolean {
    return craft.parts.some(
      (part) => keys.has(part.key) && Boolean(defOf(part).pod || defOf(part).probe),
    );
  }

  private detachPartSet(
    gv: GameVessel,
    detachedKeys: ReadonlySet<number>,
    detachedRoot: PartInstance,
    ejectionImpulse: number,
    consumedStageKeys: ReadonlySet<number>,
  ): void {
    const v = gv.runtime;
    const retainedKeys = new Set(
      v.craft.parts.filter((part) => !detachedKeys.has(part.key)).map((part) => part.key),
    );
    if (detachedKeys.size === 0 || retainedKeys.size === 0) return;
    this.separatePartComponents(
      gv,
      [retainedKeys, new Set(detachedKeys)],
      retainedKeys,
      ejectionImpulse,
      consumedStageKeys,
      detachedRoot,
    );
  }

  /** Split one craft into every connected component while preserving each component's stage plan. */
  private separatePartComponents(
    gv: GameVessel,
    components: readonly ReadonlySet<number>[],
    retainedKeys: ReadonlySet<number>,
    ejectionImpulse: number,
    consumedStageKeys: ReadonlySet<number>,
    preferredDetachedRoot?: PartInstance,
  ): void {
    const v = gv.runtime;
    const wasActive = this.activeVesselId === v.id;
    const oldCom = v.massProps.com.clone();
    const oldPos = v.pos.clone();
    const oldVel = v.vel.clone();
    const oldAtt = v.att.clone();
    const oldAngVel = v.angVel.clone();
    const oldSituation = v.situation;
    const oldSas = v.sas;
    const oldSasCustomDir = v.sasCustomDir.clone();
    const oldControls = {
      pitch: v.controls.pitch,
      yaw: v.controls.yaw,
      roll: v.controls.roll,
      throttle: v.controls.throttle,
      rcs: v.controls.rcs,
      translate: v.controls.translate.clone(),
      wheelDrive: v.controls.wheelDrive,
      wheelSteer: v.controls.wheelSteer,
      brake: v.controls.brake,
    };
    const crewBefore = [...v.crew];
    const sourceCraft = v.craft;
    // Partitioning severs the graph edges used to derive a fitted interstage.
    // Latch its finite dimensions first so the one-piece separator debris keeps
    // the same shell after staging, structural failure, or any other split path.
    snapshotInterstageShrouds(sourceCraft);
    const sourceParts = [...sourceCraft.parts];
    const sourceStages = sourceCraft.stages;
    const sourceActionGroups = sourceCraft.actionGroups;
    const sourceCurrentStage = v.currentStage;

    const orderedComponents = [
      retainedKeys,
      ...components.filter((component) => component !== retainedKeys),
    ].filter((component) => component.size > 0);
    if (orderedComponents.length < 2) return;

    const componentData = orderedComponents.map((keys, index) => {
      const parts = sourceParts.filter((part) => keys.has(part.key));
      for (const part of parts) {
        if (part.parentKey !== null && !keys.has(part.parentKey)) {
          part.parentKey = null;
          part.attach = 'root';
        }
      }
      const stagePlan = projectStages(
        sourceStages,
        sourceCurrentStage,
        keys,
        consumedStageKeys,
      );
      const craft: Craft = {
        name: index === 0 ? sourceCraft.name : `${v.name} debris`,
        version: sourceCraft.version,
        parts,
        stages: stagePlan.stages,
        actionGroups: partitionActionGroups(sourceActionGroups, keys).detached,
        nextKey: sourceCraft.nextKey,
      };
      return { keys, craft, stagePlan };
    });

    const retained = componentData[0];
    v.craft = retained.craft;
    v.currentStage = retained.stagePlan.currentStage;
    refreshDerived(v);
    v.isDebris = !hasControlSource(v.craft);

    const componentVessels: Array<{ gv: GameVessel; keys: ReadonlySet<number> }> = [
      { gv, keys: retained.keys },
    ];
    for (let index = 1; index < componentData.length; index++) {
      const data = componentData[index];
      const runtime = createVesselRuntime(
        this.newVesselId(),
        data.craft.name,
        data.craft,
        v.bodyId,
      );
      runtime.currentStage = data.stagePlan.currentStage;
      runtime.isDebris = !hasControlSource(data.craft);
      const componentGv: GameVessel = {
        runtime,
        regime: 'active',
        rails: { elements: null, landedPos: null, landedAtt: null },
        target: gv.target,
      };
      this.vessels.push(componentGv);
      componentVessels.push({ gv: componentGv, keys: data.keys });
    }

    // Runtime positions track each component's CoM. Recenter every component
    // so all parts keep their pre-separation world positions.
    for (const component of componentVessels) {
      const runtime = component.gv.runtime;
      const shift = runtime.massProps.com.clone().sub(oldCom);
      oldAtt.rotate(shift, shift);
      runtime.pos.copy(oldPos).add(shift);
      runtime.vel.copy(oldVel);
      runtime.att.copy(oldAtt);
      runtime.angVel.copy(oldAngVel);
      runtime.situation = oldSituation;
      runtime.sas = oldSas;
      runtime.sasCustomDir.copy(oldSasCustomDir);
      runtime.controls.pitch = oldControls.pitch;
      runtime.controls.yaw = oldControls.yaw;
      runtime.controls.roll = oldControls.roll;
      runtime.controls.throttle = oldControls.throttle;
      runtime.controls.rcs = oldControls.rcs;
      runtime.controls.translate.copy(oldControls.translate);
      runtime.controls.wheelDrive = oldControls.wheelDrive;
      runtime.controls.wheelSteer = oldControls.wheelSteer;
      runtime.controls.brake = oldControls.brake;
    }

    // Push each released component away from the original craft center. The
    // retained component receives the corresponding recoil from every branch.
    for (let index = 1; index < componentVessels.length; index++) {
      const runtime = componentVessels[index].gv.runtime;
      const rootPart = runtime.craft.parts.find((part) => part.parentKey === null)
        ?? (preferredDetachedRoot && componentVessels[index].keys.has(preferredDetachedRoot.key)
          ? preferredDetachedRoot
          : runtime.craft.parts[0]);
      const offset = runtime.massProps.com.clone().sub(oldCom);
      if (offset.lengthSq() < 1e-6 && rootPart) {
        offset.set(
          rootPart.position.x - oldCom.x,
          rootPart.position.y - oldCom.y,
          rootPart.position.z - oldCom.z,
        );
      }
      if (offset.lengthSq() < 1e-6) offset.set(0, index % 2 === 0 ? 1 : -1, 0);
      offset.normalize();
      oldAtt.rotate(offset, offset);
      runtime.vel.addScaled(offset, ejectionImpulse / Math.max(1, runtime.massProps.mass));
      v.vel.addScaled(offset, -ejectionImpulse / Math.max(1, v.massProps.mass) * 0.3);
    }

    // Crew has no per-seat identity yet, so preserve the existing deterministic
    // allocation by component capacity.
    let crewIndex = 0;
    for (const component of componentVessels) {
      const capacity = component.gv.runtime.craft.parts.reduce(
        (sum, part) => sum + (defOf(part).pod?.crew ?? 0),
        0,
      );
      component.gv.runtime.crew = crewBefore.slice(crewIndex, crewIndex + capacity);
      crewIndex += capacity;
    }

    logEvent(v, this.time, 'Stage separation');
    if (wasActive && v.isDebris) {
      const controlled = componentVessels.find((component) => !component.gv.runtime.isDebris);
      if (controlled) {
        this.activeVesselId = controlled.gv.runtime.id;
        logEvent(controlled.gv.runtime, this.time, 'Control transferred after separation.');
      }
    }
  }

  // ------------------------------------------------------- regime switching
  toRails(gv: GameVessel): void {
    if (gv.regime === 'rails') return;
    const v = gv.runtime;
    const body = this.bodyOf(gv);
    if (v.situation === 'landed' || v.situation === 'splashed' || v.situation === 'prelaunch') {
      if (body.def.surfaceKind !== 'solid') {
        throw new Error(`${body.name} has no solid surface for a landed rails state`);
      }
      // Store body-fixed pose.
      gv.rails.landedPos = inertialToBodyFixed(body, this.time, v.pos, new Vec3());
      gv.rails.landedAtt = inertialAttitudeToBodyFixed(body, this.time, v.att, new Quat());
      gv.rails.elements = null;
    } else {
      gv.rails.elements = stateToElements(body.mu, v.pos, v.vel, this.time);
      gv.rails.landedPos = null;
      gv.rails.landedAtt = null;
    }
    gv.regime = 'rails';
  }

  toActive(gv: GameVessel): void {
    if (gv.regime === 'active') return;
    const v = gv.runtime;
    const body = this.bodyOf(gv);
    if (gv.rails.landedPos) {
      bodyFixedToInertial(body, this.time, gv.rails.landedPos, v.pos);
      surfaceVelocity(body, v.pos, v.vel);
      if (gv.rails.landedAtt) {
        bodyFixedAttitudeToInertial(body, this.time, gv.rails.landedAtt, v.att);
      }
    } else if (gv.rails.elements) {
      elementsAtTime(gv.rails.elements, this.time, v.pos, v.vel);
    }
    gv.regime = 'active';
  }

  /** Evaluate a rails vessel's position at current time (no state change). */
  railsPosition(gv: GameVessel, outR: Vec3, outV?: Vec3): void {
    const body = this.bodyOf(gv);
    if (gv.rails.landedPos) {
      bodyFixedToInertial(body, this.time, gv.rails.landedPos, outR);
      if (outV) surfaceVelocity(body, outR, outV);
    } else if (gv.rails.elements) {
      elementsAtTime(gv.rails.elements, this.time, outR, outV ?? _v);
    }
  }

  // ------------------------------------------------------------- warp logic
  canRailsWarp(gv: GameVessel): { ok: boolean; reason?: string } {
    const v = gv.runtime;
    const body = this.bodyOf(gv);
    const alt = v.pos.length() - body.radius;
    const atmoTop = body.def.atmosphere?.height ?? 0;
    if (v.situation === 'landed' || v.situation === 'splashed' || v.situation === 'prelaunch') {
      if (body.def.surfaceKind !== 'solid') {
        return { ok: false, reason: `${body.name} has no landable surface` };
      }
      return { ok: true };
    }
    if (alt < atmoTop) return { ok: false, reason: 'Cannot warp inside the atmosphere' };
    if (v.controls.throttle > 0.001) return { ok: false, reason: 'Cannot warp under thrust' };
    return { ok: true };
  }

  setWarp(index: number, rails: boolean): void {
    const active = this.active;
    if (rails && active) {
      const check = this.canRailsWarp(active);
      // A rejected 5x rails request used to reuse its array index in the
      // physics table, turning 4x into 2x when the player pressed "faster".
      // Preserve the current mode/rate; the shell can surface the reason.
      if (!check.ok) return;
    }
    this.railsWarp = rails;
    const max = rails ? RAILS_WARP_RATES.length - 1 : PHYSICS_WARP_RATES.length - 1;
    this.warpIndex = Math.max(0, Math.min(index, max));
    const activeGv = this.active;
    if (activeGv) {
      if (rails && this.warpIndex > 0) this.toRails(activeGv);
      else this.toActive(activeGv);
    }
  }

  // ------------------------------------------------------------ master tick
  /**
   * Advance the game by real dt seconds. Returns number of physics steps run
   * (for the perf overlay).
   */
  update(realDt: number): number {
    this.lastDestruction = null;
    let steps = 0;
    if (this.railsWarp && this.warpIndex > 0) {
      // Rails warp: pure analytic time advance.
      const requestedDt = realDt * this.warpRate;
      const startTime = this.time;
      const nextAlarm = this.alarms[0];
      let endTime = nextAlarm
        ? Math.min(this.time + requestedDt, nextAlarm.time)
        : this.time + requestedDt;
      const active = this.active;
      if (active?.regime === 'rails' && active.rails.elements) {
        const event = this.firstRailsEvent(active, startTime, endTime);
        if (event) endTime = Math.min(endTime, event.time);
      }
      const dtSim = endTime - this.time;
      this.time = endTime;
      this.checkRailsEvents(startTime, endTime);
      this.stepBackgroundSystems(dtSim);
      this.fireDueAlarms();
      return 0;
    }

    // If physics warp can no longer be simulated in real time, drop back to
    // 1x instead of silently discarding requested simulation time.
    if (this.warpIndex > 0 && realDt * this.warpRate > 0.5) this.warpIndex = 0;
    const simDt = realDt * this.warpRate;
    this.accumulator += simDt;
    while (this.accumulator >= PHYSICS_DT) {
      this.accumulator -= PHYSICS_DT;
      this.stepPhysics(PHYSICS_DT);
      this.stepBackgroundSystems(PHYSICS_DT);
      this.time += PHYSICS_DT;
      steps++;
      if (this.fireDueAlarms()) {
        // The accumulated remainder was requested at the old warp rate.
        this.accumulator = 0;
        break;
      }
    }
    return steps;
  }

  /** Slow systems that run for every vessel in any regime (ISRU, etc.). */
  private stepBackgroundSystems(dt: number): void {
    for (const gv of this.vessels) {
      const propellantMade = stepIsru(this, gv, dt);
      if (
        propellantMade > 0
        && (gv.runtime.situation === 'landed' || gv.runtime.situation === 'prelaunch')
      ) {
        this.flags['campaign:surface-industry'] = true;
      }
    }
  }

  /**
   * Survey the current body's resource field. Requires a resource scanner
   * aboard, an orbit above 25 km, and 20 units of charge.
   */
  performScan(gv: GameVessel): { ok: boolean; reason?: string } {
    const v = gv.runtime;
    const hasScanner = v.craft.parts.some((p) => defOf(p).resourceScanner);
    if (!hasScanner) return { ok: false, reason: 'No resource scanner aboard' };
    if (v.situation !== 'orbit') {
      return { ok: false, reason: 'A survey needs a stable orbit' };
    }
    const body = this.bodyOf(gv);
    const alt = v.pos.length() - body.radius;
    if (alt < 25_000) return { ok: false, reason: 'Orbit too low for a survey (25 km minimum)' };
    if (this.scannedBodies.has(v.bodyId)) {
      return { ok: false, reason: `${body.name} is already surveyed` };
    }
    if (v.charge.amount < 20) return { ok: false, reason: 'Insufficient charge (20 needed)' };
    v.charge.amount -= 20;
    this.scannedBodies.add(v.bodyId);
    logEvent(v, this.time, `Resource survey of ${body.name} complete`);
    return { ok: true };
  }

  /** Make a vessel the active (controlled) one. */
  setActive(id: string): void {
    const gv = this.vessels.find((x) => x.runtime.id === id);
    if (!gv) return;
    this.activeVesselId = id;
    this.setWarp(0, false);
    this.toActive(gv);
  }

  /**
   * Physics bubble management: vessels near the active one run full physics;
   * everyone else rides rails. Called each physics step.
   */
  private manageBubble(): void {
    const active = this.active;
    if (!active) return;
    this.toActive(active);
    for (const gv of this.vessels) {
      if (gv === active) continue;
      const v = gv.runtime;
      if (v.bodyId !== active.runtime.bodyId) {
        if (gv.regime === 'active') this.toRails(gv);
        continue;
      }
      // Same SOI: compare positions (rails vessels evaluated analytically).
      if (gv.regime === 'rails') {
        this.railsPosition(gv, _r);
        const d = _r.distanceTo(active.runtime.pos);
        if (d < 2_500) this.toActive(gv);
      } else {
        const d = v.pos.distanceTo(active.runtime.pos);
        if (d > 4_000 && !v.isDebris) this.toRails(gv);
      }
    }
  }

  private stepPhysics(dt: number): void {
    this.manageBubble();
    // Sun direction for each vessel's body frame (approx: from body to star).
    for (const gv of [...this.vessels]) {
      if (gv.regime !== 'active') continue;
      const v = gv.runtime;
      const body = this.bodyOf(gv);
      this.universe.absolutePosition(body, this.time, _br);
      _sun.copy(_br).scale(-1).normalize(); // toward the star at origin

      const ctx: StepContext = { body, time: this.time, sunDir: _sun };
      const result = stepVessel(v, ctx, dt);

      if (result.terminalFailure) {
        this.destroyVessel(gv, result.terminalFailure);
        continue;
      }
      if (result.crashed) {
        this.destroyVessel(gv, `Impact at ${result.crashSpeed.toFixed(0)} m/s`);
        continue;
      }
      if (result.destroyedParts.length) {
        for (const key of result.destroyedParts) {
          const p = v.craft.parts.find((q) => q.key === key);
          if (p) {
            logEvent(v, this.time, `${defOf(p).name} destroyed by overheating`, 'danger');
          }
        }
        v.craft.parts = v.craft.parts.filter((p) => !result.destroyedParts.includes(p.key));
        if (!v.craft.parts.length || !hasControlSource(v.craft)) {
          this.destroyVessel(gv, 'Vessel lost to overheating');
          continue;
        }
        refreshDerived(v);
      }

      // Structural check under load (skip when idle on the pad).
      if (v.properAccel > 25 || v.aero.dynamicPressure > 18_000) {
        const report = evaluateStructure(
          v.craft,
          _r.set(0, v.properAccel, 0),
          v.aero.dynamicPressure,
          Math.sin(v.aero.aoa),
        );
        if (report.failures.length) {
          const worst = report.failures.sort((a, b) => b.utilization - a.utilization)[0];
          const child = v.craft.parts.find((p) => p.key === worst.childKey);
          if (child) {
            const kind = worst.bendingMoment / worst.bendingLimit > worst.axialForce / worst.axialLimit ? 'bending' : 'axial';
            logEvent(
              v,
              this.time,
              `Structural failure: ${defOf(child).name} joint broke (${kind} load ${Math.round(
                kind === 'bending' ? worst.bendingMoment : worst.axialForce,
              )} over limit)`,
              'danger',
            );
            this.detachSubtree(gv, child, 0);
          }
        }
      }

      this.checkSoiTransitionActive(gv);
    }

    // Docking capture between nearby active vessels.
    this.checkDocking();

    // Cull far/landed debris to keep vessel count bounded.
    this.cullDebris();
  }

  // ---------------------------------------------------------------- docking
  /**
   * Free docking faces on a vessel: ports whose outward node is unoccupied.
   * Face dir is craft-local (+Y top face, −Y bottom face).
   */
  private freeDockFaces(gv: GameVessel): Array<{ part: PartInstance; face: 1 | -1 }> {
    const v = gv.runtime;
    const out: Array<{ part: PartInstance; face: 1 | -1 }> = [];
    for (const p of v.craft.parts) {
      if (p.defId !== 'dock-port-s') continue;
      // A part hanging below its parent connects via its TOP node; one
      // sitting above the parent connects via its BOTTOM node.
      const topUsedByParent = p.parentKey !== null && p.attach === 'stack-bottom';
      const bottomUsedByParent = p.parentKey !== null && p.attach === 'stack-top';
      const topChild = v.craft.parts.some((c) => c.parentKey === p.key && c.attach === 'stack-top');
      const bottomChild = v.craft.parts.some((c) => c.parentKey === p.key && c.attach === 'stack-bottom');
      if (!topUsedByParent && !topChild) out.push({ part: p, face: 1 });
      if (!bottomUsedByParent && !bottomChild) out.push({ part: p, face: -1 });
    }
    return out;
  }

  /** Check active vessel pairs for docking capture. */
  private checkDocking(): void {
    const actives = this.vessels.filter((gv) => gv.regime === 'active' && !gv.runtime.isDebris);
    for (let i = 0; i < actives.length; i++) {
      for (let j = i + 1; j < actives.length; j++) {
        const a = actives[i];
        const b = actives[j];
        if (a.runtime.bodyId !== b.runtime.bodyId) continue;
        if (a.runtime.pos.distanceTo(b.runtime.pos) > 80) continue;
        if (this.tryDockPair(a, b)) return; // one merge per tick
      }
    }
  }

  private tryDockPair(a: GameVessel, b: GameVessel): boolean {
    const facesA = this.freeDockFaces(a);
    const facesB = this.freeDockFaces(b);
    if (!facesA.length || !facesB.length) return false;
    const va = a.runtime;
    const vb = b.runtime;
    const closing = _r.copy(va.vel).sub(vb.vel).length();
    if (closing > 1.6) return false;

    for (const fa of facesA) {
      for (const fb of facesB) {
        // World positions of the port faces.
        const pa = portFaceWorld(va, fa.part, fa.face, _br);
        const pb = portFaceWorld(vb, fb.part, fb.face, _bv);
        if (pa.distanceTo(pb) > 0.7) continue;
        // Facing check: face normals opposed.
        const na = portFaceNormal(va, fa.face, _r);
        const nb = portFaceNormal(vb, fb.face, _v);
        if (Vec3.dot(na, nb) > -0.8) continue;
        this.mergeVessels(a, b, fa.part, fa.face, fb.part);
        return true;
      }
    }
    return false;
  }

  /** Merge vessel B into A at the given ports. */
  private mergeVessels(
    a: GameVessel,
    b: GameVessel,
    portA: PartInstance,
    faceA: 1 | -1,
    portB: PartInstance,
  ): void {
    const va = a.runtime;
    const vb = b.runtime;
    // Relative transform B→A (craft frames).
    const qaInv = va.att.clone().conjugate();
    const qRel = qaInv.clone().multiply(vb.att);
    const keyOffset = va.craft.nextKey;

    const comA = va.massProps.com.clone();
    const comB = vb.massProps.com.clone();
    const posA = va.pos.clone();
    const posB = vb.pos.clone();
    const velA = va.vel.clone();
    const velB = vb.vel.clone();
    const dPos = _r.copy(vb.pos).sub(va.pos);
    qaInv.rotate(dPos, dPos); // into A craft frame

    // Momentum-conserving velocity of the merged stack.
    const mA = va.massProps.mass;
    const mB = vb.massProps.mass;
    const mergedMass = mA + mB;
    const mergedVelocity = velA.clone().scale(mA / mergedMass).addScaled(velB, mB / mergedMass);
    const mergedWorldCom = posA.clone().scale(mA / mergedMass).addScaled(posB, mB / mergedMass);

    // Preserve total angular momentum about the merged center of mass. The
    // vessel model uses diagonal craft-frame inertia, so the final projection
    // is the closest representable angular velocity in A's craft frame.
    const angularMomentum = va.att.rotate(
      new Vec3(
        va.massProps.inertia.x * va.angVel.x,
        va.massProps.inertia.y * va.angVel.y,
        va.massProps.inertia.z * va.angVel.z,
      ),
      new Vec3(),
    );
    const spinB = vb.att.rotate(
      new Vec3(
        vb.massProps.inertia.x * vb.angVel.x,
        vb.massProps.inertia.y * vb.angVel.y,
        vb.massProps.inertia.z * vb.angVel.z,
      ),
      new Vec3(),
    );
    angularMomentum.add(spinB);
    const armA = posA.clone().sub(mergedWorldCom);
    const armB = posB.clone().sub(mergedWorldCom);
    const momentumA = velA.clone().sub(mergedVelocity).scale(mA);
    const momentumB = velB.clone().sub(mergedVelocity).scale(mB);
    angularMomentum.add(Vec3.cross(armA, momentumA, new Vec3()));
    angularMomentum.add(Vec3.cross(armB, momentumB, new Vec3()));

    const tmp = new Vec3();
    for (const p of vb.craft.parts) {
      const local = tmp.set(p.position.x - comB.x, p.position.y - comB.y, p.position.z - comB.z);
      qRel.rotate(local, local);
      const rot = new Quat(p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w).premultiply(qRel);
      const newPart: PartInstance = {
        ...p,
        key: p.key + keyOffset,
        parentKey: p.parentKey === null ? null : p.parentKey + keyOffset,
        position: {
          x: comA.x + dPos.x + local.x,
          y: comA.y + dPos.y + local.y,
          z: comA.z + dPos.z + local.z,
        },
        rotation: { x: rot.x, y: rot.y, z: rot.z, w: rot.w },
        resources: { ...p.resources },
      };
      va.craft.parts.push(newPart);
    }
    // Link B's port under A's port.
    const newPortB = va.craft.parts.find((p) => p.key === portB.key + keyOffset)!;
    // Re-root B's tree at its port (so the link direction is consistent).
    rerootSubtree(va.craft, newPortB.key);
    newPortB.parentKey = portA.key;
    newPortB.attach = faceA === 1 ? 'stack-top' : 'stack-bottom';

    // Stages append with remapped keys.
    for (const st of vb.craft.stages) {
      va.craft.stages.push({ partKeys: st.partKeys.map((k) => k + keyOffset) });
    }
    for (const id of ACTION_GROUP_IDS) {
      const incoming = vb.craft.actionGroups[id];
      if (!incoming?.length) continue;
      va.craft.actionGroups[id] = [
        ...(va.craft.actionGroups[id] ?? []),
        ...incoming.map((assignment) => ({
          ...assignment,
          partKey: assignment.partKey + keyOffset,
        })),
      ];
    }
    va.craft.nextKey = keyOffset + vb.craft.nextKey;
    va.crew = [...va.crew, ...vb.crew];
    va.charge.amount += vb.charge.amount;
    for (const [keyId, incoming] of vb.scienceBuffer) {
      const existing = va.scienceBuffer.get(keyId);
      if (!existing) {
        va.scienceBuffer.set(keyId, { ...incoming });
        continue;
      }
      const siteCapAtCollection = Math.max(existing.siteCapAtCollection, incoming.siteCapAtCollection);
      const transmittedFromThis = Math.min(
        siteCapAtCollection,
        existing.transmittedFromThis + incoming.transmittedFromThis,
      );
      const heldValue = Math.min(siteCapAtCollection, existing.heldValue + incoming.heldValue);
      va.scienceBuffer.set(keyId, {
        siteCapAtCollection,
        heldValue: Math.max(heldValue, transmittedFromThis),
        transmittedFromThis,
        transmitTarget: Math.min(heldValue, existing.transmitTarget + incoming.transmitTarget),
      });
    }
    refreshDerived(va);
    // Runtime position is the world-space craft CoM. Recenter it after the
    // geometry merge so every existing part keeps the same world position.
    const comShift = va.massProps.com.clone().sub(comA);
    va.att.rotate(comShift, comShift);
    va.pos.copy(posA).add(comShift);
    va.vel.copy(mergedVelocity);
    const angularMomentumCraft = va.att.clone().conjugate().rotate(angularMomentum, new Vec3());
    va.angVel.set(
      angularMomentumCraft.x / va.massProps.inertia.x,
      angularMomentumCraft.y / va.massProps.inertia.y,
      angularMomentumCraft.z / va.massProps.inertia.z,
    );
    logEvent(va, this.time, `Docking confirmed: ${vb.name} + ${va.name}`);
    this.flags['campaign:first-docking'] = true;
    this.vessels = this.vessels.filter((x) => x !== b);
    if (this.activeVesselId === vb.id) this.activeVesselId = va.id;
  }

  /** Undock at a docked port pair (child port whose parent is a port). */
  undock(gv: GameVessel, childPortKey: number): boolean {
    const v = gv.runtime;
    const child = v.craft.parts.find((p) => p.key === childPortKey);
    if (!child || child.defId !== 'dock-port-s' || child.parentKey === null) return false;
    const parent = v.craft.parts.find((p) => p.key === child.parentKey);
    if (!parent || parent.defId !== 'dock-port-s') return false;
    const crewBefore = [...v.crew];
    this.detachSubtree(gv, child, 60);
    const newVessel = this.vessels[this.vessels.length - 1];
    if (newVessel && newVessel.runtime.id !== v.id) {
      newVessel.runtime.isDebris = false;
      newVessel.runtime.name = `${v.name} segment`;
      // Split crew by pod capacity on each side.
      const capOf = (craft: Craft) =>
        craft.parts.reduce((s, p) => s + (defOf(p).pod?.crew ?? 0), 0);
      const capA = capOf(v.craft);
      v.crew = crewBefore.slice(0, capA);
      newVessel.runtime.crew = crewBefore.slice(capA, capA + capOf(newVessel.runtime.craft));
      logEvent(v, this.time, 'Undocked.');
    }
    return true;
  }

  /** Docked port pairs available for undocking. */
  dockedJoints(gv: GameVessel): Array<{ childKey: number }> {
    const out: Array<{ childKey: number }> = [];
    for (const p of gv.runtime.craft.parts) {
      if (p.defId !== 'dock-port-s' || p.parentKey === null) continue;
      const parent = gv.runtime.craft.parts.find((q) => q.key === p.parentKey);
      if (parent?.defId === 'dock-port-s') out.push({ childKey: p.key });
    }
    return out;
  }

  private destroyVessel(gv: GameVessel, reason: string): void {
    logEvent(gv.runtime, this.time, reason, 'danger');
    gv.runtime.situation = 'destroyed';
    if (gv.runtime.id === this.activeVesselId) {
      this.lastDestruction = { vesselId: gv.runtime.id, reason };
    }
    this.vessels = this.vessels.filter((x) => x !== gv);
  }

  private cullDebris(): void {
    const active = this.active;
    for (const gv of [...this.vessels]) {
      if (!gv.runtime.isDebris) continue;
      if (gv.regime !== 'active') continue;
      const v = gv.runtime;
      // Debris that landed or got far from the active vessel goes on rails
      // (or away entirely if it fell on a planet).
      if (v.situation === 'landed' || v.situation === 'splashed') {
        this.vessels = this.vessels.filter((x) => x !== gv);
        continue;
      }
      if (active && active !== gv) {
        const d = _r.copy(v.pos).sub(active.runtime.pos).length();
        if (d > 20_000) {
          const body = this.bodyOf(gv);
          const alt = v.pos.length() - body.radius;
          if (alt < (body.def.atmosphere?.height ?? 0)) {
            // Debris falling in atmosphere far away: remove (it will burn/land).
            this.vessels = this.vessels.filter((x) => x !== gv);
          } else {
            this.toRails(gv);
          }
        }
      }
    }
  }

  private checkSoiTransitionActive(gv: GameVessel): void {
    const v = gv.runtime;
    const body = this.bodyOf(gv);
    // Leaving current SOI?
    if (body.soiRadius !== Infinity && v.pos.length() > body.soiRadius && body.parent) {
      this.universe.localPosition(body, this.time, _br, _bv);
      v.pos.add(_br);
      v.vel.add(_bv);
      v.bodyId = body.parent.id;
      logEvent(v, this.time, `Entered ${body.parent.name}'s sphere of influence`);
      return;
    }
    // Entering a child SOI?
    for (const child of body.children) {
      this.universe.localPosition(child, this.time, _br, _bv);
      const d = _r.copy(v.pos).sub(_br).length();
      if (d < child.soiRadius) {
        v.pos.sub(_br);
        v.vel.sub(_bv);
        v.bodyId = child.id;
        logEvent(v, this.time, `Entered ${child.name}'s sphere of influence`);
        return;
      }
    }
  }

  /** Find the first continuous rails event in a time interval. */
  private firstRailsEvent(gv: GameVessel, startTime: number, endTime: number): RailsEvent | null {
    const elements = gv.rails.elements;
    if (!elements || endTime < startTime) return null;
    const body = this.bodyOf(gv);
    let earliest: RailsEvent | null = null;
    const consider = (event: RailsEvent | null) => {
      if (!event || event.time < startTime - 1e-6 || event.time > endTime + 1e-6) return;
      if (!earliest || event.time < earliest.time) earliest = event;
    };

    const active = gv.runtime.id === this.activeVesselId;
    const atmoTop = body.def.atmosphere?.height ?? 0;
    const terrainTop = body.def.surfaceKind === 'solid' ? body.def.terrain.amplitude : 0;
    const hazardAltitude = active ? Math.max(atmoTop, terrainTop + 2_000) : Math.max(atmoTop, terrainTop);
    consider(radialCrossingEvent(
      elements,
      startTime,
      endTime,
      body.radius + hazardAltitude,
      true,
      'hazard',
    ));
    if (body.parent && Number.isFinite(body.soiRadius)) {
      consider(radialCrossingEvent(
        elements,
        startTime,
        endTime,
        body.soiRadius,
        false,
        'primary-exit',
      ));
    }

    // Child SOIs move relative to the vessel conic. Sample at a bounded
    // cadence and bisect the first sign change so short flybys cannot jump
    // across an entire SOI in one high-warp frame.
    const span = endTime - startTime;
    if (span > 0 && body.children.length) {
      const period = periodOf(elements);
      const step = Math.max(0.25, Math.min(15, Number.isFinite(period) ? period / 4096 : 15));
      const samples = Math.max(1, Math.min(8192, Math.ceil(span / step)));
      for (const child of body.children) {
        let previousTime = startTime;
        let previous = this.childSoiDistance(elements, child, previousTime);
        if (previous <= 0) {
          consider({ time: startTime, kind: 'child-entry', child });
          continue;
        }
        for (let sample = 1; sample <= samples; sample++) {
          const time = startTime + (span * sample) / samples;
          const distance = this.childSoiDistance(elements, child, time);
          if (distance <= 0) {
            let low = previousTime;
            let high = time;
            for (let iteration = 0; iteration < 36; iteration++) {
              const mid = (low + high) / 2;
              if (this.childSoiDistance(elements, child, mid) <= 0) high = mid;
              else low = mid;
            }
            consider({ time: high, kind: 'child-entry', child });
            break;
          }
          previousTime = time;
          previous = distance;
          const cutoff = (earliest as RailsEvent | null)?.time ?? Infinity;
          if (previousTime >= cutoff) break;
        }
      }
    }
    return earliest;
  }

  private childSoiDistance(elements: OrbitalElements, child: Body, time: number): number {
    elementsAtTime(elements, time, _eventR, _eventV);
    this.universe.localPosition(child, time, _eventBodyR, _eventBodyV);
    return _eventDelta.copy(_eventR).sub(_eventBodyR).length() - child.soiRadius;
  }

  /** Process every vessel through SOI and impact events over a warp interval. */
  private checkRailsEvents(startTime: number, endTime: number): void {
    for (const gv of [...this.vessels]) {
      if (gv.regime !== 'rails' || !gv.rails.elements) continue;
      let cursor = startTime;
      for (let transitions = 0; transitions < 8 && gv.rails.elements; transitions++) {
        const event = this.firstRailsEvent(gv, cursor, endTime);
        if (!event) break;
        const elements = gv.rails.elements;
        const body = this.bodyOf(gv);
        elementsAtTime(elements, event.time, _r, _v);

        if (event.kind === 'hazard') {
          gv.runtime.pos.copy(_r);
          gv.runtime.vel.copy(_v);
          if (gv.runtime.id === this.activeVesselId) {
            // The global clock was limited to this event before entering here.
            this.setWarp(0, false);
          } else {
            const reason = body.def.atmosphere
              ? `Destroyed during atmospheric entry at warp over ${body.name}`
              : `Impacted ${body.name} during warp`;
            this.destroyVessel(gv, reason);
          }
          break;
        }

        if (event.kind === 'primary-exit' && body.parent) {
          this.universe.localPosition(body, event.time, _br, _bv);
          _r.add(_br);
          _v.add(_bv);
          gv.runtime.bodyId = body.parent.id;
          logEvent(gv.runtime, event.time, `Entered ${body.parent.name}'s sphere of influence`);
        } else if (event.kind === 'child-entry' && event.child) {
          this.universe.localPosition(event.child, event.time, _br, _bv);
          _r.sub(_br);
          _v.sub(_bv);
          gv.runtime.bodyId = event.child.id;
          logEvent(gv.runtime, event.time, `Entered ${event.child.name}'s sphere of influence`);
        } else {
          break;
        }
        const newBody = this.bodyOf(gv);
        gv.rails.elements = stateToElements(newBody.mu, _r, _v, event.time);
        cursor = Math.min(endTime, event.time + 1e-4);
        if (cursor >= endTime) break;
      }
      if (!this.vessels.includes(gv) || gv.regime !== 'rails' || !gv.rails.elements) continue;
      elementsAtTime(gv.rails.elements, endTime, gv.runtime.pos, gv.runtime.vel);
    }
  }
}

const _tmpDist = new Vec3();
const _pf = new Vec3();
const _eventR = new Vec3();
const _eventV = new Vec3();
const _eventBodyR = new Vec3();
const _eventBodyV = new Vec3();
const _eventDelta = new Vec3();

function radialCrossingEvent(
  elements: OrbitalElements,
  startTime: number,
  endTime: number,
  radius: number,
  inbound: boolean,
  kind: RailsEvent['kind'],
): RailsEvent | null {
  elementsAtTime(elements, startTime, _eventR, _eventV);
  const startRadius = _eventR.length();
  if (inbound && startRadius <= radius) return { time: startTime, kind };
  if (!inbound && startRadius >= radius) return { time: startTime, kind };
  if (elements.e < 1e-12) return null;
  const p = elements.a * (1 - elements.e * elements.e);
  const cosNu = (p / radius - 1) / elements.e;
  if (cosNu < -1 || cosNu > 1 || !Number.isFinite(cosNu)) return null;
  const angle = Math.acos(Math.max(-1, Math.min(1, cosNu)));
  const targetAnomaly = inbound ? (elements.e < 1 ? Math.PI * 2 - angle : -angle) : angle;
  let dt = timeToTrueAnomaly(elements, startTime, targetAnomaly);
  if (elements.e < 1 && dt < 1e-6) dt += periodOf(elements);
  const time = startTime + dt;
  return Number.isFinite(time) && time >= startTime && time <= endTime
    ? { time, kind }
    : null;
}

/** World position of a dock port's mating face. */
function portFaceWorld(v: VesselRuntime, port: PartInstance, face: 1 | -1, out: Vec3): Vec3 {
  const def = defOf(port);
  const com = v.massProps.com;
  _pf.set(
    port.position.x - com.x,
    port.position.y - com.y + (face * def.shape.height) / 2,
    port.position.z - com.z,
  );
  // Apply the part's own rotation to the face offset direction? Ports are
  // stack parts; their local axis follows the part rotation.
  const pq = new Quat(port.rotation.x, port.rotation.y, port.rotation.z, port.rotation.w);
  const local = new Vec3(0, (face * def.shape.height) / 2, 0);
  pq.rotate(local, local);
  _pf.set(
    port.position.x - com.x + local.x,
    port.position.y - com.y + local.y,
    port.position.z - com.z + local.z,
  );
  v.att.rotate(_pf, out.copy(_pf));
  return out.add(v.pos);
}

/** World direction the port face points (outward normal). */
function portFaceNormal(v: VesselRuntime, face: 1 | -1, out: Vec3): Vec3 {
  return v.att.rotate(out.set(0, face, 0), out);
}

/**
 * Re-root a craft subtree at the given part: reverse parent links along the
 * path from the new root up to the old root of its connected component.
 */
function rerootSubtree(craft: Craft, newRootKey: number): void {
  const byKey = new Map(craft.parts.map((p) => [p.key, p]));
  const path: PartInstance[] = [];
  let cur = byKey.get(newRootKey);
  while (cur) {
    path.push(cur);
    cur = cur.parentKey !== null ? byKey.get(cur.parentKey) : undefined;
  }
  const flip = (attach: string): PartInstance['attach'] =>
    attach === 'stack-top' ? 'stack-bottom' : attach === 'stack-bottom' ? 'stack-top' : 'surface';
  for (let i = path.length - 1; i > 0; i--) {
    const parent = path[i];
    const child = path[i - 1];
    parent.parentKey = child.key;
    parent.attach = flip(child.attach);
  }
  const root = byKey.get(newRootKey)!;
  root.parentKey = null;
}

function craftHasCrewPod(craft: Craft): boolean {
  return craft.parts.some((p) => (defOf(p).pod?.crew ?? 0) > 0);
}

function hasControlSource(craft: Craft): boolean {
  return craft.parts.some((p) => defOf(p).pod || defOf(p).probe);
}

const VELLAN_NAMES = [
  'Miro Tal', 'Essa Vane', 'Pippet Rill', 'Doro Ash', 'Luma Kest',
  'Bram Ondo', 'Tikka Sol', 'Wren Halda', 'Juno Berrit', 'Fenn Oleer',
];
let crewCursor = 0;
function pickCrew(craft: Craft): string[] {
  let seats = 0;
  for (const p of craft.parts) seats += defOf(p).pod?.crew ?? 0;
  const crew: string[] = [];
  for (let i = 0; i < seats; i++) {
    crew.push(VELLAN_NAMES[crewCursor++ % VELLAN_NAMES.length]);
  }
  return crew;
}
