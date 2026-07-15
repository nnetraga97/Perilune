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
  readonly vesselId: string;
  readonly bodyId: string;
  readonly referenceOrbit: OrbitalElements;
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
 * Transient, single-node maneuver authority.
 *
 * The reference orbit is captured once. Editing changes the target derived from
 * that reference; live vessel motion never silently rewrites the plan.
 */
export class ManeuverPlanController {
  private plan: ManeuverPlan | null = null;

  get current(): Readonly<ManeuverPlan> | null {
    return this.plan;
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
    this.plan = {
      vesselId,
      bodyId,
      referenceOrbit: reference,
      node: copiedNode,
      targetOrbit: orbitAfterNode(reference, copiedNode),
      burnDirection,
      initialDeltaV,
      remainingDeltaV: initialDeltaV,
      phase: 'planned',
      revision: (this.plan?.revision ?? 0) + 1,
    };
    return this.plan;
  }

  update(node: ManeuverNode): Readonly<ManeuverPlan> | null {
    if (!this.plan || this.plan.phase === 'executing' || this.plan.phase === 'complete') return this.plan;
    const copiedNode = copyNode(node);
    const burnVector = nodeBurnVector(this.plan.referenceOrbit, copiedNode, new Vec3());
    const initialDeltaV = burnVector.length();
    this.plan.node = copiedNode;
    this.plan.targetOrbit = orbitAfterNode(this.plan.referenceOrbit, copiedNode);
    this.plan.burnDirection = initialDeltaV > 0
      ? burnVector.scale(1 / initialDeltaV)
      : new Vec3(1, 0, 0);
    this.plan.initialDeltaV = initialDeltaV;
    this.plan.remainingDeltaV = initialDeltaV;
    this.plan.phase = 'planned';
    this.plan.revision++;
    return this.plan;
  }

  clear(): void {
    this.plan = null;
  }

  beginExecution(): boolean {
    if (!this.plan || (this.plan.phase !== 'planned' && this.plan.phase !== 'overdue')) return false;
    this.plan.phase = 'executing';
    this.plan.revision++;
    return true;
  }

  markOverdue(now: number, burnDuration: number, grace = 3): boolean {
    if (!this.plan || this.plan.phase !== 'planned') return false;
    const halfBurn = Number.isFinite(burnDuration) ? Math.max(0, burnDuration / 2) : 0;
    if (now <= this.plan.node.time + halfBurn + grace) return false;
    this.plan.phase = 'overdue';
    this.plan.revision++;
    return true;
  }

  consumeDeliveredDeltaV(
    properAcceleration: number,
    thrustDirection: Readonly<Vec3>,
    dt: number,
    tolerance = 0.5,
  ): number {
    if (!this.plan || this.plan.phase !== 'executing') return this.plan?.remainingDeltaV ?? 0;
    const directionLength = Math.sqrt(Vec3.dot(thrustDirection, thrustDirection));
    const alignment = directionLength > 0
      ? Math.max(0, Vec3.dot(thrustDirection, this.plan.burnDirection) / directionLength)
      : 0;
    const delivered = Math.max(0, properAcceleration) * alignment * Math.max(0, dt);
    this.plan.remainingDeltaV = Math.max(0, this.plan.remainingDeltaV - delivered);
    if (this.plan.remainingDeltaV <= tolerance) {
      this.plan.remainingDeltaV = 0;
      this.plan.phase = 'complete';
    }
    return this.plan.remainingDeltaV;
  }

  projectedCompletion(
    mu: number,
    position: Readonly<Vec3>,
    velocity: Readonly<Vec3>,
    time: number,
  ): OrbitalElements | null {
    if (!this.plan) return null;
    return projectedOrbitAfterRemainingBurn(
      mu,
      position,
      velocity,
      time,
      this.plan.burnDirection,
      this.plan.remainingDeltaV,
    );
  }

  deltaV(): number {
    return this.plan ? nodeDeltaV(this.plan.node) : 0;
  }
}
