import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { GameState } from '../src/sim/state';
import { Vec3 } from '../src/core/vec3';
import { launchPadTerrainEnvelope } from '../src/sim/terrain';
import { LAUNCH_PAD_FOOTPRINT_RADIUS, launchSiteBodyFixedDirection } from '../src/sim/launchSite';
import { evaluateRecipeHeight, recipeForBody } from '../src/sim/terrainRecipe';
import {
  buildTerrainChunkGeometry,
  terrainFaceToDirection,
  terrainGeometryTransferables,
  type TerrainChunkGeometryRequest,
  type TerrainChunkGeometryResult,
} from '../src/render/terrain/chunkGeometry';
import {
  TerrainChunkWorkerPool,
  terrainWorkerPoolSize,
  type WorkerLike,
} from '../src/render/terrain/chunkWorkerPool';
import { handleTerrainChunkWorkerRequest } from '../src/render/terrain/chunkWorker';
import {
  CUBE_FACE_BASES,
  createTerrainTileId,
  terrainTileUvBounds,
  type TerrainTileId,
} from '../src/render/terrain/tile';
import { PLANET_QUALITY, PlanetRenderer, terrainChunkKeyInfo } from '../src/render/planet';

const veyra = new GameState().universe.get('veyra');

describe('terrain chunk diagnostic keys', () => {
  it('derives stable parent and four immediate-child keys for roots and deeper chunks', () => {
    const root = terrainChunkKeyInfo('0:0:-1.000000:-1.000000');
    expect(root.parentKey).toBeNull();
    expect(root.childKeys).toEqual([
      '0:1:-1.000000:-1.000000', '0:1:0.000000:-1.000000',
      '0:1:-1.000000:0.000000', '0:1:0.000000:0.000000',
    ]);
    const deeper = terrainChunkKeyInfo('5:3:-0.500000:0.250000');
    expect(deeper.parentKey).toBe('5:2:-0.500000:0.000000');
    expect(deeper.childKeys).toHaveLength(4);
    expect(() => terrainChunkKeyInfo('invalid')).toThrow(/invalid terrain chunk key/i);
  });
});

function request(overrides: Partial<TerrainChunkGeometryRequest> = {}): TerrainChunkGeometryRequest {
  return {
    jobKey: '0:1:-1.000000:-1.000000',
    generation: 7,
    tile: createTerrainTileId(0, 1, 0, 0),
    recipe: structuredClone(recipeForBody(veyra)),
    radius: veyra.radius,
    resolution: 9,
    skirtDepth: 12,
    palette: {
      low: [0.2, 0.3, 0.1],
      mid: [0.4, 0.5, 0.2],
      high: [0.8, 0.8, 0.7],
      ocean: [0.05, 0.1, 0.2],
    },
    ...overrides,
  };
}

function bytes(view: ArrayBufferView): number[] {
  return Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
}

function absolutePosition(result: TerrainChunkGeometryResult, vertex: number): [number, number, number] {
  return [
    result.origin[0] + result.position[vertex * 3],
    result.origin[1] + result.position[vertex * 3 + 1],
    result.origin[2] + result.position[vertex * 3 + 2],
  ];
}

function tileAtDirection(direction: Readonly<Vec3>, depth: number): TerrainTileId {
  let face = 0;
  let faceScale = -Infinity;
  for (let candidate = 0; candidate < 6; candidate++) {
    const normal = CUBE_FACE_BASES[candidate as 0 | 1 | 2 | 3 | 4 | 5].n;
    const scale = direction.x * normal[0] + direction.y * normal[1] + direction.z * normal[2];
    if (scale > faceScale) {
      face = candidate;
      faceScale = scale;
    }
  }
  const basis = CUBE_FACE_BASES[face as 0 | 1 | 2 | 3 | 4 | 5];
  const u = Math.atan(
    (direction.x * basis.u[0] + direction.y * basis.u[1] + direction.z * basis.u[2]) / faceScale,
  ) / (Math.PI / 4);
  const v = Math.atan(
    (direction.x * basis.v[0] + direction.y * basis.v[1] + direction.z * basis.v[2]) / faceScale,
  ) / (Math.PI / 4);
  const count = 2 ** depth;
  return createTerrainTileId(
    face,
    depth,
    Math.max(0, Math.min(count - 1, Math.floor((u + 1) / 2 * count))),
    Math.max(0, Math.min(count - 1, Math.floor((v + 1) / 2 * count))),
  );
}

function rayMeshAltitude(
  result: TerrainChunkGeometryResult,
  direction: Readonly<Vec3>,
  radius: number,
  resolution: number,
): number {
  let nearest = Infinity;
  const gridIndexCount = (resolution - 1) ** 2 * 6;
  for (let start = 0; start < gridIndexCount; start += 3) {
    const triangle = [result.index[start], result.index[start + 1], result.index[start + 2]];
    const [a, b, c] = triangle.map((vertex) => absolutePosition(result, vertex));
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const p = [
      direction.y * e2[2] - direction.z * e2[1],
      direction.z * e2[0] - direction.x * e2[2],
      direction.x * e2[1] - direction.y * e2[0],
    ];
    const determinant = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(determinant) < 1e-9) continue;
    const t = [-a[0], -a[1], -a[2]];
    const u = (t[0] * p[0] + t[1] * p[1] + t[2] * p[2]) / determinant;
    if (u < 0 || u > 1) continue;
    const q = [
      t[1] * e1[2] - t[2] * e1[1],
      t[2] * e1[0] - t[0] * e1[2],
      t[0] * e1[1] - t[1] * e1[0],
    ];
    const v = (direction.x * q[0] + direction.y * q[1] + direction.z * q[2]) / determinant;
    if (v < 0 || u + v > 1) continue;
    const distance = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / determinant;
    if (distance > 0) nearest = Math.min(nearest, distance);
  }
  return nearest - radius;
}

describe('terrain chunk geometry builder', () => {
  it('keeps the launchpad footprint above interpolated terrain at every LOD', () => {
    const site = launchSiteBodyFixedDirection(new Vec3());
    const east = new Vec3(-site.y, site.x, 0).normalize();
    const north = Vec3.cross(site, east, new Vec3()).normalize();
    const footprint = [site];
    for (let index = 0; index < 8; index++) {
      const angle = index / 8 * Math.PI * 2;
      footprint.push(site.clone()
        .addScaled(east, Math.cos(angle) * LAUNCH_PAD_FOOTPRINT_RADIUS / veyra.radius)
        .addScaled(north, Math.sin(angle) * LAUNCH_PAD_FOOTPRINT_RADIUS / veyra.radius)
        .normalize());
    }
    const deckHeight = launchPadTerrainEnvelope(veyra).deckHeight;
    for (const resolution of [9, 17, 33]) {
      for (let depth = 0; depth <= 16; depth++) {
        const chunks = new Map<string, TerrainChunkGeometryResult>();
        for (const direction of footprint) {
          const tile = tileAtDirection(direction, depth);
          const key = `${tile.face}/${tile.depth}/${tile.x}/${tile.y}`;
          let chunk = chunks.get(key);
          if (!chunk) {
            chunk = buildTerrainChunkGeometry(request({ jobKey: key, tile, resolution }));
            chunks.set(key, chunk);
          }
          expect(rayMeshAltitude(chunk, direction, veyra.radius, resolution), `resolution ${resolution}, depth ${depth}`)
            .toBeLessThanOrEqual(deckHeight + 0.1);
        }
      }
    }
  });

  it('is deterministic, floating-origin independent, and agrees across a shared edge', () => {
    const leftRequest = request();
    const rightRequest = request({ jobKey: 'right', tile: createTerrainTileId(0, 1, 1, 0) });
    const left = buildTerrainChunkGeometry(leftRequest);
    // A camera floating-origin change is deliberately absent from the serializable request.
    const rebuiltAfterFloatingOriginChange = buildTerrainChunkGeometry(structuredClone(leftRequest));
    const right = buildTerrainChunkGeometry(rightRequest);

    for (const field of ['position', 'normal', 'color', 'bodyDirection', 'bodyFixedDetailAnchor', 'index'] as const) {
      expect(bytes(rebuiltAfterFloatingOriginChange[field])).toEqual(bytes(left[field]));
    }
    for (let row = 0; row < leftRequest.resolution; row++) {
      const leftVertex = row * leftRequest.resolution + leftRequest.resolution - 1;
      const rightVertex = row * rightRequest.resolution;
      const leftAbsolute = absolutePosition(left, leftVertex);
      const rightAbsolute = absolutePosition(right, rightVertex);
      for (let axis = 0; axis < 3; axis++) {
        // Local positions are intentionally f32 while origins remain f64.
        expect(leftAbsolute[axis]).toBeCloseTo(rightAbsolute[axis], 0);
      }
      expect(Array.from(left.normal.slice(leftVertex * 3, leftVertex * 3 + 3)))
        .toEqual(Array.from(right.normal.slice(rightVertex * 3, rightVertex * 3 + 3)));
    }
  });

  it('matches a smaller central-difference normal on named deep Veyra relief', () => {
    // This depth-16 interior sample has substantial deterministic relief and
    // exposed the former 1e-5 UV floor, which crossed roughly ten grid cells.
    const tile = createTerrainTileId(0, 16, 12_345, 23_456);
    const resolution = 33;
    const input = request({ jobKey: 'deep-normal-reference', tile, resolution });
    const result = buildTerrainChunkGeometry(input);
    const rebuilt = buildTerrainChunkGeometry(structuredClone(input));
    const { u0, v0, size } = terrainTileUvBounds(tile);
    const cellUvSize = size / (resolution - 1);
    const column = 2;
    const row = 26;
    const u = u0 + cellUvSize * column;
    const v = v0 + cellUvSize * row;
    const referenceEpsilon = cellUvSize / 64;
    const recipe = input.recipe;

    const surfacePoint = (sampleU: number, sampleV: number): Vec3 => {
      const direction = terrainFaceToDirection(tile.face, sampleU, sampleV, new Vec3());
      return direction.scale(input.radius + evaluateRecipeHeight(recipe, direction));
    };
    const tangentU = surfacePoint(u + referenceEpsilon, v)
      .sub(surfacePoint(u - referenceEpsilon, v));
    const tangentV = surfacePoint(u, v + referenceEpsilon)
      .sub(surfacePoint(u, v - referenceEpsilon));
    const referenceNormal = Vec3.cross(tangentU, tangentV, new Vec3()).normalize();
    const outward = terrainFaceToDirection(tile.face, u, v, new Vec3());
    if (referenceNormal.dot(outward) < 0) referenceNormal.negate();

    const offset = (row * resolution + column) * 3;
    const actualNormal = new Vec3(
      result.normal[offset], result.normal[offset + 1], result.normal[offset + 2],
    ).normalize();
    const angularErrorDegrees = Math.acos(Math.max(-1, Math.min(1,
      actualNormal.dot(referenceNormal),
    ))) * 180 / Math.PI;

    expect(Math.abs(evaluateRecipeHeight(recipe, outward))).toBeGreaterThan(1_000);
    expect(angularErrorDegrees).toBeLessThan(0.001);
    expect(bytes(rebuilt.normal)).toEqual(bytes(result.normal));
  });

  it('preserves raw seafloor height and matches the shared evaluator at every grid vertex', () => {
    const input = request({ resolution: 17 });
    const result = buildTerrainChunkGeometry(input);
    let sawSeafloor = false;
    for (let vertex = 0; vertex < input.resolution ** 2; vertex++) {
      const direction = new Vec3(
        result.bodyDirection[vertex * 3],
        result.bodyDirection[vertex * 3 + 1],
        result.bodyDirection[vertex * 3 + 2],
      ).normalize();
      const expectedHeight = evaluateRecipeHeight(input.recipe, direction);
      const absolute = absolutePosition(result, vertex);
      const actualHeight = Math.hypot(...absolute) - input.radius;
      expect(actualHeight).toBeCloseTo(expectedHeight, 0);
      if (expectedHeight < 0) {
        sawSeafloor = true;
        expect(actualHeight).toBeLessThan(0);
      }
    }
    expect(sawSeafloor).toBe(true);
  });

  it('uses 8192-meter body-fixed detail anchors and valid skirt indices', () => {
    const input = request();
    const result = buildTerrainChunkGeometry(input);
    const gridVertices = input.resolution ** 2;
    const totalVertices = gridVertices + input.resolution * 4;
    expect(result.bodyFixedDetailAnchor).toHaveLength(totalVertices * 3);
    for (let axis = 0; axis < 3; axis++) {
      const periodicOrigin = ((result.origin[axis] % 8192) + 8192) % 8192;
      expect(result.bodyFixedDetailAnchor[axis])
        .toBeCloseTo(result.position[axis] + periodicOrigin, 0);
    }
    expect(result.index.length).toBe((input.resolution - 1) ** 2 * 6 + (input.resolution - 1) * 4 * 6);
    expect(Math.max(...result.index)).toBeLessThan(totalVertices);
    expect(Math.min(...result.index)).toBeGreaterThanOrEqual(0);
    expect(result.bounds.radius).toBeGreaterThan(0);
    expect(result.buildMs).toBeGreaterThanOrEqual(0);
    expect(terrainGeometryTransferables(result)).toEqual([
      result.position.buffer,
      result.normal.buffer,
      result.color.buffer,
      result.bodyDirection.buffer,
      result.bodyFixedDetailAnchor.buffer,
      result.index.buffer,
    ]);
  });

  it('winds every skirt wall outward so front-face culling keeps the crack curtain visible', () => {
    const input = request();
    const result = buildTerrainChunkGeometry(input);
    const skirtBase = input.resolution ** 2;
    const originLength = Math.hypot(...result.origin) || 1;
    const radial = result.origin.map((component) => component / originLength);
    let skirtTriangles = 0;
    for (let start = 0; start < result.index.length; start += 3) {
      const triangle = [result.index[start], result.index[start + 1], result.index[start + 2]];
      if (!triangle.some((vertex) => vertex >= skirtBase)) continue;
      skirtTriangles++;
      const [a, b, c] = triangle.map((vertex) => [
        result.position[vertex * 3],
        result.position[vertex * 3 + 1],
        result.position[vertex * 3 + 2],
      ]);
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const normal = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const centroid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
      // Positions are chunk-origin relative, so the centroid minus its radial
      // component points from the chunk center toward the edge the wall sits on.
      const radialComponent = centroid[0] * radial[0] + centroid[1] * radial[1] + centroid[2] * radial[2];
      const outward = [
        centroid[0] - radial[0] * radialComponent,
        centroid[1] - radial[1] * radialComponent,
        centroid[2] - radial[2] * radialComponent,
      ];
      const facing = normal[0] * outward[0] + normal[1] * outward[1] + normal[2] * outward[2];
      expect(facing).toBeGreaterThan(0);
    }
    expect(skirtTriangles).toBe((input.resolution - 1) * 4 * 2);
  });
});

class ControlledWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<TerrainChunkGeometryResult>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: TerrainChunkGeometryRequest[] = [];
  terminated = false;

  postMessage(message: TerrainChunkGeometryRequest): void {
    this.posted.push(message);
  }

  complete(result = buildTerrainChunkGeometry(this.posted.at(-1)!)): void {
    this.onmessage?.({ data: result } as MessageEvent<TerrainChunkGeometryResult>);
  }

  fail(message = 'worker failed'): void {
    this.onerror?.({ message } as ErrorEvent);
  }

  terminate(): void { this.terminated = true; }
}

class ThrowOnceWorker extends ControlledWorker {
  private shouldThrow = true;

  override postMessage(message: TerrainChunkGeometryRequest): void {
    if (this.shouldThrow) {
      this.shouldThrow = false;
      throw new Error('clone failed');
    }
    super.postMessage(message);
  }
}

describe('TerrainChunkWorkerPool', () => {
  it('bounds production concurrency and rejects duplicate job keys', async () => {
    expect(terrainWorkerPoolSize(1)).toBe(1);
    expect(terrainWorkerPoolSize(4)).toBe(3);
    expect(terrainWorkerPoolSize(64)).toBe(4);
    const workers: ControlledWorker[] = [];
    const pool = new TerrainChunkWorkerPool({
      size: 2,
      workerFactory: () => {
        const worker = new ControlledWorker();
        workers.push(worker);
        return worker;
      },
    });
    const first = pool.submit(request({ jobKey: 'duplicate' }));
    await expect(pool.submit(request({ jobKey: 'duplicate' }))).rejects.toThrow(/duplicate/i);
    expect(workers.reduce((sum, worker) => sum + worker.posted.length, 0)).toBe(1);
    workers.find((worker) => worker.posted.length > 0)!.complete();
    await expect(first).resolves.toMatchObject({ jobKey: 'duplicate', generation: 7 });
    expect(pool.drainCompleted()).toHaveLength(1);
    expect(pool.timings()).toMatchObject({ workers: 2, pending: 0, active: 0 });
    pool.dispose();
  });

  it('cancels generations, discards stale completions, and rejects queued work on dispose', async () => {
    const worker = new ControlledWorker();
    const pool = new TerrainChunkWorkerPool({ size: 1, workerFactory: () => worker });
    const stale = pool.submit(request({ jobKey: 'stale', generation: 1 }));
    const queued = pool.submit(request({ jobKey: 'queued', generation: 2 }));
    pool.cancelGeneration(1);
    await expect(stale).rejects.toThrow(/cancel/i);
    worker.complete();
    expect(pool.drainCompleted()).toEqual([]);
    expect(worker.posted.at(-1)?.jobKey).toBe('queued');
    pool.dispose();
    await expect(queued).rejects.toThrow(/disposed/i);
    expect(worker.terminated).toBe(true);
  });

  it('reports executor capacity and cancels only work that has not reached a worker', async () => {
    const worker = new ControlledWorker();
    const pool = new TerrainChunkWorkerPool({ size: 1, workerFactory: () => worker });
    expect(pool.availableSlots()).toBe(1);
    const active = pool.submit(request({ jobKey: 'active' }));
    const queued = pool.submit(request({ jobKey: 'queued' }));
    expect(pool.availableSlots()).toBe(0);
    expect(pool.cancelQueued('active', 7)).toBe(false);
    expect(pool.cancelQueued('queued', 7)).toBe(true);
    await expect(queued).rejects.toThrow(/cancelled before dispatch/i);
    worker.complete();
    await expect(active).resolves.toMatchObject({ jobKey: 'active' });
    expect(pool.availableSlots()).toBe(1);
    pool.dispose();
  });

  it('rejects synchronous postMessage failures and continues dispatching', async () => {
    const worker = new ThrowOnceWorker();
    const pool = new TerrainChunkWorkerPool({ size: 1, workerFactory: () => worker });
    const failed = pool.submit(request({ jobKey: 'cannot-clone' }));
    const recovered = pool.submit(request({ jobKey: 'recovered' }));
    await expect(failed).rejects.toThrow(/clone failed/i);
    expect(worker.posted.map((posted) => posted.jobKey)).toEqual(['recovered']);
    worker.complete();
    await expect(recovered).resolves.toMatchObject({ jobKey: 'recovered' });
    expect(pool.timings()).toMatchObject({ pending: 0, active: 0 });
    pool.dispose();
  });

  it('replaces an errored worker within the respawn budget, then retires the pool', async () => {
    const workers: ControlledWorker[] = [];
    const pool = new TerrainChunkWorkerPool({
      size: 1,
      workerFactory: () => {
        const worker = new ControlledWorker();
        workers.push(worker);
        return worker;
      },
    });

    const first = pool.submit(request({ jobKey: 'first' }));
    workers[0].fail('boom');
    await expect(first).rejects.toThrow('boom');
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);

    const second = pool.submit(request({ jobKey: 'second' }));
    workers[1].complete();
    await expect(second).resolves.toMatchObject({ jobKey: 'second' });
    expect(pool.timings().workers).toBe(1);

    const third = pool.submit(request({ jobKey: 'third' }));
    workers[1].fail('boom again');
    await expect(third).rejects.toThrow('boom again');
    expect(workers).toHaveLength(3);

    // The bounded budget (2 per slot) is now exhausted: the next failure
    // retires the slot instead of spawning a replacement.
    const fourth = pool.submit(request({ jobKey: 'fourth' }));
    workers[2].fail('dead');
    await expect(fourth).rejects.toThrow('dead');
    expect(workers).toHaveLength(3);
    expect(pool.timings().workers).toBe(0);
    await expect(pool.submit(request({ jobKey: 'fifth' }))).rejects.toThrow(/no live workers/);
    pool.dispose();
  });

  it('does not let a stale active error reject a same-key replacement generation', async () => {
    const worker = new ControlledWorker();
    const pool = new TerrainChunkWorkerPool({ size: 1, workerFactory: () => worker });
    const stale = pool.submit(request({ jobKey: 'same-key', generation: 1 }));
    pool.cancelGeneration(1);
    await expect(stale).rejects.toThrow(/cancel/i);
    const replacement = pool.submit(request({ jobKey: 'same-key', generation: 2 }));

    worker.fail('stale generation failed');
    expect(worker.posted.map(({ generation }) => generation)).toEqual([1, 2]);
    worker.complete();

    await expect(replacement).resolves.toMatchObject({ jobKey: 'same-key', generation: 2 });
    expect(pool.drainCompleted()).toEqual([
      expect.objectContaining({ jobKey: 'same-key', generation: 2 }),
    ]);
    expect(pool.timings()).toMatchObject({ pending: 0, active: 0 });
    pool.dispose();
  });
});

describe('terrain chunk worker entry', () => {
  it('posts the built result with every geometry buffer in its transfer list', () => {
    const postMessage = vi.fn();
    handleTerrainChunkWorkerRequest(request(), postMessage);
    expect(postMessage).toHaveBeenCalledOnce();
    const [result, transfers] = postMessage.mock.calls[0] as [TerrainChunkGeometryResult, ArrayBuffer[]];
    expect(result).toMatchObject({ jobKey: request().jobKey, generation: request().generation });
    expect(transfers).toEqual([
      result.position.buffer,
      result.normal.buffer,
      result.color.buffer,
      result.bodyDirection.buffer,
      result.bodyFixedDetailAnchor.buffer,
      result.index.buffer,
    ]);
  });
});

function updateRenderer(renderer: PlanetRenderer): void {
  renderer.update(
    { x: veyra.radius * 100, y: 0, z: 0 },
    { x: 0, y: 0, z: 0, w: 1 },
    { x: 0, y: 0, z: 0 },
  );
}

function terrainMeshes(renderer: PlanetRenderer): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  renderer.engine.group.traverse((child) => {
    if (child instanceof THREE.Mesh) meshes.push(child);
  });
  return meshes;
}

describe('PlanetRenderer shared-engine facade', () => {
  it('streams all roots through the owned worker pool before reporting coverage', () => {
    const workers: ControlledWorker[] = [];
    const pool = new TerrainChunkWorkerPool({
      size: 6,
      workerFactory: () => {
        const worker = new ControlledWorker();
        workers.push(worker);
        return worker;
      },
    });
    const renderer = new PlanetRenderer(
      veyra,
      { ...PLANET_QUALITY.low, buildBudget: 6 },
      { workerPool: pool, oceanEnabled: false },
    );
    updateRenderer(renderer);
    expect(renderer.coverageReady()).toBe(false);
    for (const worker of workers) worker.complete();
    for (let frame = 0; frame < 12 && !renderer.coverageReady(); frame++) updateRenderer(renderer);
    const roots = terrainMeshes(renderer).filter((mesh) => mesh.userData.terrainTileId.depth === 0);
    expect(roots).toHaveLength(6);
    expect(roots.every((mesh) => mesh.geometry.getAttribute('position').count === 117)).toBe(true);
    expect(renderer.coverageReady()).toBe(true);
    renderer.dispose();
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });

  it('uses renderer replacement rather than mutating quality in place', () => {
    const low = new PlanetRenderer(veyra, PLANET_QUALITY.low, { oceanEnabled: false });
    updateRenderer(low);
    updateRenderer(low);
    const lowRoots = terrainMeshes(low).filter((mesh) => mesh.userData.terrainTileId.depth === 0);
    const high = new PlanetRenderer(veyra, PLANET_QUALITY.high, { oceanEnabled: false });
    updateRenderer(high);
    updateRenderer(high);
    const highRoots = terrainMeshes(high).filter((mesh) => mesh.userData.terrainTileId.depth === 0);
    expect(lowRoots.every((mesh) => mesh.geometry.getAttribute('position').count === 117)).toBe(true);
    expect(highRoots.every((mesh) => mesh.geometry.getAttribute('position').count === 1221)).toBe(true);
    expect(low.group.children.length).toBeGreaterThan(0);
    low.dispose();
    high.dispose();
  });

  it('discards late work after facade disposal', () => {
    const worker = new ControlledWorker();
    const renderer = new PlanetRenderer(veyra, PLANET_QUALITY.low, {
      workerPool: new TerrainChunkWorkerPool({ size: 1, workerFactory: () => worker }),
      oceanEnabled: false,
    });
    updateRenderer(renderer);
    renderer.dispose();
    worker.complete();
    expect(renderer.group.children).toHaveLength(0);
    expect(terrainMeshes(renderer)).toHaveLength(0);
  });
});
