/**
 * M0 gate: planetary terrain renders from orbit to ground in a real browser
 * without visual stalls, NaNs, or unbounded memory.
 *
 * CI runs on SwiftShader (software GL), so absolute FPS is not the gate —
 * CPU-side frame cost, chunk streaming health, and stability are.
 */
import { expect, test } from '@playwright/test';

interface PerfSnapshot {
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

test('terrain descent: orbit to surface', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto('/?proto=terrain');
  await page.waitForFunction(() => (window as never as { __PERF__?: unknown }).__PERF__ !== undefined);

  // Sample perf during descent.
  const samples: PerfSnapshot[] = [];
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(2500);
    const snap = (await page.evaluate(() => (window as never as { __PERF__: unknown }).__PERF__)) as PerfSnapshot;
    samples.push(snap);
    const done = await page.evaluate(() => (window as never as { __PROTO_DONE__?: boolean }).__PROTO_DONE__);
    if (done) break;
  }

  expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);
  const last = samples[samples.length - 1];
  expect(last.frames).toBeGreaterThan(100); // it actually rendered

  // Terrain streamed in: chunks visible at ground level.
  expect(last.chunks).toBeGreaterThan(20);
  expect(last.triangles).toBeGreaterThan(10_000);

  // Simulation-side cost must be tiny (LOD selection + placement).
  const simWorst = Math.max(...samples.map((s) => s.simMs));
  expect(simWorst).toBeLessThan(30);

  // Memory must not grow without bound during the descent.
  const heaps = samples.map((s) => s.heapMB).filter((h) => h > 0);
  if (heaps.length > 3) {
    const early = heaps[Math.floor(heaps.length / 3)];
    const late = heaps[heaps.length - 1];
    expect(late).toBeLessThan(early * 2 + 200);
  }

  console.log('[terrain-proto] samples:');
  for (const s of samples) {
    console.log(
      `  fps=${s.fps.toFixed(1)} frame=${s.frameMs.toFixed(1)}ms p99=${s.frameP99.toFixed(1)}ms ` +
        `sim=${s.simMs.toFixed(2)}ms draws=${s.drawCalls} tris=${(s.triangles / 1000).toFixed(0)}k ` +
        `chunks=${s.chunks} heap=${s.heapMB.toFixed(0)}MB`,
    );
  }
});
