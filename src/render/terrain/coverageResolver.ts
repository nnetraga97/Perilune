import type { TerrainRequestClass } from './terrainScheduler';
import type { PlanetSurfaceProvider, TerrainTileDescriptor } from './surfaceProvider';
import { terrainTileParent } from './tile';

export type TerrainTileState = 'unloaded' | 'queued' | 'building' | 'ready' | 'installed' | 'failed';

export interface TerrainTileRecord {
  readonly tile: TerrainTileDescriptor;
  readonly state: TerrainTileState;
  readonly generation: number;
  readonly materialGeneration: number;
  readonly gpuValid: boolean;
}

export interface TerrainCoverageRequest {
  readonly tile: TerrainTileDescriptor;
  readonly requestClass: TerrainRequestClass;
  readonly reason: 'root' | 'replacement' | 'continuity';
}

export interface TerrainCoverageResolution {
  readonly renderedKeys: ReadonlySet<string>;
  readonly fallbackKeys: ReadonlySet<string>;
  readonly continuityKeys: ReadonlySet<string>;
  /** Installed replacement quadrants retained until their complete sibling set is ready. */
  readonly stagingKeys: ReadonlySet<string>;
  readonly protectionKeys: ReadonlySet<string>;
  readonly requests: readonly TerrainCoverageRequest[];
  readonly rootsReady: boolean;
  readonly completeCoverage: boolean;
}

export function isTerrainTileRenderable(
  record: Readonly<TerrainTileRecord> | undefined,
  generation: number,
  materialGeneration: number,
): boolean {
  return record?.state === 'installed'
    && record.generation === generation
    && record.materialGeneration === materialGeneration
    && record.gpuValid;
}

function isDescendant(
  candidate: Readonly<TerrainTileDescriptor>,
  ancestor: Readonly<TerrainTileDescriptor>,
): boolean {
  if (candidate.id.face !== ancestor.id.face || candidate.id.depth < ancestor.id.depth) return false;
  const scale = 2 ** (candidate.id.depth - ancestor.id.depth);
  return Math.floor(candidate.id.x / scale) === ancestor.id.x
    && Math.floor(candidate.id.y / scale) === ancestor.id.y;
}

const REQUEST_RANK: Readonly<Record<TerrainRequestClass, number>> = Object.freeze({
  'coverage-blocker': 0,
  'previous-frame-continuity': 1,
  'visible-refinement': 2,
  'predicted-refinement': 3,
  background: 4,
});

export function resolveTerrainCoverage(input: {
  readonly provider: PlanetSurfaceProvider;
  readonly desiredLeaves: readonly TerrainTileDescriptor[];
  readonly records: ReadonlyMap<string, TerrainTileRecord>;
  readonly previousRenderedKeys: ReadonlySet<string>;
  readonly generation: number;
  readonly materialGeneration: number;
}): TerrainCoverageResolution {
  const {
    provider, desiredLeaves, records, previousRenderedKeys, generation, materialGeneration,
  } = input;
  const desiredLeafKeys = new Set(desiredLeaves.map((tile) => tile.key));
  const desiredBranches = new Set<string>();
  for (const leaf of desiredLeaves) {
    let current: TerrainTileDescriptor | null = leaf;
    while (current) {
      desiredBranches.add(current.key);
      const parent = terrainTileParent(current.id);
      current = parent ? provider.tile(parent) : null;
    }
  }
  const renderedKeys = new Set<string>();
  const fallbackKeys = new Set<string>();
  const continuityKeys = new Set<string>();
  const stagingKeys = new Set<string>();
  const requests = new Map<string, TerrainCoverageRequest>();

  const renderable = (tile: Readonly<TerrainTileDescriptor>): boolean => (
    isTerrainTileRenderable(records.get(tile.key), generation, materialGeneration)
  );

  const request = (
    tile: TerrainTileDescriptor,
    requestClass: TerrainRequestClass,
    reason: TerrainCoverageRequest['reason'],
  ): void => {
    if (renderable(tile)) return;
    const existing = requests.get(tile.key);
    if (existing && REQUEST_RANK[existing.requestClass] <= REQUEST_RANK[requestClass]) return;
    requests.set(tile.key, Object.freeze({ tile, requestClass, reason }));
  };

  const hasRecordedDescendant = (tile: TerrainTileDescriptor): boolean => {
    for (const record of records.values()) {
      if (record.tile.id.depth > tile.id.depth && isDescendant(record.tile, tile)) return true;
    }
    return false;
  };

  const completeInstalledCover = (tile: TerrainTileDescriptor): readonly string[] | null => {
    if (renderable(tile)) return Object.freeze([tile.key]);
    if (tile.id.depth >= provider.maximumDepth || !hasRecordedDescendant(tile)) return null;
    const covered: string[] = [];
    for (const child of provider.children(tile)) {
      const quadrant = completeInstalledCover(child);
      if (!quadrant) return null;
      covered.push(...quadrant);
    }
    return Object.freeze(covered);
  };

  const previousCompleteCover = (tile: TerrainTileDescriptor): readonly string[] | null => {
    if (previousRenderedKeys.has(tile.key) && renderable(tile)) return Object.freeze([tile.key]);
    const hasPreviousDescendant = [...previousRenderedKeys].some((key) => {
      const record = records.get(key);
      return record && record.tile.id.depth > tile.id.depth && isDescendant(record.tile, tile);
    });
    if (!hasPreviousDescendant || tile.id.depth >= provider.maximumDepth) return null;
    const covered: string[] = [];
    for (const child of provider.children(tile)) {
      const quadrant = previousCompleteCover(child);
      if (!quadrant) return null;
      covered.push(...quadrant);
    }
    return Object.freeze(covered);
  };

  const useCover = (keys: readonly string[], fallback: boolean): void => {
    for (const key of keys) {
      renderedKeys.add(key);
      if (fallback) fallbackKeys.add(key);
    }
  };

  const resolve = (
    tile: TerrainTileDescriptor,
    inheritedFallback: readonly string[] | null,
  ): boolean => {
    const directCover = completeInstalledCover(tile);
    if (desiredLeafKeys.has(tile.key)) {
      if (renderable(tile)) {
        renderedKeys.add(tile.key);
        return true;
      }
      const previous = previousCompleteCover(tile);
      if (previous) {
        useCover(previous, false);
        for (const key of previous) continuityKeys.add(key);
        request(tile, 'previous-frame-continuity', 'continuity');
        return true;
      }
      if (directCover) {
        useCover(directCover, true);
        request(tile, 'coverage-blocker', 'replacement');
        return true;
      }
      if (inheritedFallback) {
        useCover(inheritedFallback, true);
        request(tile, 'coverage-blocker', 'replacement');
        return true;
      }
      request(tile, 'coverage-blocker', 'replacement');
      return false;
    }

    const children = provider.children(tile);
    const replacementCovers = children.map(completeInstalledCover);
    if (replacementCovers.some((cover) => cover === null)) {
      for (let index = 0; index < children.length; index++) {
        const cover = replacementCovers[index];
        if (!cover) request(children[index], 'coverage-blocker', 'replacement');
        else for (const key of cover) stagingKeys.add(key);
      }
      const fallback = directCover ?? inheritedFallback;
      if (!fallback) return false;
      useCover(fallback, true);
      return true;
    }

    let complete = true;
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (!desiredBranches.has(child.key)) continue;
      complete = resolve(child, replacementCovers[index]) && complete;
    }
    if (complete) return true;
    const fallback = directCover ?? inheritedFallback;
    if (!fallback) return false;
    useCover(fallback, true);
    return true;
  };

  const roots = Array.from({ length: 6 }, (_, face) => provider.rootTile(face as 0 | 1 | 2 | 3 | 4 | 5));
  const rootsReady = roots.every(renderable);
  for (const root of roots) {
    if (!renderable(root)) request(root, 'coverage-blocker', 'root');
  }
  let completeCoverage = desiredLeaves.length > 0;
  for (const root of roots) {
    if (!desiredBranches.has(root.key)) continue;
    completeCoverage = resolve(root, completeInstalledCover(root)) && completeCoverage;
  }

  const protectionKeys = new Set([
    ...renderedKeys,
    ...fallbackKeys,
    ...continuityKeys,
    ...stagingKeys,
    ...(rootsReady ? roots.map((root) => root.key) : []),
  ]);
  return Object.freeze({
    renderedKeys,
    fallbackKeys,
    continuityKeys,
    stagingKeys,
    protectionKeys,
    requests: Object.freeze([...requests.values()].sort((a, b) => (
      REQUEST_RANK[a.requestClass] - REQUEST_RANK[b.requestClass]
      || a.tile.key.localeCompare(b.tile.key)
    ))),
    rootsReady,
    completeCoverage: rootsReady && completeCoverage,
  });
}
