# Transactional Body Renderer Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace direct planet construction with an explicit, transactional body-renderer platform that supports capability checks, quality replacement, context restoration, compact-map parity, and single ownership of Auren's star presentation.

**Architecture:** `BodyRendererManager` owns one committed renderer per body and stages candidates through an injected asset/compile pipeline before swapping roots. The first production implementations are a `LegacyBodyRenderer` adapter and `StarBodyRenderer`; other body archetypes remain explicit content assignments delivered in later phases. A shared `BodyMaterialDescriptor` supplies compact flight and map rendering while simulation height, contact, and save state remain outside the renderer platform.

**Tech Stack:** TypeScript, Three.js/WebGL2, Three.js KTX2Loader, Vitest, existing `PlanetRenderer`, `BodyOrientation`, Vite, and focused Playwright smoke coverage.

## Global Constraints

- WebGL2 is required; WebGL1 receives a clear capability screen.
- Renderer selection comes from explicit body visual data, never terrain amplitude or atmosphere inference.
- Collision height comes only from the shared simulation evaluator; renderers may consume it but may not redefine it.
- Candidate loading, shader compilation, and quality replacement are transactional: the committed root remains visible until the candidate is ready.
- Failed candidates dispose every partial resource and retain the committed legacy renderer.
- Physical terrain, recipe data, and collision behavior are quality-independent.
- Only one flight-scale pack may be resident; quality overlap must stay inside the transient resource ceiling.
- Context loss prevents default disposal, pauses rendering, and rebuilds committed renderers from their descriptors after restoration.
- Compact flight and MapView body identity come from the same `BodyMaterialDescriptor`.
- `StarBodyRenderer` exclusively owns Auren's disk, sprite/corona, directional light, color/intensity, and exposure contribution.
- Per the user's latest instruction, each task runs focused tests/typecheck; long reference profiles and the broad all-tests pass are deferred to the final verification pass.

---

### Task 1: Explicit Visual Assignments and Shared Material Descriptors

**Files:**
- Create: `src/render/bodyMaterial.ts`
- Create: `src/content/bodyVisuals.ts`
- Create: `tests/body-material.test.ts`

**Interfaces:**
- Produces: `BodyRendererKind`, `BodyVisualDef`, `BodyMaterialDescriptor`, `bodyMaterialDescriptor(body)`, and `bodyFixedUv(direction)`.
- Consumes: exhaustive `BODY_VISUALS` records keyed by body id, `surfaceKind`, terrain palette, atmosphere, and `assets/planets/manifest.json` metadata.

- [ ] **Step 1: Write focused failing data/descriptor tests**

Assert the registry exactly covers all twelve bodies, Auren selects `star`, the other eleven select `legacy` for this phase while retaining an explicit target archetype, gas/star identities are descriptor fields, and body-fixed UV maps longitude `atan2(y,x)` with north at `+Z` and wraps at one seam.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/body-material.test.ts`

Expected: missing `BodyVisualDef`/descriptor imports.

- [ ] **Step 3: Add explicit content records and pure descriptor mapping**

```ts
export type BodyRendererKind = 'legacy' | 'terrestrial' | 'airless' | 'gas-giant' | 'star';
export interface BodyVisualDef {
  renderer: BodyRendererKind;
  targetArchetype: Exclude<BodyRendererKind, 'legacy'>;
  materialId: string;
}

export const BODY_VISUALS: Readonly<Record<string, BodyVisualDef>>;

export interface BodyMaterialDescriptor {
  bodyId: string;
  renderer: BodyRendererKind;
  identity: 'solid' | 'gas' | 'star';
  albedo: { low: string; mid: string; high: string; ocean: string | null };
  orientationConvention: 'body-fixed-z-up-atan2-y-x';
}
```

Keep visual assignment outside `BodyDef` so the simulation model does not depend on renderer types. Set Auren to `renderer: 'star'`. Keep every non-star on `renderer: 'legacy'` in Phase 3; assign its future `targetArchetype` explicitly without activating later-phase art.

- [ ] **Step 4: Run GREEN and typecheck**

Run: `npx vitest run tests/body-material.test.ts && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/render/bodyMaterial.ts src/content/bodyVisuals.ts tests/body-material.test.ts
git commit -m "feat: assign explicit body visual identities"
```

### Task 2: WebGL2 and Shader Capability Contract

**Files:**
- Modify: `src/render/context.ts`
- Modify: `src/main.ts`
- Create: `tests/render-capabilities.test.ts`

**Interfaces:**
- Produces: `RenderCaps`, `RenderCapabilityError`, `probeRenderCaps(gl, renderer)`, and a WebGL2-only `createRenderContext`.
- Consumes: canvas WebGL2 context, fragment `highp` precision/range, KTX2-relevant extensions, texture limits, anisotropy, and drawing-buffer sample count.

- [ ] **Step 1: Write failing capability tests with fake canvas/GL records**

Cover missing WebGL2, insufficient fragment highp precision/range, full analytic-atmosphere capability, precision fallback, compressed-format flags, max texture size, samples, and a user-facing capability message.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/render-capabilities.test.ts`

- [ ] **Step 3: Implement WebGL2-only probing**

`RenderCaps.backend` becomes the literal `'webgl2'`. If `canvas.getContext('webgl2', ...)` returns null, throw `RenderCapabilityError('Perilune requires WebGL2')` before constructing Three.js. Probe `getShaderPrecisionFormat(FRAGMENT_SHADER, HIGH_FLOAT)` and expose `atmospherePath: 'analytic' | 'lookup' | 'limb-haze'` from explicit precision thresholds. `main.ts` renders the error in the boot panel instead of leaving a blank canvas.

- [ ] **Step 4: Run GREEN and typecheck**

Run: `npx vitest run tests/render-capabilities.test.ts && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/render/context.ts src/main.ts tests/render-capabilities.test.ts
git commit -m "feat: enforce renderer capabilities"
```

### Task 3: BodyRenderer Contract, Legacy Adapter, and Star Ownership

**Files:**
- Create: `src/render/bodyRenderer.ts`
- Create: `src/render/legacyBodyRenderer.ts`
- Create: `src/render/starBodyRenderer.ts`
- Create: `src/render/bodyRendererFactory.ts`
- Create: `tests/body-renderer.test.ts`
- Modify: `src/render/worldScene.ts`
- Modify: `src/game.ts`

**Interfaces:**
- Produces: `BodyRenderer`, `BodyRenderFrame`, `BodyRendererStats`, `LegacyBodyRenderer`, `StarBodyRenderer`, and `createBodyRendererCandidate`.
- Consumes: `Body`, `BodyMaterialDescriptor`, `RenderCaps`, quality tier, camera-relative origin, body-fixed camera, orientation, sun direction, time, and altitude.

```ts
export interface BodyRenderer {
  readonly bodyId: string;
  readonly kind: BodyRendererKind;
  readonly quality: QualityTier;
  readonly root: THREE.Object3D;
  readonly ready: boolean;
  update(frame: Readonly<BodyRenderFrame>): void;
  stats(): Readonly<BodyRendererStats>;
  dispose(): void;
}

export type QualityTier = 'low' | 'medium' | 'high';
```

- [ ] **Step 1: Write failing adapter/factory/star tests**

Assert factory selection uses only `BODY_VISUALS[body.id].renderer`; Legacy owns compact sphere, terrain, and clouds without amplitude-based renderer selection; gas legacy never calls solid terrain; Star owns exactly one light and visible source; disposal is idempotent and releases owned geometry/materials/textures.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/body-renderer.test.ts`

- [ ] **Step 3: Implement adapters**

`LegacyBodyRenderer` wraps existing `PlanetRenderer`/`CloudLayer` and a descriptor-driven compact sphere, selecting compact versus terrain by view distance. For `surfaceKind !== 'solid'`, it stays compact. `StarBodyRenderer` owns an emissive disk, sprite/corona, directional light, light target, and exposure value; no star geometry is passed through rocky terrain.

- [ ] **Step 4: Refactor WorldScene ownership**

Remove `planetRenderers`, `cloudLayers`, `distantBodies`, `sun`, and `sunSprite` from `WorldScene`. Inject `RenderContext` through both normal construction and quick-load reconstruction in `game.ts`. Create renderer candidates through the explicit factory and add only their roots. Only the active SOI body may enable flight-scale terrain; parent, children, and siblings remain descriptor-driven compact meshes. WorldScene continues to calculate camera-relative positions, body orientation, and camera/body star directions, then passes those values to renderers. Keep launch-site and vessel ownership unchanged. Expand disposal to release starfield, launch-site, compact body, vessel, light, and adapter resources so quick-load reconstruction does not leak.

- [ ] **Step 5: Run focused regressions**

Run: `npx vitest run tests/body-renderer.test.ts tests/body-material.test.ts tests/body-orientation.test.ts tests/terrain-authority.test.ts && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/render/bodyRenderer.ts src/render/legacyBodyRenderer.ts src/render/starBodyRenderer.ts src/render/bodyRendererFactory.ts src/render/worldScene.ts src/game.ts tests/body-renderer.test.ts
git commit -m "feat: introduce body renderer adapters"
```

### Task 4: Transactional Asset, Shader, and Quality Replacement

**Files:**
- Create: `src/render/bodyRendererManager.ts`
- Create: `src/render/planetAssetLoader.ts`
- Create: `src/render/shaderCompiler.ts`
- Create: `src/render/renderFailures.ts`
- Create: `scripts/sync-renderer-assets.mjs`
- Create: `tests/renderer-transaction.test.ts`
- Modify: `src/render/worldScene.ts`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `BodyRendererManager.ensure(body)`, `replaceQuality(tier)`, `rebuildCommitted()`, `PlanetAssetLoader`, and `compileRendererCandidate`.
- Consumes: body renderer factory, checked manifest, `KTX2Loader.detectSupport`, renderer `compileAsync`, shader-error callback, and resource ledger.

- [ ] **Step 1: Write failing transaction tests**

Use real transaction/controller code with injected candidate factories. Cover load rejection, KTX support rejection with conventional fallback selection, shader error, `compileAsync` rejection, successful atomic root swap, old-root visibility until readiness, partial disposal on failure, previous disposal only after commit, one flight-scale resident pack, transient-budget rejection, and log-once failure keys scoped by body/tier/channel/phase.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/renderer-transaction.test.ts`

- [ ] **Step 3: Implement loader/compiler boundaries**

`PlanetAssetLoader` accepts only validator-approved local manifest entries, calls `KTX2Loader.detectSupport(renderer)` before KTX2 loading, and chooses declared PNG/WebP fallbacks when compressed support is unavailable. `scripts/sync-renderer-assets.mjs` copies the pinned Three.js `basis_transcoder.js` and `.wasm` from `node_modules/three/examples/jsm/libs/basis/` into ignored `public/basis/`; wire it through `predev` and existing `prebuild`, verify both source files exist, and configure `KTX2Loader.setTranscoderPath('./basis/')`. `compileRendererCandidate` mounts the root in an isolated staging scene, temporarily captures `renderer.debug.onShaderError`, awaits `renderer.compileAsync(stagingScene, camera)`, restores the callback, and throws a body/channel-scoped error on any shader failure. `renderFailures.ts` logs each `{body,tier,channel,phase}` failure key once and keeps counters available to renderer stats.

- [ ] **Step 4: Implement atomic manager**

Keep `{ committed, candidate }` separate. Candidate roots remain invisible until assets, compilation, coverage readiness, and budget checks pass. On failure, dispose candidate and retain committed root. On success, add candidate, make it visible, remove/dispose committed, and update residency accounting. Quality changes rebuild only visual state; they never touch simulation recipes or collision data.

- [ ] **Step 5: Integrate manager into WorldScene and run focused tests**

Run: `npx vitest run tests/renderer-transaction.test.ts tests/body-renderer.test.ts tests/content-validator.test.ts && npm run typecheck`

- [ ] **Step 6: Commit**

```bash
git add src/render/bodyRendererManager.ts src/render/planetAssetLoader.ts src/render/shaderCompiler.ts src/render/renderFailures.ts src/render/worldScene.ts scripts/sync-renderer-assets.mjs package.json .gitignore tests/renderer-transaction.test.ts
git commit -m "feat: transact body renderer replacement"
```

### Task 5: Context Loss and Restoration

**Files:**
- Create: `src/render/contextLifecycle.ts`
- Create: `tests/context-lifecycle.test.ts`
- Modify: `src/render/context.ts`
- Modify: `src/render/worldScene.ts`
- Modify: `src/game.ts`

**Interfaces:**
- Produces: `RenderContextLifecycle`, `renderPaused`, loss/restoration subscriptions, and `BodyRendererManager.rebuildCommitted()` integration.
- Consumes: `webglcontextlost`, `webglcontextrestored`, renderer manifest/descriptors, and current quality tier.

- [ ] **Step 1: Write failing lifecycle tests**

With an EventTarget canvas and fake manager, assert loss calls `preventDefault`, pauses rendering, logs once, does not dispose simulation state, restoration rebuilds the last committed renderer/quality, failed rebuild retains procedural legacy coverage, and disposal removes listeners.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/context-lifecycle.test.ts`

- [ ] **Step 3: Implement lifecycle and game-loop pause**

`RenderContextLifecycle` owns listeners and an explicit state machine: `ready -> lost -> restoring -> ready|fallback`. The animation loop continues simulation but skips `renderer.render` while lost/restoring. Restoration asks each manager to rebuild from descriptor/manifest; failures route to legacy rather than exposing a black body.

- [ ] **Step 4: Run GREEN and typecheck**

Run: `npx vitest run tests/context-lifecycle.test.ts tests/renderer-transaction.test.ts && npm run typecheck`

- [ ] **Step 5: Commit**

```bash
git add src/render/contextLifecycle.ts src/render/context.ts src/render/worldScene.ts src/game.ts tests/context-lifecycle.test.ts
git commit -m "feat: restore body renderers after context loss"
```

### Task 6: Compact Map Parity and Platform Documentation

**Files:**
- Modify: `src/ui/mapView.ts`
- Modify: `src/ui/perfOverlay.ts`
- Modify: `src/game.ts`
- Create: `tests/map-material.test.ts`
- Modify: `RENDERING.md`
- Modify: `ARCHITECTURE.md`
- Modify: `PERFORMANCE.md`

**Interfaces:**
- Consumes: `BodyMaterialDescriptor`, `bodyFixedUv`, `BodyOrientation`, renderer-manager stats, resource ledger, and active star direction.
- Produces: descriptor-driven compact map bodies and platform documentation.

- [ ] **Step 1: Write failing compact-map tests**

Assert MapView material selection uses descriptors, applies body orientation at simulation time, distinguishes gas/star identity, receives phase-correct star direction, never requests terrain/scatter assets, and disposes every map-owned geometry/material/texture/listener.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/map-material.test.ts`

- [ ] **Step 3: Replace solid-color map spheres**

Build compact materials from `BodyMaterialDescriptor`, update each body mesh quaternion through `bodyOrientation`, and update directional lighting from the body-center-to-star vector in map coordinates. Preserve current map scale, SOI lines, deposit markers, and maneuver interactions. Add `MapView.dispose()` for all scene/DOM/resize resources. Wrap the actual flight or map `renderer.render` submission with the existing `GpuTimerRing`, and feed renderer-manager draw/triangle/resource/transition/fallback/GPU-query statistics into typed overlay fields without status-dot decoration.

- [ ] **Step 4: Update architecture/rendering docs**

Document explicit assignments, lifecycle ownership, transaction failure behavior, WebGL2 capability screen, quality residency, context restoration, shared compact descriptors, and Auren star ownership. Keep Phase 4+ art described as planned rather than shipped.

- [ ] **Step 5: Run focused platform checks**

Run: `npx vitest run tests/map-material.test.ts tests/body-renderer.test.ts tests/renderer-transaction.test.ts tests/context-lifecycle.test.ts && npm run typecheck && npm run build`

The full unit/e2e/reference suite is intentionally deferred to the user's final pass request; do not claim the whole specification complete from this focused command.

- [ ] **Step 6: Commit**

```bash
git add src/ui/mapView.ts src/ui/perfOverlay.ts src/game.ts tests/map-material.test.ts RENDERING.md ARCHITECTURE.md PERFORMANCE.md
git commit -m "feat: unify compact body rendering"
```
