# Map and Maneuver Research Notes

## Current implementation

- `MapView` owns the only `ManeuverNode`; `PeriluneGame` separately owns `nodeRemainingDv` and the burn direction.
- Clicking the current vessel conic already creates a node, but there is no hover affordance. Pointer-down immediately enters time dragging.
- Active-orbit selection raycasts the rendered one-pixel `THREE.Line` with a camera-distance-scaled world threshold, so its effective screen-space target is inconsistent and often too small.
- The 3D gizmo has three positive-axis letter sprites (`P`, `N`, `R`), not six directional handles. All axis drags use vertical mouse delta, regardless of the handle's projected direction.
- Dragging the center changes time from horizontal pixels rather than following the orbit under the cursor.
- Current, planned, encounter, and body paths are fixed 256-point `THREE.Line` conics. Planned and encounter paths draw complete conics, including portions outside their valid time/SOI patch.
- The prediction cache signature omits body id, RAAN, argument of periapsis, and mean anomaly.

## Burn-preview defect

- `MapView.update` rebuilds orbital elements from live position/velocity every frame, then calls `orbitAfterNode(liveElements, originalNode)`.
- `PeriluneGame.updateNodeAssist` separately subtracts delivered acceleration from `nodeRemainingDv`, but that remaining value is not used by the map prediction.
- Result: during a burn, the already-delivered impulse changes the live base orbit and the map adds the full original impulse again.
- `MapView.update` also moves any elapsed node to `game.time + 1`, so the node time slides throughout execution.
- Desired model: a stable target conic captured from the plan plus a distinct live completion estimate using a frozen inertial burn direction and only remaining along-plan delta-v. Never mutate node time from rendering/update code.

## Reference patterns

- KSP manual: create a node anywhere on the current/future orbital path; six handles; alternate mode moves the node forward/backward along whole orbits.
- Precise Maneuver: keep the spatial gizmo but pair it with numeric +/- input, adjustable increments, event snaps, planned-orbit info, encounter info, and keyboard controls.
- Juno: click an orbit for a context menu, type or step delta-v values, tune per-node gizmo sensitivity, prioritize burn-node picking above other map UI, show manual burn progress, and keep controls resolution-independent.

## Chosen scope

- Preserve the single-node limitation.
- Fix maneuver state ownership and burn preview before visual polish.
- Add six signed handles, real orbit-following time drag, hover/click affordance, and a compact precise editor.
- Pick the active orbit from cached 2D projected segments with a fixed 12 px mouse/trackpad or 24 px coarse-pointer band; never depend on visible line width for input.
- Replace full-conic overlays with time-bounded visual segments using the prediction data already available.
- Primary click/tap adds or moves; secondary/Control-click/long-press opens orbit actions such as warp.
- Keep reference elements immutable through edits; track delivered delta-v as the acceleration component along the frozen planned direction.
- Do not add Lambert solving, automatic circularization, multi-node chains, a tracking station, or a full map renderer rewrite.
