import { describe, expect, it, vi } from 'vitest';
import { RenderDiagnostics } from '../src/render/renderDiagnostics';

describe('RenderDiagnostics', () => {
  it('records lightweight entries but gates detailed entries and samples', () => {
    const medium = new RenderDiagnostics({ quality: 'medium', detailed: false, now: () => 10 });
    medium.record({ subsystem: 'renderer', event: 'started', severity: 'state' });
    medium.recordDetailed({ subsystem: 'terrain', event: 'chunk', severity: 'state' });
    medium.sample('terrain', { subsystem: 'terrain', event: 'sample', severity: 'sample' });
    expect(medium.snapshot().entries.map((entry) => entry.event)).toEqual(['started']);
    expect(medium.snapshot().configuration).toMatchObject({ quality: 'medium', detailed: false });

    const high = new RenderDiagnostics({ quality: 'high', detailed: true, now: () => 10 });
    high.recordDetailed({ subsystem: 'terrain', event: 'chunk', severity: 'state' });
    expect(high.snapshot().entries).toHaveLength(1);
  });

  it('caps samples at 10 Hz independently per producer key', () => {
    let now = 0;
    const diagnostics = new RenderDiagnostics({ quality: 'high', detailed: true, now: () => now });
    const sample = (key: string) => diagnostics.sample(key, { subsystem: 'terrain', event: key, severity: 'sample' });
    sample('terrain');
    sample('cloud-weather');
    now = 99;
    sample('terrain');
    sample('cloud-weather');
    now = 100;
    sample('terrain');
    sample('cloud-weather');
    expect(diagnostics.snapshot().entries.map((entry) => entry.event)).toEqual([
      'terrain', 'cloud-weather', 'terrain', 'cloud-weather',
    ]);
  });

  it('keeps chronological order, overwrite counts, and monotonic sequence numbers', () => {
    let now = 0;
    const diagnostics = new RenderDiagnostics({ quality: 'medium', detailed: false, capacity: 4_096, now: () => now++ });
    for (let index = 0; index < 4_098; index++) {
      diagnostics.record({ subsystem: 'renderer', event: `entry-${index}`, severity: 'state' });
    }
    const snapshot = diagnostics.snapshot();
    expect(snapshot.entries).toHaveLength(4_096);
    expect(snapshot.overwrittenEntries).toBe(2);
    expect(snapshot.sequence).toBe(4_098);
    expect(snapshot.entries[0]).toMatchObject({ sequence: 3, event: 'entry-2' });
    expect(snapshot.entries.at(-1)).toMatchObject({ sequence: 4_098, event: 'entry-4097' });
  });

  it('returns frozen isolated snapshots and matching JSON', () => {
    const diagnostics = new RenderDiagnostics({ quality: 'medium', detailed: false, now: () => 1 });
    diagnostics.record({ subsystem: 'assets', event: 'loaded', severity: 'state', data: { channel: 'albedo' } });
    const first = diagnostics.snapshot();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.entries)).toBe(true);
    expect(Object.isFrozen(first.entries[0].data)).toBe(true);
    expect(() => ((first.entries[0].data as Record<string, unknown>).channel = 'changed')).toThrow();
    expect(JSON.parse(diagnostics.exportJson())).toEqual(diagnostics.snapshot());
  });

  it('downloads through one local object URL and always revokes it', () => {
    const click = vi.fn();
    const createElement = vi.fn(() => ({ href: '', download: '', click }) as unknown as HTMLAnchorElement);
    const createObjectURL = vi.fn(() => 'blob:diagnostics');
    const revokeObjectURL = vi.fn();
    const diagnostics = new RenderDiagnostics({
      quality: 'high', detailed: true, now: () => 1,
      document: { createElement } as Pick<Document, 'createElement'>,
      url: { createObjectURL, revokeObjectURL },
    });
    diagnostics.download();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:diagnostics');
  });

  it('deduplicates warnings by anomaly code', () => {
    const warn = vi.fn();
    const diagnostics = new RenderDiagnostics({ quality: 'medium', detailed: false, now: () => 1, warn });
    diagnostics.anomaly('coverage-gap', 'terrain');
    diagnostics.anomaly('coverage-gap', 'terrain');
    expect(warn).toHaveBeenCalledOnce();
    expect(diagnostics.snapshot().anomalyCodes).toEqual(['coverage-gap']);
  });

  it('isolates throwing input access and clock failures', () => {
    let throwClock = false;
    const diagnostics = new RenderDiagnostics({ quality: 'medium', detailed: false, now: () => {
      if (throwClock) throw new Error('clock');
      return 1;
    } });
    const data = Object.defineProperty({}, 'bad', { enumerable: true, get: () => { throw new Error('getter'); } });
    diagnostics.record({ subsystem: 'renderer', event: 'bad-data', severity: 'state', data: data as never });
    throwClock = true;
    diagnostics.record({ subsystem: 'renderer', event: 'bad-clock', severity: 'state' });
    expect(diagnostics.snapshot().recordingFailures).toBeGreaterThanOrEqual(2);
  });

  it('detects transition, terrain, and cloud anomalies without throwing', () => {
    let now = 0;
    const warn = vi.fn();
    const diagnostics = new RenderDiagnostics({ quality: 'high', detailed: true, now: () => now, warn });
    const baseTransition = {
      bodyId: 'veyra', rendererIdentity: 'renderer-a', requestedPresentation: 'terrain' as const, state: 'fading' as const,
      progress: 0.8, compactCoverage: 0.2, terrainCoverage: 0.8, coverageReady: true,
      gapCount: 0, prewarm: true, visibleBand: true, framePressure: false,
      compactVisible: true, terrainVisible: true, terrainVisibleChunks: 10,
    };
    diagnostics.observeTransition(baseTransition);
    now = 100;
    diagnostics.observeTransition({ ...baseTransition, state: 'prewarming', progress: 0.1, compactCoverage: 0.2, terrainCoverage: 0.2, coverageReady: false });
    diagnostics.observeTerrainSample({
      bodyId: 'veyra', terrainRequested: true, generation: 1, visible: 2, chunks: 2,
      triangles: 10, geometryBytes: 100, pending: 1, oldestPendingAgeMs: 2_001,
      coverageGaps: 1, coverageReady: false, replacementRoots: 0, workers: 2,
      activeWorkers: 1, queuedWorkers: 1, scheduleMs: 1, installMs: 1, buildP99Ms: 2,
    });
    diagnostics.observeCloudShell({
      bodyId: 'veyra', rendererIdentity: 'renderer-a', shell: 'weather', classification: 'outside', radius: 1,
      shellAltitude: 10, signedDistance: 20, opacity: 2, baseOpacity: 0.46,
      side: 'front', materialVersion: 1, textureIdentity: 'texture-a', visible: true,
      renderOrder: 31, driftAngle: 0,
    });
    expect(diagnostics.snapshot().anomalyCodes).toEqual(expect.arrayContaining([
      'transition-progress-regressed',
      'transition-rollback-without-request-change',
      'transition-combined-coverage-gap',
      'transition-coverage-readiness-lost',
      'terrain-job-pending-over-two-seconds',
      'cloud-opacity-out-of-range',
    ]));
  });

  it('detects every machine-checkable terrain streaming invariant', () => {
    let now = 0;
    const diagnostics = new RenderDiagnostics({ quality: 'high', detailed: true, sampleIntervalMs: 0, now: () => now++ });
    const baseline = {
      bodyId: 'veyra', terrainRequested: true, generation: 1, visible: 6, chunks: 6,
      triangles: 10, geometryBytes: 90, reservedBytes: 10, allocationBytes: 100,
      pending: 0, oldestPendingAgeMs: 0, coverageGaps: 0, coverageReady: true,
      rootsReady: true, replacementRoots: 0, workers: 2, activeWorkers: 0,
      queuedWorkers: 0, scheduleMs: 1, installMs: 1, buildP99Ms: 2,
      balanceViolations: 0, incompleteTransitions: 0, protectedEvictions: 0,
      immediateReplacements: 0,
    };
    diagnostics.observeTerrainSample(baseline);
    diagnostics.observeTerrainSample({
      ...baseline,
      rootsReady: false,
      coverageGaps: 1,
      coverageReady: false,
      geometryBytes: 101,
      reservedBytes: 1,
      balanceViolations: 1,
      incompleteTransitions: 1,
      protectedEvictions: 1,
      immediateReplacements: 1,
    });
    expect(diagnostics.snapshot().anomalyCodes).toEqual(expect.arrayContaining([
      'terrain-incomplete-root-coverage',
      'terrain-protected-eviction',
      'terrain-reservation-violation',
      'terrain-neighbor-depth-violation',
      'terrain-transition-incomplete',
      'terrain-immediate-replacement',
      'terrain-coverage-readiness-lost',
    ]));
    diagnostics.observeTerrainSample({ ...baseline, coverageGaps: 1 });
    expect(diagnostics.snapshot().anomalyCodes).toContain('terrain-incomplete-branch-coverage');
  });

  it('preserves lifecycle batches beyond the ordinary diagnostic text limit', () => {
    const diagnostics = new RenderDiagnostics({ quality: 'high', detailed: true, now: () => 1 });
    const events = Array.from({ length: 20 }, (_, index) => JSON.stringify({
      event: 'visibility-on',
      key: `0:8:${index.toFixed(6)}:-1.000000`,
      detail: 'x'.repeat(40),
    })).join('\n');
    expect(events.length).toBeGreaterThan(500);
    diagnostics.recordDetailed({
      subsystem: 'terrain', event: 'terrain-lifecycle-batch', severity: 'state', data: { events },
    });
    expect(diagnostics.snapshot().entries[0].data.events).toBe(events);
  });

  it('does not report a repeat request after the installed chunk was evicted', () => {
    const warn = vi.fn();
    const diagnostics = new RenderDiagnostics({ quality: 'high', detailed: true, now: () => 1, warn });
    const observation = { bodyId: 'veyra', rendererIdentity: 'renderer-a', key: '1:0:-1.000000:-1.000000', generation: 1 };
    diagnostics.observeTerrainEvent({ ...observation, event: 'request' });
    diagnostics.observeTerrainEvent({ ...observation, event: 'installed' });
    diagnostics.observeTerrainEvent({ ...observation, event: 'evicted' });
    diagnostics.observeTerrainEvent({ ...observation, event: 'request' });
    expect(diagnostics.snapshot().anomalyCodes).not.toContain('terrain-repeat-request-after-install');
    expect(warn).not.toHaveBeenCalled();
  });
});
