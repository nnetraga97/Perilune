import { describe, expect, it } from 'vitest';
import { GameState } from '../src/sim/state';
import { Vec3 } from '../src/core/vec3';
import { evaluateRecipeHeight, recipeForBody } from '../src/sim/terrainRecipe';
import {
  buildTerrainChunkGeometry,
  terrainGeometryTransferables,
  type TerrainChunkGeometryRequest,
  type TerrainChunkGeometryResult,
} from '../src/render/terrain/chunkGeometry';
import {
  TerrainChunkWorkerPool,
  terrainWorkerPoolSize,
  type WorkerLike,
} from '../src/render/terrain/chunkWorkerPool';

const veyra = new GameState().universe.get('veyra');

function request(overrides: Partial<TerrainChunkGeometryRequest> = {}): TerrainChunkGeometryRequest {
  return {
    jobKey: '0:1:-1.000000:-1.000000',
    generation: 7,
    recipe: structuredClone(recipeForBody(veyra)),
    radius: veyra.radius,
    face: 0,
    u0: -1,
    v0: -1,
    size: 1,
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

describe('terrain chunk geometry builder', () => {
  it('is deterministic, floating-origin independent, and agrees across a shared edge', () => {
    const leftRequest = request();
    const rightRequest = request({ jobKey: 'right', u0: 0 });
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

  terminate(): void { this.terminated = true; }
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
});
