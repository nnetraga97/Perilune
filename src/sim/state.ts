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
  stateToElements,
} from '../core/orbit';
import { Body, Universe } from './universe';
import { AUREN_SYSTEM } from '../content/system';
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

export type AlarmKind = 'custom' | 'transfer' | 'maneuver' | 'entry';

export interface GameAlarm {
  id: string;
  time: number;
  label: string;
  kind: AlarmKind;
  /** Vessel that owned the event when it was scheduled, if any. */
  vesselId: string | null;
}

const _r = new Vec3();
const _v = new Vec3();
const _br = new Vec3();
const _bv = new Vec3();
const _sun = new Vec3();

export class GameState {
  readonly universe = new Universe(AUREN_SYSTEM);
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
  /** Recovered science points (spendable in later milestones). */
  sciencePoints = 0;
  /** Completed experiment keys (experimentId@body-situation). */
  completedExperiments = new Set<string>();
  /** Progress/tutorial flags. */
  flags: Record<string, boolean> = {};
  /** Bodies whose resource fields have been surveyed from orbit. */
  scannedBodies = new Set<string>();
  /** Mission alarms, ordered by trigger time then stable id. */
  readonly alarms: GameAlarm[] = [];
  private readonly firedAlarms: GameAlarm[] = [];
  private nextAlarmSerial = 1;

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

  /** Place a craft on the launch pad of Veyra (Cape Skyward, lon 0). */
  spawnOnPad(craft: Craft, name: string): GameVessel {
    const veyra = this.universe.get('veyra');
    const runtime = createVesselRuntime(this.newVesselId(), name, craft, 'veyra');

    // Pad site: fixed longitude/latitude on the surface at current spin.
    const dirI = launchSiteDirection(veyra, this.time, new Vec3());
    const groundR = groundRadiusInertial(veyra, dirI, this.time);

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
    runtime.landedBodyFixed = inertialToBodyFixed(veyra, this.time, runtime.pos, new Vec3());
    // Surface rotation velocity.
    surfaceVelocity(veyra, runtime.pos, runtime.vel);
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
      if (!check.ok) {
        rails = false;
        index = Math.min(index, PHYSICS_WARP_RATES.length - 1);
      }
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
      const nextAlarm = this.alarms[0];
      const endTime = nextAlarm
        ? Math.min(this.time + requestedDt, nextAlarm.time)
        : this.time + requestedDt;
      const dtSim = endTime - this.time;
      this.time = endTime;
      this.checkSoiTransitionsRails();
      this.stepBackgroundSystems(dtSim);
      this.fireDueAlarms();
      return 0;
    }

    const simDt = realDt * this.warpRate;
    this.accumulator = Math.min(this.accumulator + simDt, 0.5); // spiral-of-death guard
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
    for (const gv of this.vessels) stepIsru(this, gv, dt);
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
    for (const gv of this.vessels) {
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

    const comA = va.massProps.com;
    const comB = vb.massProps.com;
    const dPos = _r.copy(vb.pos).sub(va.pos);
    qaInv.rotate(dPos, dPos); // into A craft frame

    // Momentum-conserving velocity of the merged stack.
    const mA = va.massProps.mass;
    const mB = vb.massProps.mass;
    va.vel.scale(mA / (mA + mB)).addScaled(vb.vel, mB / (mA + mB));

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
    refreshDerived(va);
    logEvent(va, this.time, `Docking confirmed: ${vb.name} + ${va.name}`);
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

  private checkSoiTransitionsRails(): void {
    for (const gv of this.vessels) {
      if (gv.regime !== 'rails' || !gv.rails.elements) continue;
      const v = gv.runtime;
      const body = this.bodyOf(gv);
      this.railsPosition(gv, _r, _v);
      let transitioned = false;
      if (body.soiRadius !== Infinity && _r.length() > body.soiRadius && body.parent) {
        this.universe.localPosition(body, this.time, _br, _bv);
        _r.add(_br);
        _v.add(_bv);
        v.bodyId = body.parent.id;
        transitioned = true;
        logEvent(v, this.time, `Entered ${body.parent.name}'s sphere of influence`);
      } else {
        for (const child of body.children) {
          this.universe.localPosition(child, this.time, _br, _bv);
          const d = _tmpDist.copy(_r).sub(_br).length();
          if (d < child.soiRadius) {
            _r.sub(_br);
            _v.sub(_bv);
            v.bodyId = child.id;
            transitioned = true;
            logEvent(v, this.time, `Entered ${child.name}'s sphere of influence`);
            break;
          }
        }
      }
      if (transitioned) {
        const newBody = this.bodyOf(gv);
        gv.rails.elements = stateToElements(newBody.mu, _r, _v, this.time);
        v.pos.copy(_r);
        v.vel.copy(_v);
      } else {
        // Keep runtime pos/vel roughly current for UI reads.
        v.pos.copy(_r);
        v.vel.copy(_v);
      }
      // Atmosphere entry or ground impact during rails warp: drop to active.
      const alt = _r.length() - body.radius;
      const atmoTop = this.bodyOf(gv).def.atmosphere?.height ?? 0;
      if (!gv.rails.landedPos && alt < Math.max(atmoTop, 2000) && gv.runtime.id === this.activeVesselId) {
        this.setWarp(0, false);
      }
    }
  }
}

const _tmpDist = new Vec3();
const _pf = new Vec3();

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
