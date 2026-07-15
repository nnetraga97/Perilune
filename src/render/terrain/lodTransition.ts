import { parseTerrainTileKey, terrainTileKey, terrainTileParent } from './tile';

export type TerrainLodDirection = 'split' | 'merge';

export interface TerrainLodTransitionRequest {
  readonly parentKey: string;
  readonly childKeys: readonly [string, string, string, string];
  readonly direction: TerrainLodDirection;
  readonly sourceRenderable: boolean;
  readonly destinationRenderable: boolean;
}

export interface TerrainLodTransitionSnapshot {
  readonly id: string;
  readonly parentKey: string;
  readonly childKeys: readonly [string, string, string, string];
  readonly direction: TerrainLodDirection;
  readonly progress: number;
  readonly state: 'active' | 'release-pending';
  readonly completedFrame: number | null;
}

interface MutableTransition {
  id: string;
  parentKey: string;
  childKeys: readonly [string, string, string, string];
  direction: TerrainLodDirection;
  progress: number;
  state: 'active' | 'release-pending';
  completedFrame: number | null;
}

function isAncestorOrSelf(ancestorKey: string, descendantKey: string): boolean {
  const ancestor = parseTerrainTileKey(ancestorKey);
  let current = parseTerrainTileKey(descendantKey);
  while (current.depth > ancestor.depth) current = terrainTileParent(current)!;
  return terrainTileKey(current) === terrainTileKey(ancestor);
}

function overlaps(a: Readonly<MutableTransition>, parentKey: string): boolean {
  return isAncestorOrSelf(a.parentKey, parentKey) || isAncestorOrSelf(parentKey, a.parentKey);
}

function validateRequest(request: Readonly<TerrainLodTransitionRequest>): void {
  const parent = parseTerrainTileKey(request.parentKey);
  if (new Set(request.childKeys).size !== 4) throw new Error('Terrain LOD transition requires four unique children');
  for (const childKey of request.childKeys) {
    const child = parseTerrainTileKey(childKey);
    const childParent = terrainTileParent(child);
    if (!childParent || terrainTileKey(childParent) !== terrainTileKey(parent)) {
      throw new Error(`Terrain LOD child ${childKey} is not immediate child of ${request.parentKey}`);
    }
  }
}

export class TerrainLodTransitionManager {
  private readonly transitions = new Map<string, MutableTransition>();
  private nextId = 1;

  constructor(
    private readonly normalDurationSeconds = 0.35,
    private readonly pressureDurationSeconds = 0.2,
  ) {
    if (!Number.isFinite(normalDurationSeconds) || normalDurationSeconds < 0) {
      throw new Error(`Invalid normal terrain transition duration ${normalDurationSeconds}`);
    }
    if (!Number.isFinite(pressureDurationSeconds) || pressureDurationSeconds < 0) {
      throw new Error(`Invalid pressure terrain transition duration ${pressureDurationSeconds}`);
    }
  }

  request(request: Readonly<TerrainLodTransitionRequest>): 'waiting' | 'started' | 'retained' | 'reversed' | 'serialized' {
    validateRequest(request);
    const existing = this.transitions.get(request.parentKey);
    if (existing) {
      if (existing.direction === request.direction) return 'retained';
      if (!request.sourceRenderable || !request.destinationRenderable) return 'waiting';
      existing.direction = request.direction;
      existing.state = 'active';
      existing.completedFrame = null;
      return 'reversed';
    }
    if (!request.sourceRenderable || !request.destinationRenderable) return 'waiting';
    if ([...this.transitions.values()].some((transition) => overlaps(transition, request.parentKey))) {
      return 'serialized';
    }
    this.transitions.set(request.parentKey, {
      id: `terrain-lod-${this.nextId++}`,
      parentKey: request.parentKey,
      childKeys: Object.freeze([...request.childKeys]) as unknown as readonly [string, string, string, string],
      direction: request.direction,
      progress: request.direction === 'split' ? 0 : 1,
      state: 'active',
      completedFrame: null,
    });
    return 'started';
  }

  advance(deltaSeconds: number, framePressure: boolean, frame: number): readonly TerrainLodTransitionSnapshot[] {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
      throw new Error(`Invalid terrain transition delta ${deltaSeconds}`);
    }
    if (!Number.isInteger(frame) || frame < 0) throw new Error(`Invalid terrain transition frame ${frame}`);
    for (const [key, transition] of this.transitions) {
      if (transition.state === 'release-pending') {
        if (transition.completedFrame !== null && frame > transition.completedFrame) {
          this.transitions.delete(key);
        }
        continue;
      }
      const duration = framePressure ? this.pressureDurationSeconds : this.normalDurationSeconds;
      const amount = duration > 0 ? deltaSeconds / duration : 1;
      transition.progress = Math.max(0, Math.min(
        1,
        transition.progress + (transition.direction === 'split' ? amount : -amount),
      ));
      const complete = transition.direction === 'split'
        ? transition.progress >= 1
        : transition.progress <= 0;
      if (complete) {
        transition.state = 'release-pending';
        transition.completedFrame = frame;
      }
    }
    return this.snapshots();
  }

  snapshots(): readonly TerrainLodTransitionSnapshot[] {
    return Object.freeze([...this.transitions.values()]
      .sort((a, b) => a.parentKey.localeCompare(b.parentKey))
      .map((transition) => Object.freeze({ ...transition })));
  }

  protectionKeys(): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const transition of this.transitions.values()) {
      keys.add(transition.parentKey);
      for (const child of transition.childKeys) keys.add(child);
    }
    return keys;
  }

  clear(): void { this.transitions.clear(); }
}
