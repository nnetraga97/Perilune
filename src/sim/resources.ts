/**
 * In-situ resources: a deterministic ore field per body (same contract as
 * terrain height — pure function of (body, body-fixed direction)), orbital
 * scanning, and the drill/converter processing loop that also runs in the
 * background under rails warp.
 */
import { Vec3 } from '../core/vec3';
import { fbm3 } from '../core/noise';
import { RESOURCE_DENSITY, PartDef } from '../content/parts';
import { defOf } from './vessel';
import type { Body } from './universe';
import type { GameState, GameVessel } from './state';
import { inertialToBodyFixed } from './bodyOrientation';

/**
 * Ore concentration 0..1 for a unit direction in the body's rotating
 * (surface-fixed) frame. 0 on bodies without a minable surface.
 */
export function oreConcentration(body: Body, dir: Readonly<Vec3>): number {
  const t = body.def.terrain;
  if (t.amplitude === 0) return 0; // star / gas giants
  const f = 2.6;
  const s = t.seed + 101;
  const n = fbm3(dir.x * f, dir.y * f, dir.z * f, s, 4);
  const c = 0.5 + n * 0.9;
  return c < 0 ? 0 : c > 1 ? 1 : c;
}

export interface DepositSite {
  dir: Vec3; // body-fixed unit direction
  concentration: number;
}

const _fib = new Vec3();

/**
 * Deterministic list of the body's richest, well-separated deposit sites
 * (for the map overlay after scanning). Fibonacci-sphere sampled.
 */
export function depositSites(body: Body, count = 6): DepositSite[] {
  const N = 1600;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const scored: Array<{ x: number; y: number; z: number; c: number }> = [];
  for (let i = 0; i < N; i++) {
    const z = 1 - (2 * i + 1) / N;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const th = golden * i;
    _fib.set(r * Math.cos(th), r * Math.sin(th), z);
    const c = oreConcentration(body, _fib);
    if (c > 0.5) scored.push({ x: _fib.x, y: _fib.y, z: _fib.z, c });
  }
  scored.sort((a, b) => b.c - a.c);
  const sites: DepositSite[] = [];
  for (const s of scored) {
    if (sites.length >= count) break;
    let tooClose = false;
    for (const kept of sites) {
      if (kept.dir.x * s.x + kept.dir.y * s.y + kept.dir.z * s.z > 0.9) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) sites.push({ dir: new Vec3(s.x, s.y, s.z), concentration: s.c });
  }
  return sites;
}

/** Ore storage capacity of a part definition. */
export function oreCapacityOf(def: PartDef): number {
  return def.oreCapacity ?? 0;
}

const _dirBF = new Vec3();

/** Body-fixed surface direction under a vessel (active or rails-landed). */
function siteDirection(game: GameState, gv: GameVessel, out: Vec3): Vec3 {
  if (gv.regime === 'rails' && gv.rails.landedPos) {
    return out.copy(gv.rails.landedPos).normalize();
  }
  const body = game.universe.get(gv.runtime.bodyId);
  const p = gv.runtime.pos;
  return inertialToBodyFixed(body, game.time, p, out).normalize();
}

/**
 * Advance drills and converters for one vessel by dt seconds of game time.
 * Runs for every vessel each update — including rails-warped ones — so
 * mining bases keep working while the player is elsewhere.
 */
export function stepIsru(game: GameState, gv: GameVessel, dt: number): void {
  const v = gv.runtime;
  if (v.isDebris) return;

  let solarRate = 0;
  let hasDrill = false;
  let hasConverter = false;
  for (const p of v.craft.parts) {
    const def = defOf(p);
    if (def.solar) solarRate += def.solar.chargeRate;
    if (def.drill && p.activated) hasDrill = true;
    if (def.converter && p.activated) hasConverter = true;
  }
  if (!hasDrill && !hasConverter) return;

  // Background power: rails vessels trickle-charge at the day/night-averaged
  // solar rate (active vessels are charged by the real electrical pass).
  if (gv.regime === 'rails' && solarRate > 0) {
    v.charge.amount = Math.min(v.charge.capacity, v.charge.amount + solarRate * 0.5 * dt);
  }

  const landed =
    v.situation === 'landed' || v.situation === 'prelaunch';

  // ------------------------------------------------------------- drills
  if (hasDrill && landed) {
    const body = game.universe.get(v.bodyId);
    const conc = oreConcentration(body, siteDirection(game, gv, _dirBF));
    if (conc > 0.01) {
      for (const p of v.craft.parts) {
        const def = defOf(p);
        if (!def.drill || !p.activated) continue;
        const need = def.drill.power * dt;
        if (v.charge.amount < need) continue;
        // Find bin space.
        let space = 0;
        for (const bin of v.craft.parts) {
          const cap = oreCapacityOf(defOf(bin));
          if (cap > 0) space += cap - (bin.resources.ore ?? 0);
        }
        if (space <= 1e-9) continue;
        const mined = Math.min(def.drill.rate * conc * dt, space);
        if (mined <= 0) continue;
        v.charge.amount -= need;
        let rest = mined;
        for (const bin of v.craft.parts) {
          const cap = oreCapacityOf(defOf(bin));
          if (cap <= 0) continue;
          const have = bin.resources.ore ?? 0;
          const take = Math.min(cap - have, rest);
          if (take > 0) {
            bin.resources.ore = have + take;
            rest -= take;
          }
          if (rest <= 1e-12) break;
        }
      }
    }
  }

  // --------------------------------------------------------- converters
  if (hasConverter) {
    for (const p of v.craft.parts) {
      const def = defOf(p);
      if (!def.converter || !p.activated) continue;
      const conv = def.converter;
      const need = conv.power * dt;
      if (v.charge.amount < need) continue;
      // Available ore across the craft.
      let oreAvail = 0;
      for (const bin of v.craft.parts) oreAvail += bin.resources.ore ?? 0;
      if (oreAvail <= 1e-9) continue;
      // Propellant space across the craft (tank capacity = def resource).
      let propSpace = 0;
      for (const tank of v.craft.parts) {
        const cap = defOf(tank).resources?.propellant ?? 0;
        if (cap > 0) propSpace += cap - (tank.resources.propellant ?? 0);
      }
      if (propSpace <= 1e-9) continue;

      const ratio = conv.yield * (RESOURCE_DENSITY.ore / RESOURCE_DENSITY.propellant);
      let oreUsed = Math.min(conv.rate * dt, oreAvail, propSpace / ratio);
      if (oreUsed <= 0) continue;
      v.charge.amount -= need;
      let propMade = oreUsed * ratio;
      // Drain ore.
      for (const bin of v.craft.parts) {
        const have = bin.resources.ore ?? 0;
        if (have <= 0) continue;
        const take = Math.min(have, oreUsed);
        bin.resources.ore = have - take;
        oreUsed -= take;
        if (oreUsed <= 1e-12) break;
      }
      // Fill tanks.
      for (const tank of v.craft.parts) {
        const cap = defOf(tank).resources?.propellant ?? 0;
        if (cap <= 0) continue;
        const have = tank.resources.propellant ?? 0;
        const put = Math.min(cap - have, propMade);
        if (put > 0) {
          tank.resources.propellant = have + put;
          propMade -= put;
        }
        if (propMade <= 1e-12) break;
      }
    }
  }
}
