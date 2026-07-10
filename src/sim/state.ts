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
  Craft,
  PartInstance,
  defOf,
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

  get active(): GameVessel | null {
    return this.vessels.find((gv) => gv.runtime.id === this.activeVesselId) ?? null;
  }

  bodyOf(gv: GameVessel): Body {
    return this.universe.get(gv.runtime.bodyId);
  }

  newVesselId(): string {
    return `vessel-${this.nextVesselSerial++}`;
  }

  get warpRate(): number {
    return this.railsWarp ? RAILS_WARP_RATES[this.warpIndex] : PHYSICS_WARP_RATES[this.warpIndex];
  }

  /** Place a craft on the launch pad of Veyra (Cape Skyward, lon 0). */
  spawnOnPad(craft: Craft, name: string): GameVessel {
    const veyra = this.universe.get('veyra');
    const runtime = createVesselRuntime(this.newVesselId(), name, craft, 'veyra');

    // Pad site: fixed longitude/latitude on the surface at current spin.
    const lat = 0.12;
    const lon = -0.5;
    const spin = veyra.rotationAngle(this.time);
    const dirBF = new Vec3(
      Math.cos(lat) * Math.cos(lon),
      Math.cos(lat) * Math.sin(lon),
      Math.sin(lat),
    );
    const cs = Math.cos(spin);
    const ss = Math.sin(spin);
    const dirI = new Vec3(dirBF.x * cs - dirBF.y * ss, dirBF.x * ss + dirBF.y * cs, dirBF.z);
    const groundR = groundRadiusInertial(veyra, dirI, this.time);

    // Height so the craft's lowest part rests on ground.
    let minY = Infinity;
    for (const p of craft.parts) {
      const def = defOf(p);
      let bottom = p.position.y - def.shape.height / 2;
      if (def.leg) bottom -= def.leg.length;
      minY = Math.min(minY, bottom);
    }
    const comY = runtime.massProps.com.y;
    const standHeight = comY - minY + 0.4;

    runtime.pos.copy(dirI).scale(groundR + standHeight);
    // Surface rotation velocity.
    const omega = (Math.PI * 2) / veyra.def.rotationPeriod;
    runtime.vel.set(-omega * runtime.pos.y, omega * runtime.pos.x, 0);
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
    for (const dec of decouplersToFire) {
      this.detachSubtree(gv, dec, defOf(dec).decoupler!.ejection);
    }
    v.currentStage++;
    refreshDerived(v);
    return fired;
  }

  /** Split parts at a decoupler/failed joint into a debris vessel. */
  detachSubtree(gv: GameVessel, atPart: PartInstance, ejectionImpulse: number): void {
    const v = gv.runtime;
    const keys = splitAtJoint(v.craft, atPart.key);
    if (keys.length === v.craft.parts.length) return; // would detach everything
    const detachedParts = v.craft.parts.filter((p) => keys.includes(p.key));
    v.craft.parts = v.craft.parts.filter((p) => !keys.includes(p.key));
    for (const stage of v.craft.stages) {
      stage.partKeys = stage.partKeys.filter((k) => !keys.includes(k));
    }

    // Build the debris craft. Keep positions; root the detached top part.
    const debrisCraft: Craft = {
      name: `${v.name} debris`,
      version: 1,
      parts: detachedParts,
      stages: [],
      nextKey: v.craft.nextKey,
    };
    const rootPart = detachedParts.find((p) => p.key === atPart.key) ?? detachedParts[0];
    rootPart.parentKey = null;

    const debris = createVesselRuntime(this.newVesselId(), debrisCraft.name, debrisCraft, v.bodyId);
    debris.isDebris = true;
    debris.pos.copy(v.pos);
    debris.vel.copy(v.vel);
    debris.att.copy(v.att);
    debris.angVel.copy(v.angVel).scale(1.2);
    debris.situation = v.situation;

    // Ejection: push debris along its offset direction (usually down/side).
    const dv = ejectionImpulse / Math.max(1, debris.massProps.mass);
    const offset = new Vec3(
      rootPart.position.x - v.massProps.com.x,
      rootPart.position.y - v.massProps.com.y,
      rootPart.position.z - v.massProps.com.z,
    );
    if (offset.lengthSq() < 1e-6) offset.set(0, -1, 0);
    offset.normalize();
    v.att.rotate(offset, offset);
    debris.vel.addScaled(offset, dv);
    v.vel.addScaled(offset, -ejectionImpulse / Math.max(1, v.massProps.mass) * 0.3);

    logEvent(v, this.time, `Stage separation`);
    this.vessels.push({
      runtime: debris,
      regime: 'active',
      rails: { elements: null, landedPos: null, landedAtt: null },
    });
    refreshDerived(v);
  }

  // ------------------------------------------------------- regime switching
  toRails(gv: GameVessel): void {
    if (gv.regime === 'rails') return;
    const v = gv.runtime;
    const body = this.bodyOf(gv);
    if (v.situation === 'landed' || v.situation === 'splashed' || v.situation === 'prelaunch') {
      // Store body-fixed pose.
      const spin = body.rotationAngle(this.time);
      const cs = Math.cos(-spin);
      const ss = Math.sin(-spin);
      gv.rails.landedPos = new Vec3(
        v.pos.x * cs - v.pos.y * ss,
        v.pos.x * ss + v.pos.y * cs,
        v.pos.z,
      );
      gv.rails.landedAtt = v.att.clone();
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
      const spin = body.rotationAngle(this.time);
      const cs = Math.cos(spin);
      const ss = Math.sin(spin);
      const bf = gv.rails.landedPos;
      v.pos.set(bf.x * cs - bf.y * ss, bf.x * ss + bf.y * cs, bf.z);
      const omega = body.def.rotationPeriod !== 0 ? (Math.PI * 2) / body.def.rotationPeriod : 0;
      v.vel.set(-omega * v.pos.y, omega * v.pos.x, 0);
      if (gv.rails.landedAtt) v.att.copy(gv.rails.landedAtt);
    } else if (gv.rails.elements) {
      elementsAtTime(gv.rails.elements, this.time, v.pos, v.vel);
    }
    gv.regime = 'active';
  }

  /** Evaluate a rails vessel's position at current time (no state change). */
  railsPosition(gv: GameVessel, outR: Vec3, outV?: Vec3): void {
    const body = this.bodyOf(gv);
    if (gv.rails.landedPos) {
      const spin = body.rotationAngle(this.time);
      const cs = Math.cos(spin);
      const ss = Math.sin(spin);
      const bf = gv.rails.landedPos;
      outR.set(bf.x * cs - bf.y * ss, bf.x * ss + bf.y * cs, bf.z);
      if (outV) {
        const omega = body.def.rotationPeriod !== 0 ? (Math.PI * 2) / body.def.rotationPeriod : 0;
        outV.set(-omega * outR.y, omega * outR.x, 0);
      }
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
      this.time += realDt * this.warpRate;
      this.checkSoiTransitionsRails();
      return 0;
    }

    const simDt = realDt * this.warpRate;
    this.accumulator = Math.min(this.accumulator + simDt, 0.5); // spiral-of-death guard
    while (this.accumulator >= PHYSICS_DT) {
      this.accumulator -= PHYSICS_DT;
      this.stepPhysics(PHYSICS_DT);
      this.time += PHYSICS_DT;
      steps++;
    }
    return steps;
  }

  private stepPhysics(dt: number): void {
    // Sun direction for each vessel's body frame (approx: from body to star).
    for (const gv of this.vessels) {
      if (gv.regime !== 'active') continue;
      const v = gv.runtime;
      const body = this.bodyOf(gv);
      this.universe.absolutePosition(body, this.time, _br);
      _sun.copy(_br).scale(-1).normalize(); // toward the star at origin

      const ctx: StepContext = { body, time: this.time, sunDir: _sun };
      const result = stepVessel(v, ctx, dt);

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

    // Cull far/landed debris to keep vessel count bounded.
    this.cullDebris();
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
