# Perilune — Performance Log

Budgets, benchmark history, and profiling notes. CI target: `npm run bench`
must stay within budgets; regressions fail review.

## Frame budget (60 FPS = 16.7 ms)

| Slice | Budget |
|---|---|
| Simulation (fixed-step, amortized) | 5 ms |
| Render (draw + scene sync) | 8 ms |
| UI + input + audio | 2 ms |
| Headroom / GC | 1.7 ms |

## Benchmark history

### 2026-07-10 — M0 numerical prototypes (Node 22 V8, 4-core container)

| Benchmark | mean | p99 | budget | verdict |
|---|---|---|---|---|
| Analytic propagation ×200 vessels | 0.110 ms | 0.17 ms | 0.5 ms | ✅ 4.5× headroom |
| Universal propagation ×400 steps | 0.181 ms | 0.29 ms | 2 ms | ✅ 11× |
| stateToElements ×1000 | 0.453 ms | 0.88 ms | n/a (not per-frame) | ✅ |
| Structural pass, 150 parts | 0.094 ms | 0.37 ms | 2 ms | ✅ 21× |
| Structural pass, 500 parts | 0.340 ms | 0.97 ms | 2 ms | ✅ 5.9× |
| Mass properties, 500 parts | 0.132 ms | 0.28 ms | 1 ms | ✅ 7.6× |
| Staging/Δv analysis, 150 parts | 0.108 ms | 0.23 ms | editor-async | ✅ |

Conclusion: TypeScript numerics clear every budget (ADR-001). The dominant
frame cost will be rendering, not simulation — profiling effort goes there.

### 2026-07-10 — M0 terrain descent (headless Chromium 134, SwiftShader)

Automated descent over Veyra: 3000 km orbit → 3 m above terrain, 57 s.
Gate: no console errors, no NaN, bounded memory, healthy chunk streaming.

| Metric | Result | Gate | Verdict |
|---|---|---|---|
| Console errors / NaN states | 0 | 0 | ✅ |
| Visible chunks at ground | 79–141 draws, 50–100k tris | streams in | ✅ |
| CPU sim cost (LOD select + builds) | 0.1–8.3 ms worst | < 30 ms | ✅ |
| JS heap over full descent | 5 → ~20 MB, stable | no unbounded growth | ✅ |
| Chunk cache | ≤ 535 cached, evicting | ≤ quality cap | ✅ |

FPS on SwiftShader was 7–15 (software rasterizer, expected 10–20× below
real GPUs); with ~100 draw calls / 80k triangles the GPU-side load is far
under entry-level hardware budgets. Action item: move chunk mesh builds off
the main thread if real-device profiling shows the 8 ms build spikes.

### M0 conclusions

- Numerics: TypeScript, no WASM (ADR-001) — 5–15× headroom.
- Terrain: quadtree cube-sphere + floating origin works orbit→ground with
  crack-free skirts and stable memory (ADR-003 validated in-browser).
- Workers: **not required at current scale** (sim ≤ 8 ms worst including
  mesh builds). Revisit for chunk building + trajectory sweeps if profiling
  on target hardware demands it.
- Save serialization: craft/vessel state is plain JSON data by construction;
  round-trip is covered by the save-system unit tests in M1.
- WebGPU: detection wired (`render/context.ts`); WebGL2 baseline renders in
  CI including software GL; WebGL1 fallback path exists.

## Device tiers (to be filled from real browser profiling)

- **Baseline desktop** (2020 4–6 core, entry GPU): 1080p / Medium / 60 FPS,
  100–150-part vessel.
- **Recommended desktop** (modern midrange): 1440p / High / 60 FPS,
  200–300 parts.
- **Stress**: 500-part vessel controllable, ≥30 FPS or clearly reported
  sim-limited state.

CI environment note: headless Chromium in this container uses SwiftShader
(software GL), so absolute FPS numbers in CI are far below any real GPU;
CI perf tests therefore track *relative* regressions and CPU-side frame
cost, while tier validation numbers come from real-hardware runs.

## Planet-rendering feasibility protocol

Phase 2 uses one combined fixture before the production renderer platform is
built. The Medium fixture contains authoritative terrain, atmosphere, ocean,
two cloud scales, one shadow receiver, complementary transition overlap,
50,000 visible instanced scatter items, and 128 active physical proxies. Low
may reduce visual work but retains identical physical terrain and proxy IDs.

### Required reference machines

| Tier | CPU / GPU | Memory | Drawing buffer | Gate |
|---|---|---:|---:|---|
| Medium | Intel Core i5-1135G7 / Iris Xe 80-EU | 16 GiB dual-channel | 1920×1080 | ≥60 FPS median; frame <16.7 ms p95; submission ≤4 ms p95; terrain schedule/install ≤2 ms p95; valid GPU work ≤8 ms p95 |
| Low | Intel Core i5-8250U / UHD 620 | 16 GiB dual-channel | 1920×1080 | ≥30 FPS median; frame <33.3 ms p95 |

Both runs use AC power, the operating system's performance mode, no browser
zoom, no supersampling, and device scale 1. Record laptop model, firmware,
graphics driver, OS build, stable browser build, power mode, and sustained
package-power configuration. The application drawing buffer—not only the CSS
viewport—must report exactly 1920×1080.

Each run warms for 30 seconds, then executes three five-minute journeys. Each
journey traverses orbit, atmosphere, low flight, and surface motion. The gate
uses the median of the three frame-time medians and the worst journey p95 for
frame, renderer-submission, terrain, and GPU times. GPU results come from
`EXT_disjoint_timer_query_webgl2`, are read only after availability, and are
discarded when disjoint. Medium certification requires valid GPU samples;
software-renderer and other-device timings never substitute for either named
machine.

Example certifying commands (supply values from the machine being tested):

```bash
npm run profile:feasibility -- --mode=reference --tier=medium --reference=iris-xe --model="..." --firmware="..." --driver="..." --os="..." --power="AC performance" --sustained-power="..."
npm run profile:feasibility -- --mode=reference --tier=low --reference=uhd-620 --model="..." --firmware="..." --driver="..." --os="..." --power="AC performance" --sustained-power="..."
```

The script writes a JSON record under `artifacts/performance/`, exits nonzero
for a failing eligible reference run, and labels any other hardware
non-certifying. Reviewed reference records are moved to
`docs/performance/reference/` before Phase 2 is signed off.

All six GPU feature groups can be disabled independently with
`--disabled=terrain,atmosphere,ocean,clouds,scatter,transition` for delta
profiles. If the combined Medium fixture misses its gate, only this ordered
reduction ladder is allowed:

1. Remove Medium cloud shadows.
2. Reduce atmosphere samples from 12 to 8.
3. Remove the second cloud scale.
4. Reduce visual scatter from 50,000 to 25,000.
5. Simplify ocean glitter.

The ladder is selected with `--stage=0` through `--stage=5`. Physical terrain
and the 128 proxies are invariant. A run with disabled feature groups is a
diagnostic delta and is never eligible for certification.

### 2026-07-10 — local combined-fixture smoke run (non-certifying)

Machine: MacBook Pro (Mac15,10), Apple M3 Max (14-core CPU, 30-core GPU),
36 GiB, macOS 26.5.2 (25F84), Chrome 149.0.7827.201. The automated run used
headless Chrome, a 1920×1080 drawing buffer, the full Medium stage-0 fixture,
1.5 seconds of warm-up, and three shortened three-second journeys. Power and
sustained-package settings were not recorded, so this is deliberately not a
reference result.

| Metric | Local smoke result | Medium allocation | Observation only |
|---|---:|---:|---|
| Median FPS | 120.26 | ≥60 | within allocation |
| Worst journey frame p95 | 10.01 ms | <16.7 ms | within allocation |
| Renderer submission p95 | 0.61 ms | ≤4 ms | within allocation |
| Terrain schedule/install p95 | 3.69 ms | ≤2 ms | over; abrupt smoke transitions are a follow-up signal |
| Valid GPU-work p95 | 5.68 ms | ≤8 ms | within allocation |
| Active-body estimate | 12.33 MiB | ≤128 MiB | within allocation |
| Total-renderer estimate | 44.15 MiB | ≤384 MiB | within allocation |
| GPU query samples | 1,080 valid / 0 disjoint | valid required | available |
| Console or shader errors | 0 | 0 | clean |

This proves that the harness, counters, delayed queries, scene population,
and local rendering path work. It does **not** prove Iris Xe or UHD 620
performance. Phase 2 remains open until both full reference records pass, or
the approved design spec is revised; Phase 3 must not start before that gate.
