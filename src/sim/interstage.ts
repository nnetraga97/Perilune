import type { PartDef } from '../content/parts';
import {
  defOf,
  type Craft,
  type InterstageShroudSpec,
  type PartInstance,
} from './vessel';

const MIN_RADIUS = 0.05;
const MAX_RADIUS = 10;
const MIN_SPAN = 0.08;
const MAX_SPAN = 8;
const MAX_RADIAL_OFFSET = 0.05;
const MIN_UP_DOT = Math.cos(5 * Math.PI / 180);
const MAX_WALK_PARTS = 16;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validate untrusted craft/save data and return a fresh bounded snapshot. */
export function sanitizeInterstageShroudSpec(raw: unknown): InterstageShroudSpec | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<InterstageShroudSpec>;
  if (
    !finite(value.lowerRadius)
    || !finite(value.upperRadius)
    || !finite(value.lowerY)
    || !finite(value.upperY)
  ) return null;
  const span = value.upperY - value.lowerY;
  if (
    value.lowerRadius < MIN_RADIUS || value.lowerRadius > MAX_RADIUS
    || value.upperRadius < MIN_RADIUS || value.upperRadius > MAX_RADIUS
    || span < MIN_SPAN || span > MAX_SPAN
    || Math.abs(value.lowerY) > MAX_SPAN || Math.abs(value.upperY) > MAX_SPAN
  ) return null;
  return {
    lowerRadius: value.lowerRadius,
    upperRadius: value.upperRadius,
    lowerY: value.lowerY,
    upperY: value.upperY,
  };
}

function isStackEdge(child: PartInstance): boolean {
  return child.attach === 'stack-top' || child.attach === 'stack-bottom';
}

function radiusAtFace(def: PartDef, top: boolean): number | null {
  if (def.shape.kind === 'cylinder' || def.shape.kind === 'cone') {
    return top
      ? def.shape.radiusTop ?? def.shape.radiusBottom ?? null
      : def.shape.radiusBottom ?? def.shape.radiusTop ?? null;
  }
  if (def.shape.kind === 'capsule' || def.shape.kind === 'dome') {
    return def.shape.radiusBottom ?? def.shape.radiusTop ?? null;
  }
  const width = def.shape.width ?? 0;
  const depth = def.shape.depth ?? 0;
  return Math.max(width, depth) > 0 ? Math.max(width, depth) / 2 : null;
}

function radiallyAligned(a: PartInstance, b: PartInstance): boolean {
  return Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z) <= MAX_RADIAL_OFFSET;
}

function upright(part: PartInstance): boolean {
  const { x, y, z, w } = part.rotation;
  if (![x, y, z, w].every(Number.isFinite)) return false;
  const upY = 1 - 2 * (x * x + z * z);
  return upY >= MIN_UP_DOT;
}

function stackNeighbors(craft: Craft, part: PartInstance): PartInstance[] {
  const neighbors: PartInstance[] = [];
  if (part.parentKey !== null && isStackEdge(part)) {
    const parent = craft.parts.find((candidate) => candidate.key === part.parentKey);
    if (parent) neighbors.push(parent);
  }
  for (const candidate of craft.parts) {
    if (candidate.parentKey === part.key && isStackEdge(candidate)) neighbors.push(candidate);
  }
  return neighbors;
}

/**
 * Resolve a fitted M-to-S shell from the connected stack. The upper walk skips
 * engines so the shroud closes against the upper tank rather than the engine bell.
 */
export function deriveInterstageShroud(
  craft: Craft,
  separator: PartInstance,
): InterstageShroudSpec | null {
  const separatorDef = defOf(separator);
  if (!separatorDef.decoupler?.interstage || separatorDef.decoupler.mode !== 'separator') return null;
  if (!upright(separator)) return null;

  const immediate = stackNeighbors(craft, separator)
    .filter((part) => radiallyAligned(separator, part) && upright(part));
  const lowerCandidates = immediate.filter((part) => part.position.y < separator.position.y - 1e-4);
  const upperCandidates = immediate.filter((part) => part.position.y > separator.position.y + 1e-4);
  if (lowerCandidates.length !== 1 || upperCandidates.length !== 1) return null;

  const lower = lowerCandidates[0];
  let upper = upperCandidates[0];
  let previous = separator;
  const visited = new Set<number>([separator.key]);
  for (let step = 0; step < MAX_WALK_PARTS && defOf(upper).engine; step++) {
    if (visited.has(upper.key)) return null;
    visited.add(upper.key);
    const next = stackNeighbors(craft, upper).filter((candidate) => (
      candidate.key !== previous.key
      && candidate.position.y > upper.position.y + 1e-4
      && radiallyAligned(separator, candidate)
      && upright(candidate)
    ));
    if (next.length !== 1) return null;
    previous = upper;
    upper = next[0];
  }
  if (defOf(upper).engine || visited.has(upper.key)) return null;

  const lowerDef = defOf(lower);
  const upperDef = defOf(upper);
  const lowerRadius = radiusAtFace(lowerDef, true);
  const upperRadius = radiusAtFace(upperDef, false);
  if (lowerRadius === null || upperRadius === null || Math.abs(lowerRadius - upperRadius) < 0.025) return null;

  const spec = sanitizeInterstageShroudSpec({
    lowerRadius,
    upperRadius,
    lowerY: lower.position.y + lowerDef.shape.height / 2 - separator.position.y,
    upperY: upper.position.y - upperDef.shape.height / 2 - separator.position.y,
  });
  return spec;
}

/** Snapshot every live fitted interstage before graph partitioning mutates its neighbors. */
export function snapshotInterstageShrouds(craft: Craft): void {
  for (const part of craft.parts) {
    const spec = deriveInterstageShroud(craft, part);
    if (spec) part.interstageShroud = spec;
  }
}
