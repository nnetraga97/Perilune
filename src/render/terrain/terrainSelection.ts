import type { VectorCoordinates } from '../bodyRenderer';
import { terrainFaceToDirection } from './chunkGeometry';
import { nextTerrainSplitState, screenSpaceErrorPixels, type TerrainQualityPolicy } from './terrainPolicy';
import type { PlanetSurfaceProvider, TerrainTileDescriptor } from './surfaceProvider';
import { edgeNeighbor, terrainTileKey, terrainTileParent, type TerrainTileEdge } from './tile';

export interface TerrainSelectionFrame {
  readonly cameraBodyFixed: VectorCoordinates;
  readonly cameraBodyFixedVelocity: VectorCoordinates;
  readonly verticalFovRadians: number;
  readonly drawingBufferHeight: number;
}

export interface TerrainTileBoundingSphere {
  readonly center: VectorCoordinates;
  readonly radius: number;
  readonly angularRadius: number;
}

export interface TerrainSelectionChange {
  readonly key: string;
  readonly depth: number;
  readonly screenSpaceError: number;
  readonly split: boolean;
}

export interface TerrainSelectionResult {
  readonly leaves: readonly TerrainTileDescriptor[];
  readonly splitKeys: ReadonlySet<string>;
  readonly changes: readonly TerrainSelectionChange[];
}

export type TerrainVisibilityPredicate = (
  tile: Readonly<TerrainTileDescriptor>,
  bounds: Readonly<TerrainTileBoundingSphere>,
) => boolean;

const EDGES = ['west', 'east', 'south', 'north'] as const;

function dot(a: Readonly<VectorCoordinates>, b: Readonly<VectorCoordinates>): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function distance(a: Readonly<VectorCoordinates>, b: Readonly<VectorCoordinates>): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function terrainTileBoundingSphere(
  provider: Readonly<PlanetSurfaceProvider>,
  tile: Readonly<TerrainTileDescriptor>,
): TerrainTileBoundingSphere {
  const { u0, v0, size } = tile.uvBounds;
  const centerDirection = terrainFaceToDirection(tile.id.face, u0 + size / 2, v0 + size / 2);
  const minimumRadius = provider.radiusMeters + provider.displacementBounds.minimumHeightMeters;
  const maximumRadius = provider.radiusMeters + provider.displacementBounds.maximumHeightMeters;
  const centerRadius = (minimumRadius + maximumRadius) / 2;
  const center = Object.freeze({
    x: centerDirection.x * centerRadius,
    y: centerDirection.y * centerRadius,
    z: centerDirection.z * centerRadius,
  });
  let angularRadius = 0;
  let radius = 0;
  for (const u of [u0, u0 + size]) {
    for (const v of [v0, v0 + size]) {
      const direction = terrainFaceToDirection(tile.id.face, u, v);
      angularRadius = Math.max(
        angularRadius,
        Math.acos(Math.max(-1, Math.min(1, dot(centerDirection, direction)))),
      );
      for (const surfaceRadius of [minimumRadius, maximumRadius]) {
        radius = Math.max(radius, distance(center, {
          x: direction.x * surfaceRadius,
          y: direction.y * surfaceRadius,
          z: direction.z * surfaceRadius,
        }));
      }
    }
  }
  return Object.freeze({ center, radius, angularRadius });
}

function horizonCulled(
  provider: Readonly<PlanetSurfaceProvider>,
  tile: Readonly<TerrainTileDescriptor>,
  bounds: Readonly<TerrainTileBoundingSphere>,
  camera: Readonly<VectorCoordinates>,
): boolean {
  if (tile.id.depth < 3) return false;
  const cameraDistance = Math.hypot(camera.x, camera.y, camera.z);
  if (cameraDistance <= provider.radiusMeters * 1.01) return false;
  const inverseCameraDistance = 1 / cameraDistance;
  const cameraDirection = {
    x: camera.x * inverseCameraDistance,
    y: camera.y * inverseCameraDistance,
    z: camera.z * inverseCameraDistance,
  };
  const centerDistance = Math.hypot(bounds.center.x, bounds.center.y, bounds.center.z) || 1;
  const centerDirection = {
    x: bounds.center.x / centerDistance,
    y: bounds.center.y / centerDistance,
    z: bounds.center.z / centerDistance,
  };
  const horizonAngle = Math.acos(Math.min(1, provider.radiusMeters / cameraDistance));
  return dot(cameraDirection, centerDirection) < Math.cos(horizonAngle + bounds.angularRadius);
}

export function selectTerrainDetail(
  provider: Readonly<PlanetSurfaceProvider>,
  quality: Readonly<TerrainQualityPolicy>,
  frame: Readonly<TerrainSelectionFrame>,
  previousSplitKeys: ReadonlySet<string> = new Set(),
  visible: TerrainVisibilityPredicate = () => true,
): TerrainSelectionResult {
  const leaves: TerrainTileDescriptor[] = [];
  const splitKeys = new Set<string>();
  const changes: TerrainSelectionChange[] = [];
  const cameraDistance = Math.hypot(
    frame.cameraBodyFixed.x,
    frame.cameraBodyFixed.y,
    frame.cameraBodyFixed.z,
  ) || 1;
  const cameraDirection = {
    x: frame.cameraBodyFixed.x / cameraDistance,
    y: frame.cameraBodyFixed.y / cameraDistance,
    z: frame.cameraBodyFixed.z / cameraDistance,
  };

  const visit = (tile: TerrainTileDescriptor): void => {
    const bounds = terrainTileBoundingSphere(provider, tile);
    if (!visible(tile, bounds) || horizonCulled(provider, tile, bounds, frame.cameraBodyFixed)) return;
    const boundDistance = Math.max(0, distance(frame.cameraBodyFixed, bounds.center) - bounds.radius);
    const sse = screenSpaceErrorPixels({
      geometricErrorMeters: tile.geometricErrorMeters,
      distanceToBoundingVolumeMeters: boundDistance,
      drawingBufferHeight: frame.drawingBufferHeight,
      verticalFovRadians: frame.verticalFovRadians,
    });
    const previouslySplit = previousSplitKeys.has(tile.key);
    const split = tile.id.depth < provider.maximumDepth
      && nextTerrainSplitState(previouslySplit, sse, quality);
    if (split !== previouslySplit) {
      changes.push(Object.freeze({ key: tile.key, depth: tile.id.depth, screenSpaceError: sse, split }));
    }
    if (!split) {
      leaves.push(tile);
      return;
    }
    splitKeys.add(tile.key);
    for (const child of provider.children(tile)) visit(child);
  };

  const roots = Array.from({ length: 6 }, (_, face) => provider.rootTile(face as 0 | 1 | 2 | 3 | 4 | 5));
  roots.sort((a, b) => {
    const ac = terrainTileBoundingSphere(provider, a).center;
    const bc = terrainTileBoundingSphere(provider, b).center;
    return dot(cameraDirection, bc) - dot(cameraDirection, ac) || a.key.localeCompare(b.key);
  });
  for (const root of roots) visit(root);
  return Object.freeze({
    leaves: Object.freeze(leaves.sort((a, b) => a.key.localeCompare(b.key))),
    splitKeys,
    changes: Object.freeze(changes),
  });
}

export function selectPredictedTerrainDetail(
  provider: Readonly<PlanetSurfaceProvider>,
  quality: Readonly<TerrainQualityPolicy>,
  frame: Readonly<TerrainSelectionFrame>,
  previousSplitKeys: ReadonlySet<string> = new Set(),
  visible: TerrainVisibilityPredicate = () => true,
): TerrainSelectionResult {
  return selectTerrainDetail(provider, quality, {
    ...frame,
    cameraBodyFixed: {
      x: frame.cameraBodyFixed.x + frame.cameraBodyFixedVelocity.x * quality.predictionSeconds,
      y: frame.cameraBodyFixed.y + frame.cameraBodyFixedVelocity.y * quality.predictionSeconds,
      z: frame.cameraBodyFixed.z + frame.cameraBodyFixedVelocity.z * quality.predictionSeconds,
    },
  }, previousSplitKeys, visible);
}

function coarserLeafForNeighbor(
  neighborAtDepth: ReturnType<typeof edgeNeighbor>,
  leaves: ReadonlyMap<string, TerrainTileDescriptor>,
): TerrainTileDescriptor | null {
  let candidate: ReturnType<typeof edgeNeighbor> | null = neighborAtDepth;
  while (candidate) {
    const leaf = leaves.get(terrainTileKey(candidate));
    if (leaf) return leaf;
    candidate = terrainTileParent(candidate);
  }
  return null;
}

export function balanceTerrainLeaves(
  provider: Readonly<PlanetSurfaceProvider>,
  input: readonly TerrainTileDescriptor[],
): readonly TerrainTileDescriptor[] {
  const leaves = new Map(input.map((tile) => [tile.key, tile]));
  let changed = true;
  let passes = 0;
  while (changed) {
    changed = false;
    if (++passes > provider.maximumDepth * 8 + 8) {
      throw new Error('Terrain neighbor balancing did not converge');
    }
    for (const tile of [...leaves.values()].sort((a, b) => b.id.depth - a.id.depth || a.key.localeCompare(b.key))) {
      for (const edge of EDGES) {
        const neighbor = coarserLeafForNeighbor(edgeNeighbor(tile.id, edge), leaves);
        if (!neighbor || tile.id.depth - neighbor.id.depth <= 1) continue;
        leaves.delete(neighbor.key);
        for (const child of provider.children(neighbor)) leaves.set(child.key, child);
        changed = true;
        break;
      }
      if (changed) break;
    }
  }
  return Object.freeze([...leaves.values()].sort((a, b) => a.key.localeCompare(b.key)));
}

export function terrainNeighborDepthViolations(
  leavesInput: readonly TerrainTileDescriptor[],
): readonly string[] {
  const leaves = new Map(leavesInput.map((tile) => [tile.key, tile]));
  const violations: string[] = [];
  for (const tile of leaves.values()) {
    for (const edge of EDGES as readonly TerrainTileEdge[]) {
      const neighbor = coarserLeafForNeighbor(edgeNeighbor(tile.id, edge), leaves);
      if (neighbor && tile.id.depth - neighbor.id.depth > 1) {
        violations.push(`${tile.key}:${edge}:${neighbor.key}`);
      }
    }
  }
  return Object.freeze(violations.sort());
}
