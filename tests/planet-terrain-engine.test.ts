import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { AUREN_SYSTEM } from '../src/content/system';
import { Body } from '../src/sim/universe';
import { PlanetTerrainEngine, type PlanetTerrainFrame } from '../src/render/terrain/planetTerrainEngine';
import { type TerrainQualityPolicy } from '../src/render/terrain/terrainPolicy';
import { createBodySurfaceProvider } from '../src/render/terrain/surfaceProvider';
import {
  TerrainChunkWorkerPool,
  type WorkerLike,
} from '../src/render/terrain/chunkWorkerPool';
import {
  buildTerrainChunkGeometry,
  type TerrainChunkGeometryRequest,
  type TerrainChunkGeometryResult,
} from '../src/render/terrain/chunkGeometry';
import { RenderDiagnostics } from '../src/render/renderDiagnostics';

function policy(overrides: Partial<TerrainQualityPolicy> = {}): TerrainQualityPolicy {
  return Object.freeze({
    gridResolution: 5,
    maximumSsePixels: 3,
    mergeSsePixels: 2,
    submissionsPerFrame: 6,
    schedulingBudgetMs: 2,
    installationBudgetMs: 2,
    maximumWorkers: 2,
    maximumDesiredLeaves: 96,
    predictionSeconds: 0.5,
    normalTransitionSeconds: 0.35,
    pressureTransitionSeconds: 0.2,
    softResidencyRatio: 0.75,
    hardReservationRatio: 1,
    ...overrides,
  });
}

function provider(generation = 1, maximumDepth = 2) {
  const definition = structuredClone(AUREN_SYSTEM.find((candidate) => candidate.id === 'palla')!);
  definition.id = `engine-flat-${generation}`;
  definition.radius = 1_000;
  definition.terrain.amplitude = 0;
  return createBodySurfaceProvider(new Body(definition, null), {
    generation,
    gridResolution: 5,
    maximumDepth,
  });
}

function frame(
  generation = 1,
  cameraBodyFixed = { x: 1_150, y: 0, z: 0 },
): PlanetTerrainFrame {
  return {
    cameraBodyFixed,
    cameraBodyFixedVelocity: { x: 0, y: 0, z: 0 },
    cameraRelativeOrigin: { x: -cameraBodyFixed.x, y: -cameraBodyFixed.y, z: -cameraBodyFixed.z },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    verticalFovRadians: Math.PI / 3,
    drawingBufferHeight: 1_080,
    deltaSeconds: 1 / 60,
    framePressure: false,
    generation,
  };
}

function updateUntilReady(engine: PlanetTerrainEngine, input: PlanetTerrainFrame, limit = 24): void {
  for (let iteration = 0; iteration < limit && !engine.coverageReady(); iteration++) {
    engine.update(input);
  }
}

class ManualWorker implements WorkerLike {
  onmessage: ((event: MessageEvent<TerrainChunkGeometryResult>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: TerrainChunkGeometryRequest[] = [];
  terminated = false;

  postMessage(message: TerrainChunkGeometryRequest): void { this.posted.push(message); }

  complete(index = this.posted.length - 1): void {
    this.onmessage?.({ data: buildTerrainChunkGeometry(this.posted[index]) } as MessageEvent<TerrainChunkGeometryResult>);
  }

  emit(result: TerrainChunkGeometryResult): void {
    this.onmessage?.({ data: result } as MessageEvent<TerrainChunkGeometryResult>);
  }

  fail(message = 'synthetic worker failure'): void {
    this.onerror?.({ message } as ErrorEvent);
  }

  terminate(): void { this.terminated = true; }
}

describe('PlanetTerrainEngine', () => {
  it('establishes and permanently retains all six roots before reporting readiness', () => {
    const surface = provider(1, 2);
    const diagnostics = new RenderDiagnostics({
      quality: 'medium', detailed: true, sampleIntervalMs: 0, now: () => performance.now(),
    });
    const engine = new PlanetTerrainEngine({
      provider: surface,
      quality: policy(),
      material: new THREE.MeshBasicMaterial(),
      terrainAllocationBytes: 250_000,
      diagnostics,
      diagnosticSource: 'engine-test',
    });

    expect(engine.coverageReady()).toBe(false);
    updateUntilReady(engine, frame());
    expect(engine.coverageReady()).toBe(true);
    expect(engine.stats.rootsReady).toBe(true);
    expect(engine.stats.coverageGaps).toBe(0);
    expect(Object.isFrozen(engine.stats)).toBe(true);
    const snapshot = diagnostics.snapshot();
    const samples = snapshot.entries.filter((entry) => entry.event === 'terrain-sample');
    expect(samples.at(-1)?.data).toMatchObject({
      rootsReady: true,
      coverageGaps: 0,
      balanceViolations: 0,
      allocationBytes: 250_000,
    });
    expect(snapshot.entries.some((entry) => (
      entry.event === 'terrain-lifecycle-batch'
      && String(entry.data.events).includes('0/0/0/0')
    ))).toBe(true);
    expect(snapshot.anomalyCodes).not.toEqual(expect.arrayContaining([
      'terrain-incomplete-root-coverage',
      'terrain-incomplete-branch-coverage',
      'terrain-protected-eviction',
      'terrain-reservation-violation',
      'terrain-neighbor-depth-violation',
      'terrain-transition-incomplete',
    ]));
    for (let face = 0; face < 6; face++) {
      expect(engine.group.getObjectByName(`terrain:${surface.rootTile(face as 0 | 1 | 2 | 3 | 4 | 5).key}`))
        .toBeDefined();
    }

    engine.dispose();
  });

  it('defers ready results when the installation budget expires', () => {
    let time = 0;
    const engine = new PlanetTerrainEngine({
      provider: provider(1, 0),
      quality: policy({ installationBudgetMs: 1 }),
      material: new THREE.MeshBasicMaterial(),
      terrainAllocationBytes: 100_000,
      now: () => {
        time += 0.6;
        return time;
      },
    });

    engine.update(frame());
    engine.update(frame());
    expect(engine.stats.chunks).toBe(1);
    expect(engine.stats.ready).toBe(5);
    updateUntilReady(engine, frame());
    expect(engine.coverageReady()).toBe(true);
    engine.dispose();
  });

  it('contains worker failure, retries, and tolerates reversed camera demand', async () => {
    let time = 0;
    const workers: ManualWorker[] = [];
    const pool = new TerrainChunkWorkerPool({
      size: 2,
      workerFactory: () => {
        const worker = new ManualWorker();
        workers.push(worker);
        return worker;
      },
    });
    const engine = new PlanetTerrainEngine({
      provider: provider(1, 1),
      quality: policy(),
      material: new THREE.MeshBasicMaterial(),
      terrainAllocationBytes: 250_000,
      workerPool: pool,
      now: () => time,
    });

    expect(() => engine.update(frame())).not.toThrow();
    workers[0].fail();
    await Promise.resolve();
    time = 300;
    expect(() => engine.update(frame(1, { x: -1_150, y: 0, z: 0 }))).not.toThrow();
    expect(workers.some((worker, index) => index >= 2 && worker.posted.length > 0)).toBe(true);

    for (let iteration = 0; iteration < 20 && !engine.coverageReady(); iteration++) {
      for (const worker of workers) {
        if (worker.posted.length > 0) worker.complete();
      }
      time += 16;
      const x = iteration % 2 === 0 ? 1_150 : -1_150;
      engine.update(frame(1, { x, y: 0, z: 0 }));
    }
    expect(engine.coverageReady()).toBe(true);
    expect(engine.stats.coverageGaps).toBe(0);
    engine.dispose();
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });

  it('contains an invalid completed geometry and requeues its covered tile', () => {
    const worker = new ManualWorker();
    const pool = new TerrainChunkWorkerPool({ size: 1, workerFactory: () => worker });
    const engine = new PlanetTerrainEngine({
      provider: provider(1, 0),
      quality: policy(),
      material: new THREE.MeshBasicMaterial(),
      terrainAllocationBytes: 100_000,
      workerPool: pool,
    });

    engine.update(frame());
    const invalid = {
      ...buildTerrainChunkGeometry(worker.posted[0]),
      position: null as unknown as Float32Array,
    };
    worker.emit(invalid);
    expect(() => engine.update(frame())).not.toThrow();
    expect(engine.stats.chunks).toBe(0);
    expect(worker.posted).toHaveLength(2);
    engine.dispose();
  });

  it('maintains complete ancestor coverage through a long surface-orbit loop under pressure', () => {
    const engine = new PlanetTerrainEngine({
      provider: provider(1, 4),
      quality: policy({ maximumDesiredLeaves: 64 }),
      material: new THREE.MeshBasicMaterial(),
      // Six root reservations fit, while another refinement reservation does not.
      terrainAllocationBytes: 22_500,
    });
    updateUntilReady(engine, frame());
    expect(engine.coverageReady()).toBe(true);

    for (let iteration = 0; iteration < 240; iteration++) {
      const phase = (iteration % 80) / 79;
      const distance = 1_080 + Math.sin(phase * Math.PI) * 20_000;
      const angle = iteration * 0.037;
      engine.update(frame(1, {
        x: Math.cos(angle) * distance,
        y: Math.sin(angle) * distance,
        z: Math.sin(angle * 0.31) * distance * 0.1,
      }));
      expect(engine.stats.coverageGaps).toBe(0);
      expect(engine.stats.rootsReady).toBe(true);
      expect(engine.stats.geometryBytes + engine.stats.reservedBytes).toBeLessThanOrEqual(22_500);
    }
    engine.dispose();
  });

  it('ignores stale frame generations and owns worker/geometry disposal but not the shared material', () => {
    const worker = new ManualWorker();
    const pool = new TerrainChunkWorkerPool({ size: 1, workerFactory: () => worker });
    const material = new THREE.MeshBasicMaterial();
    const materialDispose = vi.spyOn(material, 'dispose');
    const engine = new PlanetTerrainEngine({
      provider: provider(2, 0),
      quality: policy(),
      material,
      terrainAllocationBytes: 100_000,
      workerPool: pool,
    });

    engine.update(frame(1));
    expect(worker.posted).toHaveLength(0);
    engine.update(frame(2));
    expect(worker.posted).toHaveLength(1);
    engine.dispose();
    expect(worker.terminated).toBe(true);
    expect(materialDispose).not.toHaveBeenCalled();
    expect(engine.group.children).toHaveLength(0);
    expect(() => engine.update(frame(2))).not.toThrow();
  });
});
