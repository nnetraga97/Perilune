# Sol visual final audit — 2026-07-19

**Branch:** `feature/sol-earth-moon-visuals`
**Reference command:** `npx playwright test e2e/sol-visual-reference.spec.ts`
**Viewport:** 1280 by 720 drawing-buffer pixels, DPR 1
**Machine:** Apple M3 Max, Chrome/ANGLE Metal

## Outcome

The production visual system is now the physically scaled Sun, Earth, and Moon. Earth and Moon identity comes from pinned NASA/NOAA imagery and height products; the Sun uses an angularly correct analytic presentation. All three renderer families pass the same transactional preparation path and expose resource/transition diagnostics.

The reviewed Low, Medium, and High matrix covers 20 stations per tier: solar disk and partial lunar occultation, true-scale Earth-Moon framing, Earth day/terminator/night/limb/descent/ground/ocean, and lunar Earth-view/near/far/polar/orbit/surface views. PNGs and detailed JSON sidecars are generated under ignored `test-results/sol-visual-reference`.

The real application path also passes five production smoke cases covering menu startup, responsive layout, autosave/continue, and the complete build-launch-fly-save-load loop.

## Numeric and visual audit

- Checked scale tests enforce source radii/distances and solar apparent size. The physical camera envelope contains lunar apogee with more than 180,000 km margin.
- Fallback and KTX orientation use the same north-at-row-zero convention. Africa/Atlantic and lunar near/far landmarks were visually reviewed in the fixed stations.
- Earth daylight now presents natural Blue Marble color, a separately lit cloud layer, a narrow atmosphere limb, ocean masking/reflection, and cloud-attenuated Black Marble night emission.
- Moon near/far identity and low-angle surface relief are readable without atmospheric or blue ambient fill.
- The Sun retains the correct roughly 0.53 degree diameter at Earth distance. The occultation station separates the photospheric disk from glare/corona measurement.
- Compact displacement and streamed terrain use the same checked source macro-height authority and deterministic local relief. Local PBR coordinates/classification no longer reveal quadtree tiles as bright rectangles.
- Atmosphere and clouds include logarithmic-depth output; this fixed the prior shell occlusion failure. The High weather march uses 24 samples and denser shell tessellation. Below the weather base it fades in favor of the outer parallax layer, avoiding the diagnosed radial horizon-line artifact.
- Medium/High use stabilized local PCFSoft shadows; Low records zero shadow allocation. Terrain, vessels, and launch solids cast and receive.
- Screenshot histograms show no materially clipped white output. Deep-space stations intentionally contain large black fractions.

## Checked asset budgets

| Body/tier | Compressed transfer | Runtime authored GPU | Fallback GPU ceiling | Transient ceiling |
| --- | ---: | ---: | ---: | ---: |
| Earth Low | 1,494,603 B | 3,844,984 B | 16,777,224 B | 8,912,896 B |
| Earth Medium | 5,525,262 B | 16,777,440 B | 78,293,684 B | 41,943,040 B |
| Earth High | 20,827,921 B | 67,109,088 B | 313,174,708 B | 167,772,160 B |
| Moon Low | 1,611,274 B | 3,145,896 B | 13,981,020 B | 7,864,320 B |
| Moon Medium | 6,218,324 B | 12,583,080 B | 55,924,060 B | 31,457,280 B |
| Moon High | 23,426,732 B | 50,331,816 B | 223,696,220 B | 125,829,120 B |

The runtime validator rejects pack, combined active-renderer, and transient overages. High's active-body ceiling is explicitly 320 MiB; Low/Medium remain 64/128 MiB.

## Lifecycle and failure audit

- Repeated Earth to Moon cycles, tier replacement, and context rebuild tests leave one committed root and dispose every replaced renderer/asset owner exactly once.
- Candidate asset, preparation, shader compile, coverage, or budget failure retains the prior committed renderer.
- LUTs, authored textures, terrain geometry, workers, shadows, and procedural solar resources have idempotent disposal coverage.
- Reference sidecars record draw calls, triangles, texture/geometry counts, asset bytes, LUT bytes, height-cache bytes, shadow bytes, coverage, pending refinement, transition state, exposure, frame-time percentiles, and screenshot luminance/clipping.

## Final runtime envelope

| Tier | Max draws | Max triangles | Average frame p50 | Max frame p95 | Max shadow allocation |
| --- | ---: | ---: | ---: | ---: | ---: |
| Low | 188 | 113,088 | 8.329 ms | 9.380 ms | 0 B |
| Medium | 275 | 306,720 | 8.351 ms | 10.625 ms | 4,194,304 B |
| High | 170 | 391,680 | 8.330 ms | 14.465 ms | 16,777,216 B |

These are final single-browser reference measurements, not cross-hardware guarantees. One-time shader/asset warm-up outliers remain visible in the raw p99 sidecars (81.805 ms Low, 218.040 ms Medium, and 784.265 ms High); steady p50/p95 measurements are the relevant presentation envelope. Deep-space black coverage peaks near 31.4%, while white clipping remains below 0.008% in every station.

## Intentional implementation boundaries

- Earth remains spherical at runtime, as approved; asset reprojection and orientation remain datum/source aware.
- Earth weather, cloud, and night fields are pinned snapshots, not live services.
- The checked 512 by 256 signed half-metre macro grid is always resident and immutable for render/contact agreement. Higher visual macro texture mips exist in the authored packs, but asynchronous survey-grade/cube-face height promotion is not enabled in this visual slice; this avoids version divergence in physics and is the principal data-coverage follow-up.
- The current forward canvas exposes post-tone-map screenshot luminance, not a truthful pre-tone-map HDR framebuffer. Exposure anchors are unified and deterministic; a future HDR composition target should add linear readback without pretending the canvas values are pre-tone-map.
- Represented geometric ocean waves remain deferred; the shipped hierarchy uses the camera-local cap, filtered normal response, Fresnel sky/Sun reflection, and shoreline mask.
- Ground-level High weather volume fades below 1–5 km because long tangent marches produced radial slices. A later local cloud-volume pass can replace that bounded workaround.

These boundaries are visible in this record rather than hidden by reference-camera selection. They do not change physical scale, source identity, or the Artemis IV visual foundation.
