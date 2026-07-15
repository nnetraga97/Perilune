import type { VectorCoordinates } from '../bodyRenderer';
import { terrainFaceToDirection } from './chunkGeometry';
import { nextTerrainSplitState, screenSpaceErrorPixels, type TerrainQualityPolicy } from './terrainPolicy';
import type { PlanetSurfaceProvider, TerrainTileDescriptor } from './surfaceProvider';
import { edgeNeighbor, terrainTileKey, terrainTileParent, type TerrainTileEdge } from './tile';
import {
  LAUNCH_PAD_MAX_LOD_RADIUS,
  LAUNCH_PAD_MAX_LOD_STREAM_DISTANCE,
  LAUNCH_SITE_LAT,
  LAUNCH_SITE_LON,
} from '../../sim/launchSite';

export interface TerrainSelectionFrame {
  readonly cameraBodyFixed: VectorCoordinates;
  readonly cameraBodyFixedVelocity: VectorCoordinates;
  /** Camera forward direction in body-fixed coordinates. Omit to disable view-cone culling. */
  readonly viewDirectionBodyFixed?: VectorCoordinates;
  /** Extra angular coverage retained outside the vertical field of view for quick camera turns. */
  readonly viewMarginRadians?: number;
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
  readonly screenSpaceErrors: ReadonlyMap<string, number>;
}

export type TerrainVisibilityPredicate = (
  tile: Readonly<TerrainTileDescriptor>,
  bounds: Readonly<TerrainTileBoundingSphere>,
) => boolean;

const EDGES = ['west', 'east', 'south', 'north'] as const;
const BOUNDING_SPHERE_CACHE = new WeakMap<object, Map<string, TerrainTileBoundingSphere>>();
const NEIGHBOR_ANCESTOR_CACHE = new WeakMap<object, Map<TerrainTileEdge, readonly string[]>>();
const MAX_BOUNDING_SPHERE_CACHE_ENTRIES = 20_000;
export const DEFAULT_TERRAIN_VIEW_MARGIN_RADIANS = Math.PI / 4;

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
  let providerCache = BOUNDING_SPHERE_CACHE.get(provider);
  if (!providerCache) {
    providerCache = new Map();
    BOUNDING_SPHERE_CACHE.set(provider, providerCache);
  }
  const cached = providerCache.get(tile.key);
  if (cached) {
    providerCache.delete(tile.key);
    providerCache.set(tile.key, cached);
    return cached;
  }
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
  const result = Object.freeze({ center, radius, angularRadius });
  if (providerCache.size >= MAX_BOUNDING_SPHERE_CACHE_ENTRIES) {
    const oldest = providerCache.keys().next().value as string | undefined;
    if (oldest !== undefined) providerCache.delete(oldest);
  }
  providerCache.set(tile.key, result);
  return result;
}

export function terrainTileHorizonCulled(
  provider: Readonly<PlanetSurfaceProvider>,
  tile: Readonly<TerrainTileDescriptor>,
  bounds: Readonly<TerrainTileBoundingSphere>,
  camera: Readonly<VectorCoordinates>,
): boolean {
  if (tile.id.depth < 2) return false;
  const cameraDistance = Math.hypot(camera.x, camera.y, camera.z);
  const occluderRadius = Math.max(0, provider.radiusMeters + provider.displacementBounds.minimumHeightMeters);
  if (cameraDistance <= occluderRadius || occluderRadius <= 0) return false;

  const toTile = {
    x: bounds.center.x - camera.x,
    y: bounds.center.y - camera.y,
    z: bounds.center.z - camera.z,
  };
  const tileDistance = Math.hypot(toTile.x, toTile.y, toTile.z);
  if (tileDistance <= bounds.radius) return false;
  const inverseTileDistance = 1 / tileDistance;
  const inverseCameraDistance = 1 / cameraDistance;
  const separationCos = Math.max(-1, Math.min(1,
    (-camera.x * toTile.x - camera.y * toTile.y - camera.z * toTile.z)
      * inverseCameraDistance * inverseTileDistance,
  ));
  const separation = Math.acos(separationCos);
  const occluderAngularRadius = Math.asin(Math.min(1, occluderRadius / cameraDistance));
  const tileAngularRadius = Math.asin(Math.min(1, bounds.radius / tileDistance));
  const tangentDistance = Math.sqrt(Math.max(0, cameraDistance * cameraDistance - occluderRadius * occluderRadius));
  return separation + tileAngularRadius < occluderAngularRadius
    && tileDistance - bounds.radius > tangentDistance;
}

function viewConeCulled(
  tile: Readonly<TerrainTileDescriptor>,
  bounds: Readonly<TerrainTileBoundingSphere>,
  frame: Readonly<TerrainSelectionFrame>,
): boolean {
  if (tile.id.depth < 3) return false;
  const view = frame.viewDirectionBodyFixed;
  if (!view) return false;
  const viewLength = Math.hypot(view.x, view.y, view.z);
  if (viewLength < 1e-9) return false;
  const toTile = {
    x: bounds.center.x - frame.cameraBodyFixed.x,
    y: bounds.center.y - frame.cameraBodyFixed.y,
    z: bounds.center.z - frame.cameraBodyFixed.z,
  };
  const tileDistance = Math.hypot(toTile.x, toTile.y, toTile.z);
  if (tileDistance <= bounds.radius) return false;
  const directionCos = Math.max(-1, Math.min(1,
    dot(view, toTile) / (viewLength * tileDistance),
  ));
  const centerAngle = Math.acos(directionCos);
  const tileAngularRadius = Math.asin(Math.min(1, bounds.radius / tileDistance));
  const retainedHalfAngle = Math.min(
    Math.PI,
    frame.verticalFovRadians / 2
      + (frame.viewMarginRadians ?? DEFAULT_TERRAIN_VIEW_MARGIN_RADIANS),
  );
  return centerAngle - tileAngularRadius > retainedHalfAngle;
}

export function selectTerrainDetail(
  provider: Readonly<PlanetSurfaceProvider>,
  quality: Readonly<TerrainQualityPolicy>,
  frame: Readonly<TerrainSelectionFrame>,
  previousSplitKeys: ReadonlySet<string> = new Set(),
  visible: TerrainVisibilityPredicate = () => true,
): TerrainSelectionResult {
  const leaves = new Map<string, TerrainTileDescriptor>();
  const splitKeys = new Set<string>();
  const changes: TerrainSelectionChange[] = [];
  const screenSpaceErrors = new Map<string, number>();
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
  const launchSiteDirection = provider.bodyId === 'veyra' ? {
    x: Math.cos(LAUNCH_SITE_LAT) * Math.cos(LAUNCH_SITE_LON),
    y: Math.cos(LAUNCH_SITE_LAT) * Math.sin(LAUNCH_SITE_LON),
    z: Math.sin(LAUNCH_SITE_LAT),
  } : null;
  const launchSiteDetailActive = launchSiteDirection !== null && Math.hypot(
    frame.cameraBodyFixed.x - launchSiteDirection.x * provider.radiusMeters,
    frame.cameraBodyFixed.y - launchSiteDirection.y * provider.radiusMeters,
    frame.cameraBodyFixed.z - launchSiteDirection.z * provider.radiusMeters,
  ) <= LAUNCH_PAD_MAX_LOD_STREAM_DISTANCE;
  const launchPadCellTargetMeters = quality.gridResolution >= 33
    ? 2
    : quality.gridResolution >= 17 ? 4 : 8;
  const launchPadTargetDepth = Math.min(
    provider.maximumDepth,
    Math.max(0, Math.ceil(Math.log2(
      (provider.radiusMeters * 2)
        / (Math.max(1, quality.gridResolution - 1) * launchPadCellTargetMeters),
    ))),
  );

  interface SplitCandidate {
    readonly tile: TerrainTileDescriptor;
    readonly screenSpaceError: number;
    readonly forced: boolean;
  }

  const candidates: SplitCandidate[] = [];
  const candidateBefore = (a: Readonly<SplitCandidate>, b: Readonly<SplitCandidate>): boolean => (
    Number(a.forced) > Number(b.forced)
      || (a.forced === b.forced && (
        a.screenSpaceError > b.screenSpaceError
          || (a.screenSpaceError === b.screenSpaceError && a.tile.key < b.tile.key)
      ))
  );
  const pushCandidate = (candidate: SplitCandidate): void => {
    candidates.push(candidate);
    let index = candidates.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!candidateBefore(candidates[index], candidates[parent])) break;
      [candidates[index], candidates[parent]] = [candidates[parent], candidates[index]];
      index = parent;
    }
  };
  const popCandidate = (): SplitCandidate | undefined => {
    const first = candidates[0];
    const last = candidates.pop();
    if (!first || !last || candidates.length === 0) return first;
    candidates[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let best = index;
      if (left < candidates.length && candidateBefore(candidates[left], candidates[best])) best = left;
      if (right < candidates.length && candidateBefore(candidates[right], candidates[best])) best = right;
      if (best === index) break;
      [candidates[index], candidates[best]] = [candidates[best], candidates[index]];
      index = best;
    }
    return first;
  };

  const recordDecision = (tile: TerrainTileDescriptor, sse: number, split: boolean): void => {
    if (split !== previousSplitKeys.has(tile.key)) {
      changes.push(Object.freeze({ key: tile.key, depth: tile.id.depth, screenSpaceError: sse, split }));
    }
  };

  const evaluate = (tile: TerrainTileDescriptor): SplitCandidate | null => {
    const bounds = terrainTileBoundingSphere(provider, tile);
    if (
      !visible(tile, bounds)
      || viewConeCulled(tile, bounds, frame)
      || terrainTileHorizonCulled(provider, tile, bounds, frame.cameraBodyFixed)
    ) return null;
    const boundDistance = Math.max(0, distance(frame.cameraBodyFixed, bounds.center) - bounds.radius);
    const sse = screenSpaceErrorPixels({
      geometricErrorMeters: tile.geometricErrorMeters,
      distanceToBoundingVolumeMeters: boundDistance,
      drawingBufferHeight: frame.drawingBufferHeight,
      verticalFovRadians: frame.verticalFovRadians,
    });
    screenSpaceErrors.set(tile.key, sse);
    const launchSiteDot = launchSiteDetailActive
      ? (
          (bounds.center.x / Math.hypot(bounds.center.x, bounds.center.y, bounds.center.z))
            * Math.cos(LAUNCH_SITE_LAT) * Math.cos(LAUNCH_SITE_LON)
          + (bounds.center.y / Math.hypot(bounds.center.x, bounds.center.y, bounds.center.z))
            * Math.cos(LAUNCH_SITE_LAT) * Math.sin(LAUNCH_SITE_LON)
          + (bounds.center.z / Math.hypot(bounds.center.x, bounds.center.y, bounds.center.z))
            * Math.sin(LAUNCH_SITE_LAT)
        )
      : -1;
    const launchSiteDistance = launchSiteDetailActive
      ? Math.acos(Math.max(-1, Math.min(1, launchSiteDot)))
      : Infinity;
    const forced = tile.id.depth < launchPadTargetDepth && launchSiteDistance
      <= bounds.angularRadius + LAUNCH_PAD_MAX_LOD_RADIUS / provider.radiusMeters;
    const wantsSplit = tile.id.depth < provider.maximumDepth
      && (forced || nextTerrainSplitState(previousSplitKeys.has(tile.key), sse, quality));
    if (!wantsSplit) recordDecision(tile, sse, false);
    return wantsSplit ? { tile, screenSpaceError: sse, forced } : null;
  };

  const roots = Array.from({ length: 6 }, (_, face) => provider.rootTile(face as 0 | 1 | 2 | 3 | 4 | 5));
  roots.sort((a, b) => {
    const ac = terrainTileBoundingSphere(provider, a).center;
    const bc = terrainTileBoundingSphere(provider, b).center;
    return dot(cameraDirection, bc) - dot(cameraDirection, ac) || a.key.localeCompare(b.key);
  });
  for (const root of roots) {
    const candidate = evaluate(root);
    if (!screenSpaceErrors.has(root.key)) continue;
    leaves.set(root.key, root);
    if (candidate) pushCandidate(candidate);
  }
  while (candidates.length > 0) {
    const candidate = popCandidate()!;
    const tile = candidate.tile;
    if (!leaves.has(tile.key)) continue;
    const children = provider.children(tile)
      .map((child) => ({ child, candidate: evaluate(child) }))
      .filter(({ child }) => screenSpaceErrors.has(child.key));
    if (children.length === 0) {
      recordDecision(tile, candidate.screenSpaceError, false);
      continue;
    }
    const leafDelta = children.length - 1;
    if (leaves.size + leafDelta > quality.maximumDesiredLeaves) {
      recordDecision(tile, candidate.screenSpaceError, false);
      continue;
    }
    leaves.delete(tile.key);
    splitKeys.add(tile.key);
    recordDecision(tile, candidate.screenSpaceError, true);
    for (const { child, candidate: childCandidate } of children) {
      leaves.set(child.key, child);
      if (childCandidate) pushCandidate(childCandidate);
    }
  }
  return Object.freeze({
    leaves: Object.freeze([...leaves.values()].sort((a, b) => a.key.localeCompare(b.key))),
    splitKeys,
    changes: Object.freeze(changes),
    screenSpaceErrors,
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

function neighborAncestorKeys(
  tile: Readonly<TerrainTileDescriptor>,
  edge: TerrainTileEdge,
): readonly string[] {
  let cachedByEdge = NEIGHBOR_ANCESTOR_CACHE.get(tile);
  if (!cachedByEdge) {
    cachedByEdge = new Map();
    NEIGHBOR_ANCESTOR_CACHE.set(tile, cachedByEdge);
  }
  const cached = cachedByEdge.get(edge);
  if (cached) return cached;
  const keys: string[] = [];
  let candidate: ReturnType<typeof edgeNeighbor> | null = edgeNeighbor(tile.id, edge);
  while (candidate) {
    keys.push(terrainTileKey(candidate));
    candidate = terrainTileParent(candidate);
  }
  const result = Object.freeze(keys);
  cachedByEdge.set(edge, result);
  return result;
}

function coarserLeafForNeighbor(
  tile: Readonly<TerrainTileDescriptor>,
  edge: TerrainTileEdge,
  leaves: ReadonlyMap<string, TerrainTileDescriptor>,
): TerrainTileDescriptor | null {
  for (const key of neighborAncestorKeys(tile, edge)) {
    const leaf = leaves.get(key);
    if (leaf) return leaf;
  }
  return null;
}

export function balanceTerrainLeaves(
  provider: Readonly<PlanetSurfaceProvider>,
  input: readonly TerrainTileDescriptor[],
): readonly TerrainTileDescriptor[] {
  const leaves = new Map(input.map((tile) => [tile.key, tile]));
  const queue = [...leaves.values()]
    .sort((a, b) => b.id.depth - a.id.depth || a.key.localeCompare(b.key))
    .map((tile) => tile.key);
  const queued = new Set(queue);
  let cursor = 0;
  let operations = 0;
  const maximumOperations = Math.max(64, input.length * (provider.maximumDepth + 1) * 8);
  const enqueue = (tile: Readonly<TerrainTileDescriptor>): void => {
    if (queued.has(tile.key)) return;
    queued.add(tile.key);
    queue.push(tile.key);
  };
  while (cursor < queue.length) {
    const key = queue[cursor++];
    queued.delete(key);
    const tile = leaves.get(key);
    if (!tile) continue;
    for (const edge of EDGES) {
      const neighbor = coarserLeafForNeighbor(tile, edge, leaves);
      if (!neighbor || tile.id.depth - neighbor.id.depth <= 1) continue;
      if (++operations > maximumOperations) throw new Error('Terrain neighbor balancing did not converge');
      if (!leaves.delete(neighbor.key)) continue;
      const children = provider.children(neighbor);
      for (const child of children) {
        leaves.set(child.key, child);
        enqueue(child);
      }
      enqueue(tile);
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
      const neighbor = coarserLeafForNeighbor(tile, edge, leaves);
      if (neighbor && tile.id.depth - neighbor.id.depth > 1) {
        violations.push(`${tile.key}:${edge}:${neighbor.key}`);
      }
    }
  }
  return Object.freeze(violations.sort());
}
