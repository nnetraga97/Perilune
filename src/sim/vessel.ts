/**
 * Vessel craft graph: parts, attachments, staging, resources, and the
 * engineering analysis (mass / delta-v / TWR) that powers the editor
 * readouts and the flight simulation.
 *
 * Craft-local frame: +Y is "up" along the stack (nose direction), origin at
 * the root part's center.
 */
import { Vec3, Vec3Like } from '../core/vec3';
import { QuatLike } from '../core/quat';
import {
  PartDef,
  ResourceId,
  RESOURCE_DENSITY,
  partById,
} from '../content/parts';

export const G0 = 9.80665;

export type AttachKind = 'root' | 'stack-top' | 'stack-bottom' | 'surface';

export interface PartInstance {
  /** Unique within the craft. */
  key: number;
  defId: string;
  parentKey: number | null;
  attach: AttachKind;
  /** Center position in craft-local frame (m). */
  position: Vec3Like;
  /** Orientation in craft-local frame. */
  rotation: QuatLike;
  /** Current resource amounts (units). */
  resources: Partial<Record<ResourceId, number>>;
  /** Symmetry group id (parts placed together), 0 = none. */
  symmetry: number;
  /** Runtime flags. */
  activated?: boolean;
  deployed?: boolean;
  temperature?: number;
}

export interface Stage {
  /** Part keys triggered when this stage fires. */
  partKeys: number[];
}

export const ACTION_GROUP_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export type ActionGroupId = (typeof ACTION_GROUP_IDS)[number];
export type PartAction = 'toggle' | 'activate' | 'deactivate';

export interface ActionGroupAssignment {
  partKey: number;
  action: PartAction;
}

export type ActionGroups = Partial<Record<ActionGroupId, ActionGroupAssignment[]>>;

export interface StagePlan {
  stages: Stage[];
  currentStage: number;
}

export interface StagePartition {
  retained: StagePlan;
  detached: StagePlan;
}

/** Project a stage plan onto one connected component without mutating it. */
export function projectStages(
  stages: readonly Stage[],
  currentStage: number,
  partKeys: ReadonlySet<number>,
  consumedKeys: ReadonlySet<number> = new Set<number>(),
): StagePlan {
  const nextStage = Math.min(stages.length, Math.max(0, Math.trunc(currentStage)));
  const projected = stages.map((stage) => ({
    partKeys: stage.partKeys.filter(
      (key) => partKeys.has(key) && !consumedKeys.has(key),
    ),
  }));
  const compacted = projected.filter((stage) => stage.partKeys.length > 0);
  const firedStages = projected
    .slice(0, nextStage)
    .filter((stage) => stage.partKeys.length > 0).length;
  return {
    stages: compacted,
    currentStage: Math.min(firedStages, compacted.length),
  };
}

/** Split and compact a stage plan between two resulting vessel components. */
export function partitionStages(
  stages: readonly Stage[],
  currentStage: number,
  detachedKeys: ReadonlySet<number>,
  consumedKeys: ReadonlySet<number> = new Set<number>(),
): StagePartition {
  const project = (detached: boolean): StagePlan => {
    const keys = new Set<number>();
    for (const stage of stages) {
      for (const key of stage.partKeys) {
        if (detachedKeys.has(key) === detached) keys.add(key);
      }
    }
    return projectStages(stages, currentStage, keys, consumedKeys);
  };
  return {
    retained: project(false),
    detached: project(true),
  };
}

/** Split action-group assignments by part ownership without mutating them. */
export function partitionActionGroups(
  groups: Readonly<ActionGroups>,
  detachedKeys: ReadonlySet<number>,
): { retained: ActionGroups; detached: ActionGroups } {
  const retained: ActionGroups = {};
  const detached: ActionGroups = {};
  for (const id of ACTION_GROUP_IDS) {
    const assignments = groups[id] ?? [];
    const kept = assignments
      .filter((assignment) => !detachedKeys.has(assignment.partKey))
      .map((assignment) => ({ ...assignment }));
    const split = assignments
      .filter((assignment) => detachedKeys.has(assignment.partKey))
      .map((assignment) => ({ ...assignment }));
    if (kept.length) retained[id] = kept;
    if (split.length) detached[id] = split;
  }
  return { retained, detached };
}

export interface Craft {
  name: string;
  version: number;
  parts: PartInstance[];
  /** stages[0] fires first (launch), matching bottom-of-list-first ordering. */
  stages: Stage[];
  /** Player-defined activation groups, addressed by flight keys 1–0. */
  actionGroups: ActionGroups;
  nextKey: number;
}

export function createCraft(name: string): Craft {
  return { name, version: 1, parts: [], stages: [], actionGroups: {}, nextKey: 1 };
}

export function craftPart(craft: Craft, key: number): PartInstance | undefined {
  return craft.parts.find((p) => p.key === key);
}

export function defOf(part: PartInstance): PartDef {
  return partById(part.defId);
}

export function addPart(
  craft: Craft,
  defId: string,
  parentKey: number | null,
  attach: AttachKind,
  position: Vec3Like,
  rotation: QuatLike = { x: 0, y: 0, z: 0, w: 1 },
  symmetry = 0,
): PartInstance {
  const def = partById(defId);
  const part: PartInstance = {
    key: craft.nextKey++,
    defId,
    parentKey,
    attach,
    position: { ...position },
    rotation: { ...rotation },
    resources: { ...(def.resources ?? {}) },
    symmetry,
  };
  craft.parts.push(part);
  return part;
}

/** Remove a part and its whole subtree. Returns removed keys. */
export function removeSubtree(craft: Craft, key: number): number[] {
  const removed = new Set<number>([key]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of craft.parts) {
      if (p.parentKey !== null && removed.has(p.parentKey) && !removed.has(p.key)) {
        removed.add(p.key);
        grew = true;
      }
    }
  }
  craft.parts = craft.parts.filter((p) => !removed.has(p.key));
  for (const stage of craft.stages) {
    stage.partKeys = stage.partKeys.filter((k) => !removed.has(k));
  }
  craft.stages = craft.stages.filter((s) => s.partKeys.length > 0);
  craft.actionGroups = partitionActionGroups(craft.actionGroups, removed).retained;
  return [...removed];
}

export function childrenOf(craft: Craft, key: number): PartInstance[] {
  return craft.parts.filter((p) => p.parentKey === key);
}

/** Build stages by attachment-tree separation level, not screen position. */
export function buildAutoStages(craft: Craft): Stage[] {
  const byKey = new Map(craft.parts.map((p) => [p.key, p]));
  const decouplersAbove = (part: PartInstance): number => {
    let count = 0;
    let parentKey = part.parentKey;
    const visited = new Set<number>();
    while (parentKey !== null && !visited.has(parentKey)) {
      visited.add(parentKey);
      const parent = byKey.get(parentKey);
      if (!parent) break;
      if (defOf(parent).decoupler) count++;
      parentKey = parent.parentKey;
    }
    return count;
  };
  const groups = new Map<number, { decouplers: number[]; engines: number[] }>();
  const groupAt = (level: number) => {
    let group = groups.get(level);
    if (!group) {
      group = { decouplers: [], engines: [] };
      groups.set(level, group);
    }
    return group;
  };
  for (const part of craft.parts) {
    const def = defOf(part);
    const level = decouplersAbove(part);
    if (def.engine) groupAt(level).engines.push(part.key);
    if (def.decoupler) groupAt(level).decouplers.push(part.key);
  }
  const stages = [...groups.keys()]
    .sort((a, b) => b - a)
    .map((level) => {
      const group = groups.get(level)!;
      return { partKeys: [...group.decouplers, ...group.engines] };
    })
    .filter((stage) => stage.partKeys.length > 0);
  const recovery = craft.parts.filter((p) => defOf(p).parachute).map((p) => p.key);
  if (recovery.length) stages.push({ partKeys: recovery });
  return stages;
}

export function partWetMass(part: PartInstance): number {
  const def = defOf(part);
  let m = def.massDry;
  for (const key of Object.keys(part.resources) as ResourceId[]) {
    m += (part.resources[key] ?? 0) * RESOURCE_DENSITY[key];
  }
  return m;
}

export interface MassProperties {
  mass: number; // kg
  dryMass: number;
  com: Vec3; // craft-local
  /** Diagonal moments of inertia about CoM (kg·m^2), craft axes. */
  inertia: Vec3;
}

export function computeMassProperties(craft: Craft): MassProperties {
  let mass = 0;
  let dryMass = 0;
  const com = new Vec3();
  for (const p of craft.parts) {
    const m = partWetMass(p);
    mass += m;
    dryMass += defOf(p).massDry;
    com.x += p.position.x * m;
    com.y += p.position.y * m;
    com.z += p.position.z * m;
  }
  if (mass > 0) com.scale(1 / mass);
  const inertia = new Vec3();
  for (const p of craft.parts) {
    const m = partWetMass(p);
    const dx = p.position.x - com.x;
    const dy = p.position.y - com.y;
    const dz = p.position.z - com.z;
    const def = defOf(p);
    const h = def.shape.height;
    let localIx: number;
    let localIy: number;
    let localIz: number;
    if (def.shape.kind === 'box' || def.shape.kind === 'panel') {
      const w = def.shape.width ?? 0.3;
      const d = def.shape.depth ?? 0.3;
      localIx = (m * (h * h + d * d)) / 12;
      localIy = (m * (w * w + d * d)) / 12;
      localIz = (m * (w * w + h * h)) / 12;
    } else {
      // Cylinder/cone/capsule approximation around the part-local +Y axis.
      const r = def.shape.radiusBottom ?? (def.shape.width ?? 0.6) / 2;
      localIx = (m * (3 * r * r + h * h)) / 12;
      localIy = (m * r * r) / 2;
      localIz = localIx;
    }

    // Rotate the local diagonal tensor into craft axes. We retain the diagonal
    // terms supported by the flight integrator instead of treating every
    // radially-mounted part as axis-aligned.
    const q = p.rotation;
    const xx = q.x * q.x, yy = q.y * q.y, zz = q.z * q.z;
    const xy = q.x * q.y, xz = q.x * q.z, yz = q.y * q.z;
    const wx = q.w * q.x, wy = q.w * q.y, wz = q.w * q.z;
    const r00 = 1 - 2 * (yy + zz), r01 = 2 * (xy - wz), r02 = 2 * (xz + wy);
    const r10 = 2 * (xy + wz), r11 = 1 - 2 * (xx + zz), r12 = 2 * (yz - wx);
    const r20 = 2 * (xz - wy), r21 = 2 * (yz + wx), r22 = 1 - 2 * (xx + yy);
    const selfX = r00 * r00 * localIx + r01 * r01 * localIy + r02 * r02 * localIz;
    const selfY = r10 * r10 * localIx + r11 * r11 * localIy + r12 * r12 * localIz;
    const selfZ = r20 * r20 * localIx + r21 * r21 * localIy + r22 * r22 * localIz;
    inertia.x += selfX + m * (dy * dy + dz * dz);
    inertia.y += selfY + m * (dx * dx + dz * dz);
    inertia.z += selfZ + m * (dx * dx + dy * dy);
  }
  // Never allow zero inertia (single tiny part)
  inertia.x = Math.max(inertia.x, 10);
  inertia.y = Math.max(inertia.y, 10);
  inertia.z = Math.max(inertia.z, 10);
  return { mass, dryMass, com, inertia };
}

// ---------------------------------------------------------------------------
// Crossfeed: which tanks can feed a given engine.
// Fuel flows across parent/child links where BOTH parts allow crossfeed.
// Decouplers and non-crossfeed parts (boosters, struts) block flow.
// ---------------------------------------------------------------------------

export function crossfeedComponent(craft: Craft, startKey: number): Set<number> {
  const adjacency = new Map<number, number[]>();
  const partsByKey = new Map<number, PartInstance>();
  for (const p of craft.parts) partsByKey.set(p.key, p);
  for (const p of craft.parts) {
    if (p.parentKey === null) continue;
    const parent = partsByKey.get(p.parentKey);
    if (!parent) continue;
    if (defOf(p).crossfeed && defOf(parent).crossfeed) {
      if (!adjacency.has(p.key)) adjacency.set(p.key, []);
      if (!adjacency.has(parent.key)) adjacency.set(parent.key, []);
      adjacency.get(p.key)!.push(parent.key);
      adjacency.get(parent.key)!.push(p.key);
    }
  }
  const seen = new Set<number>([startKey]);
  const queue = [startKey];
  while (queue.length) {
    const k = queue.pop()!;
    for (const n of adjacency.get(k) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen;
}

/** Build every crossfeed component once for reuse by engines in hot loops. */
export function buildCrossfeedIndex(craft: Craft): Map<number, readonly PartInstance[]> {
  const partsByKey = new Map<number, PartInstance>();
  const adjacency = new Map<number, number[]>();
  for (const part of craft.parts) {
    partsByKey.set(part.key, part);
    adjacency.set(part.key, []);
  }
  for (const part of craft.parts) {
    if (part.parentKey === null) continue;
    const parent = partsByKey.get(part.parentKey);
    if (!parent || !defOf(part).crossfeed || !defOf(parent).crossfeed) continue;
    adjacency.get(part.key)!.push(parent.key);
    adjacency.get(parent.key)!.push(part.key);
  }
  const index = new Map<number, readonly PartInstance[]>();
  const visited = new Set<number>();
  for (const part of craft.parts) {
    if (visited.has(part.key)) continue;
    const keys: number[] = [];
    const queue = [part.key];
    visited.add(part.key);
    while (queue.length) {
      const key = queue.pop()!;
      keys.push(key);
      for (const neighbor of adjacency.get(key) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
    const component = keys.map((key) => partsByKey.get(key)!);
    for (const key of keys) index.set(key, component);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Staging analysis: per-stage delta-v, TWR, burn time.
// Simulates firing stages in order, draining reachable propellant, then
// dropping decoupled subtrees.
// ---------------------------------------------------------------------------

export interface StageAnalysis {
  stageIndex: number;
  deltaV: number; // m/s
  twrStart: number;
  twrEnd: number;
  burnTime: number; // s
  massStart: number; // kg
  massEnd: number;
  thrust: number; // N (vacuum)
  isp: number; // effective, s
}

export interface CraftAnalysis {
  stages: StageAnalysis[];
  totalDeltaV: number;
  mass: number;
  dryMass: number;
  partCount: number;
  crewCapacity: number;
  warnings: string[];
}

interface SimPart {
  key: number;
  def: PartDef;
  parentKey: number | null;
  resources: Partial<Record<ResourceId, number>>;
  alive: boolean;
  engineLit: boolean;
}

/**
 * Analyze the craft's staging plan.
 * @param gravity local gravity for TWR (m/s^2)
 * @param atmPressure ambient pressure (Pa) for Isp interpolation (0 = vacuum)
 */
export function analyzeCraft(
  craft: Craft,
  gravity = 9.42,
  atmPressure = 101_325,
): CraftAnalysis {
  const warnings: string[] = [];
  const sim = new Map<number, SimPart>();
  for (const p of craft.parts) {
    sim.set(p.key, {
      key: p.key,
      def: defOf(p),
      parentKey: p.parentKey,
      resources: { ...p.resources },
      alive: true,
      engineLit: false,
    });
  }

  const liveMass = () => {
    let m = 0;
    for (const sp of sim.values()) {
      if (!sp.alive) continue;
      m += sp.def.massDry;
      for (const k of Object.keys(sp.resources) as ResourceId[]) {
        m += (sp.resources[k] ?? 0) * RESOURCE_DENSITY[k];
      }
    }
    return m;
  };

  const crossfeedFor = (startKey: number): Set<number> => {
    // Rebuild adjacency over alive parts only.
    const adjacency = new Map<number, number[]>();
    for (const sp of sim.values()) {
      if (!sp.alive || sp.parentKey === null) continue;
      const parent = sim.get(sp.parentKey);
      if (!parent || !parent.alive) continue;
      if (sp.def.crossfeed && parent.def.crossfeed) {
        if (!adjacency.has(sp.key)) adjacency.set(sp.key, []);
        if (!adjacency.has(parent.key)) adjacency.set(parent.key, []);
        adjacency.get(sp.key)!.push(parent.key);
        adjacency.get(parent.key)!.push(sp.key);
      }
    }
    const seen = new Set<number>([startKey]);
    const queue = [startKey];
    while (queue.length) {
      const k = queue.pop()!;
      for (const n of adjacency.get(k) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    return seen;
  };

  const killKeys = (keys: ReadonlySet<number>) => {
    for (const k of keys) {
      const sp = sim.get(k);
      if (sp) sp.alive = false;
    }
  };

  const sideHasControl = (keys: ReadonlySet<number>) => [...keys].some((key) => {
    const def = sim.get(key)?.def;
    return Boolean(def?.pod || def?.probe);
  });

  // Match runtime component ownership: keep the root-side component unless it
  // loses control, while an omni separator itself becomes discarded debris.
  const separateAt = (rootKey: number) => {
    const coupling = sim.get(rootKey);
    if (!coupling?.alive || !coupling.def.decoupler) return;
    const omni = coupling.def.decoupler.mode === 'separator';
    const liveParts = [...sim.values()].filter((part) => part.alive);
    const adjacency = new Map<number, number[]>();
    for (const part of liveParts) adjacency.set(part.key, []);
    let cutEdges = 0;
    for (const part of liveParts) {
      if (part.parentKey === null || !adjacency.has(part.parentKey)) continue;
      const cut = omni
        ? part.key === rootKey || part.parentKey === rootKey
        : part.parentKey === rootKey;
      if (cut) {
        cutEdges++;
        continue;
      }
      adjacency.get(part.key)!.push(part.parentKey);
      adjacency.get(part.parentKey)!.push(part.key);
    }
    if (cutEdges === 0) return;

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
    if (components.length < 2) return;

    const liveRoot = liveParts.find(
      (part) => part.parentKey === null || !sim.get(part.parentKey)?.alive,
    )?.key;
    const nonRingComponents = omni
      ? components.filter((component) => !(component.size === 1 && component.has(rootKey)))
      : components;
    let keep = nonRingComponents.find(
      (component) => liveRoot !== undefined && liveRoot !== rootKey && component.has(liveRoot),
    );
    if (!keep || !sideHasControl(keep)) {
      keep = nonRingComponents.find((component) => sideHasControl(component)) ?? keep;
    }
    keep ??= [...nonRingComponents].sort((a, b) => b.size - a.size)[0];
    if (!keep) return;
    for (const component of components) {
      if (component !== keep) killKeys(component);
    }
  };

  const ispAt = (eng: NonNullable<PartDef['engine']>): number => {
    const frac = Math.min(1, atmPressure / 101_325);
    return eng.ispVac + (eng.ispSea - eng.ispVac) * frac;
  };

  const stages: StageAnalysis[] = [];
  let totalDeltaV = 0;

  for (let si = 0; si < craft.stages.length; si++) {
    const stage = craft.stages[si];
    // 1. Fire decouplers in this stage and follow the runtime-controlled side.
    for (const key of stage.partKeys) {
      const sp = sim.get(key);
      if (!sp || !sp.alive || !sp.def.decoupler) continue;
      separateAt(sp.key);
    }
    // 2. Light engines in this stage.
    for (const key of stage.partKeys) {
      const sp = sim.get(key);
      if (!sp || !sp.alive || !sp.def.engine) continue;
      sp.engineLit = true;
    }

    // 3. Burn: engines drain reachable propellant.
    const litEngines = [...sim.values()].filter((sp) => sp.alive && sp.engineLit && sp.def.engine);
    const massStart = liveMass();

    if (litEngines.length === 0) {
      stages.push({
        stageIndex: si,
        deltaV: 0,
        twrStart: 0,
        twrEnd: 0,
        burnTime: 0,
        massStart,
        massEnd: massStart,
        thrust: 0,
        isp: 0,
      });
      continue;
    }

    let thrust = 0;
    let flowSum = 0; // kg/s
    for (const sp of litEngines) {
      const eng = sp.def.engine!;
      // Air-breathing engines scale with ambient pressure and die in vacuum.
      const isp = eng.airBreathing ? eng.ispVac : ispAt(eng);
      const thrustHere = eng.airBreathing
        ? eng.thrustVac * Math.min(1, atmPressure / 101_325)
        : eng.thrustVac * (isp / eng.ispVac);
      thrust += thrustHere;
      flowSum += thrustHere / (isp * G0);
    }
    if (flowSum <= 0) {
      // Engines lit but producing nothing here (air-breathers in vacuum).
      stages.push({
        stageIndex: si,
        deltaV: 0,
        twrStart: 0,
        twrEnd: 0,
        burnTime: 0,
        massStart,
        massEnd: massStart,
        thrust: 0,
        isp: 0,
      });
      continue;
    }
    const effIsp = thrust / (flowSum * G0);

    // Available propellant: union of crossfeed pools for liquid engines,
    // self-contained fuel for solids.
    let availableProp = 0;
    const countedTanks = new Set<number>();
    for (const sp of litEngines) {
      const eng = sp.def.engine!;
      if (eng.propellant === 'solidFuel') {
        if (!countedTanks.has(sp.key)) {
          availableProp += (sp.resources.solidFuel ?? 0) * RESOURCE_DENSITY.solidFuel;
          countedTanks.add(sp.key);
        }
      } else {
        for (const k of crossfeedFor(sp.key)) {
          if (countedTanks.has(k)) continue;
          const tank = sim.get(k);
          if (tank?.alive && (tank.resources.propellant ?? 0) > 0) {
            availableProp += (tank.resources.propellant ?? 0) * RESOURCE_DENSITY.propellant;
            countedTanks.add(k);
          }
        }
      }
    }

    const massEnd = massStart - availableProp;
    const deltaV = availableProp > 0 ? effIsp * G0 * Math.log(massStart / massEnd) : 0;
    const burnTime = availableProp > 0 ? availableProp / flowSum : 0;

    // Drain the counted tanks for the next stage's bookkeeping.
    for (const k of countedTanks) {
      const tank = sim.get(k)!;
      if (tank.def.engine?.propellant === 'solidFuel' || tank.resources.solidFuel !== undefined) {
        if (tank.resources.solidFuel !== undefined) tank.resources.solidFuel = 0;
      }
      if (tank.resources.propellant !== undefined) tank.resources.propellant = 0;
    }

    stages.push({
      stageIndex: si,
      deltaV,
      twrStart: thrust / (massStart * gravity),
      twrEnd: massEnd > 0 ? thrust / (massEnd * gravity) : 0,
      burnTime,
      massStart,
      massEnd,
      thrust,
      isp: effIsp,
    });
    totalDeltaV += deltaV;
  }

  const props = computeMassProperties(craft);
  let crewCapacity = 0;
  let hasControl = false;
  for (const p of craft.parts) {
    const def = defOf(p);
    if (def.pod) {
      crewCapacity += def.pod.crew;
      hasControl = true;
    }
    if (def.probe) hasControl = true;
  }
  if (!hasControl && craft.parts.length > 0) {
    warnings.push('No control source: add a crew pod or probe core.');
  }
  if (craft.parts.length > 0 && craft.stages.length === 0) {
    warnings.push('No staging defined: nothing will fire at launch.');
  }

  return {
    stages,
    totalDeltaV,
    mass: props.mass,
    dryMass: props.dryMass,
    partCount: craft.parts.length,
    crewCapacity,
    warnings,
  };
}
