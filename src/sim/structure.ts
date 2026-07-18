/**
 * Structural model.
 *
 * The vessel flies as ONE welded rigid body (no springy joint chains, no
 * noodle rockets). Structure is enforced by an analytic load pass over the
 * attachment tree: each joint carries the inertial + aerodynamic load of the
 * subtree hanging from it. Overloaded joints fail, splitting the craft —
 * and the failure report says which joint, what load, and what the limit was.
 *
 * Complexity is O(parts) per evaluation, so even 500-part vessels are cheap.
 */
import { Vec3 } from '../core/vec3';
import { Craft, PartInstance, defOf, partWetMass } from './vessel';

/** Joint strength constants (N per m^2 of contact area, and bending factor). */
const STACK_STRENGTH = 2.6e6;
// Calibrated so ordinary surface hardware retains roughly 55% headroom through
// the stock Wayfarer's ~45 kPa max-Q turn, while aggressive high-AoA flight
// can still tear fins and radial couplings away.
const SURFACE_STRENGTH = 2.3e6;
const BENDING_FACTOR = 0.55;

export interface JointLoad {
  childKey: number;
  parentKey: number;
  axialForce: number; // N (tension/compression magnitude)
  bendingMoment: number; // N·m
  axialLimit: number;
  bendingLimit: number;
  /** Utilization 0..1+, >1 means failure. */
  utilization: number;
}

export interface StructureReport {
  joints: JointLoad[];
  /** Joints exceeding limits this evaluation. */
  failures: JointLoad[];
  maxUtilization: number;
}

interface Node {
  part: PartInstance;
  children: Node[];
  subtreeMass: number;
  subtreeCom: Vec3;
  /** Effective joint contact radius to parent (m). */
  jointRadius: number;
}

const _lever = new Vec3();

/** Effective contact radius of a joint between child and its parent. */
function jointRadiusOf(child: PartInstance, parent: PartInstance): number {
  const cd = defOf(child).shape;
  const pd = defOf(parent).shape;
  const cr = Math.max(cd.radiusTop ?? 0, cd.radiusBottom ?? 0, (cd.width ?? 0) / 2, 0.08);
  const pr = Math.max(pd.radiusTop ?? 0, pd.radiusBottom ?? 0, (pd.width ?? 0) / 2, 0.08);
  return Math.min(cr, pr);
}

/** Reinforced fittings strengthen both faces of the connection they bridge. */
function jointStrengthMultiplier(child: PartInstance, parent: PartInstance): number {
  return Math.max(
    1,
    defOf(child).jointStrengthMultiplier ?? 1,
    defOf(parent).jointStrengthMultiplier ?? 1,
  );
}

/**
 * Evaluate joint loads for the craft as a rigid body undergoing:
 * @param properAccel proper acceleration (thrust+aero)/mass, craft frame (m/s^2)
 * @param angAccel angular acceleration about CoM, craft frame (rad/s^2)
 * @param dynamicPressure q (Pa) for aero side-load estimation
 * @param aoaSin |sin(angle of attack)| for bending loads
 */
export function evaluateStructure(
  craft: Craft,
  properAccel: Readonly<Vec3>,
  dynamicPressure: number,
  aoaSin: number,
): StructureReport {
  const byKey = new Map<number, Node>();
  let root: Node | null = null;
  for (const part of craft.parts) {
    byKey.set(part.key, {
      part,
      children: [],
      subtreeMass: 0,
      subtreeCom: new Vec3(),
      jointRadius: 0.3,
    });
  }
  for (const node of byKey.values()) {
    const pk = node.part.parentKey;
    if (pk === null) {
      root = node;
    } else {
      const parent = byKey.get(pk);
      if (parent) {
        parent.children.push(node);
        node.jointRadius = jointRadiusOf(node.part, parent.part);
      } else {
        root = node;
      }
    }
  }
  if (!root) return { joints: [], failures: [], maxUtilization: 0 };

  // Post-order subtree mass & CoM (iterative to handle big vessels).
  const order: Node[] = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    order.push(n);
    for (const c of n.children) stack.push(c);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const n = order[i];
    let m = partWetMass(n.part);
    const com = n.subtreeCom.set(
      n.part.position.x * m,
      n.part.position.y * m,
      n.part.position.z * m,
    );
    for (const c of n.children) {
      m += c.subtreeMass;
      com.addScaled(c.subtreeCom, c.subtreeMass);
    }
    n.subtreeMass = m;
    if (m > 0) com.scale(1 / m);
  }

  const accelMag = properAccel.length();
  const joints: JointLoad[] = [];
  const failures: JointLoad[] = [];
  let maxUtilization = 0;

  for (const n of order) {
    if (n.part.parentKey === null) continue;
    const parent = byKey.get(n.part.parentKey)!;
    const r = n.jointRadius;
    const area = Math.PI * r * r;
    const isSurface = n.part.attach === 'surface';
    const strengthMultiplier = jointStrengthMultiplier(n.part, parent.part);
    const axialLimit = area * (isSurface ? SURFACE_STRENGTH : STACK_STRENGTH) * strengthMultiplier;
    const bendingLimit = axialLimit * BENDING_FACTOR * Math.max(r, 0.1);

    // A joint cut has two sides. Loading only the child subtree makes the
    // answer depend on which part is the craft root, and severely overstates
    // loads near a pod-rooted rocket's upper stage. Use the lighter supported
    // side as the conservative root-independent approximation.
    const totalMass = root.subtreeMass;
    const oppositeMass = Math.max(0, totalMass - n.subtreeMass);
    const useOpposite = oppositeMass > 0 && oppositeMass < n.subtreeMass;
    const supportedMass = useOpposite ? oppositeMass : n.subtreeMass;
    const axialForce = supportedMass * accelMag;

    // Aero side load: q × (frontal-ish area of subtree) × sin(aoa),
    // acting at the subtree CoM lever arm from the joint.
    const jointPos = _lever.set(
      (n.part.position.x + parent.part.position.x) / 2,
      (n.part.position.y + parent.part.position.y) / 2,
      (n.part.position.z + parent.part.position.z) / 2,
    );
    let supportedComX = n.subtreeCom.x;
    let supportedComY = n.subtreeCom.y;
    let supportedComZ = n.subtreeCom.z;
    if (useOpposite) {
      supportedComX = (root.subtreeCom.x * totalMass - n.subtreeCom.x * n.subtreeMass) / oppositeMass;
      supportedComY = (root.subtreeCom.y * totalMass - n.subtreeCom.y * n.subtreeMass) / oppositeMass;
      supportedComZ = (root.subtreeCom.z * totalMass - n.subtreeCom.z * n.subtreeMass) / oppositeMass;
    }
    const leverArm = Math.max(0.1, Math.hypot(
      supportedComX - jointPos.x,
      supportedComY - jointPos.y,
      supportedComZ - jointPos.z,
    ));
    const sideArea = Math.sqrt(supportedMass) * 0.05; // crude area proxy from mass
    const sideForce = dynamicPressure * sideArea * aoaSin;
    const bendingMoment = sideForce * leverArm + axialForce * 0.02 * leverArm;

    const utilization = Math.max(axialForce / axialLimit, bendingMoment / bendingLimit);
    const load: JointLoad = {
      childKey: n.part.key,
      parentKey: n.part.parentKey,
      axialForce,
      bendingMoment,
      axialLimit,
      bendingLimit,
      utilization,
    };
    joints.push(load);
    if (utilization > 1) failures.push(load);
    if (utilization > maxUtilization) maxUtilization = utilization;
  }

  return { joints, failures, maxUtilization };
}

/**
 * Split the craft at a failed joint: returns the detached subtree keys.
 * The caller turns those parts into a new debris vessel.
 */
export function splitAtJoint(craft: Craft, childKey: number): number[] {
  const detached = new Set<number>([childKey]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of craft.parts) {
      if (p.parentKey !== null && detached.has(p.parentKey) && !detached.has(p.key)) {
        detached.add(p.key);
        grew = true;
      }
    }
  }
  return [...detached];
}
