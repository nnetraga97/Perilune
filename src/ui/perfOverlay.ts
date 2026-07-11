/**
 * In-game performance overlay (F3). Tracks frame time percentiles, sim/render
 * split, draw calls, triangles, memory. Exposes machine-readable stats on
 * window.__PERF__ for the automated test harness.
 */
import * as THREE from 'three';
import type { GpuTimerSnapshot, GpuTimingSample } from '../render/gpuTimer';

interface GpuTimerOwner {
  begin(label: string): boolean;
  end(): void;
  poll(): GpuTimingSample[];
  snapshot(): Readonly<GpuTimerSnapshot>;
  dispose(): void;
}

export interface ProductionGpuMetrics {
  readonly gpuTimingSupported: boolean;
  readonly flightGpuMs: number | null;
  readonly mapGpuMs: number | null;
  readonly gpuQueriesPending: number;
  readonly gpuQueriesValid: number;
  readonly gpuQueriesDisjoint: number;
  readonly gpuQueriesInvalid: number;
  readonly gpuQueriesUnavailable: number;
  readonly gpuQueriesSaturated: number;
}

export interface RendererPlatformMetrics {
  readonly chunks: number;
  readonly visibleChunks: number;
  readonly rendererManagers: number;
  readonly residentFlightPacks: number;
  readonly residentPackGpuBytes: number;
  readonly rendererFailures: number;
  readonly transitionActive: boolean;
  readonly transitionMs: number;
  readonly contextFallback: boolean;
}

const EMPTY_GPU_METRICS: ProductionGpuMetrics = Object.freeze({
  gpuTimingSupported: false,
  flightGpuMs: null,
  mapGpuMs: null,
  gpuQueriesPending: 0,
  gpuQueriesValid: 0,
  gpuQueriesDisjoint: 0,
  gpuQueriesInvalid: 0,
  gpuQueriesUnavailable: 0,
  gpuQueriesSaturated: 0,
});

const EMPTY_RENDERER_METRICS: RendererPlatformMetrics = Object.freeze({
  chunks: 0,
  visibleChunks: 0,
  rendererManagers: 0,
  residentFlightPacks: 0,
  residentPackGpuBytes: 0,
  rendererFailures: 0,
  transitionActive: false,
  transitionMs: 0,
  contextFallback: false,
});

/** Game-lifetime owner for delayed GPU query rings around production submissions. */
export class GpuSubmissionProfiler {
  private timer: GpuTimerOwner | null = null;
  private flightGpuMs: number | null = null;
  private mapGpuMs: number | null = null;
  private disposed = false;

  constructor(private readonly createTimer: () => GpuTimerOwner) {
    this.timer = this.allocateTimer();
  }

  submit(label: 'flight' | 'map', render: () => void): void {
    if (this.disposed) {
      render();
      return;
    }
    let needsEnd = false;
    try {
      this.timer?.begin(label);
      needsEnd = true;
    } catch {
      this.disableTimer();
    }
    try {
      render();
    } finally {
      if (needsEnd) {
        try { this.timer?.end(); } catch { this.disableTimer(); }
      }
    }
  }

  poll(): void {
    if (this.disposed) return;
    try {
      for (const sample of this.timer?.poll() ?? []) {
        if (sample.status !== 'valid') continue;
        if (sample.label === 'flight') this.flightGpuMs = sample.milliseconds;
        if (sample.label === 'map') this.mapGpuMs = sample.milliseconds;
      }
    } catch {
      this.disableTimer();
    }
  }

  metrics(): Readonly<ProductionGpuMetrics> {
    if (this.disposed) return EMPTY_GPU_METRICS;
    let snapshot: Readonly<GpuTimerSnapshot>;
    try {
      if (!this.timer) return EMPTY_GPU_METRICS;
      snapshot = this.timer.snapshot();
    } catch {
      this.disableTimer();
      return EMPTY_GPU_METRICS;
    }
    return Object.freeze({
      gpuTimingSupported: snapshot.supported,
      flightGpuMs: this.flightGpuMs,
      mapGpuMs: this.mapGpuMs,
      gpuQueriesPending: snapshot.pending,
      gpuQueriesValid: snapshot.validSamples,
      gpuQueriesDisjoint: snapshot.disjointSamples,
      gpuQueriesInvalid: snapshot.invalidSamples,
      gpuQueriesUnavailable: snapshot.unavailablePolls,
      gpuQueriesSaturated: snapshot.saturatedBegins,
    });
  }

  /** Context restoration invalidates all previous queries, even if the GL object is reused. */
  recreate(options: { readonly disposePrevious?: boolean } = {}): void {
    if (this.disposed) return;
    if (options.disposePrevious === false) this.timer = null;
    else this.disableTimer();
    this.timer = this.allocateTimer();
    this.flightGpuMs = null;
    this.mapGpuMs = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disableTimer();
  }

  private allocateTimer(): GpuTimerOwner | null {
    try { return this.createTimer(); } catch { return null; }
  }

  private disableTimer(): void {
    const timer = this.timer;
    this.timer = null;
    try { timer?.dispose(); } catch { /* the old context may reject query cleanup */ }
  }
}

export interface PerfSnapshot {
  fps: number;
  frameMs: number;
  frameP95: number;
  frameP99: number;
  worstMs: number;
  simMs: number;
  renderMs: number;
  drawCalls: number;
  triangles: number;
  chunks: number;
  heapMB: number;
  frames: number;
  drawingBufferWidth: number;
  drawingBufferHeight: number;
  estimatedGpuMB: number;
  scatterInstances: number;
  physicalProxies: number;
  disjointQueries: number;
  transitionMs: number;
  compressedDownloadBytes: number;
  rendererManagers: number;
  residentFlightPacks: number;
  residentPackGpuBytes: number;
  rendererFailures: number;
  transitionActive: boolean;
  contextFallback: boolean;
  gpuTimingSupported: boolean;
  flightGpuMs: number | null;
  mapGpuMs: number | null;
  gpuQueriesPending: number;
  gpuQueriesValid: number;
  gpuQueriesDisjoint: number;
  gpuQueriesInvalid: number;
  gpuQueriesUnavailable: number;
  gpuQueriesSaturated: number;
}

export class PerfOverlay {
  private el: HTMLDivElement;
  private frameTimes: number[] = [];
  private simMs = 0;
  private renderMs = 0;
  private extra: Record<string, number | string> = {};
  private lastUpdate = 0;
  private frames = 0;
  private rendererMetrics: RendererPlatformMetrics | null = null;
  private gpuMetrics: ProductionGpuMetrics | null = null;
  visible = false;

  constructor(uiRoot: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'perf-overlay';
    this.el.style.cssText = `
      position: absolute; top: 8px; right: 8px; padding: 8px 12px;
      background: var(--ui-bg); border: 1px solid #223240; border-radius: 6px;
      font-family: var(--ui-mono); font-size: 11px; line-height: 1.5;
      white-space: pre; display: none; z-index: 50; color: var(--ui-fg);
    `;
    uiRoot.appendChild(this.el);
    (window as unknown as { __PERF__: PerfSnapshot }).__PERF__ = this.snapshot();
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? 'block' : 'none';
  }

  beginSim(): number {
    return performance.now();
  }

  endSim(start: number): void {
    this.simMs = performance.now() - start;
  }

  endRender(start: number): void {
    this.renderMs = performance.now() - start;
  }

  setExtra(key: string, value: number | string): void {
    this.extra[key] = value;
  }

  setRendererMetrics(metrics: Readonly<RendererPlatformMetrics>): void {
    this.rendererMetrics = { ...metrics };
  }

  setGpuMetrics(metrics: Readonly<ProductionGpuMetrics>): void {
    this.gpuMetrics = { ...metrics };
  }

  frame(dtMs: number, renderer: THREE.WebGLRenderer): void {
    this.frames++;
    this.frameTimes.push(dtMs);
    if (this.frameTimes.length > 300) this.frameTimes.shift();

    const now = performance.now();
    if (now - this.lastUpdate < 250) return;
    this.lastUpdate = now;

    const snap = this.snapshot(renderer);
    (window as unknown as { __PERF__: PerfSnapshot }).__PERF__ = snap;

    if (this.visible) {
      let text =
        `FPS        ${snap.fps.toFixed(0)}\n` +
        `frame      ${snap.frameMs.toFixed(2)} ms (p95 ${snap.frameP95.toFixed(1)}, p99 ${snap.frameP99.toFixed(1)})\n` +
        `sim        ${snap.simMs.toFixed(2)} ms\n` +
        `render     ${snap.renderMs.toFixed(2)} ms\n` +
        `buffer     ${snap.drawingBufferWidth}×${snap.drawingBufferHeight}\n` +
        `draws      ${snap.drawCalls}\n` +
        `tris       ${(snap.triangles / 1000).toFixed(0)}k\n` +
        `heap       ${snap.heapMB.toFixed(0)} MB\n` +
        `renderers  ${snap.rendererManagers} managers / ${snap.residentFlightPacks} flight pack\n` +
        `pack GPU   ${(snap.residentPackGpuBytes / 1048576).toFixed(1)} MB\n` +
        `transaction ${snap.transitionActive ? 'active' : 'last'} ${snap.transitionMs.toFixed(1)} ms\n` +
        `failures   ${snap.rendererFailures}${snap.contextFallback ? ' (context fallback)' : ''}\n` +
        `GPU query  ${snap.gpuTimingSupported ? `${snap.gpuQueriesValid} valid / ${snap.gpuQueriesPending} pending / ${snap.gpuQueriesDisjoint} disjoint / ${snap.gpuQueriesInvalid} invalid / ${snap.gpuQueriesSaturated} saturated` : 'unavailable'}\n` +
        `GPU ms     flight ${snap.flightGpuMs?.toFixed(2) ?? '—'} / map ${snap.mapGpuMs?.toFixed(2) ?? '—'}`;
      for (const [k, v] of Object.entries(this.extra)) {
        text += `\n${k.padEnd(10)} ${v}`;
      }
      this.el.textContent = text;
    }
  }

  snapshot(renderer?: THREE.WebGLRenderer): PerfSnapshot {
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    const mean = sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const rendererMetrics = this.rendererMetrics ?? EMPTY_RENDERER_METRICS;
    const gpuMetrics = this.gpuMetrics ?? EMPTY_GPU_METRICS;
    return {
      fps: mean > 0 ? 1000 / mean : 0,
      frameMs: mean,
      frameP95: at(0.95),
      frameP99: at(0.99),
      worstMs: sorted[sorted.length - 1] ?? 0,
      simMs: this.simMs,
      renderMs: this.renderMs,
      drawCalls: renderer?.info.render.calls ?? 0,
      triangles: renderer?.info.render.triangles ?? 0,
      chunks: this.rendererMetrics ? rendererMetrics.visibleChunks : Number(this.extra['chunks'] ?? 0),
      heapMB: mem ? mem.usedJSHeapSize / 1048576 : 0,
      frames: this.frames,
      drawingBufferWidth: renderer?.getDrawingBufferSize(new THREE.Vector2()).x ?? 0,
      drawingBufferHeight: renderer?.getDrawingBufferSize(new THREE.Vector2()).y ?? 0,
      estimatedGpuMB: Number(this.extra['gpu MB'] ?? 0),
      scatterInstances: Number(this.extra['scatter'] ?? 0),
      physicalProxies: Number(this.extra['proxies'] ?? 0),
      disjointQueries: this.gpuMetrics ? gpuMetrics.gpuQueriesDisjoint : Number(this.extra['disjoint'] ?? 0),
      transitionMs: this.rendererMetrics ? rendererMetrics.transitionMs : Number(this.extra['transition ms'] ?? 0),
      compressedDownloadBytes: Number(this.extra['download bytes'] ?? 0),
      rendererManagers: rendererMetrics.rendererManagers,
      residentFlightPacks: rendererMetrics.residentFlightPacks,
      residentPackGpuBytes: rendererMetrics.residentPackGpuBytes,
      rendererFailures: rendererMetrics.rendererFailures,
      transitionActive: rendererMetrics.transitionActive,
      contextFallback: rendererMetrics.contextFallback,
      ...gpuMetrics,
    };
  }
}
