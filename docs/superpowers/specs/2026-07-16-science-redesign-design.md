# Perilune Science Redesign

**Date:** 2026-07-16

**Status:** Revision 3 — final implementation contract. Revision 2 decisions confirmed; final reader testing closed repeated-collection, integer-rounding, and upgrade-snapshot edge cases.

**Scope:** Rework the science gameplay loop from a flat, situation-only, recover-only system into a legible exploration economy built on biomes and a transmit-vs-recover decision, without adopting full time-based simulation. Extract the loop into a pure `sim` module, fixing the correctness and architecture defects that currently live in the UI layer, and route it through the systems that already exist (the terrain authority, the communications network, ground stations).

## Objective

Perilune already has the hard parts: deterministic situations from real orbital state, a shared terrain authority, a full communications network with ground stations and relays, a clean tech-economy module, and versioned saves. What it lacks is *depth per world* and *decisions per mission*. Today a whole planet is at most six one-time collection events, every experiment is an identical instant button press, and the only way to bank a point is to physically land the vessel back on the home world — while the antenna parts and the comms network sit unused by science.

This redesign makes exploration the reward loop by adding two dimensions on top of instant collection: **biomes** (more sites per world) and **transmit vs. recover** (a real "how do I get the data home" decision, routed through the existing comms network). Collection stays a single instant press. The depth comes from *where* you go and *how you get the data home*, not from managing timers.

The structural target is **legible strategy owned by the simulation**: at any moment the player sees what science is available here, what it's worth, and what it costs to bank it; and every rule that decides those things lives in `sim/`, is deterministic, and is unit-tested.

## Final Product Decisions

These were open forks in Revision 1 that the review correctly flagged as blocking. They are now implementation decisions.

1. **Biome authority = a new deterministic classifier built on `sim/terrain.ts` geometry, not the render material field.** See *Architecture §3*. Consequence: science biome boundaries are geometric and will not perfectly match the visual material blend; exact visual alignment is a deferred non-goal.
2. **Transmission consumes the existing `evaluateComms` result.** No new range/occlusion logic. Transmit requires `connected === true`; link `strength` gates connection but does not scale value in v1. See *Architecture §4*.
3. **Collect-all and transmit-all.** One press records everything collectable at the site; one press transmits everything transmissible over the current link. Per-result selection is a non-goal for v1.
4. **Finite exploration campaign with an endless sink.** Total obtainable science is finite (sum of all site caps). Repeatable upgrade nodes absorb overflow demand — they do *not* create new supply. See *Economy*.
5. **No per-situation multiplier in v1.** Differentiation comes from body × biome multipliers only. The value formula omits a situation term until proven necessary.
6. **Duplicate experiment parts do not stack.** One keyed result per `(experiment, body, biome, situation)` regardless of how many copies of the instrument are aboard. Redundancy buys reliability, not extra science.

## Non-Goals

- No Kerbalism-style time-to-complete experiments, data-rate bandwidth budgets, or lab-over-time processing. (The "deep simulation" direction was explicitly not chosen.)
- No rewrite of orbital mechanics, the situation classifier's physics, the terrain authority, or the comms network. Science *consumes* these; it does not redefine them.
- No second communications authority. Science transmission must go through `evaluateComms` (`src/sim/comms.ts:101`).
- No exact alignment between science biome boundaries and the renderer's continuous material blend. Coarser geometric biomes are acceptable for v1.
- No new contract *system*. Contracts are touched only where they read the science-return flag; a fuller contract redesign is a separate effort (Open Questions).
- **Renderer/terrain visual changes are out of scope. 2D UI surfaces (flight HUD, Program Control, Science panel) are in scope** — this replaces Revision 1's mistaken "HUD-only visual changes" non-goal, which contradicted the panel work.

## Current-State Findings

Verified against the code on 2026-07-16.

- **Situation-only, no biomes.** `scienceSituation` (`src/content/science.ts:70`) maps to six situations; the key is `expId@bodyId-situation` (`experimentKey`, `:93`).
- **The biome data assumed by Revision 1 does not exist in a usable form.** The scatter biome is attached to sparse obstacle records, and only Veyra has a compiled scatter artifact — every other body resolves to an empty recipe (`scatterRecipeForBody`, `src/sim/scatterRecipe.ts:269`). The *visible* terrestrial surface is a continuous blend of biome class, moisture, altitude, shore, slope, and latitude, classified by `classifyTerrestrialSurface` against frozen `SURFACE_THRESHOLDS` (`src/render/terrestrial/surfaceMaterial.ts:23,82`) — but that classifier lives in the render layer and there is no sim-side per-direction biome evaluator today. `sim/terrain.ts` exposes only geometry: `solidHeight`, `isOcean`, `surfaceSlopeDegrees`, `terrainHeight` (`src/sim/terrain.ts:25,170,152`).
- **A full comms network already exists.** `evaluateComms(game, target) → { connected, path, strength }` (`src/sim/comms.ts:101`) does BFS relay routing from a vessel to any of three Veyra ground stations, with bilateral range (`sqrt(rangeA·rangeB)`) and planetary occlusion (`segmentBlocked`). `antennaRange` picks the best antenna aboard (`:88`). Science reads none of this.
- **Collection is instant, binary, one-shot, collect-all.** `runScience` (`src/game.ts:676`) records each valid experiment once per `(body, situation)` at a fixed value. The per-part "Run experiment" button calls the same global handler (`src/ui/flightHud.ts:526`).
- **No feedforward.** `scienceBtn` is created once (`:174`) and never updated; feedback is a log line that self-removes after ~6s.
- **Recovery rule lives in the UI, duplicated; `recover()` itself is unguarded.** `recover()` (`src/game.ts:707`) has no precondition. The "home + landed" rule is written twice — `src/ui/flightHud.ts:466` and `src/ui/missionTools.ts:330` — and the home world is the literal `'veyra'` in both (and ~10 files total). There is no `homeBodyId`.
- **Double-count is reachable.** `recover()` sums a vessel's `scienceData` and banks it without checking the global `completedExperiments` ledger (`:711-714`).
- **Stringly-typed keys double as the save format.** `expId@bodyId-situation` is a `Map` key and persisted (`src/save/schema.ts:80,107`).
- **Part→tech is a hand-maintained duplicate with a silent fallback** to `deep-space-systems` (`src/sim/campaign.ts:112,207`).
- **The economy is shallow and front-loadable:** six tech nodes, ~265 science total, no sink after completion.

## What the Genre Teaches

- **Biomes are what make exploration the reward, and repeat yields taper.** The [PlayerAssist guide](https://playerassist.com/kerbal-space-program-get-science/) describes biome-specific rewards and diminishing repeat yields — one world becomes many sites, and farming one site stops paying. This directly motivates *Architecture §3* and the diminishing-returns curve in *State Model*.
- **Transmit-then-return, repeated, is the interesting decision.** The [Steam discussion "Transmit, Return or Process?"](https://steamcommunity.com/app/220200/discussions/0/135512305401041096/) describes transmitting for partial value now and recovering (or re-running and re-transmitting) for the remainder later — the exact partial/remainder mechanic specified in *State Model* and *Architecture §4*.
- **Instant one-shot science with no curve is the failure mode.** The recurring complaint is that science "is not supposed to be grindy" and players "run out of ways to earn science" early ([KSP forums](https://forum.kerbalspaceprogram.com/topic/58376-stop-making-science-grindy/)). This is the argument for a diminishing curve plus a scaling sink rather than more collection events.
- **Depth we are deliberately not adopting:** [Kerbalism's](https://kerbalism.readthedocs.io/en/latest/science.html) time-based data streams and lab processing are the reference point for the rejected "deep simulation" direction.

## State Model & Value Formula (authoritative)

Everything below is defined before the workstreams so each commit has unambiguous semantics. This section resolves review findings P0-2, P0-3, and the "additional revisions" about formulas and multiplicity.

### Keys

```
type ScienceKey   = { experimentId: string; bodyId: string; biomeId: string; situation: ScienceSituation };
type ScienceKeyId = string;   // canonical encoding, e.g. `${experimentId}|${bodyId}|${biomeId}|${situation}`
```

`ScienceKeyId` is the **only** thing used as a `Map` key (resolving P0-3: object keys are unsafe under `Map` identity). The structured `ScienceKey` is decoded domain data. A single `encodeKey`/`decodeKey` pair is the sole boundary; no ad-hoc parsing in the UI. `biomeId` is always present from day one; before the classifier exists it is the body's single `global` biome (see workstream ordering).

### The two records

**Ledger** — global, the sole authority for "how much of this site has been delivered." One entry per key:

```
type LedgerEntry = { cap: number; deliveredByTransmit: number; deliveredByRecovery: number };
// delivered = deliveredByTransmit + deliveredByRecovery,  invariant: 0 ≤ delivered ≤ cap
```

Tracking the two channels separately is what lets the Science panel show *transmitted* vs *recovered* totals (P0-2). "Site exhausted / not collectable" ⇔ `delivered === cap`. Values are integers, so there is no fractional remainder state.

**Buffer** — per vessel, uncommitted science aboard. One entry per key:

```
type BufferedResult = { siteCapAtCollection: number; heldValue: number; transmittedFromThis: number; transmitTarget: number };
// heldValue: integer provisional value captured at collection
// transmittedFromThis ≤ transmitTarget ≤ heldValue
```

The buffer has **no authority** over "have I collected this" — only the ledger does. This is the fix for the double-count and the undefined-state cases in P0-2.

### Value formula

```
cap(key)              = round(experiment.baseValue × body.scienceMultiplier × biome.scienceMultiplier)
collectFraction(level) = 1 − (1 − COLLECT_FRACTION) × 0.9^level                         // base = 0.6
collectionYield(key)   = max(1, round((cap(key) − ledger.delivered(key)) × collectFraction(level)))
sampleTransmitFraction(base, level) = base === 0 ? 0 : 1 − (1 − base) × 0.92^level
sampleTransmitTarget   = round(heldValue × sampleTransmitFraction(experiment.transmitFraction, downlinkLevel))
```

`cap` is the site's total lifetime value; `collectionYield` is a *single collection's* provisional integer value (resolving the "cap vs single yield" ambiguity). First collection of a virgin site yields 60% of the cap at upgrade level 0; repeats taper geometrically toward it. All caps, buffers, deliveries, and `sciencePoints` are integer points. There is no situation term (Decision 5).

### Atomic transitions

- **collect(vessel, site):** for each experiment aboard valid at `(body, biome, situation)` and not exhausted, create one buffer record with `siteCapAtCollection`, `heldValue = collectionYield(key)`, and the absolute integer `transmitTarget = sampleTransmitTarget`. If that vessel already has a buffer record for the key, collection skips it; repeated button presses cannot duplicate an aboard sample or fill a cap through click-spam. Multiple copies of the instrument contribute once (Decision 6). The ledger is **not** touched. Two different vessels may both hold value for the same key; the ledger clamp at delivery decides who actually gets it.
- **transmit(vessel, link):** requires `evaluateComms(game, vessel).connected` (Decision 2). For each buffered key, deliverable-by-transmit = `transmitTarget − transmittedFromThis`; actual delivered = `min(deliverable, ledger.cap − ledger.delivered)`; add the integer result to `deliveredByTransmit` and `transmittedFromThis`. One press delivers the current sample's full transmissible target; subsequent presses are idempotent. Remove the buffer record when its full held value has transmitted **or** the authoritative ledger site is exhausted, because it can deliver no further value.
- **recover(vessel):** requires `isRecoverable(vessel, universe)` checked **inside** the command (P0-1). For each buffered key, deliverable = `heldValue − transmittedFromThis`; actual delivered = `min(deliverable, ledger.cap − ledger.delivered)`; add the integer result to `deliveredByRecovery`, then clear the buffer. Recoverability, not positive science delivery, defines command success: an empty vessel or a vessel whose duplicated results deliver zero still recovers normally. `game.ts` removes the vessel and grants the hardware refund only after success; `campaign:science-return` is set only when `deliveredByRecovery > 0`. Invalid recovery rejects and mutates nothing.
- **loss(vessel destroyed):** discard the buffer; the ledger is unchanged, so un-transmitted held value is lost and the site remains collectable to that extent (resolving "lost data being recollected").

`sciencePoints` spendable balance increments by exactly the summed integer *actual delivered* of each transition — never by a raw buffer sum — which is why double-count is impossible (every delivery is clamped against one ledger).

**Cap snapshot rule:** an existing ledger entry's `cap` is immutable. If a key has no ledger entry, the first delivered buffer creates it using that buffer's `siteCapAtCollection`; later content tuning cannot rewrite opened-site history. An untouched site uses the current content formula. If two saved buffers carry different historical caps, the first one delivered establishes the ledger cap and later deliveries clamp to it.

### Panel totals

`recovered = Σ deliveredByRecovery`, `transmitted = Σ deliveredByTransmit`, `aboard/collected = Σ over buffers min(heldValue − transmittedFromThis, remaining ledger cap when one exists)`.

## Architecture

### 1. Science authority — new deterministic module `src/sim/science.ts`

Distinct from `src/content/science.ts` (pure definitions). Owns deterministic state transitions currently stranded in `game.ts`, implementing the State Model exactly and performing no UI, persistence, or renderer work:

- `collect(state, vessel) → CollectOutcome`
- `transmit(state, vessel) → TransmitOutcome` (calls `evaluateComms` itself)
- `recover(state, vessel) → RecoverOutcome | { rejected: 'not-recoverable' }` (calls `isRecoverable` itself)
- `isRecoverable(vessel, universe) → boolean` — the single home-and-landed predicate
- `availableHere(state, vessel) → SciencePreview` — pure query for HUD feedforward

`game.ts`'s `runScience`/`recover` shrink to: call the module, surface outcomes in the log/dialog, persist. **No banking, refund, or vessel removal happens before the module returns success** (P0-1). The refund and `campaign:science-return` flag move behind the module's success result.

### 2. Structured keys & the ledger replace the split authority

Replace `expId@bodyId-situation` strings with `ScienceKeyId`/`ScienceKey`. Replace the `completedExperiments` set + per-vessel `scienceData`-as-dedup with the single **ledger** (authority) plus per-vessel **buffers** (uncommitted). Persisted shapes change accordingly (see Save Migration).

### 3. Biome authority — a deterministic sim classifier over existing geometry (Decision 1)

There is no sim-side biome field today, and lifting the render material field into `sim/` is larger than the entire rest of this rework. Therefore v1 defines `biomeAt(body, bodyFixedDir) → biomeId` as a **new deterministic classifier in `sim/`** built only from authorities `sim/terrain.ts` already exposes, plus latitude from the direction:

- ocean: `isOcean(body, dir)` → `ocean`
- else by altitude band (`solidHeight`), latitude band (`|dir·polarAxis|`), and slope (`surfaceSlopeDegrees`): e.g. `ice-cap` (cold latitude), `highland`/`mountains` (high altitude or steep slope), `lowland` (default). Thresholds are authored per body.

Bodies declare their biome set and multipliers in content:

```
BodyDef.biomes?: { id: string; name: string; scienceMultiplier: number }[] // authored sets include global
BodyDef.scienceBiomeThresholds?: {
  iceLatitudeMin?: number;       // normalized |body-fixed z| in [0,1]
  highlandAltitudeMin?: number;  // meters above datum
  mountainSlopeMinDeg?: number;  // degrees
}
```

- Every authored set must contain exactly one `global` biome with multiplier `1`; all ids are unique and multipliers are finite and positive. Bodies without a set synthesize that single global biome.
- **Exact precedence for granular situations:** gas body → `upper-atmosphere`; otherwise ocean → `ocean`; latitude at/above `iceLatitudeMin` → `ice-cap`; slope at/above `mountainSlopeMinDeg` → `mountains`; altitude at/above `highlandAltitudeMin` → `highland`; otherwise → `lowland`. A missing threshold disables that branch. Every enabled branch id must exist in the authored set; validation fails rather than silently emitting an unknown id.
- **Situation → biome applicability:** `surface`, `ocean`, and `flying-low` use the granular classifier. `flying-high`, `space-low`, and `space-high` always use `global`, whose multiplier is exactly `1`. Gas giants therefore author both `global` and `upper-atmosphere`; they have no solid-surface biome. Airless bodies use the geometric classifier with the ocean branch disabled.
- **Consequence (stated as a non-goal):** these geometric boundaries need not match the renderer's continuous blend. Exact alignment (lifting the material field into a shared sim authority) is deferred.

`biomeAt` is pure and deterministic and gets its own determinism tests; it is the single source consulted at collection time.

### 4. Transmission consumes the comms network (Decision 2)

Science transmit does **not** re-derive connectivity. It calls `evaluateComms(game, vessel)`:

- **Eligibility:** `connected === true`. (`needsCommsForControl` semantics are irrelevant here; transmission needs a link regardless of crew.)
- **Multiple antennas / relays:** already resolved by `evaluateComms` (best antenna via `antennaRange`, relayed BFS). Science adds nothing.
- **Link strength:** must be connected; `strength` does **not** scale delivered value in v1 (kept legible). Future lever noted.
- **`antenna.rate`:** not used to gate science value in v1 — one transmit press delivers the full transmissible remainder over the current link. (A per-press `rate` cap that forces large backlogs into multiple passes is a deferred lever.)
- **Charge:** transmission requires only a live comms link in v1; no separate electric-charge threshold or consumption. (Deferred lever.)
- **Value:** governed entirely by `transmitFraction` per experiment (State Model). `ExperimentDef` gains `transmitFraction ∈ [0,1]`; telemetry-type ≈ 1.0, imagery ≈ 0.6, physical samples 0.0–0.3 — the lever that makes sample-heavy science worth a return craft.

### 5. Home world & part-tech — remove the magic strings

- Introduce `homeBodyId` (the body hosting the ground stations — currently Veyra) as data on the universe/campaign; route `isRecoverable` and both recovery UI paths through it. Ground stations already encode "home"; align recovery-home with comms-home.
- Move tech gating onto the part: `PartDef.tech: TechId`; retire `PART_TECH`; `validate:content` fails on any missing/unknown `tech` (no silent fallback).

## The Reworked Interaction Loop

1. **Editor / build.** Parts locked by `PartDef.tech`. Antennas surface a "science downlink" affordance so their new role is discoverable.
2. **In flight — arriving.** HUD shows a **current biome** readout and a **science-available** indicator from `availableHere`; the Science button reflects it (enabled/badged when new, dimmed when exhausted).
3. **Collect (one press).** Records all valid experiments at `(body, biome, situation)` into the buffer with first-time-high / diminishing-repeat yields. A persistent aboard-science summary replaces the vanishing log flash.
4. **Transmit (new verb).** Enabled iff `evaluateComms(...).connected`. Delivers the transmissible fraction; shows partial-vs-full so the tradeoff is legible; samples read "recover only."
5. **Recover (home + landed).** One `isRecoverable` authority gates both buttons and the command itself; banks full remaining value; ledger prevents double-count.
6. **Spend (Program Control).** Expanded tech tree plus repeatable upgrade nodes as the scaling sink.
7. **Review (Science panel).** Grouped body → biome → situation, showing collected/transmitted/recovered and remaining cap per site — an exploration checklist that motivates travel.

## Economy (Decision 4)

- **Finite supply, endless sink.** Total obtainable science = Σ `cap` over all `(experiment, body, biome, situation)` sites. This is finite. Repeatable upgrade nodes create endless *demand*, not supply — so late-game science always has somewhere to go without pretending new science appears from nowhere. Revision 1's "science available forever" claim was inconsistent and is removed.
- **Per-world budget check.** Define a target campaign curve; the home world's biomes must not sum to enough to unlock the full tree (today they nearly do). `validate:content` fails if the per-world budget or the home-world share falls outside target bands.
- **Diminishing returns** as in the State Model (`COLLECT_FRACTION`), so a *new* site always beats farming an old one.
- **Transmit fractions** per experiment as the recover-incentive lever; samples skew low.
- **Expanded fixed tree.** Add Precision Science (80), Crewed Expeditions (105), and Planetary Industry (130) as later branches that redistribute advanced instruments, docking/crew hardware, and ISRU hardware out of the current six broad buckets.
- **Repeatable upgrades: persistence & retroactivity.** Purchased levels persist in `CampaignState.upgradeLevels`. Field Methods costs `round(60 × 1.55^level)` and uses `collectFraction(level)` above. Downlink Coding costs `round(75 × 1.6^level)` and uses `sampleTransmitFraction(base, level)` above; experiments authored with a base fraction of zero remain recover-only. Both upgrades apply to **future collection only**. `heldValue` and the absolute `transmitTarget` snapshot their effects, so later purchases never change aboard or delivered results and never inflate a site cap.

## Save Migration (two distinct rules — P1-2)

Old saves store the global completed-key **set** plus a scalar `sciencePoints`, and per-vessel uncommitted `science: Record<string, number>` separately. They contain **no per-key banked value**. Therefore:

- **Rule A — banked history → ledger (exhaustion only).** Each legacy completed key (which has no biome) maps to the body's `global` biome bucket and is written as a ledger entry with `deliveredByRecovery = cap`, `deliveredByTransmit = 0` (i.e., that global bucket is marked exhausted so it is not re-collectable). New biome-specific sites remain collectable. **The reconstructed ledger is authoritative only for "which sites are exhausted," not for the points total.**
- **Rule B — vessel buffers → buffers.** Legacy per-vessel `science: Record<string, number>` maps under the `global` biome to `BufferedResult { siteCapAtCollection: current global cap, heldValue: round(storedValue), transmittedFromThis: 0, transmitTarget: round(storedValue × experiment.transmitFraction) }`, **not** marked banked. This fixes the review's point that marking everything `collected = cap` would wrongly bank science still aboard a vessel.
- **Invariant after migration:** the historical scalar `sciencePoints` is preserved verbatim as the spendable balance and **wins** over any total reconstructed from the ledger (old saves cannot reconstruct a faithful per-key total; the scalar is the real earned/spent balance). No science is gained or lost; every legacy completed key is exhausted; aboard science stays aboard.
- Schema version bumps; a round-trip test asserts load → re-save stability and that `sciencePoints` and aboard/ledger totals are unchanged.

## Workstreams & Sequencing

Rewritten so **every commit has valid save and behavior semantics** (P1-3). The State Model and value formula above are settled first; workstreams only layer features on top.

- **WS0 — Foundation (one coherent change; correctness fixes, no new player features).** Introduce `sim/science.ts`, the ledger + buffers, `ScienceKeyId`/`ScienceKey` with `encode`/`decode`, `homeBodyId`, `isRecoverable` checked inside `recover`, the value formula with `COLLECT_FRACTION`, the `biomeId` field fixed to each body's synthetic `global` value, and the Rule A/B migration. `game.ts` calls the module. This single step fixes double-count and unguarded/duplicated recovery and lands a stable save format.
- **WS1 — Data hygiene.** `PartDef.tech` + retire `PART_TECH` + `validate:content` failure; both recovery UI paths consume the WS0 predicate.
- **WS2 — Biomes.** `biomeAt` classifier + `BodyDef.biomes` + situation→biome applicability. Granular `biomeId` values now flow into keys; migration already tolerates them (global bucket). Seed the three graphics archetypes first (Veyra terrestrial, Palla airless, Tyran gas), others fall back to `global`.
- **WS3 — Transmit.** `transmitFraction` on experiments; the transmit verb consuming `evaluateComms`; sample-vs-telemetry classification and the "recover only" UI.
- **WS4 — Economy.** Tune `COLLECT_FRACTION` and per-biome multipliers to the target curve; expanded + repeatable tech nodes with the persistence/retroactivity rules; the `validate:content` budget check.
- **WS5 — Feedforward & panel.** Science-available indicator, biome readout, persistent aboard summary, and the exploration-checklist Science panel.

WS0–WS5 are cumulative checkpoints, not parallel-independent branches. Each checkpoint is shippable after its listed predecessors: WS0 → WS1 → WS2 → WS3 → WS4 → WS5. WS0 is the correctness beachhead; WS2–WS3 are the depth payload; WS4–WS5 make it legible and give science somewhere to go.

## Testing Strategy

- **`sim/science` unit tests** exercising the State Model transitions: collect writes one buffer record and repeated collect is idempotent while it remains aboard; two vessels collecting one site then both delivering never exceeds `cap`; transmit delivers the rounded per-sample target once and repeated transmit is idempotent; recovery pays the remainder to `cap`; loss discards the buffer and leaves the site collectable. Balance assertions use `closing sciencePoints = opening balance + post-load delivery − spending`; migrated ledger totals are not expected to reconstruct legacy balances.
- **`isRecoverable` truth table:** home/away × landed/splashed/prelaunch/flying × debris, asserted at the command boundary (rejection mutates nothing).
- **`biomeAt` determinism:** stable per `(body, dir)`; correct branch selection at sampled ocean/altitude/latitude/slope points; `global` fallback for unauthored bodies and orbital situations.
- **Transmit integration:** with a mocked `evaluateComms`, transmit is gated on `connected` and ignores `strength` for value in v1.
- **Content validation:** every part has a valid `tech`; every experiment `transmitFraction ∈ [0,1]`; per-world and home-world science budgets within target bands.
- **Save migration:** legacy completed keys → exhausted `global` ledger buckets; legacy aboard `science` → un-banked buffers; `sciencePoints` preserved; round-trip stable; no science gained or lost.
- **E2e smoke:** collect → transmit partial (link up) → return → recover remainder → spend on a node, asserting ledger channel totals at each step.

## Deferred Decisions (not blockers for v1)

1. **Biome faithfulness.** V1 ships geometric sim biomes that may not match the visual blend. A later renderer/sim unification may align them exactly.
2. **Airless-body biomes.** V1 gives Palla altitude/latitude/slope biomes but no crater identity; crater-based biomes require a new shared authority.
3. **Contracts.** Out of scope, but the 4-flag board and its auto-settle-on-accept quirk (`utilityTools.ts:207`) intersect the science-return flag. Fold a light pass into WS4, or spec separately?
4. **`strength`/`rate`/charge as future levers.** V1 deliberately ignores link strength as a value scalar, `antenna.rate`, and charge consumption.

### Resolved (from Revision 1 review)

- P0 recovery enforcement → predicate checked inside the command; `game.ts` banks nothing before success (*Architecture §1*, *State Model*).
- P0 ledger state model → explicit buffer/ledger records, two delivery channels, atomic transitions (*State Model*).
- P0 unsafe object `Map` keys → canonical `ScienceKeyId` string as the only map key (*State Model*).
- P0 biome authority → deterministic sim classifier over `terrain.ts` geometry, chosen and specified (*Architecture §3*, Decision 1).
- P1 comms → science consumes `evaluateComms`; no second authority (*Architecture §4*, Decision 2).
- P1 migration → two rules, preserved `sciencePoints` invariant, defined tiebreaker (*Save Migration*).
- P1 sequencing → State Model settled first; WS0–WS5 each valid (*Workstreams*).
- P1 finite-vs-forever → finite supply, endless sink; retroactivity rules defined (*Economy*, Decision 4).
- Additional: collect-all/transmit-all (Decision 3), no situation multiplier (Decision 5), no multiplicity stacking (Decision 6), formula/rounding/exhaustion threshold (*State Model*), biome-per-situation table (*Architecture §3*), corrected UI non-goal (*Non-Goals*), sources attached to specific claims (*What the Genre Teaches*).
