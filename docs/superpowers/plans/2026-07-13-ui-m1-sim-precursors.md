# UI M1 Simulation Precursors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilize the simulation and save contracts consumed by the flight-HUD and maneuver-planning work: correct staging after every vessel split, persisted body targets, and executable craft action groups.

**Architecture:** Keep all authoritative state and mutation in `src/sim/` and `src/save/`; UI code will consume these contracts in the next plan. Stage and action-group partitions are pure craft helpers. Save version 6 introduces both target and action-group fields in one migration so this milestone causes only one schema bump.

**Tech Stack:** Strict TypeScript, Vitest, existing deterministic simulation, versioned JSON save schema.

## Global Constraints

- Use the approved Revision 3 UI redesign spec on `origin/main` as the source of truth.
- Fast-forward the local branch to the completed workstream-1 baseline before editing.
- Preserve the existing `.gitignore`, package, lockfile, `vercel.json`, and staging work while integrating the remote baseline.
- Simulation and persistence code remain DOM-free.
- Empty stage entries are removed from both resulting vessels; each `currentStage` is remapped to the first unfired surviving stage.
- Body targets are body ids or `null`; invalid ids fail save restoration before vessel state is installed.
- Action groups are numbered 1 through 10 and support `toggle`, `activate`, and `deactivate` against a part's existing `activated` flag.
- Testing cadence is intentionally light during implementation: run focused checks after risky schema/split work, then run the full unit suite and build at the end.
- Do not commit or push unless the user explicitly requests it.

---

## File Structure

- `src/sim/vessel.ts` — craft-level stage/action-group types and pure partition helpers.
- `src/sim/state.ts` — split cursor propagation, body target ownership, action-group execution.
- `src/save/schema.ts` — save version 6 shapes, validation, and v5→v6 migration.
- `src/save/persistence.ts` — serialize/restore targets and action groups; validate older craft files.
- `tests/stage-partition.test.ts` — the four deterministic split cases required by the spec.
- `tests/action-groups.test.ts` — group execution and split/remap behavior.
- `tests/save-maneuver.test.ts` — target/action-group save round trip.
- `tests/save-terrain-migration.test.ts` — v5→v6 compatibility.

### Task 1: Integrate the approved remote baseline

**Files:** No content changes; update `main` from `origin/main` while retaining the dirty worktree.

**Interfaces:**
- Consumes: fetched `origin/main` at `76c9d53` or newer.
- Produces: local worktree containing approved Revision 3 and completed workstream 1.

- [ ] **Step 1: Record the dirty state**

Run:

```bash
git status --short
git diff -- src/sim/state.ts src/sim/vessel.ts tests/vessel.test.ts tests/stage-partition.test.ts
```

Expected: the staging work and unrelated deployment files are visible; no UI-foundation file is locally modified.

- [ ] **Step 2: Fast-forward without rewriting local changes**

Run:

```bash
git merge --ff-only origin/main
```

Expected: fast-forward succeeds because the remote workstream-1 commits do not overlap the dirty simulation/deployment files.

- [ ] **Step 3: Recheck ownership boundaries**

Run:

```bash
git status --short
git diff --check
```

Expected: all pre-existing changes remain and the new spec/UI files are tracked at `HEAD`.

### Task 2: Normalize stage plans across vessel splits

**Files:**
- Modify: `src/sim/vessel.ts`
- Modify: `src/sim/state.ts`
- Modify: `tests/vessel.test.ts`
- Modify: `tests/stage-partition.test.ts`

**Interfaces:**
- Consumes: `Stage`, detached part keys, and the original next-stage cursor.
- Produces:

```ts
export interface StagePlan {
  stages: Stage[];
  currentStage: number;
}

export interface StagePartition {
  retained: StagePlan;
  detached: StagePlan;
}

export function partitionStages(
  stages: readonly Stage[],
  currentStage: number,
  detachedKeys: ReadonlySet<number>,
): StagePartition;
```

- [ ] **Step 1: Replace the provisional helper with cursor-aware compaction**

Implement one `project(detached: boolean)` pass in `partitionStages`:

```ts
const projected = stages.map((stage) => ({
  partKeys: stage.partKeys.filter((key) => detachedKeys.has(key) === detached),
}));
return {
  stages: projected.filter((stage) => stage.partKeys.length > 0),
  currentStage: projected
    .slice(0, Math.max(0, currentStage))
    .filter((stage) => stage.partKeys.length > 0).length,
};
```

Clamp the returned cursor to `stages.length`. Do not mutate the source stages.

- [ ] **Step 2: Advance a fired stage before separation and install both plans**

In `GameState.fireStage`, increment `v.currentStage` after activating the stage's parts but before calling `detachSubtree`. In `detachSubtree`, pass that next-stage cursor to `partitionStages`, assign the retained plan to `v`, and construct the detached craft/runtime from the detached plan:

```ts
const stagePlans = partitionStages(v.craft.stages, v.currentStage, detachedKeys);
v.craft.stages = stagePlans.retained.stages;
v.currentStage = stagePlans.retained.currentStage;
debrisCraft.stages = stagePlans.detached.stages;
debris.currentStage = stagePlans.detached.currentStage;
```

Structural failure and undock call the same method without pre-advancing, so their first unfired stage remains first on both sides.

- [ ] **Step 3: Cover the four specified deterministic scenarios**

Keep the pure immutability test and make `tests/stage-partition.test.ts` cover:

```ts
it('continues above a fired decoupler without an empty-stage press', ...);
it('keeps control and the next action below a fired decoupler', ...);
it('remaps both cursors through a three-stage serial split', ...);
it('round-trips compacted plans after a mid-flight separation', ...);
```

The save/load case must call `serializeGame` and `restoreGame` after separation and compare both vessels' `stages` and `currentStage`.

- [ ] **Step 4: Run the focused split checks**

Run:

```bash
npx vitest run tests/vessel.test.ts tests/stage-partition.test.ts tests/docking.test.ts tests/ascent.test.ts
```

Expected: all selected tests pass with no hollow pending stage entries.

### Task 3: Add craft action-group authority

**Files:**
- Modify: `src/sim/vessel.ts`
- Modify: `src/sim/state.ts`
- Create: `tests/action-groups.test.ts`
- Update every direct `Craft` literal reported by TypeScript to include `actionGroups: {}`.

**Interfaces:**
- Produces:

```ts
export type ActionGroupId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
export type PartAction = 'toggle' | 'activate' | 'deactivate';

export interface ActionGroupAssignment {
  partKey: number;
  action: PartAction;
}

export type ActionGroups = Partial<Record<ActionGroupId, ActionGroupAssignment[]>>;

export function partitionActionGroups(
  groups: Readonly<ActionGroups>,
  detachedKeys: ReadonlySet<number>,
): { retained: ActionGroups; detached: ActionGroups };

GameState.executeActionGroup(gv: GameVessel, group: ActionGroupId): number;
```

- [ ] **Step 1: Add the schema to `Craft`**

Add `actionGroups: ActionGroups` to `Craft`; initialize it in `createCraft`. `partitionActionGroups` filters assignments by part ownership, retains group numbers, drops empty groups, clones assignments, and never mutates the input.

- [ ] **Step 2: Preserve assignments through graph mutations**

- `removeSubtree`: remove assignments referencing removed keys.
- `detachSubtree`: install the retained/detached action-group partitions on their respective crafts.
- docking merge: offset the incoming vessel's `partKey`s and append assignments into the matching group.
- undock and structural failure inherit correct behavior through `detachSubtree`.

- [ ] **Step 3: Execute groups through the simulation API**

Implement `executeActionGroup` by resolving each assignment against the current craft. Ignore missing keys, update only `activated`, log `Action group N: X action(s)`, and return the number of resolved assignments:

```ts
if (assignment.action === 'toggle') part.activated = !part.activated;
else part.activated = assignment.action === 'activate';
```

Call `refreshDerived` only if a future action affects geometry/mass; the three initial actions do not.

- [ ] **Step 4: Add focused behavior coverage**

Cover activate/deactivate/toggle, missing part keys, subtree removal, decoupler partition, and docking key remapping in `tests/action-groups.test.ts`.

### Task 4: Persist targets and action groups in save version 6

**Files:**
- Modify: `src/sim/state.ts`
- Modify: `src/save/schema.ts`
- Modify: `src/save/persistence.ts`
- Modify: `tests/save-maneuver.test.ts`
- Modify: `tests/save-terrain-migration.test.ts`
- Modify: `tests/craft-file-validation.test.ts`

**Interfaces:**
- `GameVessel.target: string | null`
- `SavedVessel.target: string | null`
- `SavedCraft.actionGroups: ActionGroups`
- `SAVE_VERSION = 6`

- [ ] **Step 1: Add target ownership to every vessel construction path**

Spawned vessels start with `target: null`. Detached vessels inherit `gv.target`; docking retains the receiving vessel's target. `setActive` does not change targets.

- [ ] **Step 2: Add the v5→v6 migration**

The migration supplies defaults without discarding old state:

```ts
if (save.saveVersion === 5) {
  save = {
    ...save,
    saveVersion: 6,
    vessels: save.vessels.map((vessel) => ({
      ...vessel,
      target: null,
      craft: { ...vessel.craft, actionGroups: {} },
    })),
  };
}
```

Update `validateSave` to require `target === null || typeof target === 'string'`, action-group ids 1–10, known action names, integer part keys, and arrays of assignments.

- [ ] **Step 3: Serialize and restore the new fields**

Deep-clone action-group assignments during serialization/restoration. Before installing vessels, resolve every non-null target through `game.universe.get`; let an unknown id abort restore. Restore target onto `GameVessel`, not `VesselRuntime`.

- [ ] **Step 4: Keep standalone craft files backward compatible**

`validateCraftFile` accepts missing `actionGroups` as `{}` for older files. Present groups are validated and cloned; assignments to unknown part keys are discarded just like dangling stage keys.

- [ ] **Step 5: Add focused persistence coverage**

- Save/restore preserves target and assignments.
- A v5 fixture migrates to `target: null` and `{}` action groups.
- Invalid target ids fail restoration.
- Old craft files without action groups still load.

### Task 5: Milestone contract verification

**Files:** No new production files.

**Interfaces:** Produces a stable contract for the HUD plan: compact stages/cursors, `GameVessel.target`, and `executeActionGroup`.

- [ ] **Step 1: Run simulation and persistence coverage**

Run:

```bash
npx vitest run tests/stage-partition.test.ts tests/action-groups.test.ts tests/save-maneuver.test.ts tests/save-terrain-migration.test.ts tests/craft-file-validation.test.ts tests/docking.test.ts tests/ascent.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 2: Run full verification at the batch boundary**

Run:

```bash
npm test
npm run build
git diff --check
```

Expected: zero test failures; content validation, strict TypeScript, and Vite production build succeed; no whitespace errors.

- [ ] **Step 3: Review the final diff for scope**

Run:

```bash
git status --short
git diff --stat
git diff -- src/sim src/save tests docs/superpowers/plans/2026-07-13-ui-m1-sim-precursors.md
```

Expected: only the planned simulation/save/tests/plan files plus the user's pre-existing deployment changes are present.
