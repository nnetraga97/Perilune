# Artemis IV Lunar Landing Guided Mission — Implementation Plan

**Date:** 2026-07-21

**Status:** Approved implementation plan with the final craft and presentation refinements incorporated. The user selected the downloaded MartianDays 2019 generic Starship GLB as the lander visual and required that it remain unedited; the source asset, provenance lock, and pass-through runtime manifest are present. Orion will reuse Perilune's NASA-derived Voyager visual. Mission code has not yet been implemented from this plan.

**Worktree:** `/Users/nicknetraganti/Desktop/Developer Stuff/Perilune/artemis-iv-lunar-landing`

**Branch baseline:** `feature/artemis-iv-lunar-landing` at `163b6c6`, tracking `origin/main`.

**Supersedes:** The abandoned Gateway-centered Artemis replay on `feature/artemis-mission-replay` and commit `926d076`. That branch is historical evidence only. It must not be merged or cherry-picked into this worktree.

## Goal

Make **Artemis IV** the first guided experience new players see on the main screen: a hands-on, craft-focused lunar-landing mission in the instructional style of First Light and Second Light.

The player operates Orion and a representative landing-system simulation visualized with an unchanged 2019 generic Starship concept through the parts of the mission Perilune can teach honestly: lunar approach, rendezvous and docking, descent, landing, ascent, redocking, trans-Earth return, entry, and splashdown. Crew transfer and the approximately one-week surface expedition are concise text steps. The experience is not a passive replay, an astronaut/EVA game, or a claim to reproduce NASA's final flight plan. The chosen mesh is not Starship HLS and must never be presented as an accurate HLS configuration.

The result must be polished enough to serve as Perilune's first impression while remaining a normal simulation session: the player's inputs, the physics state, and real completion conditions advance the guide.

## Confirmed real-world mission

This plan follows NASA's current July 2026 Artemis architecture:

- Artemis IV is targeted for early 2028 and is NASA's first crewed lunar landing in the revised sequence.
- Four astronauts launch in Orion; two transfer to a commercial human landing system, land near the lunar South Pole, spend about a week on the surface, ascend, rejoin the other two crew members, and return in Orion for Pacific splashdown.
- NASA has not selected the Artemis IV lander provider. Readiness will determine whether SpaceX or Blue Origin flies the mission.
- NASA's current Artemis IV sequence describes Orion docking directly with the commercial lander in lunar orbit. Gateway is not part of this tutorial.
- NASA will replace ICPS with a new second stage, is assessing alternative second-stage options, and no longer plans to use EUS or Mobile Launcher 2. Until NASA publishes the resulting configuration, a rendered “accurate Artemis IV launch stack” would be fictional.

These facts are the mission's truth boundary. Provider-specific vehicle performance, final burn times, landing site, crew assignments, detailed science manifest, and exact mission duration remain provisional unless NASA publishes them before content lock.

## Product decisions

| Decision | Locked choice | Reason |
| --- | --- | --- |
| Main-screen placement | Add an `ARTEMIS IV` mission entry and make it primary for a first-time user | It is the intended first experience, but the user still enters through the main screen rather than an unskippable auto-launch |
| Interaction style | Extend First Light's live, contextual guide over a real `GameState` | The player learns by operating the craft; a timeline/replay does not teach Perilune |
| Playable focus | Vehicle operations | Crew transfer and the surface expedition are explicit text/Continue steps; no EVA controls or astronaut model are required |
| HLS visual for v1 | **MartianDays' unchanged 2019 generic Starship concept GLB** | The user selected the exact downloaded model. Its CC BY 4.0 license permits redistribution with attribution, and its byte identity is locked in the mission manifest |
| Provider claim | `UNCHANGED 2019 STARSHIP CONCEPT STAND-IN · NASA PROVIDER TBD` remains visible on the menu card and guide header | NASA has not assigned Artemis IV to SpaceX, and this mesh is not Starship HLS. The scenario choice must not be presented as an announcement, prediction, or accurate HLS model |
| Vehicle assets | Preserve the Starship GLB byte-for-byte; reuse the existing NASA-derived `orion-voyager-pod` at Orion scale; add only the missing ESM, docking, and recovery attachments | This uses the best fitting assets already in the project and avoids a second Orion model pipeline |
| Launch/TLI | Sourced text prologue; interactive session begins in Orion after TLI | The Artemis IV SLS upper-stage configuration is not yet defined, so showing an old Block 1 or Block 1B stack would undermine the accuracy requirement |
| Lunar site | A clearly labeled South Pole **training analogue** based on the existing NASA PGDA Site 01 terrain | NASA has not published the Artemis IV landing site. The tutorial may teach polar landing conditions without claiming Site 01 is the mission site |
| Camera | Normal Perilune external flight and map views | The abandoned first-person/NASA Eyes experiment is out of scope; it should not be revived implicitly |
| Session length | Approximately 35–50 minutes, split into resumable chapters | Full-duration coasts and a week-long stay are compressed without replacing hands-on maneuvers with a replay |
| Guide presentation | Improve the existing tutorial card, spotlight, and completion feedback in place | The interaction should feel responsive and authored without introducing a tutorial DSL or animation system |
| Maneuver planner | Expose the strong interactions and live predictions that already exist | Clear labels, visible outcomes, and one guided adjustment teach planning better than a new solver or planner |
| Space backdrop | Use one neutral space background and upgrade the existing single-draw starfield | Earth's atmosphere should create the local blue; space itself should not change color by renderer type |
| Starship hardware gate | Keep Artemis IV primary, but run a visible preflight before loading and switch the mission renderer to its certified high tier only on supported devices | The exact unedited textures exceed the default medium resource envelope; unsupported devices get a clear First Light fallback rather than a crash or silent downgrade |

## Why the unchanged Starship concept is the implementation choice

No first-party, downloadable Starship HLS geometry was found. The selected model is instead MartianDays' downloadable 2019 `SpaceX Starship` GLB from Sketchfab. The embedded metadata and public model record identify the author, source, and CC BY 4.0 license. The exact 19,007,332-byte file is placed under `assets/missions/artemis-iv/models/` with SHA-256 `287317f26516237ed154b9364914396d562552d330a3041000f6157f97c9304c`.

This selection intentionally trades HLS visual accuracy for immediate use of the user's chosen Starship model. The file depicts a generic 2019 Earth-return/Mars-era concept with cabin windows, cargo elements, sea-level and vacuum engines. It lacks the current HLS nose docking system, lunar landing thrusters, landing gear, elevator, and other HLS-specific configuration. Nothing in the UI, guide, docs, or tests may collapse “Starship concept stand-in” into “Starship HLS model.”

The Artemis mission data names the checked Starship asset directly. If a rights-cleared HLS visual is approved later, that asset reference and its external anchors can change without changing checkpoint physics. V1 does not add a provider/variant abstraction for that hypothetical future. The visible model remains unchanged; representative docking, thrust, RCS, crew capacity, and landing contacts come from editor-hidden mission physics elements and are never described as manufacturer specifications.

The source license permits redistribution with attribution but does not grant SpaceX trademark rights or imply endorsement. The bundled textures were inspected and no provider logo was found. Visible credits, descriptive-use wording, and the non-endorsement disclaimer remain release requirements.

## Vehicle and asset contract

### Orion

Reuse `orion-voyager-pod` directly as the final Crew Module silhouette. Its source recipe is based on NASA's `Orion Capsule (no fbc).stl`, so it is genuinely Orion-derived rather than merely Orion-like. Apply a mission-only uniform visual scale of `4.164`, taking its checked diameter from about 1.20 m to 5.0 m. The resulting height is about 3.54 m versus NASA's published 3.35 m, so the UI must call it `Orion Crew Module · simplified exterior`, not a dimensionally exact model.

Do not change or reuse the stock `pod-voyager` gameplay definition: it is a one-seat, 840 kg game part. The Artemis assembly owns the representative four-person capacity, mass, heat-shield/reentry envelope, CM RCS, docking transform, ESM propulsion, and CM/ESM separation. Stock craft remain unchanged.

Add only the missing visible context around the reused capsule:

- a simple, dimensionally grounded ESM body with four three-panel solar wings and a clear CM/ESM separation boundary;
- a visible docking collar, while the invisible mission docking transform remains authoritative;
- the existing `orion-homecoming-housing` where it fits, plus a lightweight three-main-canopy recovery visual or an explicit `representative deployment` label if the current single-canopy renderer is retained.

The ESM and attachments may be assembled from existing/procedural project geometry. Do not start a new hero-asset compiler merely to create them. The stock Odyssey assembly is useful as a topology reference, but its narrow tanks and small panels are not a credible final ESM exterior.

### Unchanged 2019 Starship concept stand-in

Use `assets/missions/artemis-iv/models/martiandays-spacex-starship-2019.glb` byte-for-byte. Do not run it through the stock part compiler, Meshopt, KTX2 conversion, texture resizing, geometry cleanup, material rewriting, anchor baking, or authoring tools.

The external manifest transform is the only permitted visual adjustment: uniform scale `0.01`, checked centering translation, identity rotation, and `+Y` nose alignment. It yields checked centered bounds of approximately 19.995 m wide by 53.179 m tall by 11.045 m deep without changing the asset. Docking, center-of-mass, thrust, RCS, landing-contact, camera, and plume anchors live in the mission definition outside the GLB.

The model is a visual shell only. Do not add visible HLS features to it, describe its sea-level/vacuum engine geometry as the Artemis IV propulsion system, or imply that its windows/cargo elements will fly on HLS. Crew transfer and surface operations stay text-only, so no speculative interior or elevator animation is required.

### Mission-specific asset boundary

The current stock part catalog is already about 64,090 of its 65,000-triangle budget. Do not squeeze Artemis vehicles into that eager-preloaded library.

Keep the asset path small and explicit:

- load Voyager through the existing checked `PartModelLibrary`, clone it once for the Orion mission composite, and apply the mission scale outside the stock part definition;
- add one small lazy Starship loader around the existing GLTF/KTX2/Meshopt setup and the checked mission manifest; do not generalize it into a new model-library framework until a second mission asset actually needs that abstraction;
- keep the Starship's external numeric transform and functional anchors in the mission data; no changes are baked into the GLB;
- retain source URL, author, license/attribution, checksum, no-edit policy, runtime transform, truth label, dimensions, triangle/draw/texture counts, transfer bytes, and GPU estimate in the checked manifest;
- no third-party model in Git or the production bundle without a project-compatible written license, exact checksum, attribution, and accuracy label; the selected CC BY 4.0 Starship GLB satisfies that gate;
- no copied NASA/provider texture, decal, logo, or committed reference-image sheet without permission specific to that use; `restricted` or `unknown` clearance blocks provider-specific art;
- no loading dependency before the main screen becomes interactive;
- preload Starship only after the menu is usable and before a chapter that displays it. If it is unavailable or corrupt, keep the menu usable and offer `RETRY`/`EXIT`; do not silently replace it with generic stock parts.

The user-selected unaltered Starship is 20,630 triangles, eight draws, 19,007,332 transfer bytes, and approximately 357,913,936 texture bytes resident with a full RGBA8 mip chain. Because editing or texture optimization is explicitly disallowed, it does not fit the default medium total-renderer envelope. Starting Artemis IV therefore runs a capability/resource preflight and, only after it passes, switches the mission renderer to its certified **high** tier before loading the model. Charge the Starship's measured texture, geometry, and material bytes to the existing renderer resource ledger; the manifest alone is not enforcement.

Mission craft transfer must remain below 25,165,824 bytes and every measured combined scene below the Artemis path's 1,342,177,280-byte ceiling. That combined allowance includes the checked High-tier planet renderer, the unchanged Starship textures, and framebuffer headroom; it does not raise the planet pack's independent 805,306,368-byte limit. Crossing either ceiling fails the release gate and returns the asset choice to the user; the implementation may not hide this cost behind the current PNG stats bug. If the device cannot support the certified path or allocation/loading fails, do not begin an invisible or unstable mission: explain that the unchanged visual requires High quality and offer `OPEN FIRST LIGHT`, `RETRY`, and `EXIT`. Restore the player's prior renderer tier when the mission exits.

Measure the docked Orion/lander stack, powered-descent terrain plus plumes, and Orion entry plus parachutes against that one high-tier ceiling. Per-asset compliance cannot pass an over-budget combined scene.

The displayed model and the physics assembly are separate concerns. Use one visible composite root per separable flight element, backed by editor-hidden functional parts for docking ports, propulsion, propellant, RCS, crew capacity, landing contacts, and decouplers. The mission craft should not appear in the normal editor catalog until they meet normal part-library standards.

## Guided mission flow

Every action step uses a real simulation predicate. Text steps expose an explicit, accessible `Continue` control and cannot be bypassed accidentally by unrelated vessel state.

| Chapter | Starting state | Player action and lesson | Completion gate |
| --- | --- | --- | --- |
| 0. Mission briefing | Main-screen mission card | Read the current Artemis IV outline, provider disclaimer, and text summary of launch/TLI | Player selects `BEGIN MISSION` |
| 1. Lunar approach | Orion/ESM on a checked post-TLI trajectory | Adjust a prepared prograde correction until predicted lunar periapsis enters the guided encounter corridor, execute it, coast into lunar SOI, then inspect and execute a separate prepared retrograde lunar-orbit-insertion burn | Orion reaches the checked representative inclined/polar staging-orbit envelope |
| 2. Find the lander | Orion and the pre-positioned Starship stand-in on a prepared phasing/near-rendezvous solution | Select the lander as target, execute the guided intercept, read relative range/rate, approach, and stop at the safe hold point | Stable hold within the configured range and closing-rate envelope |
| 3. Dock and transfer | Vehicles near the docking corridor | Align docking axes, close slowly, dock, then acknowledge the text crew-transfer step | Docked state plus an acknowledgement that mutates and validates two crew in Orion/two in the lander |
| 4. Commit to descent | Docked stack in a representative lunar staging orbit | Switch to the lander, undock, orient, and execute the deorbit/descent setup | Lander is separated and enters the checked descent corridor |
| 5. Powered descent | Lander above the South Pole training analogue | Use attitude guidance, throttle, target marker, vertical/horizontal speed, AGL, and slope cues to land | Sustained stable multi-point landed state inside the safe training ellipse and within touchdown-speed/slope limits |
| 6. Surface expedition | Landed lander | Text sequence summarizes roughly one week of science, samples, and surface operations | Player chooses `CONTINUE TO ASCENT` |
| 7. Lunar ascent | Checked landed checkpoint | Initiate ascent, hold the guidance corridor, and insert into lunar orbit | Stable orbit inside the representative ascent checkpoint envelope |
| 8. Rejoin Orion | Lander and Orion on a prepared phasing solution | Rendezvous, hold, dock, and acknowledge crew/sample transfer | Docked state plus an acknowledgement that returns/validates all four crew and samples in Orion |
| 9. Return to Earth | Orion/ESM in the checked departure orbit with a prepared representative TEI node | Separate the lander, inspect/execute trans-Earth injection, and use time warp through the return coast | Orion enters the checked Earth approach corridor |
| 10. Entry and splashdown | Orion on a validated entry interface state | Jettison ESM, orient the crew module, survive entry, deploy parachutes, and splash down | Crew module is safely recovered in a representative Pacific recovery area |

Long coasts use existing time warp. Chapter checkpoints compress only uneventful time and prepared phasing, not the maneuver currently being taught. If the outbound lunar-coast and capture sequence makes the first session too long after playtesting, Chapter 1 may begin closer to lunar approach, but the briefing must state the compression.

## Main-screen and resume behavior

After the Milestone 6 release gate, make the dedicated Artemis IV mission entry public; do not hide it under Program or Sandbox. Before that gate it remains development-only.

The menu card subtitle and in-mission guide header must both retain `UNCHANGED 2019 STARSHIP CONCEPT STAND-IN · NASA PROVIDER TBD`; the provider and accuracy qualifiers cannot be confined to a briefing users may skip.

- **Fresh user, no normal save and no Artemis session:** `ARTEMIS IV` is the primary action. First Light remains visible as the fundamentals option.
- **Artemis session, no normal save:** the card becomes `RESUME ARTEMIS IV · CHAPTER N`, states that resume begins at the chapter checkpoint, and remains primary.
- **Normal autosave exists:** `CONTINUE` remains primary so the menu does not hijack an established player's save. Artemis remains a visible mission entry and shows its chapter-checkpoint resume state if applicable.
- **Completed mission:** retain `ARTEMIS IV` with a completed treatment and `FLY AGAIN`; do not add decorative live-status dots.

The briefing must state, before launch:

> NASA has not yet assigned the Artemis IV lander. This scenario uses an unchanged artist-made 2019 generic Starship model as its visual stand-in. It is not a Starship HLS model or an official NASA or SpaceX flight configuration.

The copy can be polished, but that meaning cannot be removed.

## Implementation approach

### Scope discipline

Reuse the current system first. Add an abstraction only when two features in this release use it or the existing code cannot satisfy a required mission step. Artemis-specific code stays under `src/missions/artemisIv/`; do not create a generic guidance framework, mission compiler, provider adapter, telemetry registry, or second maneuver planner in anticipation of future missions.

### 1. Existing tutorial presentation plus a small Artemis guide

Leave First Light and Second Light's current state machine in `src/ui/tutorial.ts`. Improve its shared presentation in place, then create a small Artemis-specific chapter controller using plain step data and direct completion functions. A tiny `sustainFor` helper is acceptable; a predicate DSL is not.

The presentation upgrade is deliberately limited to:

- structure each card as a chapter label, `READ`/`DO`/`WATCH` step kind, short explanation, prominent `DO NEXT` instruction, and at most three goal/status cues; exact maneuver numbers remain owned by the planner;
- add a segmented progress rail and hold a completed action for about 400 ms with a clear confirmation before advancing, so success is visible rather than instantaneous;
- show one contextual primary action, with quieter Back, Retry Chapter, and Exit controls instead of six equal-weight buttons;
- retain drag, keyboard movement, focus handling, explicit Continue for text steps, and the existing spotlight primitive;
- add one map-mode class that reflows the guide below the existing upper-right camera controls and away from the left planner on desktop, while preserving the current top-card/bottom-sheet mobile layout;
- sharpen the spotlight with a restrained label/halo and target state; do not add a responsive connector. Respect reduced motion and do not add animated status dots, narration, or a cinematic overlay system.

Step completion must be scoped to the active mission role and expected topology. Crew/sample acknowledgements apply and validate their state change before the card advances. Because resume is chapter-based, any short completion dwell restarts harmlessly with the chapter.

### 2. Make the current maneuver planner teach what it already does

Keep the existing controller, solver, orbit-click placement, six-direction handles, retiming, queue, snapping, encounter prediction, and live trajectory update. Modify only `src/ui/mapView.ts`, `src/ui/kit.ts`, and minimal guide wiring:

- show a context sentence under the header: place a node, drag the colored handles, or prepare to execute;
- keep apoapsis, periapsis, encounter/periapsis, total burn, estimated duration, and remaining vehicle delta-v above the collapsed detail section;
- label the current cryptic actions `WARP TO BURN` and `ARM AUTO`, with honest `AUTO ARMED` and `EXECUTING` states;
- show a simple execution bar from the existing initial/remaining delta-v values;
- use the same yellow/purple/blue terms and colors in the panel and map handles, label the delta-v step in `m/s`, and enlarge touch targets without changing the interaction model;
- have the guide highlight the exact planner control and state the goal/corridor; the planner remains the single owner of live numeric results.

The tutorial gets one genuine but forgiving planning interaction: a prepared post-TLI correction node begins near the solution, and the player adjusts prograde delta-v until predicted lunar periapsis enters a broad encounter corridor. The UI responds live, confirms `TRANSFER SOLUTION ACCEPTED`, and offers `RESET NODE`. After the coast, lunar capture is a separate prepared retrograde burn. A novice is not asked to derive either maneuver from scratch.

### 3. Small, isolated chapter resume

Do not write Artemis into normal autosave. Store one namespaced, versioned Artemis document containing only mission version, current chapter, completed acknowledgements, completion state, and the latest validated chapter-start `SaveGame`. Resume and Retry Chapter both start that checkpoint; the UI says so explicitly.

Use one `sessionKind` check at the app's existing save/load/menu seams to keep mission craft out of Workshop, normal autosave, quickload, named saves, and cloud sync. Do not build a general save-policy framework. On incompatible mission or terrain versions, offer chapter restart instead of attempting partial migration.

Each chapter has a plain initializer function that restores only the transient state absent from `SaveGame`: active mission role, target selection, landing marker, prepared maneuver, and relevant UI mode. Install the existing `moon-site01` terrain authority before creating or restoring a lunar checkpoint, including the landed surface chapter.

### 4. Mission state and flight behavior

Use stable Artemis role IDs (`orion-cm`, `orion-esm`, and `hls`) alongside vessel IDs so merge/split operations do not lose mission identity. Register any hidden functional part through the existing global part resolver with mission-only/editor-hidden availability; do not create a parallel resolver.

The text transfer step still performs real state changes: two crew remain in Orion and two move to the lander; all four and the sample inventory return to Orion before TEI. Add only the flight data the current game lacks:

- a runtime vessel target distinct from the existing body target, derived from the stable Artemis role by each chapter initializer, with rails-aware closest approach and relative range/rate;
- authoritative docking-axis alignment, safe closure bands, and hold-point checks;
- a mission-owned South Pole training target and descent corridor built from existing marker, AGL, slope, and velocity calculations;
- an external multi-point landing footprint for the tall Starship visual, with stable-contact and tip-over checks;
- a representative ascent cue and prepared, validated TEI node using existing SAS, throttle, staging, and orbital calculations.

Both rendezvous chapters start on checked near-phasing solutions. The player performs final approach, hold, alignment, and docking; v1 does not add an arbitrary-orbit rendezvous solver or general Moon-to-Earth solver.

### 5. Minimal craft visual binding

Create one Artemis composite mapping that pairs the scaled Voyager CM, simple ESM attachments, and unchanged Starship roots with editor-hidden functional assemblies. Store numeric docking, thrust, RCS, contact, camera, plume, and parachute anchors in Artemis data. Use checked visual bounds for camera framing.

CM, ESM, and Starship remain distinct visible roots across docking, undocking, and jettison. Route topology changes through the existing `WorldScene.invalidateVessel(id)` rebuild seam; do not introduce a parallel visual cache. Match Orion's reentry/plasma envelope to the scaled Voyager silhouette rather than the hidden stock physics parts.

### 6. One space background, one improved starfield

There is no current skybox asset: both flight and map scenes use a clear color plus one `THREE.Points` star sphere. Keep the one-draw-per-scene design.

- define one neutral sRGB `SPACE_BACKGROUND` shared by `exposurePolicy.ts`, `worldScene.ts`, and `mapView.ts` for terrestrial, airless, fallback, and map backgrounds;
- let the existing atmosphere shell provide Earth's local blue sky and limb scattering instead of tinting the full frame;
- extend the deterministic point geometry with a magnitude/size attribute and a tiny point shader: mostly faint stars, a sparse 1.5–2.2 px bright set, round soft falloff, restrained near-white/warm/cool color, and a subtle fixed density band;
- do not add an HDR cubemap, external catalog, twinkle, animation, parallax, or a new sky system.

Acceptance is visual continuity: no background hue pop between flight/map, Earth orbit, cislunar space, and lunar orbit; blue remains local to atmosphere/limb; stars are round and varied rather than uniform confetti; each scene's starfield remains deterministic and one draw call.

## Reuse, repurpose, and discard audit

### Reuse directly

- `GameState` multi-vessel, body-transition, staging, docking-capture/merge, undocking/split physics core, and landed/orbit situations; player-facing undocking, crew allocation, and mission identity are new work;
- First Light's card DOM/style, `spotlight()` primitive, keyboard drag/accessibility controls, and real completion-predicate approach;
- First/Second Light scenario construction patterns, map mode, maneuver planning/execution, warp, SAS, throttle, and staging;
- map landing-marker rendering primitive plus the existing terrain/surface-instrument AGL, slope, horizontal-speed, vertical-speed, and surface-relative velocity calculations; there is no existing powered lunar-landing predictor or assigned lunar target to reuse;
- save serialization/validation, single-key storage primitives, validated backup concepts, and IndexedDB/localStorage fallback; not the current multi-key rotation as an atomic mission transaction;
- existing `PartModelLibrary` loading/cloning for `orion-voyager-pod`, plus `orion-homecoming-housing` where its simplified shape fits;
- GLTF/KTX2/Meshopt loader setup, shared-resource clone behavior, and the existing GLB stats, canonical JSON, safe-path, atomic-publish, checksum, and bounds utilities for the single Starship pass-through;
- the current maneuver planner, orbit-click/handle interactions, predictions, queue, and execution data;
- the current one-draw-per-scene procedural starfield and terrestrial atmosphere shell;
- current Moon renderer;
- the NASA-derived Voyager geometry as the final simplified Crew Module exterior, at a checked mission-only scale.

### Repurpose with focused changes

- improve the existing tutorial card/spotlight presentation in place while leaving First/Second Light's state machine and content path intact;
- use the Voyager visual at `4.164` scale, but give the mission separate four-crew, reentry, docking, and propulsion behavior;
- use existing/procedural shapes for the ESM, solar wings, docking collar, and recovery attachment instead of starting a new Orion asset pipeline;
- adapt docking and landing tests into chapter-state acceptance tests;
- extend menu mission metadata and tests for Artemis start/resume/complete precedence;
- install Site 01 through the mission initializer before vessel creation/restore and refuse incompatible checkpoint versions;
- reuse `WorldScene.invalidateVessel()` by adding simulation topology notifications and stable mission-element root mapping instead of creating a second invalidation system.

### Do not reuse

- the abandoned Gateway chronology, NRHO path artifact, “I-Hab delivery” objective, timeline replay, replay dashboard, mission playback state, cinematics, or first-person Orion POV;
- the old plan's source lock or acceptance tests, because they encode the wrong mission;
- existing generic station parts as Gateway stand-ins;
- stock tanks, Viking legs, Apollo engine, or generic cylinders as visible Starship additions;
- the stock one-seat `pod-voyager` gameplay definition or its original 1.2 m visual scale as Artemis Orion behavior;
- the NASA Gateway Core model in this mission;
- any copy or identifier that presents the selected generic Starship geometry as an accurate Starship HLS model;
- third-party marketplace geometry without a separately verified right to redistribute it in a browser-delivered game.

The old branch's low-level clock/interpolation/formatter utilities are not needed for a live tutorial. If a later feature independently needs one, reimplement or port it in an isolated, reviewed commit rather than cherry-picking the replay.

## Implementation milestones

### Milestone 0 — Accuracy, reuse, and asset lock

**Retain/complete:**

- `docs/research/artemis-iv-current-architecture-2026-07.md`
- the existing `assets/missions/artemis-iv/source-lock.json`, `manifest.json`, exact Starship GLB, attribution/license entries, and SHA-verifying public sync path
- `tests/artemis-iv-source-lock.test.ts`

**Work:**

- record all factual mission copy with source URL, publication/update date, access date, owner, rights notes, and whether the fact is confirmed or provisional;
- record the unchanged-2019-Starship stand-in disclaimer and forbid copy that implies NASA selected SpaceX or that this is Starship HLS;
- validate the already pinned GLB provenance, CC BY 4.0 terms, exact checksum, byte length, dimensions, runtime transform, visible attribution, and pass-through publication path that rejects any byte change;
- record Voyager's NASA-derived source chain, the `4.164` mission visual scale, its dimension mismatch, and the `simplified exterior` label; prepare only the ESM/attachment references that are still missing;
- lock the v1 chapter-checkpoint resume, local-only mission save policy, prepared rendezvous starts, prepared TEI node, and no-unpublished-HLS-staging assumption;
- establish the stock-catalog baseline, Moon-surface render baseline, menu time-to-interactive baseline, per-asset caps, and combined docked/descent/entry scene caps;
- lock the South Pole terrain wording to “training analogue” and keep the actual landing site as TBD;
- add a content check that rejects the obsolete Gateway/I-Hab/NRHO objective and claims that Block 1B/EUS is the current Artemis IV launch configuration, without forbidding accurate historical discussion.

**Gate:** A reviewer can trace every real-world sentence to a dated source or see it labeled representative; the checked Starship file is byte-identical to the CC BY 4.0 download; attribution and non-endorsement copy are visible; and no product surface calls the mesh Starship HLS.

### Milestone 1 — First-impression controls and chapter session

**Create/modify:**

- characterize First/Second Light's current buttons, completion timing, spotlight, revert path, and Second Light handoff;
- enhance `src/ui/tutorial.ts` and `src/ui/kit.ts` with step kinds, `DO NEXT`, live readouts, progress rail, 400 ms success confirmation, one primary action, and non-overlapping map/mobile placement;
- enhance `src/ui/mapView.ts` and its existing styles with contextual instruction, visible predicted outcomes, clear action labels, consistent handle colors/terms, execution progress, and larger touch targets;
- unify the sRGB space background across flight and map, and improve `src/render/starfield.ts` within its current deterministic one-draw-per-scene design;
- add a small `src/missions/artemisIv/guide.ts` smoke chapter using direct functions and the prepared-node adjustment; do not add a guidance framework;
- persist one versioned Artemis chapter document and add the minimal `sessionKind` guards at existing save/menu seams;
- modify `src/game.ts` only at start, update, exit, and resume integration seams;
- add focused tutorial regression, planner-label/outcome, starfield determinism/background-continuity, checkpoint-resume, and corrupt-session tests.

**Gate:** First/Second Light still behaves correctly; the guide and planner coexist on desktop/mobile and give visible action feedback; Earth and deep space share a neutral background; and Artemis reload/retry restores the declared chapter checkpoint without touching normal saves.

### Milestone 2 — Full-route graybox feasibility and flight tools

**Create/modify:**

- keep the initial implementation to `src/missions/artemisIv/mission.ts`, `checkpoints.ts`, and `guide.ts`; split a file later only if it gains a second clear responsibility;
- add registered mission-only part definitions, editor-hidden availability, render-hidden/physics-only functional children, and consistent resolver coverage across simulation, save, analysis, and rendering;
- add stable mission-element IDs independent from merge/split vessel IDs;
- install and validate Site 01 before lunar state construction or restore;
- add deterministic per-chapter post-restore initializers for active role, guide, target vessel, landing target/ellipse, prepared maneuver, and controller/UI state;
- add an inclined/polar orbit checkpoint factory that crosses the Site 01 analogue rather than relying on the current equatorial-only orbit spawn helper;
- add a runtime vessel target derived from the stable Artemis role, map/flight selection, rails-aware relative position/velocity telemetry, target orbit/closest approach, authoritative docking transforms, alignment, safety bands, and hold points;
- add one contextual `UNDOCK LANDER` action for the known mission topology, explicit two-and-two crew allocation in the existing crew arrays plus Artemis-local transfer/sample flags, and role-based active-vessel handoff; do not add a general dock-joint selector or crew/inventory UI;
- add mission-owned landing ellipse/target and descent-corridor predicates, external multi-point landing contacts/stable-contact behavior, plus the representative ascent attitude/cutoff cue;
- emit topology revision/events from docking, undocking, separation, and restore, and route them through existing vessel visual invalidation;
- add graybox composite mapping coverage so hidden functional children, component roots, numeric anchors, camera bounds, and topology rebuilds are proven before final visuals;
- create and validate the prepared representative TEI node/trajectory because the current generic transfer planner does not solve Moon-to-Earth return;
- construct and validate every chapter checkpoint before connecting final narrative copy;
- execute the complete graybox chain: inclined/polar lunar staging orbit, target/phase, dock, transfer mutation, undock, descend/multi-point land, initiate ascent, redock, return transfer mutation, prepared TEI, CM/ESM separation, Orion-scale entry, parachutes, and recovery;
- cold-resume from the beginning of every chapter, including the landed surface checkpoint, under the correct terrain and mission version;
- record novice and median chapter durations now; move prepared phasing/checkpoint starts earlier if the complete journey cannot meet the 35–50 minute target.

**Gate:** The entire mission is physically completable with proxy visuals, including every chapter cold restore, rails-to-physics target transition, stable multi-point landing, correct crew/sample ownership after both transfers, correct retained/created visual roots after every topology change, verified Moon-to-Earth trajectory/entry, and an acceptable end-to-end duration. Final visual binding does not begin before this gate passes.

### Milestone 3 — Craft visuals and development-only mission entry

**Create/modify:**

- retain the checked `assets/missions/artemis-iv/models/`, `source-lock.json`, and `manifest.json` boundary already added for the unchanged Starship;
- keep the SHA-verifying pass-through publication and load the exact file from its checksum-addressed URL with one small mission-specific lazy loader;
- add the launch preflight, mission-only high-tier switch/restore, and renderer-ledger charge for the actual Starship geometry/textures/materials; exercise the same allocation/failure path in tests rather than trusting manifest arithmetic;
- clone `orion-voyager-pod` through the existing `PartModelLibrary`, apply the checked `4.164` mission scale, and leave the stock part untouched;
- assemble only the missing simplified ESM, solar-wing, docking-collar, forward-cover, and recovery visuals from existing/procedural project geometry;
- bind the Voyager/ESM and Starship roots to the proven hidden functional parts with numeric docking, thrust, RCS, contact, camera, plume, picking, and parachute anchors;
- validate separation topology, multi-point ground contact, camera framing, and the scaled Voyager reentry/plasma envelope;
- add the sourced main-screen mission card and briefing behind a development flag; menu interactivity must not wait on Starship.

**Gate:** The published Starship is byte-identical and visibly labeled as a stand-in; the scaled Voyager is recognizable as a simplified Orion CM; both craft remain visually and physically coherent through docking, split, landing, ESM jettison, entry, and recovery; a default-medium start reaches the explicit preflight and either enters the certified high-tier mission or offers First Light/Retry/Exit without blocking the menu.

### Milestone 4 — Outbound flight through lunar landing

**Work:**

- connect the development-only mission card to Chapters 1–5; do not make it public/primary for fresh users yet;
- implement Chapters 1–5 with contextual highlights, safe envelopes, failure messages, and checkpoint retry;
- use the near-solution prograde correction during lunar approach, followed by the distinct prepared retrograde insertion burn, then reuse the same readable outcome presentation for later prepared nodes;
- prewarm Starship only before it becomes visible;
- playtest novice readability, guide/planner coexistence, map-to-flight transitions, docking closure rate, descent fuel margin, space-background continuity, and South Pole terrain contrast.

**Gate:** Through the development-gated card, a clean-profile tester can reach landing without developer intervention and cannot complete a guide step by operating the wrong vessel or satisfying a stale predicate. The public first-run menu remains unchanged.

### Milestone 5 — Surface text, ascent, return, and recovery

**Work:**

- implement the text-only surface expedition and both transfer acknowledgements;
- implement Chapters 7–10 with ascent, rendezvous/redocking, TEI, ESM jettison, entry, parachutes, and splashdown;
- validate time-warp boundaries, sphere-of-influence transitions, active-vessel selection, thermal/entry tuning, and recovery completion;
- add completion persistence and `FLY AGAIN` without deleting the player's normal save.

**Gate:** The full development-gated mission is completable from a clean profile and resumable at every chapter, with no simulated astronaut segment and no Gateway objective.

### Milestone 6 — First-impression polish and release gate

**Work:**

- run complete novice, keyboard-only, reduced-motion, narrow viewport, reconnect/reload, asset-failure, and supported high-tier GPU passes;
- test menu precedence for every normal-save/mission-session/completion combination;
- review all copy against the source lock immediately before release;
- capture performance traces in lunar orbit, docked stack, powered descent, surface touchdown, ascent, and Earth entry;
- review loading progress, error recovery, focus order, visible focus, screen-reader labels, card/planner positioning, live maneuver feedback, space continuity, contrast, and tutorial pacing;
- rerun complete novice/median duration measurements and keep the full journey within the approved target;
- run a final external mission-accuracy review and a separate code review;
- only after the full clean-profile, every-chapter resume, duration, accessibility, accuracy, rights, and performance gates pass, remove the development flag and make Artemis IV primary for a fresh user.

**Gate:** No critical or high-severity accuracy, progression, accessibility, save, rights, visual-topology, or performance defect remains; all lower-severity deferrals are documented, and the completed mission—not a partial chapter set—is the first-run path.

### Milestone 7 — Pip learning path and Artemis V follow-on (post-release)

This milestone begins only after Milestone 6 ships. It is a follow-on product increment and cannot block, widen, or weaken the Artemis IV release gate.

**Work:**

- mount the existing advisory-only Pip presentation once at the app UI root so it can survive editor-to-flight transitions, then add only `showGuidedStep(...)` and `clearGuidedStep()` entry points; do not turn Pip into a mission runner;
- route First Light's Earth steps, its Second Light Moon shortcut/steps, and Artemis IV's chapter output through Pip's guide mode while leaving their deterministic completion/retry state machines untouched;
- use a fixed presentation priority: immediate safety alert, required guided step, requested AI briefing, then routine local callout. When a safety alert clears, restore the exact current guide step; Pip must not cover the planner or camera controls;
- keep guide copy, progress, actions, readouts, and factual Artemis text local and source-locked. Pip may explain supplied telemetry or reinforce the current objective, but it never advances a step, changes controls, authors mission facts, or contradicts the guide;
- update the optional AI snapshot minimally with `systemId` and `objectiveSource: 'guided'`, and update the server instruction boundary so it distinguishes fictional Perilune flights from source-locked Sol training missions. The supplied simulation/guide context remains authoritative; Pip may not fill missing Artemis facts from model memory;
- reuse the existing `FlightDirectorSnapshot`, evidence-key validation, allowed-action validation, local fallback callouts, audit logging, and on-demand `ASK PIP` flow. Add only the few mission roles/actions/evidence values exercised by these guided experiences; do not build a conversation agent or general mission ontology;
- ensure First Light, Second Light, Artemis IV, and Artemis V remain fully completable when AI is disabled, unavailable, or rate-limited;
- create a separately versioned, development-only `ARTEMIS V · PROVISIONAL FOLLOW-ON`, unlocked after Artemis IV completion and only after a fresh official-source lock. As of July 2026, NASA describes Artemis V as an additional lunar surface mission targeted for late 2028, using a standardized SLS configuration, and the point at which Moon-base construction is expected to begin. Lander/provider, crew, site, duration, docking architecture, payloads, exact upper stage, base element, detailed operations, and final flight plan remain provisional;
- do not import legacy Gateway/Block 1B/EUS assumptions into Artemis V. Reuse the validated Artemis IV Orion, representative lander, chapter checkpoints, rendezvous, landing, ascent, return, recovery, guide presentation, and Pip context only where the refreshed source lock and a playable graybox prove they still fit;
- keep Moon-base coordination and crew/surface activity text-only unless a later approved scope adds surface gameplay. Use the same lander visual only with the existing provider-TBD/stand-in labels; a new lander or other vehicle asset requires a separate user decision and rights/source gate. Before implementation starts, identify one officially supportable craft-operation lesson that makes Artemis V meaningfully different from Artemis IV.
- keep Artemis IV as the first-run primary mission, First Light as the fundamentals option, and Artemis V as a follow-on rather than a competing first-screen primary; do not add Pip voice, chat history, character animation, autonomous control, or AI-authored mission content.

**Gate:** First Light, Second Light, and Artemis IV retain identical completion/retry behavior while appearing coherently through Pip; safety interruptions restore the current guide step; AI unavailable/disabled never blocks or advances a mission; and the separately reviewed Artemis V mission is end-to-end completable without reviving superseded Gateway architecture or asserting unpublished details. Artemis V remains development-only until every factual claim, route, and release gate passes; reuse alone is not a public-release decision.

## Verification matrix

### Automated

- focused tests for Artemis guide transitions, short completion dwell, active-role/topology scoping, state-mutating acknowledgements, checkpoint restore, and mission-version mismatch;
- characterization tests for the unchanged First Light and Second Light state machine plus their improved card presentation;
- local-only Artemis session, normal-save/editor/Workshop isolation, deterministic chapter initialization, and every-chapter cold-restore tests;
- maneuver-planner instruction/action labels, visible result values, reset behavior, and execution-progress tests;
- deterministic star count/radius/size bounds and bright-star fraction, one draw per scene, and sRGB background equality across terrestrial/airless/fallback/map policies;
- deterministic scenario tests for inclined/polar orbital envelopes, prepared phasing, rails-to-physics targeting, hold points, docking, crew/sample transfer, undocking, multi-point landing, ascent, redocking, prepared TEI, entry, parachutes, and recovery;
- mission-only part availability/resolver tests across editor, import, save/restore, analysis, simulation, and rendering;
- asset manifest/schema/rights/provenance, numeric anchors, checked bounds, per-asset/combined budget, hash, and byte-identical public sync tests;
- mission-model renderer-ledger accounting, default-medium to mission-high transition/restore, preflight rejection, allocation failure, and missing/corrupt Starship recovery tests;
- menu development-flag and release ordering/start/chapter-resume/complete-state tests;
- visual-binding/root lifecycle and reentry-envelope tests across docking, split, jettison, checkpoint reload, and retained/created vessel IDs;
- forbidden-copy tests for Gateway/I-Hab/NRHO, claims that SpaceX has been selected, and any label that calls the unchanged 2019 mesh Starship HLS;
- existing build, typecheck, lint/content validation, and current test suite.

### Manual/runtime

- start, exit, reload to the declared chapter checkpoint, retry, finish, and fly again from a clean browser profile;
- fail each maneuver deliberately and verify recovery text points to the actual violated envelope;
- complete every chapter with keyboard-only input;
- verify text transfer steps apply the required crew/sample state mutations and the surface chapter never suggests simulated EVA controls;
- inspect the composite docked stack and every post-separation state for duplicate, missing, or stale roots;
- measure main-screen time to interactive before and after a cold mission-asset cache;
- start Artemis IV from the default medium renderer, verify the explicit high-tier preflight/transition and exit restore, then repeat on a deliberately unsupported/failing configuration and verify the First Light fallback;
- compare the scaled Voyager CM and simplified ESM against the checked NASA dimensions, and compare Starship renders to the exact downloaded GLB at near, normal, and far gameplay distances;
- verify the tutorial card never covers the maneuver planner or map camera controls, shows success before advancing, and remains usable with keyboard, touch-sized controls, reduced motion, and a narrow viewport;
- verify the Earth-orbit, cislunar, and lunar-orbit background stays neutral without a hue pop, with atmospheric blue confined to Earth's sky/limb;
- collect frame-time, draw-call, triangle, transfer, peak residency/disposal, and GPU estimates at all combined performance scenes on the supported high tier;
- read every provider and NASA reference note in the shipped experience for non-endorsement and uncertainty wording.

## Acceptance criteria

The implementation is complete only when:

1. a new user sees Artemis IV as the principal main-screen mission and can still choose First Light;
2. the briefing accurately describes the current lunar-landing mission and explicitly says NASA has not selected the HLS provider;
3. the visual scenario uses the checksum-locked, unchanged MartianDays 2019 Starship concept with visible stand-in labeling plus the scaled NASA-derived Voyager as `Orion Crew Module · simplified exterior`; it never presents either visual as an exact flight model;
4. tutorial steps show a clear next action, live results, visible completion feedback, and a coherent guide/planner layout without replacing First/Second Light's current behavior;
5. the maneuver planner teaches one forgiving node adjustment using its existing simulation and makes predicted outcome, fuel margin, warp, arming, and execution state understandable;
6. flight/map views in Earth orbit, cislunar space, and lunar orbit share a neutral space background and a restrained, varied one-draw-per-scene starfield, with blue confined to Earth's atmosphere;
7. the player performs craft operations through real simulation and scoped/temporal guide checks; crew transfer and surface activity remain text-facing steps, but transfer acknowledgements mutate and validate crew/sample state;
8. Gateway, I-Hab delivery, the old NRHO replay, and claims that Block 1B/EUS is the current launch configuration are absent;
9. every chapter survives exit/reload by restoring its deterministic chapter-start checkpoint, and retry uses the same contract;
10. docking, crew allocation, undocking, multi-point landing, ascent, redocking, sample return, ESM jettison, entry, and splashdown preserve correct physics, mission identity, and composite/reentry visuals;
11. the actual Artemis IV provider, site, timings, and unpublished performance are never asserted as known;
12. the main screen does not block on Starship loading; mission launch charges the unaltered asset to renderer accounting, enters only through the certified high-tier preflight, restores the prior tier on exit, and gives unsupported devices an honest First Light/Retry/Exit path;
13. the full clean-profile journey passes the release accessibility, accuracy, rights, local save-safety, duration, and performance gates.

## Explicitly out of scope

- astronaut movement, EVA mechanics, cabin interiors, surface walking, or suit modeling;
- Gateway, I-Hab delivery, NRHO station operations, or the NASA Gateway Core model;
- an exact Artemis IV launch stack before NASA finalizes the new upper stage;
- claiming a final Artemis IV landing site, provider, crew, or flight plan;
- editing the selected Starship into HLS, adding visible HLS landing gear/thrusters/elevator, or claiming Starship-specific flight performance;
- first-person/cockpit presentation;
- passive replay controls, cinematic timeline playback, narration synchronization, or reuse of the abandoned replay architecture;
- exact intra-step/live-controller resume, Artemis cloud sync, arbitrary-orbit rendezvous planning, a general Moon-to-Earth transfer solver, or migration of First/Second Light onto the Artemis chapter controller;
- a new tutorial DSL/framework, maneuver solver, telemetry registry, animation system, HDR skybox/catalog pipeline, or generalized mission-model library;
- a provider plugin/adapter framework before a second approved HLS variant exists;
- shipping third-party marketplace geometry without an explicit project-compatible license.

## Primary sources

- NASA, [Artemis IV mission overview](https://www.nasa.gov/mission/artemis-iv/)
- NASA, [Artemis V mission overview](https://www.nasa.gov/event/artemis-v/)
- NASA, [Moon Base overview](https://www.nasa.gov/reference/moonbase-about/)
- NASA, [NASA Strengthens Artemis: Adds Mission, Refines Overall Architecture](https://www.nasa.gov/directorates/esdmd/nasa-strengthens-artemis-adds-mission-refines-overall-architecture/)
- NASA, [How NASA's Artemis III Lander Test Will Pave Way for Moon Landings](https://www.nasa.gov/directorates/esdmd/artemis-campaign-development-division/human-landing-system-program/how-nasas-artemis-iii-lander-test-will-pave-way-for-moon-landings/)
- NASA, [Industry Moon Lander Training Cabin Lands at NASA for Artemis](https://www.nasa.gov/directorates/esdmd/artemis-campaign-development-division/human-landing-system-program/industry-moon-lander-training-cabin-lands-at-nasa-for-artemis/)
- NASA, [Human Landing System Program](https://www.nasa.gov/humans-in-space/human-landing-system/), background only; its current editor warning and superseded provider caption do not control Artemis IV wording
- SpaceX, [Human Spaceflight: Moon](https://www.spacex.com/humanspaceflight/moon/)
- SpaceX, [Intellectual Property](https://www.spacex.com/trademark/)
- MartianDays, [SpaceX Starship model](https://sketchfab.com/3d-models/spacex-starship-a8a0b69f776841a1a465cd9fb3762fd2), visual stand-in source only
- Creative Commons, [Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/)
- NASA, [3D Resources](https://science.nasa.gov/3d-resources/) and [NASA 3D Resources repository](https://github.com/nasa/NASA-3D-Resources)
- NASA, [Orion Capsule 3D resource](https://science.nasa.gov/3d-resources/orion-capsule/)
- NASA, [Orion spacecraft components](https://www.nasa.gov/reference/spacecraft-components/)
- NASA, [Gateway Lunar Space Station 3D resource](https://science.nasa.gov/3d-resources/gateway-lunar-space-station/), retained only as evidence for excluding the superseded architecture
- NASA, [Images and Media Usage Guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/)
