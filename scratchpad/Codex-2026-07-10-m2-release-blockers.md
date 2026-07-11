# M2 release-blocker repair plan

## Confirmed root causes

- Planet LOD hides a parent as soon as children are selected, even when the
  build budget has not created every child mesh, leaving ocean-colored holes.
- Revert/relaunch removes only the active vessel, leaving staged debris and
  earlier mission vessels in the scene.
- Workshop placement has no drag/drop path. Stack snapping also uses a fixed
  world-space ray distance, making valid nodes difficult to hit at some zooms.
- Auto-stage groups engines and decouplers by vertical position rather than
  attachment-tree relationships.
- Generic accent bands are rendered on every cylinder/cone with an accent,
  including command pods and adapters where the band reads as extra geometry.
- Existing tests do not cover post-separation control ownership, HUD SAS
  clicks, navball projections, or LOD coverage.

## Resolution notes

- Separation follows the controllable side when the retained root loses its
  control source; both pieces are recentered without a world-space jump.
- Navball marker projection uses +X right and +Z screen-up, with a stable
  heading reference for vertical flight.
- Graph-based staging produces correct two-stage delta-v analysis and replaces
  the height heuristic.
- Fresh launch/revert clears every old mission vessel. Cape Skyward now has a
  persistent facility mesh aligned to the shared spawn transform.
- Terrain holes came from inward grid winding plus parent/child LOD overlap;
  both are covered by regression tests.

## Test-first repair order

All six repair groups completed. Final gate: 65 unit/integration tests, the
production build, and two Chromium interaction/playable-loop tests pass.

## Follow-up interaction fixes

- Liquid plumes now query the same crossfeed-aware fuel availability as the
  flight simulation and ease their scale to zero after flameout.
- Placed parts receive a visible selection box.
- A selected part can be dragged freely on a camera-facing plane; its subtree
  follows while the logical attachment graph remains intact.
