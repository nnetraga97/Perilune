# Planet Authority and Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the versioned simulation authority, orientation/save compatibility, gas-body behavior, and deterministic asset-validation foundation required by the planet renderer.

**Architecture:** A pure `BodyOrientation` module owns all body-fixed/inertial transforms. Versioned terrain recipes feed a shared evaluator that exposes distinct solid, water, and contact surfaces. Save schema v4 persists landed body-fixed poses and recipe hashes. Explicit body kinds prevent gas giants and stars from entering solid-contact code. Node tooling validates provenance and deterministic build metadata before every production build.

**Tech Stack:** TypeScript 5.7, Vitest, Three.js-independent simulation modules, Node ESM validation scripts, SHA-256, npm/Vite, and GitHub Actions.

## Global Constraints

- Collision-scale height comes only from the shared recipe evaluator.
- Visual-only maps and scatter never modify solid height.
- Physical terrain and obstacles remain quality-independent.
- `surfaceKind: 'gas'` has no ground, splashed, prelaunch, or landed-rails state.
- Tyran terminates vessels at 5,000,000 Pa or 60,000 meters below reference radius.
- Production builds must run content validation and must not download authoring sources.
- Phase completion requires all unit tests and the production build to pass.

---

### Task 1: Shared Body Orientation

**Files:**
- Create: `src/sim/bodyOrientation.ts`
- Create: `tests/body-orientation.test.ts`
- Modify: `src/sim/terrain.ts`
- Modify: `src/sim/state.ts`
- Modify: `src/render/worldScene.ts`
- Modify: `src/proto/terrainProto.ts`

**Interfaces:**
- Produces: `bodyFixedToInertial(body, time, vector, out)`, `inertialToBodyFixed(...)`, `bodyFixedAttitudeToInertial(...)`, `inertialAttitudeToBodyFixed(...)`, `bodyAngularVelocity(body, out)`, and `surfaceVelocity(body, position, out)`.
- Consumes: `Body.rotationAngle`, `BodyDef.axialTilt`, `Quat`, and `Vec3`.

The test file defines quaternion equivalence as the smaller Euclidean distance to `q` or `-q`:

```ts
function quaternionDistance(a: Readonly<Quat>, b: Readonly<Quat>): number {
  const direct = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z, a.w - b.w);
  const negated = Math.hypot(a.x + b.x, a.y + b.y, a.z + b.z, a.w + b.w);
  return Math.min(direct, negated);
}
```

- [ ] **Step 1: Write failing round-trip, tilt, velocity, and rails-pose tests**

```ts
it('round-trips vectors and attitudes through tilt and spin', () => {
  const body = new GameState().universe.get('veyra');
  const bf = new Vec3(0.2, -0.7, 0.68).normalize();
  const inertial = bodyFixedToInertial(body, 12345, bf, new Vec3());
  expect(inertialToBodyFixed(body, 12345, inertial, new Vec3()).distanceTo(bf)).toBeLessThan(1e-12);
  const attitude = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), 0.4);
  const world = bodyFixedAttitudeToInertial(body, 12345, attitude, new Quat());
  expect(quaternionDistance(inertialAttitudeToBodyFixed(body, 12345, world, new Quat()), attitude)).toBeLessThan(1e-12);
});

it('tilts the local north pole and computes tangent surface velocity', () => {
  const body = new GameState().universe.get('veyra');
  const north = bodyFixedToInertial(body, 0, new Vec3(0, 0, 1), new Vec3());
  expect(Math.abs(north.y + Math.sin(body.def.axialTilt))).toBeLessThan(1e-12);
  const position = bodyFixedToInertial(body, 50, new Vec3(body.radius, 0, 0), new Vec3());
  expect(Vec3.dot(position, surfaceVelocity(body, position, new Vec3()))).toBeCloseTo(0, 6);
});
```

- [ ] **Step 2: Run the orientation tests and verify RED**

Run: `npx vitest run tests/body-orientation.test.ts`

Expected: module-resolution failure because `bodyOrientation.ts` does not exist.

- [ ] **Step 3: Implement the quaternion convention**

```ts
// body-fixed -> inertial applies local +Z spin, then axial tilt about inertial +X.
export function bodyOrientation(body: Body, time: number, out: Quat): Quat {
  const spin = new Quat().setFromAxisAngle(Z_AXIS, body.rotationAngle(time));
  const tilt = new Quat().setFromAxisAngle(X_AXIS, body.def.axialTilt);
  return out.copy(tilt).multiply(spin).normalize();
}

export function bodyFixedToInertial(body: Body, time: number, value: Readonly<Vec3>, out: Vec3): Vec3 {
  return bodyOrientation(body, time, ORIENTATION).rotate(value, out);
}

export function inertialToBodyFixed(body: Body, time: number, value: Readonly<Vec3>, out: Vec3): Vec3 {
  return bodyOrientation(body, time, ORIENTATION).conjugate().rotate(value, out);
}
```

Compose attitudes with the same orientation quaternion. Compute angular velocity by rotating local `(0,0,2π/period)` through the tilt-only orientation, and compute surface velocity as `ω × r`.

- [ ] **Step 4: Replace every hand-written body-spin transform**

Use the shared functions in terrain sampling, launch-site placement, rails conversion/activation/position, entry landing direction, world launch-pad placement, and terrain prototype placement. Store landed rails attitude in body-fixed coordinates and restore it to inertial coordinates at activation time.

- [ ] **Step 5: Run orientation, ground, release-blocker, save, ascent, and Palla tests**

Run: `npx vitest run tests/body-orientation.test.ts tests/ground.test.ts tests/release-blockers.test.ts tests/save-maneuver.test.ts tests/ascent.test.ts tests/palla-mission.test.ts`

Expected: all selected tests pass.

- [ ] **Step 6: Commit orientation authority**

```bash
git add src/sim/bodyOrientation.ts src/sim/terrain.ts src/sim/state.ts src/sim/entry.ts src/render/worldScene.ts src/proto/terrainProto.ts tests/body-orientation.test.ts
git commit -m "feat: centralize body orientation transforms"
```

### Task 2: Versioned Terrain Recipes and Surface Queries

**Files:**
- Create: `src/sim/terrainRecipe.ts`
- Create: `src/content/terrainRecipes.ts`
- Create: `tests/terrain-authority.test.ts`
- Modify: `src/sim/universe.ts`
- Modify: `src/sim/terrain.ts`
- Modify: `src/content/system.ts`
- Modify: `src/render/planet.ts`

**Interfaces:**
- Produces: `BodyFeatureRecipe`, `SurfaceHeightResult`, `solidHeight(body, direction)`, `waterSurfaceHeight(body, direction)`, `contactSurface(body, direction)`, and `solidRadiusInertial(...)`.
- Consumes: existing deterministic noise functions and body terrain parameters.

The authority test locates deterministic sample regions with this bounded helper:

```ts
function findDirection(predicate: (direction: Vec3) => boolean): Vec3 {
  for (let lat = -80; lat <= 80; lat += 5) {
    for (let lon = -180; lon < 180; lon += 5) {
      const phi = (lat * Math.PI) / 180;
      const theta = (lon * Math.PI) / 180;
      const direction = new Vec3(
        Math.cos(phi) * Math.cos(theta),
        Math.cos(phi) * Math.sin(theta),
        Math.sin(phi),
      );
      if (predicate(direction)) return direction;
    }
  }
  throw new Error('No matching deterministic terrain sample');
}
```

- [ ] **Step 1: Write failing authority and ocean tests**

```ts
it('returns raw seafloor separately from water contact', () => {
  const veyra = new GameState().universe.get('veyra');
  const ocean = findDirection((dir) => solidHeight(veyra, dir).kind === 'solid' && solidHeight(veyra, dir).height < 0);
  expect(waterSurfaceHeight(veyra, ocean)).toEqual({ kind: 'water', height: 0 });
  expect(contactSurface(veyra, ocean)).toEqual({ kind: 'water', height: 0 });
  expect(solidHeight(veyra, ocean)).toMatchObject({ kind: 'solid' });
});

it('returns a typed no-surface result for Tyran', () => {
  const tyran = new GameState().universe.get('tyran');
  expect(solidHeight(tyran, new Vec3(1, 0, 0))).toEqual({ kind: 'none' });
  expect(contactSurface(tyran, new Vec3(1, 0, 0))).toEqual({ kind: 'none' });
});
```

- [ ] **Step 2: Run the authority tests and verify RED**

Run: `npx vitest run tests/terrain-authority.test.ts`

Expected: imports fail because recipe/surface APIs do not exist.

- [ ] **Step 3: Add immutable recipes and explicit body kinds**

```ts
export type SurfaceKind = 'solid' | 'gas' | 'star';

export interface BodyFeatureRecipe {
  version: number;
  hash: string;
  bodyId: string;
  seed: number;
  amplitude: number;
  frequency: number;
  octaves: number;
  oceanLevel: number;
  craters: readonly CraterFeature[];
}

export type SurfaceHeightResult =
  | { kind: 'solid' | 'water'; height: number }
  | { kind: 'none' };
```

Assign `surfaceKind` and a version/hash recipe reference to all twelve bodies. Veyra, Palla, and every landable body are `solid`; Tyran is `gas`; Auren is `star`. Freeze recipe records after module initialization.

- [ ] **Step 4: Route terrain and rendering through shared queries**

Move the current deterministic height formula into `evaluateRecipeHeight(recipe, direction)`. `solidHeight` invokes only that evaluator. Water exists at datum when a solid recipe has `oceanLevel > 0` and raw height is negative. `contactSurface` selects water or solid. Keep `terrainHeight` and `surfaceHeight` as documented legacy numeric adapters for existing renderer code, but make gas/star handling explicit rather than amplitude-derived. Render raw seafloor geometry and keep the independent ocean sphere.

- [ ] **Step 5: Run terrain and mission tests**

Run: `npx vitest run tests/terrain-authority.test.ts tests/ground.test.ts tests/release-blockers.test.ts tests/ascent.test.ts tests/palla-mission.test.ts`

Expected: all selected tests pass.

- [ ] **Step 6: Commit recipes and surface separation**

```bash
git add src/sim/terrainRecipe.ts src/content/terrainRecipes.ts src/sim/universe.ts src/sim/terrain.ts src/content/system.ts src/render/planet.ts tests/terrain-authority.test.ts
git commit -m "feat: version authoritative terrain recipes"
```

### Task 3: Landed Save Pose and Recipe Migration

**Files:**
- Create: `tests/save-terrain-migration.test.ts`
- Modify: `src/save/schema.ts`
- Modify: `src/save/persistence.ts`
- Modify: `src/sim/state.ts`

**Interfaces:**
- Consumes: `BodyOrientation`, recipe hashes, solid/contact queries, and saved simulation time.
- Produces: save schema v4 `SavedSurfacePose` and deterministic v3 migration during restoration.

`makeVersion3LandedSaveAtTime` creates a real current save, rewrites only the version and new surface field, and preserves the legacy inertial/rails fields:

```ts
function makeVersion3LandedSaveAtTime(time: number): SaveGame {
  const game = new GameState();
  game.time = time;
  game.spawnOnPad(buildTwoStageRocket(), 'Legacy lander');
  const save = serializeGame(game, 'v3 migration') as SaveGame & {
    vessels: Array<SavedVessel & { surfacePose?: SavedSurfacePose }>;
  };
  save.saveVersion = 3;
  for (const vessel of save.vessels) delete vessel.surfacePose;
  return save;
}
```

- [ ] **Step 1: Write failing v4 round-trip and v3 migration tests**

```ts
it('stores landed direction and attitude in the body-fixed frame', () => {
  const game = new GameState();
  const gv = game.spawnOnPad(buildTwoStageRocket(), 'Lander');
  const save = serializeGame(game, 'surface');
  expect(save.saveVersion).toBe(4);
  expect(save.vessels[0].surfacePose).toMatchObject({ bodyId: 'veyra', recipeHash: expect.any(String) });
  const restored = restoreGame(JSON.parse(JSON.stringify(save)));
  expect(restored.active!.runtime.pos.distanceTo(gv.runtime.pos)).toBeLessThan(1e-6);
});

it('migrates a v3 landed pose using the legacy Z-spin frame', () => {
  const v3 = makeVersion3LandedSaveAtTime(4321);
  const restored = restoreGame(v3);
  expect(restored.active!.runtime.situation).toBe('landed');
  expect(restored.active!.runtime.pos.isFinite()).toBe(true);
  expect(restored.active!.runtime.pos.length()).toBeGreaterThan(restored.bodyOf(restored.active!).radius);
});
```

- [ ] **Step 2: Run migration tests and verify RED**

Run: `npx vitest run tests/save-terrain-migration.test.ts`

Expected: failure because save v4 and `surfacePose` do not exist.

- [ ] **Step 3: Implement schema v4 and transactional migration**

```ts
export interface SavedSurfacePose {
  bodyId: string;
  recipeHash: string;
  scatterRecipeHash: string;
  directionBF: Vec3Like;
  attitudeBF: QuatLike;
  contactOffset: number;
}
```

Serialize this record for active or rails vessels in `prelaunch`, `landed`, or `splashed`. For v3 saves, derive the body-fixed direction and attitude with the legacy Z-spin transform at saved time, calculate clearance against the legacy terrain evaluator, then reproject through the current recipe and `BodyOrientation`. Reject unavailable recipe hashes before mutating `GameState`. Retain old recipe evaluators for one schema generation.

- [ ] **Step 4: Run save, orientation, ground, and mission tests**

Run: `npx vitest run tests/save-terrain-migration.test.ts tests/save-maneuver.test.ts tests/body-orientation.test.ts tests/ground.test.ts tests/ascent.test.ts tests/palla-mission.test.ts`

Expected: all selected tests pass.

- [ ] **Step 5: Commit save compatibility**

```bash
git add tests/save-terrain-migration.test.ts src/save/schema.ts src/save/persistence.ts src/sim/state.ts
git commit -m "feat: version landed terrain saves"
```

### Task 4: Gas-Body Terminal Physics

**Files:**
- Create: `tests/gas-body.test.ts`
- Modify: `src/sim/universe.ts`
- Modify: `src/content/system.ts`
- Modify: `src/sim/flight.ts`
- Modify: `src/sim/state.ts`
- Modify: `src/sim/entry.ts`
- Modify: `src/save/schema.ts`

**Interfaces:**
- Produces: explicit negative-altitude gas pressure/density, terminal-boundary step results, and save rejection for landed gas vessels.
- Consumes: `surfaceKind`, `terminalPressurePa`, and `terminalDepthMeters`.

- [ ] **Step 1: Write failing gas-body behavior tests**

```ts
it('continues Tyran pressure below reference radius', () => {
  const tyran = new GameState().universe.get('tyran');
  expect(tyran.pressureAt(-10_000)).toBeGreaterThan(tyran.pressureAt(0));
  expect(tyran.densityAt(-10_000)).toBeGreaterThan(tyran.densityAt(0));
});

it('never lands and destroys a vessel at Tyran terminal pressure', () => {
  const game = new GameState();
  const gv = game.spawnInOrbit(buildProbe(), 'Dive', 'tyran', 10_000);
  gv.runtime.pos.set(game.universe.get('tyran').radius - 40_000, 0, 0);
  gv.runtime.vel.set(-10, 0, 0);
  game.update(PHYSICS_DT);
  expect(game.vessels).not.toContain(gv);
  expect(game.lastDestruction?.reason).toMatch(/pressure|depth/i);
});
```

Add save validation cases rejecting `prelaunch`, `landed`, or `splashed` situations on a gas body.

- [ ] **Step 2: Run gas tests and verify RED**

Run: `npx vitest run tests/gas-body.test.ts`

Expected: pressure does not increase below datum and the vessel contacts an artificial solid sphere.

- [ ] **Step 3: Implement explicit gas behavior**

For gas bodies, pressure and density use `base × exp(-altitude / scaleHeight)` at all altitudes below atmosphere top. Skip every ground/wheel/contact query. After integration, return a terminal-failure reason when pressure reaches 5,000,000 Pa or altitude reaches -60,000 meters. `GameState` destroys the vessel through its existing destruction path and never converts it to landed rails. Entry prediction uses terminal boundaries as its closest valid approach and does not call solid terrain.

- [ ] **Step 4: Run gas, planning, flight, and save tests**

Run: `npx vitest run tests/gas-body.test.ts tests/planning.test.ts tests/save-maneuver.test.ts tests/ascent.test.ts`

Expected: all selected tests pass.

- [ ] **Step 5: Commit gas physics**

```bash
git add tests/gas-body.test.ts src/sim/universe.ts src/content/system.ts src/sim/flight.ts src/sim/state.ts src/sim/entry.ts src/save/schema.ts
git commit -m "feat: model non-landable gas giants"
```

### Task 5: Provenance, Compiler Metadata, and Build Validation

**Files:**
- Create: `assets/planets/manifest.json`
- Create: `assets/planets/recipes.json`
- Create: `scripts/lib/canonical-json.mjs`
- Create: `scripts/validate-content.mjs`
- Create: `scripts/compile-planet-assets.ts`
- Create: `tools/planet-assets/Dockerfile`
- Create: `tools/planet-assets/compiler-lock.json`
- Create: `.github/workflows/ci.yml`
- Create: `tests/content-validator.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CONTENT_PIPELINE.md`
- Modify: `LICENSES.md`

**Interfaces:**
- Consumes: terrain recipes and shared `solidHeight` evaluator.
- Produces: canonical JSON hashing, manifest validation, compiler metadata, `compile:planet-assets`, working `validate:content`, and mandatory `prebuild`/CI gates.

- [ ] **Step 1: Write failing validator integration tests**

```ts
it('accepts the checked-in empty-source manifest and recipe hashes', () => {
  expect(spawnSync(process.execPath, ['scripts/validate-content.mjs'], { encoding: 'utf8' })).toMatchObject({ status: 0 });
});

it('rejects unknown and share-alike asset licenses', () => {
  for (const license of ['UNKNOWN', 'CC-BY-SA-4.0']) {
    const result = runValidatorWithManifest({ ...validManifest, sources: [{ ...source, license }] });
    expect(result.status).not.toBe(0);
  }
});
```

Add cases for checksum mismatch, missing attribution, wrong dimensions, channel mismatch, package/fallback mismatch, transfer limits, and GPU-memory limits.

- [ ] **Step 2: Run validator tests and verify RED**

Run: `npx vitest run tests/content-validator.test.ts`

Expected: failure because validator files and manifests do not exist.

- [ ] **Step 3: Implement canonical hashing and strict manifests**

Canonical JSON recursively sorts object keys and preserves array order, then SHA-256 hashes UTF-8 bytes. Allow only `CC0-1.0`, `Public-Domain`, and `CC-BY-4.0`; require a case-review record for `NASA` or `JPL`; reject SA, NC, ND, and unknown identifiers. Validate each source URL, author, license URL, attribution, checksum, transformations, body/channel usage, exact dimensions/formats, compressed/fallback pair, transfer bytes, and calculated mip/resource bytes. The initial manifest has no third-party sources and therefore passes without pretending repository-level licensing covers textures.

- [ ] **Step 4: Implement the shared-evaluator compiler entry point**

Install `tsx` as a pinned dev dependency. `compile-planet-assets.ts` imports `AUREN_SYSTEM`, `Universe`, and `solidHeight` directly, verifies recipe hashes, samples requested canonical directions, hashes raw signed-16-bit buffers, and writes only declared outputs. It accepts `--check` to compare hashes without modifying files. It never downloads sources.

- [ ] **Step 5: Pin the compiler environment and wire build/CI**

Add an immutable Linux/amd64 Node image digest and exact tool versions to the Dockerfile/lock. Add:

```json
"prebuild": "npm run validate:content",
"validate:content": "node scripts/validate-content.mjs",
"compile:planet-assets": "tsx scripts/compile-planet-assets.ts"
```

CI runs install, content validation, tests, build, and Playwright as separate named steps. Production build consumes local declared artifacts only.

- [ ] **Step 6: Run validator tests, validation, full unit tests, and build**

Run: `npx vitest run tests/content-validator.test.ts`

Run: `npm run validate:content`

Run: `npm test`

Run: `npm run build`

Expected: every command exits 0 with no failed tests or validation findings.

- [ ] **Step 7: Self-review Phase 1 and commit tooling/docs**

Audit transform call sites, recipe/hash coverage for all twelve bodies, gas contact exclusions, v3/v4 migration, license allow-list, build-chain invocation, and absence of implicit downloads. Fix discrepancies and rerun Step 6.

```bash
git add assets scripts tools .github tests/content-validator.test.ts package.json package-lock.json CONTENT_PIPELINE.md LICENSES.md
git commit -m "build: validate deterministic planet content"
```
