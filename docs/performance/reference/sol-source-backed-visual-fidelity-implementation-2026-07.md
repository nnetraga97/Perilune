# Sol source-backed visual fidelity implementation record

**Date:** 2026-07-20  
**Worktree:** `fable-test`  
**Branch:** `feature/sol-earth-moon-visuals`

## Delivered

- Milestone 0 source locks, live probes, authority inspection, numeric oracles, and categorical surface-class oracles.
- Direct-source Earth and Moon resident height derivation. Visual derivatives are no longer accepted as numeric height authority.
- Deploy validation checks the committed generated height artifact and its internal digest without requiring ignored authoring TIFFs. `npm run check:height-authority:source` remains the source-backed freshness check for authoring environments that hold those originals.
- Exact Earth `surfaceClass` products with a complete global parent and a KSC regional override. Ocean ownership and scatter eligibility resolve exact class codes rather than height sign or filtered color.
- Bounded GIBS, Moon Trek WAC, and allowlisted KSC NAIP adapters; tier budgets; abort/retry behavior; in-memory and persistent caches; generation keys; and deterministic resident-parent fallback.
- A same-origin `/api/planet-data` route that accepts only the locked NAIP dataset and computed tile coordinates. It enforces coverage, response size, timeout, cost gating, rate limiting, cache headers, and fail-closed production behavior.
- Source-native compact equirectangular pages and worker-reprojected cube visual pages with gutters, validity alpha, complete-page installation, crossfade, source-specific visual-albedo calibration, and resident-parent fallback.
- Terrain detail now follows the selected terrain leaves through a fixed four-slot priority set: camera coverage first, visible selected-leaf refinement next, and bounded velocity prediction last. The four pages install atomically in one 2x2 color atlas rather than partially replacing their parent.
- Decoded Moon LOLA and KSC 3DEP scalar metres now derive body-space shading normals in the detail worker. KSC samples are transformed from NAVD88/GEOID18 to the EGM2008 presentation datum through the pinned NOAA VDatum 4.8 3x3 correction surface. The result is shading-only and cannot move geometry or contact.
- A second 2x2 normal atlas keeps four-page relief within the WebGL 16-sampler boundary. Parallax remains intentionally zero because the current silhouette/contact surface does not justify apparent displacement.
- Detail diagnostics now expose visual and numeric dataset identity, datum, source cell size, height range, selected cube keys, exact surface class, decoded/persistent/GPU bytes, cache provenance, request counts, and fetch/decode/reproject/upload timings.
- The reference harness adds the KSC coast transect, a second low-orbit sun direction, and an opt-in exact surface-class diagnostic view with atmosphere, ocean, and clouds removed.
- Low remains source-streaming disabled. Medium and High use explicit CPU/GPU/cache/request ceilings.
- Reference stations for KSC at 1 km and ground level, source-detail diagnostics in renderer stats, and a harness that waits for detail requests/reprojection/crossfade to settle before capture.
- Atmosphere/ocean behavior remains on the approved low-altitude presentation. The broad blue orbital shell was not restored.
- Milestone 3 freezes a content-addressed KSC 3DEP height region at launch. Its corrected EGM2008 samples drive contact, launch-pad placement, terrain vertices/normals, and scatter from one recipe generation; renderer transactions and terrain workers assert that generation. Invalid or unavailable regional data reports the reason and falls back atomically to the checked global parent.

## Live delivery evidence

- Direct GIBS Earth and Moon Trek WAC paths reached `ready` with nine complete pages and no proxy traffic in the Medium reference harness.
- The real Vercel development route reached `ready` for both compact and terrain KSC NAIP consumers. The ground capture used level 18, nine pages per consumer, 18 proxy requests in total, and remained within the configured session byte ceiling.
- A forced ordinary Vite-preview run cannot serve the proxy route and deterministically falls back to the resident/GIBS parent without runtime errors.
- Source atlas orientation, cube edge/corner gutters, partial-source alpha validity, timeout/corruption behavior, and cache generation behavior have focused automated coverage.

## Deliberately not claimed

- Streamed visual imagery still does not change compact silhouette or contact. Only the explicitly preloaded and frozen KSC numeric authority can change terrain vertices and contact for a new flight.
- Global shoreline authority remains lower resolution outside the bounded KSC regional classification. At broad low-orbit Florida views, the exact categorical boundary can therefore remain visibly stepped even while land imagery is sharper.
- Final post-integration visual and performance validation remains for the user. The partial full-matrix run exposed and led to fixes for the 16-sampler overflow and the High fallback-reference terrain allocation; it was intentionally not restarted after the user asked to stop testing.
- Lunar and arbitrary-location geometric promotion are not implemented. The Moon remains source-informed shading over the checked parent geometry until a bounded landing/reference region is explicitly selected and gated.

## Operational configuration

- Proxy-backed detail defaults off unless `PLANET_DETAIL_MONTHLY_COST_CEILING_USD` is at least the documented conservative threshold.
- Production requires the configured external limiter; missing limiter state fails closed.
- Direct-source CSP access is limited to the locked NASA GIBS, Moon Trek visual/LOLA, and USGS 3DEP (`elevation.nationalmap.gov`) hosts. NAIP remains same-origin through the allowlisted API.
- Cost assumptions and stop rules are recorded in `docs/performance/reference/planet-detail-delivery-budget-2026-07.md`.
