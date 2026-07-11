# M2 Baseline Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the interrupted M2 mission-planning baseline by completing deterministic alarms, alarm persistence, and atmospheric-entry prediction while retaining the transfer planner.

**Architecture:** `GameState` owns a sorted alarm queue and clips time advancement at the next due alarm before disabling warp. Save schema version 3 persists plain alarm data. A pure entry predictor integrates a disposable position/velocity copy with gravity, co-rotating atmospheric drag, authoritative terrain contact, and bounded sampling; it never mutates the live simulation.

**Tech Stack:** TypeScript 5.7, Vitest 2.1, existing `Vec3`, `Body`, `AeroModel`, terrain authority, and save migration chain.

## Global Constraints

- Preserve deterministic simulation behavior and existing transfer-planner results.
- Write and observe a failing test before each production behavior change.
- Alarm warp must stop at the alarm boundary, not after a full rails-warp increment.
- Entry prediction must consume authoritative terrain height and must not alter the live vessel.
- Phase completion requires `npm test` and `npm run build` with zero failures.

---

### Task 1: Deterministic Alarm Queue and Warp Interlock

**Files:**
- Create: `tests/alarms.test.ts`
- Modify: `src/sim/state.ts`

**Interfaces:**
- Produces: `AlarmKind`, `GameAlarm`, `GameState.alarms`, `GameState.addAlarm(time, label, kind)`, and `GameState.removeAlarm(id)`.
- Consumes: existing `GameState.update`, `setWarp`, physics and rails warp rates.

- [ ] **Step 1: Add focused failing alarm tests**

```ts
import { describe, expect, it } from 'vitest';
import { GameState, PHYSICS_DT } from '../src/sim/state';
import { addPart, createCraft } from '../src/sim/vessel';

function buildProbe() {
  const craft = createCraft('Probe');
  const core = addPart(craft, 'core-pilot', null, 'root', { x: 0, y: 0, z: 0 });
  addPart(craft, 'batt-s', core.key, 'surface', { x: 0.3, y: 0, z: 0 });
  return craft;
}

it('orders alarms and clips rails warp at the first boundary', () => {
  const game = new GameState();
  game.spawnInOrbit(buildProbe(), 'Probe', 'veyra', 120_000);
  game.addAlarm(8_000, 'later', 'custom');
  const first = game.addAlarm(5_000, 'first', 'custom');
  expect(game.alarms.map((alarm) => alarm.id)).toEqual([first.id, expect.any(String)]);
  game.setWarp(4, true);
  game.update(10);
  expect(game.time).toBe(5_000);
  expect(game.warpIndex).toBe(0);
  expect(game.alarms.map((alarm) => alarm.label)).toEqual(['later']);
});

it('fires a due alarm during fixed-step physics warp', () => {
  const game = new GameState();
  game.spawnInOrbit(buildProbe(), 'Probe', 'veyra', 120_000);
  game.addAlarm(3, 'soon', 'custom');
  game.setWarp(2, false);
  for (let i = 0; i < 400 && game.warpIndex !== 0; i++) game.update(PHYSICS_DT);
  expect(game.time).toBeGreaterThanOrEqual(3);
  expect(game.time).toBeLessThan(3 + PHYSICS_DT + 1e-9);
  expect(game.alarms).toHaveLength(0);
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run tests/alarms.test.ts`

Expected: TypeScript/runtime failure because alarm APIs do not exist.

- [ ] **Step 3: Implement the sorted alarm queue and boundary clipping**

```ts
export type AlarmKind = 'custom' | 'transfer' | 'maneuver' | 'entry';

export interface GameAlarm {
  id: string;
  time: number;
  label: string;
  kind: AlarmKind;
}

readonly alarms: GameAlarm[] = [];
private nextAlarmSerial = 1;

addAlarm(time: number, label: string, kind: AlarmKind): GameAlarm {
  if (!Number.isFinite(time) || time <= this.time) throw new Error('Alarm time must be in the future');
  const alarm = { id: `alarm-${this.nextAlarmSerial++}`, time, label: label.trim(), kind };
  if (!alarm.label) throw new Error('Alarm label is required');
  this.alarms.push(alarm);
  this.alarms.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  return alarm;
}

removeAlarm(id: string): boolean {
  const index = this.alarms.findIndex((alarm) => alarm.id === id);
  if (index < 0) return false;
  this.alarms.splice(index, 1);
  return true;
}
```

In rails warp, advance only to `min(time + realDt * warpRate, nextAlarm.time)`, run background systems for that clipped delta, consume all alarms due at the resulting time, and call `setWarp(0, false)`. During fixed-step physics, perform the same due-alarm check after each simulation tick.

- [ ] **Step 4: Run focused and existing alarm tests and verify GREEN**

Run: `npx vitest run tests/alarms.test.ts`

Expected: all focused alarm tests pass.

- [ ] **Step 5: Commit the alarm behavior**

```bash
git add tests/alarms.test.ts src/sim/state.ts
git commit -m "feat: add deterministic mission alarms"
```

### Task 2: Alarm Save Persistence and Migration

**Files:**
- Modify: `tests/save-maneuver.test.ts`
- Modify: `src/save/schema.ts`
- Modify: `src/save/persistence.ts`

**Interfaces:**
- Consumes: `GameAlarm` and `GameState.addAlarm` from Task 1.
- Produces: save schema version 3 with `alarms: SavedAlarm[]` and a v2-to-v3 migration.

- [ ] **Step 1: Add failing round-trip and migration tests**

```ts
it('round-trips alarms and migrates version 2 saves with an empty queue', () => {
  const game = new GameState();
  game.addAlarm(1234, 'Window: Rusk', 'transfer');
  const saved = serializeGame(game, 'alarm');
  expect(saved.saveVersion).toBe(3);
  expect(restoreGame(saved).alarms[0]).toMatchObject({ time: 1234, label: 'Window: Rusk', kind: 'transfer' });

  const v2 = { ...saved, saveVersion: 2 } as SaveGame;
  delete (v2 as Partial<SaveGame>).alarms;
  expect(migrateSave(v2).alarms).toEqual([]);
});
```

- [ ] **Step 2: Run the save test and verify RED**

Run: `npx vitest run tests/save-maneuver.test.ts -t alarms`

Expected: failure because version 3 and saved alarms do not exist.

- [ ] **Step 3: Add the schema, validation, migration, and persistence**

```ts
export const SAVE_VERSION = 3;

export interface SavedAlarm {
  id: string;
  time: number;
  label: string;
  kind: AlarmKind;
}

// Add this required field to SaveGame:
alarms: SavedAlarm[];
```

Validate finite future-independent alarm timestamps, non-empty IDs/labels, and allowed kinds. Migrate version 2 with `alarms: []`. Serialize `game.alarms` as plain objects. Restore through a `GameState.restoreAlarms(savedAlarms)` helper that preserves IDs, sorts by time, and advances the private serial beyond restored numeric IDs.

- [ ] **Step 4: Run save and alarm tests and verify GREEN**

Run: `npx vitest run tests/save-maneuver.test.ts tests/alarms.test.ts`

Expected: both test files pass.

- [ ] **Step 5: Commit persistence**

```bash
git add tests/save-maneuver.test.ts src/save/schema.ts src/save/persistence.ts src/sim/state.ts
git commit -m "feat: persist mission alarms"
```

### Task 3: Atmospheric Entry Predictor

**Files:**
- Create: `src/sim/entry.ts`
- Modify: `tests/planning.test.ts`

**Interfaces:**
- Consumes: `Body`, `AeroModel`, vessel mass, inertial position/velocity, simulation time, `groundRadiusInertial`, and orbital-element helpers.
- Produces: `predictEntry(body, model, mass, position, velocity, startTime): EntryPrediction`.

- [ ] **Step 1: Tighten the existing failing predictor tests**

```ts
expect(v.pos).toEqual(positionBefore);
expect(v.vel).toEqual(velocityBefore);
expect(pred.samples.every((sample) => sample.isFinite())).toBe(true);
expect(pred.landingTime).toBeGreaterThan(game.time);
```

Add these airless-body cases:

```ts
it('predicts direct terrain impact on an airless body without heating', () => {
  const game = new GameState();
  const palla = game.universe.get('palla');
  const craft = buildProbe();
  const model = buildAeroModel(craft);
  const mass = computeMassProperties(craft).mass;
  const pred = predictEntry(
    palla,
    model,
    mass,
    new Vec3(palla.radius + 10_000, 0, 0),
    new Vec3(-100, 0, 0),
    game.time,
  );
  expect(pred.lands).toBe(true);
  expect(pred.peakHeatFlux).toBe(0);
});

it('reports no entry for a stable airless orbit', () => {
  const game = new GameState();
  const gv = game.spawnInOrbit(buildProbe(), 'Probe', 'palla', 100_000);
  const palla = game.bodyOf(gv);
  const model = buildAeroModel(gv.runtime.craft);
  const mass = computeMassProperties(gv.runtime.craft).mass;
  const pred = predictEntry(palla, model, mass, gv.runtime.pos, gv.runtime.vel, game.time);
  expect(pred.willEnter).toBe(false);
  expect(pred.lands).toBe(false);
});
```

- [ ] **Step 2: Run predictor tests and verify RED**

Run: `npx vitest run tests/planning.test.ts -t "entry prediction"`

Expected: module-resolution failure for `src/sim/entry.ts`.

- [ ] **Step 3: Implement a bounded pure trajectory integrator**

```ts
export interface EntryPrediction {
  willEnter: boolean;
  lands: boolean;
  landingDirBF: Vec3 | null;
  landingTime: number;
  impactSpeed: number;
  peakHeatFlux: number;
  samples: Vec3[];
}

export function predictEntry(
  body: Body,
  model: AeroModel,
  mass: number,
  position: Readonly<Vec3>,
  velocity: Readonly<Vec3>,
  startTime: number,
): EntryPrediction {
  const r = new Vec3(position.x, position.y, position.z);
  const v = new Vec3(velocity.x, velocity.y, velocity.z);
  const elements = stateToElements(body.mu, r, v, startTime);
  const outerRadius = body.radius + (body.def.atmosphere?.height ?? body.def.terrain.amplitude);
  const potentialEntry = elements.e >= 1 || periapsisOf(elements) <= outerRadius;
  if (!potentialEntry) return emptyPrediction();

  const initialPeriod = elements.e < 1 ? periodOf(elements) : Infinity;
  const endTime = startTime + Math.min(Number.isFinite(initialPeriod) ? initialPeriod * 2 : 21_600, 21_600);
  const samples = [r.clone()];
  let time = startTime;
  let entered = false;
  let peakHeatFlux = 0;
  let previousR = r.clone();
  let previousV = v.clone();
  let previousTime = time;
  let previousClearance = clearance(body, r, time);

  for (let iteration = 0; iteration < 100_000 && time < endTime; iteration++) {
    const altitude = r.length() - body.radius;
    const atmospheric = !!body.def.atmosphere && altitude < body.def.atmosphere.height;
    entered ||= atmospheric;
    const dt = Math.min(atmospheric ? 0.25 : 2, endTime - time);
    previousR.copy(r);
    previousV.copy(v);
    previousTime = time;
    previousClearance = clearance(body, r, time);

    const radius = r.length();
    const acceleration = r.clone().scale(-body.mu / (radius * radius * radius));
    if (atmospheric) {
      const omega = body.def.rotationPeriod === 0 ? 0 : (Math.PI * 2) / body.def.rotationPeriod;
      const airVelocity = new Vec3(v.x + omega * r.y, v.y - omega * r.x, v.z);
      const speed = airVelocity.length();
      const density = body.densityAt(altitude);
      const cdA = model.areaAxial * model.cdAxial;
      if (speed > 0 && density > 0) {
        acceleration.addScaled(airVelocity, -(0.5 * density * speed * cdA) / mass);
        peakHeatFlux = Math.max(peakHeatFlux, 0.5 * density * speed * speed * speed);
      }
    }
    v.addScaled(acceleration, dt);
    r.addScaled(v, dt);
    time += dt;
    if (samples.length < 2_048 && (iteration % 8 === 0 || atmospheric)) samples.push(r.clone());

    const currentClearance = clearance(body, r, time);
    if (currentClearance <= 0 && previousClearance > 0) {
      const fraction = previousClearance / (previousClearance - currentClearance);
      const landingPosition = Vec3.lerp(previousR, r, fraction, new Vec3());
      const landingVelocity = Vec3.lerp(previousV, v, fraction, new Vec3());
      const landingTime = previousTime + dt * fraction;
      const landingDirBF = inertialDirectionToBodyFixed(body, landingPosition, landingTime);
      const omega = body.def.rotationPeriod === 0 ? 0 : (Math.PI * 2) / body.def.rotationPeriod;
      const relativeVelocity = landingVelocity.sub(new Vec3(-omega * landingPosition.y, omega * landingPosition.x, 0));
      return { willEnter: true, lands: true, landingDirBF, landingTime, impactSpeed: relativeVelocity.length(), peakHeatFlux, samples };
    }
  }
  return { willEnter: entered || potentialEntry, lands: false, landingDirBF: null, landingTime: 0, impactSpeed: 0, peakHeatFlux, samples };
}
```

Define `emptyPrediction()` in the same module to return finite zero/default fields, `clearance()` as `position.length() - groundRadiusInertial(body, normalizedDirection, time)`, and `inertialDirectionToBodyFixed()` as normalized direction rotated by `-body.rotationAngle(time)` around +Z. The later authority phase replaces that last helper with `BodyOrientation` without changing this public API.

- [ ] **Step 4: Run predictor tests and verify GREEN**

Run: `npx vitest run tests/planning.test.ts -t "entry prediction"`

Expected: all entry-prediction tests pass.

- [ ] **Step 5: Run the full planning suite**

Run: `npx vitest run tests/planning.test.ts`

Expected: transfer, alarm, and entry tests all pass.

- [ ] **Step 6: Commit the predictor**

```bash
git add src/sim/entry.ts tests/planning.test.ts
git commit -m "feat: predict atmospheric entry trajectories"
```

### Task 4: Phase 0 Documentation and Full Verification

**Files:**
- Modify: `CLAUDE.md`
- Modify: `STATUS.md`

**Interfaces:**
- Consumes: all Phase 0 behavior.
- Produces: accurate repository commands and baseline status.

- [ ] **Step 1: Replace stale repository guidance**

Document `npm test`, `npm run build`, `npm run test:e2e`, the TypeScript/Vite architecture, and the fact that Phase 0 mission planning is implemented.

- [ ] **Step 2: Run full verification**

Run: `npm test`

Expected: all Vitest files and tests pass with zero failures.

Run: `npm run build`

Expected: TypeScript and Vite production build exit 0.

- [ ] **Step 3: Self-review Phase 0 against the spec**

Check alarm boundary clipping, alarm save migration, predictor purity, authoritative terrain contact, bounded loops, finite outputs, and absence of placeholder comments. Fix any discrepancy and repeat Step 2.

- [ ] **Step 4: Commit Phase 0 documentation**

```bash
git add CLAUDE.md STATUS.md
git commit -m "docs: record restored M2 planning baseline"
```
