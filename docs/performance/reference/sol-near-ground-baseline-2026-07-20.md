# Sol Near-Ground Baseline — 2026-07-20

Baseline for `docs/superpowers/plans/2026-07-20-near-ground-visual-completion.md` before renderer implementation.

- Git SHA: `b4868a12a7dec9992c8d8b37319b69d1850fb4b3`
- Browser: Chromium through Playwright
- GPU: `ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max)`
- Drawing buffer: 1280×720 at DPR 1
- Checked planet manifest: `5ab8f88248dd149c10959a63019f0f82ef5fa38d307735821b0ad940f8c93933`
- Targeted browser result: 18/18 passed with no recorded runtime errors
- Focused unit baseline: 8 files, 59 tests passed; typecheck passed
- Medium local shadow allocation: 4 MiB per active solid-body renderer
- High local shadow allocation: 16 MiB per active solid-body renderer
- Visible scatter and scatter allocation: 0 at every captured station

## Targeted station envelope

| Tier | Station | p50 ms | p95 ms | Draws | Triangles |
|---|---|---:|---:|---:|---:|
| Medium | sun-from-earth | 8.350 | 9.510 | 2 | 256 |
| Medium | earth-moon-true-scale | 8.350 | 9.345 | 5 | 106,272 |
| Medium | earth-day-full | 8.340 | 9.275 | 4 | 94,176 |
| Medium | earth-10km | 8.385 | 9.890 | 225 | 274,720 |
| Medium | earth-1km | 8.330 | 9.250 | 134 | 216,480 |
| Medium | earth-ground | 8.320 | 9.280 | 142 | 221,600 |
| Medium | earth-ocean-horizon | 8.345 | 9.425 | 129 | 213,280 |
| Medium | moon-low-orbit | 8.325 | 9.280 | 1 | 12,096 |
| Medium | moon-surface | 8.325 | 9.280 | 167 | 106,880 |
| High | sun-from-earth | 8.330 | 9.180 | 2 | 256 |
| High | earth-moon-true-scale | 8.330 | 9.310 | 5 | 207,104 |
| High | earth-day-full | 8.335 | 9.240 | 4 | 176,704 |
| High | earth-10km | 8.325 | 9.245 | 25 | 268,416 |
| High | earth-1km | 8.330 | 9.130 | 38 | 298,368 |
| High | earth-ground | 8.330 | 9.210 | 47 | 319,104 |
| High | earth-ocean-horizon | 8.330 | 9.285 | 32 | 284,544 |
| High | moon-low-orbit | 8.335 | 9.020 | 1 | 30,400 |
| High | moon-surface | 8.365 | 17.215 | 178 | 410,112 |

High `moon-surface` p95 is the only targeted baseline substantially above the common 9–10 ms band. Treat it as a pre-existing station-specific envelope rather than attributing the value to later scatter work without a same-machine comparison.

## Artifacts

Images and JSON sidecars are under `test-results/sol-visual-reference/{medium,high}/`. The comparison set includes `sun-from-earth`, `earth-moon-true-scale`, `earth-day-full`, `earth-10km`, `earth-1km`, `earth-ground`, `earth-ocean-horizon`, `moon-low-orbit`, and `moon-surface`.
