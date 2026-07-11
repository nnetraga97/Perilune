/**
 * In-game performance overlay (F3). Tracks frame time percentiles, sim/render
 * split, draw calls, triangles, memory. Exposes machine-readable stats on
 * window.__PERF__ for the automated test harness.
 */
import * as THREE from 'three';

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
}

export class PerfOverlay {
  private el: HTMLDivElement;
  private frameTimes: number[] = [];
  private simMs = 0;
  private renderMs = 0;
  private extra: Record<string, number | string> = {};
  private lastUpdate = 0;
  private frames = 0;
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
        `draws      ${snap.drawCalls}\n` +
        `tris       ${(snap.triangles / 1000).toFixed(0)}k\n` +
        `heap       ${snap.heapMB.toFixed(0)} MB`;
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
      chunks: Number(this.extra['chunks'] ?? 0),
      heapMB: mem ? mem.usedJSHeapSize / 1048576 : 0,
      frames: this.frames,
    };
  }
}
