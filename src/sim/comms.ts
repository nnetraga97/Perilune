/**
 * Communications network: line-of-sight links between vessels and ground
 * stations, with planetary occlusion and range limits, routed by BFS through
 * relays. Probe-controlled vessels need a route home for full control.
 *
 * Link budget: two antennas connect within sqrt(rangeA × rangeB); planets
 * block the segment (slightly shrunk so surface stations see the sky).
 */
import { Vec3 } from '../core/vec3';
import type { GameState, GameVessel } from './state';
import { defOf } from './vessel';
import { bodyFixedToInertial } from './bodyOrientation';
import { launchSiteBodyFixedDirection } from './launchSite';

export interface GroundStation {
  id: string;
  name: string;
  bodyId: string;
  /** Body-fixed unit direction of the site. */
  dir: Vec3;
  range: number;
}

export const GROUND_STATIONS: GroundStation[] = [
  {
    id: 'gs-cape',
    name: 'Cape Skyward',
    bodyId: 'veyra',
    dir: launchSiteBodyFixedDirection(new Vec3()),
    range: 5e10,
  },
  {
    id: 'gs-farside',
    name: 'Farside Array',
    bodyId: 'veyra',
    dir: new Vec3(Math.cos(0.12) * Math.cos(-0.5), Math.cos(0.12) * Math.sin(-0.5), Math.sin(0.12)).normalize(),
    range: 5e10,
  },
  {
    id: 'gs-polar',
    name: 'Highwatch Station',
    bodyId: 'veyra',
    dir: new Vec3(Math.cos(1.1) * Math.cos(1.2), Math.cos(1.1) * Math.sin(1.2), Math.sin(1.1)).normalize(),
    range: 5e10,
  },
];

export interface CommsStatus {
  connected: boolean;
  /** Hops: vessel/station names from the craft back to the ground. */
  path: string[];
  /** 0..1 quality of the weakest link. */
  strength: number;
}

interface NetNode {
  id: string;
  name: string;
  pos: Vec3; // absolute (root frame)
  range: number;
  isGround: boolean;
  vessel?: GameVessel;
}

const _sp = new Vec3();
const _seg = new Vec3();
const _toC = new Vec3();

/** True if the segment a→b is blocked by any celestial body. */
export function segmentBlocked(game: GameState, a: Readonly<Vec3>, b: Readonly<Vec3>): boolean {
  Vec3.sub(b, a, _seg);
  const segLen2 = _seg.lengthSq();
  for (const body of game.universe.bodies.values()) {
    if (body.def.isStar) continue;
    game.universe.absolutePosition(body, game.time, _sp);
    Vec3.sub(_sp, a, _toC);
    const t = segLen2 > 0 ? Math.max(0, Math.min(1, Vec3.dot(_toC, _seg) / segLen2)) : 0;
    const dx = _toC.x - _seg.x * t;
    const dy = _toC.y - _seg.y * t;
    const dz = _toC.z - _seg.z * t;
    const d2 = dx * dx + dy * dy + dz * dz;
    const rEff = body.radius * 0.985;
    if (d2 < rEff * rEff) return true;
  }
  return false;
}

/** Best antenna range aboard a vessel (0 = no antenna). */
export function antennaRange(gv: GameVessel): number {
  let best = 0;
  for (const p of gv.runtime.craft.parts) {
    const a = defOf(p).antenna;
    if (a) best = Math.max(best, a.range);
  }
  return best;
}

/**
 * Evaluate connectivity of `target` back to any ground station, relaying
 * through other antenna-equipped vessels.
 */
export function evaluateComms(game: GameState, target: GameVessel): CommsStatus {
  const nodes: NetNode[] = [];
  // Ground stations (rotate with their body).
  for (const gs of GROUND_STATIONS) {
    const body = game.universe.get(gs.bodyId);
    const pos = bodyFixedToInertial(body, game.time, gs.dir, new Vec3()).scale(body.radius + 500);
    game.universe.absolutePosition(body, game.time, _sp);
    pos.add(_sp);
    nodes.push({ id: gs.id, name: gs.name, pos, range: gs.range, isGround: true });
  }
  // Vessels with antennas (including the target).
  for (const gv of game.vessels) {
    const range = antennaRange(gv);
    if (range <= 0 && gv !== target) continue;
    const pos = new Vec3();
    if (gv.regime === 'rails') game.railsPosition(gv, pos);
    else pos.copy(gv.runtime.pos);
    game.universe.absolutePosition(game.universe.get(gv.runtime.bodyId), game.time, _sp);
    pos.add(_sp);
    nodes.push({ id: gv.runtime.id, name: gv.runtime.name, pos, range, isGround: false, vessel: gv });
  }

  const targetNode = nodes.find((n) => n.vessel === target);
  if (!targetNode || targetNode.range <= 0) {
    return { connected: false, path: [], strength: 0 };
  }

  // BFS from target to any ground node.
  const visited = new Set<string>([targetNode.id]);
  const queue: Array<{ node: NetNode; path: string[]; strength: number }> = [
    { node: targetNode, path: [targetNode.name], strength: 1 },
  ];
  while (queue.length) {
    const { node, path, strength } = queue.shift()!;
    for (const other of nodes) {
      if (visited.has(other.id)) continue;
      const maxRange = Math.sqrt(node.range * other.range);
      const d = node.pos.distanceTo(other.pos);
      if (d > maxRange) continue;
      if (segmentBlocked(game, node.pos, other.pos)) continue;
      const linkStrength = Math.min(strength, 1 - Math.pow(d / maxRange, 2) * 0.95);
      if (other.isGround) {
        return { connected: true, path: [...path, other.name], strength: linkStrength };
      }
      visited.add(other.id);
      queue.push({ node: other, path: [...path, other.name], strength: linkStrength });
    }
  }
  return { connected: false, path: [], strength: 0 };
}

/** Does this vessel need a comms link for control? (probe-only, no crew) */
export function needsCommsForControl(gv: GameVessel): boolean {
  const hasCrewPod = gv.runtime.craft.parts.some((p) => (defOf(p).pod?.crew ?? 0) > 0 && gv.runtime.crew.length > 0);
  const hasProbe = gv.runtime.craft.parts.some((p) => defOf(p).probe);
  return hasProbe && !hasCrewPod;
}
