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
