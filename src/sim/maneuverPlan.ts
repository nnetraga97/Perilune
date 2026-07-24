import { Vec3 } from '../core/vec3';
import { type OrbitalElements, stateToElements } from '../core/orbit';
import {
  type ManeuverNode,
  nodeBurnVector,
  nodeDeltaV,
  orbitAfterNode,
} from './maneuver';

export type ManeuverPhase = 'planned' | 'executing' | 'overdue' | 'complete';

export interface ManeuverPlan {
  readonly id: string;
  readonly vesselId: string;
  readonly bodyId: string;
  referenceOrbit: OrbitalElements;
  node: ManeuverNode;
  targetOrbit: OrbitalElements;
  burnDirection: Vec3;
  initialDeltaV: number;
  remainingDeltaV: number;
  phase: ManeuverPhase;
  revision: number;
}

function copyElements(elements: OrbitalElements): OrbitalElements {
  return { ...elements };
}

function copyNode(node: ManeuverNode): ManeuverNode {
  return { ...node };
}

/** Apply only the still-undelivered inertial burn vector to the live state. */
export function projectedOrbitAfterRemainingBurn(
  mu: number,
  position: Readonly<Vec3>,
  velocity: Readonly<Vec3>,
  time: number,
  burnDirection: Readonly<Vec3>,
  remainingDeltaV: number,
): OrbitalElements {
  const projectedVelocity = new Vec3().copy(velocity).addScaled(burnDirection, Math.max(0, remainingDeltaV));
  return stateToElements(mu, position, projectedVelocity, time);
}

/**
 * Transient maneuver-queue authority.
 *
 * Each vessel/body schedule is ordered by burn time. Later nodes derive from
 * the previous target orbit, while captured live references let deletion and
 * post-burn rebasing rebuild the remaining queue safely.
 */
export class ManeuverPlanController {
  private plans: ManeuverPlan[] = [];
  private capturedReferences = new Map<string, OrbitalElements>();
  private selectedId: string | null = null;
  private nextId = 1;

  get current(): Readonly<ManeuverPlan> | null {
    return this.plans.find((plan) => plan.id === this.selectedId) ?? this.plans[0] ?? null;
  }

  get all(): readonly Readonly<ManeuverPlan>[] {
    return [...this.plans].sort((a, b) => a.node.time - b.node.time);
  }

  scheduledFor(vesselId: string, bodyId: string): readonly Readonly<ManeuverPlan>[] {
    return this.plans
      .filter((plan) => plan.vesselId === vesselId && plan.bodyId === bodyId)
      .sort((a, b) => a.node.time - b.node.time);
  }

  selectedFor(vesselId: string, bodyId: string): Readonly<ManeuverPlan> | null {
    const scheduled = this.scheduledFor(vesselId, bodyId);
    return scheduled.find((plan) => plan.id === this.selectedId) ?? scheduled[0] ?? null;
  }

  nextFor(vesselId: string, bodyId: string): Readonly<ManeuverPlan> | null {
    return this.scheduledFor(vesselId, bodyId).find((plan) => plan.phase !== 'complete') ?? null;
  }

  select(id: string): Readonly<ManeuverPlan> | null {
    const plan = this.plans.find((candidate) => candidate.id === id) ?? null;
    if (plan) this.selectedId = plan.id;
    return plan;
  }

  create(
    vesselId: string,
    bodyId: string,
    referenceOrbit: OrbitalElements,
    node: ManeuverNode,
  ): Readonly<ManeuverPlan> {
    const reference = copyElements(referenceOrbit);
    const copiedNode = copyNode(node);
    const burnVector = nodeBurnVector(reference, copiedNode, new Vec3());
    const initialDeltaV = burnVector.length();
    const burnDirection = initialDeltaV > 0
      ? burnVector.scale(1 / initialDeltaV)
      : new Vec3(1, 0, 0);
    const id = `node-${this.nextId++}`;
    const plan: ManeuverPlan = {
      id,
      vesselId,
      bodyId,
      referenceOrbit: reference,
      node: copiedNode,
      targetOrbit: orbitAfterNode(reference, copiedNode),
      burnDirection,
      initialDeltaV,
      remainingDeltaV: initialDeltaV,
      phase: 'planned',
      revision: 1,
    };
    this.plans.push(plan);
    this.capturedReferences.set(id, reference);
    this.selectedId = id;
    this.recomputeSchedule(vesselId, bodyId);
    return plan;
  }

  update(node: ManeuverNode, id = this.selectedId): Readonly<ManeuverPlan> | null {
    const plan = this.find(id);
    if (!plan || plan.phase === 'executing' || plan.phase === 'complete') return plan;
    const copiedNode = copyNode(node);
    plan.node = copiedNode;
    plan.phase = 'planned';
    this.recomputeSchedule(plan.vesselId, plan.bodyId);
    return plan;
  }

  clear(id = this.selectedId): void {
    const plan = this.find(id);
    if (!plan) return;
    this.plans = this.plans.filter((candidate) => candidate.id !== plan.id);
    this.capturedReferences.delete(plan.id);
    if (this.selectedId === plan.id) {
      this.selectedId = this.scheduledFor(plan.vesselId, plan.bodyId)[0]?.id ?? this.plans[0]?.id ?? null;
    }
    this.recomputeSchedule(plan.vesselId, plan.bodyId);
  }

  removeVessel(vesselId: string): void {
    const removed = this.plans.filter((plan) => plan.vesselId === vesselId);
    if (removed.length === 0) return;
    const removedIds = new Set(removed.map((plan) => plan.id));
    this.plans = this.plans.filter((plan) => !removedIds.has(plan.id));
    for (const id of removedIds) this.capturedReferences.delete(id);
    if (this.selectedId && removedIds.has(this.selectedId)) {
      this.selectedId = this.plans[0]?.id ?? null;
    }
  }

  beginExecution(id = this.selectedId): boolean {
    const plan = this.find(id);
    if (!plan || (plan.phase !== 'planned' && plan.phase !== 'overdue')) return false;
    this.selectedId = plan.id;
    plan.phase = 'executing';
    plan.revision++;
    return true;
  }

  markOverdue(now: number, burnDuration: number, grace = 3, id = this.selectedId): boolean {
    const plan = this.find(id);
    if (!plan || plan.phase !== 'planned') return false;
    const halfBurn = Number.isFinite(burnDuration) ? Math.max(0, burnDuration / 2) : 0;
    if (now <= plan.node.time + halfBurn + grace) return false;
    plan.phase = 'overdue';
    plan.revision++;
    return true;
  }

  consumeDeliveredDeltaV(
    properAcceleration: number,
    thrustDirection: Readonly<Vec3>,
    dt: number,
    tolerance = 0.5,
    id = this.selectedId,
  ): number {
    const plan = this.find(id);
    if (!plan || plan.phase !== 'executing') return plan?.remainingDeltaV ?? 0;
    const directionLength = Math.sqrt(Vec3.dot(thrustDirection, thrustDirection));
    const alignment = directionLength > 0
      ? Math.max(0, Vec3.dot(thrustDirection, plan.burnDirection) / directionLength)
      : 0;
    const delivered = Math.max(0, properAcceleration) * alignment * Math.max(0, dt);
    plan.remainingDeltaV = Math.max(0, plan.remainingDeltaV - delivered);
    if (plan.remainingDeltaV <= tolerance) {
      plan.remainingDeltaV = 0;
      plan.phase = 'complete';
    }
    return plan.remainingDeltaV;
  }

  projectedCompletion(
    mu: number,
    position: Readonly<Vec3>,
    velocity: Readonly<Vec3>,
    time: number,
    id = this.selectedId,
  ): OrbitalElements | null {
    const plan = this.find(id);
    if (!plan) return null;
    return projectedOrbitAfterRemainingBurn(
      mu,
      position,
      velocity,
      time,
      plan.burnDirection,
      plan.remainingDeltaV,
    );
  }

  deltaV(id = this.selectedId): number {
    const plan = this.find(id);
    return plan ? nodeDeltaV(plan.node) : 0;
  }

  /** Re-anchor the next queued maneuver to the orbit actually achieved. */
  rebaseFirst(vesselId: string, bodyId: string, referenceOrbit: OrbitalElements): void {
    const first = this.scheduledFor(vesselId, bodyId)[0];
    if (!first) return;
    this.capturedReferences.set(first.id, copyElements(referenceOrbit));
    this.recomputeSchedule(vesselId, bodyId);
  }

  private find(id: string | null): ManeuverPlan | null {
    return id ? this.plans.find((plan) => plan.id === id) ?? null : null;
  }

  private recomputeSchedule(vesselId: string, bodyId: string): void {
    const scheduled = this.plans
      .filter((plan) => plan.vesselId === vesselId && plan.bodyId === bodyId)
      .sort((a, b) => a.node.time - b.node.time);
    let previousTarget: OrbitalElements | null = null;
    for (const plan of scheduled) {
      if (plan.phase === 'executing' || plan.phase === 'complete') {
        previousTarget = plan.targetOrbit;
        continue;
      }
      const captured = this.capturedReferences.get(plan.id) ?? plan.referenceOrbit;
      plan.referenceOrbit = copyElements(previousTarget ?? captured);
      const burnVector = nodeBurnVector(plan.referenceOrbit, plan.node, new Vec3());
      const initialDeltaV = burnVector.length();
      plan.targetOrbit = orbitAfterNode(plan.referenceOrbit, plan.node);
      plan.burnDirection = initialDeltaV > 0
        ? burnVector.scale(1 / initialDeltaV)
        : new Vec3(1, 0, 0);
      plan.initialDeltaV = initialDeltaV;
      plan.remainingDeltaV = initialDeltaV;
      plan.revision++;
      previousTarget = plan.targetOrbit;
    }
  }
}
