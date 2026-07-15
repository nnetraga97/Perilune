# VAB sample rocket integration

## Goal

Integrate the authored Mule/Pod tanks, separator, fins, radial decoupler, Torch SRB, SRB nose cone, engines, and Voyager pod into the checked runtime part pipeline. Add the Blender sample rocket as an immutable built-in craft in a distinct VAB section. Render one detachable procedural interstage from the Mule-sized separator ring around the Colt to the Pod-sized upper tank.

## Contracts to preserve

- Part physics and attachment dimensions remain authoritative in `PartDef`; GLBs are visuals only.
- Every imported asset is compiled, bounded, hashed, and loaded through the checked part manifest.
- The built-in craft is created through normal `Craft`/`PartInstance` APIs and is cloned before editing.
- The interstage is derived from actual parent/child stack radii and attached to the separator visual, so existing separator staging automatically disposes it with the ring.
- Existing dirty plume, smoke, pod, and renderer work must be preserved.
- Medium quality is the primary target: bounded radial segments, cached shroud geometry, and shared materials.

## Verification

- Validate asset recipes and regenerate the checked manifest/output GLBs.
- Unit-test the built-in craft graph, stage plan, shroud dimensions/lifecycle, and VAB built-in section.
- Run focused tests, typecheck/build, and inspect the craft in localhost if runtime tooling permits.

## Result

- The authoritative compiler emitted 16 checked models; the Wayfarer uses 60,257 imported triangles plus a cached 1,152-triangle runtime shroud.
- The built-in VAB load and launch flow passes its Playwright check.
- Typecheck, production build, and all 611 unit tests pass.

## Follow-up: separator visibility and staging repair

- The standalone Mule-size separator already exists as `dec-m`, but the authored ring model was only routed to the M-S interstage. Share the checked ring asset with `dec-m` and give the standalone card a distinct Wayfarer name.
- Staging accepts only parts with a stage action: engines, decouplers, and parachutes. Structural parts remain available to action groups but do not appear in the staging column.
- `Craft.stages[0]` is the next launch event. Because the editor displays stages in reverse, `+ Stage` must insert at index zero so existing display numbers stay stable and the new first-fire stage appears at the bottom.
- Auto-stage groups by serial separator depth. Radial releases are a separate event after propulsion at the same depth, producing core plus boosters, radial release, then interstage plus upper engine for Wayfarer.
