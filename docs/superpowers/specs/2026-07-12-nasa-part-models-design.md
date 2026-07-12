# Perilune NASA-Style Part Models

**Date:** 2026-07-12

**Status:** Approved for implementation planning

**Scope:** Add a curated offline model pipeline and ship enhanced visuals for eight existing parts while preserving procedural fallbacks and all simulation authority.

## Objective

Perilune's 47 parts currently render from procedural primitives. This design proves a production-ready external-model path on eight representative parts: a pod, landing leg, two engines, antenna, wheel, fuel tank, and stowed parachute housing. The visual target is recognizable NASA hardware with authentic materials and engineering detail. NASA and JPL logos, flags, mission patches, vehicle names, and identifying text are removed.

Imported geometry is visual only. `PartShape`, attachment nodes, collision dimensions, mass, resources, thrust, staging, and all other gameplay behavior remain authoritative.

## Approved Decisions

- Use curated offline asset recipes rather than runtime extraction from full source models.
- Pin source files and checksums for reproducibility, but keep branding and usage review as a manual pre-production responsibility rather than a development build gate.
- Compile one normalized, optimized GLB per enhanced part.
- Use Meshopt-compressed geometry and the existing KTX2/Basis runtime infrastructure.
- Keep the current procedural geometry as a guaranteed fallback.
- Preserve NASA geometry, materials, and hardware character as closely as performance and part dimensions allow.
- Keep the Homecoming Chute visually stowed; canopy rendering and deployment animation are deferred.
- Give the Shuttle-derived Mule three visual plume anchors without changing its single-engine gameplay behavior.

## Non-Goals

- Replacing or rebalancing part physics.
- Upgrading all 47 parts in this slice.
- Adding parachute deployment visuals or new parachute state.
- Adding completed NASA craft templates. Saturn V, Ares I, and other stock crafts are shelved until the part-model work is complete.
- Loading, slicing, or cleaning original NASA vehicle files at runtime.
- Requiring external source downloads during install, development startup, tests, or production builds.

## Current State

`src/content/parts.ts` defines every part's gameplay data and procedural `PartShape`. `src/render/vesselMesh.ts` synchronously creates cached primitive geometry, flat PBR materials, accent bands, and one plume per engine. The editor and flight renderer share this builder. Craft saves contain part IDs and runtime state, so visual upgrades do not require a save migration.

The repository already has useful content-pipeline patterns for pinned sources, checked manifests, KTX2 assets, deterministic fingerprints, and transfer/GPU budgets. The part pipeline reuses those conventions without coupling part assets to planet compilation.

## Architecture

### Authoring Sources

A lightweight source manifest records each upstream URL or repository path, pinned commit, SHA-256, contributor, basic attribution, and usage-guideline URL. Source fetching is an explicit authoring command. Large original assets are not production dependencies.

Assets that require Blender work produce a canonical cleaned intermediate GLB and a short extraction log. The intermediate checksum is pinned. Full source files and Blender project files do not ship in production.

### Part Recipes

Each recipe declares:

- Source or reviewed intermediate.
- Extraction method: whole asset, selected components, or manual derivation.
- Geometry, materials, markings, and print-only components to remove.
- Local orientation, origin, scale, and authoritative attachment axis.
- Target `PartShape` dimensions and visual bounds.
- Material and texture treatment.
- Nozzle anchors where applicable.
- Triangle, texture, transfer, and GPU budgets.

All scale, rotation, origin correction, branding removal, and attachment fitting are baked offline. Runtime content does not depend on upstream node names.

### Deterministic Compilation

The compiler converts each normalized intermediate into one runtime GLB. It removes unused data, repairs normals and tangents where required, simplifies geometry to the approved budget, consolidates materials, resizes textures, encodes KTX2 textures, applies Meshopt compression, and writes a checked runtime manifest.

The generated manifest records artifact checksum, byte size, triangle count, texture allocation, bounds, attachment alignment, and effect anchors. Production builds validate and package committed runtime artifacts but never download sources or invoke Blender.

### Runtime Model Library

A part-model library owns the checked manifest, GLTF/KTX2/Meshopt configuration, parsed source scenes, and shared GPU resources. After the WebGL renderer exists, startup attempts to preload all eight assets with independent failure handling. Failed assets do not reject the overall preload.

`PartDef` gains an optional model asset ID. `buildVesselVisual()` remains synchronous and requests a clone from the initialized library. A cached imported model replaces the procedural body and accent band. If the model is unavailable, the existing procedural path runs unchanged.

Geometry, materials, and textures are shared and immutable. Each vessel owns only holders, transforms, selection helpers, and effects. Shared resources are released only on renderer shutdown or full context replacement.

## Eight-Part Visual Specification

| Part | Source and treatment | Triangle limit |
| --- | --- | ---: |
| Voyager Pod (`pod-voyager`) | NASA Orion capsule STL. Remove print-only or unnecessary interior geometry, create clean stack interfaces, and author realistic heat-shield, metal, and thermal-cover materials. | 6,000 |
| Stilt Leg (`leg-lander`) | Join one NASA Viking leg and foot, retain the recognizable truss and footpad, and add a compact surface-mount bracket. | 2,500 |
| V-2 "Colt" (`eng-colt`) | Extract the Apollo Lunar Module descent-engine bell. The identified engine-sized submesh must be visually confirmed in Blender; if it is not the correct bell, select the correct geometry manually from the same pinned source. | 2,000 |
| Longtalk Dish (`ant-dish`) | Use the standalone TDRS-C antenna reflector and feed assembly; remove unrelated mounting remnants and fit its base to the part attachment point. | 3,500 |
| Mesa Wheel (`wheel-mesa`) | Use the standalone Mars 2020 five-inch wheel; retain its tread and hub silhouette while simplifying repetitive geometry. | 3,500 |
| K-180 "Mule" (`eng-mule`) | Use the Space Shuttle main-engine assembly; preserve the multi-nozzle layout and metallic hardware. | 6,000 |
| PL-400 Tank (`tank-s4`) | Cut a straight barrel section from the Space Shuttle External Tank; retain orange foam, feedline, seams, and brackets, then replace tapered ends with flat stack interfaces. | 4,500 |
| Homecoming Chute (`chute-main`) | Create a closed Orion-style forward-bay housing from NASA reference imagery. It remains stowed in every runtime state in this slice. | 1,500 |

Every model uses local `+Y` as its stack or mounting axis, places its origin at the authoritative `PartShape` center, and aligns declared stack or surface attachment locations exactly. Visual details may vary inside the declared visual envelope, but they may not redefine gameplay dimensions.

## Runtime and Editor Behavior

### Vessel Construction

Model-backed and procedural parts may coexist in one craft. Imported models live under the same per-part holder used today, so nested meshes remain pickable and inherit the part's position and quaternion. Saved crafts continue to store only part IDs and state; loading an existing save automatically uses enhanced models when available.

### Plumes

Plume anchors come from the generated asset manifest. Existing engines without authored anchors receive one central anchor. The Mule receives three anchors. A part's plume group is parented to its holder so every plume follows engine translation and rotation correctly. All plumes for one part still share that engine's existing activation, throttle, pressure, and fuel state.

### Editor Ghosts and Selection

The editor preview uses the same model-backed vessel builder as flight. Drag ghosts replace materials only on the temporary clone; they never mutate cached shared materials. Attachment snapping continues to use `PartShape` and existing attachment rules rather than mesh intersections or imported bounds.

### Failure Handling

- Source fetch or checksum failure stops the authoring command without replacing prior files.
- Invalid geometry, attachment misalignment, or a technical budget overrun fails content validation.
- Missing manual branding-review metadata does not fail development validation.
- Runtime fetch, checksum, decoder, or parse failure marks only that asset unavailable and uses its procedural fallback.
- Each failed asset reports one actionable error rather than logging repeatedly.
- Removing a part or vessel disposes per-instance helpers and effects without disposing shared model resources.

## Validation and Budgets

Technical validation checks that every declared runtime model exists, parses, matches its manifest checksum, contains finite geometry, uses the documented `+Y` convention, stays inside its visual envelope, and aligns its attachment and effect anchors within tolerance.

Budgets for the slice are:

- The per-part triangle limits in the visual-specification table.
- No more than 30,000 triangles for one copy of all eight enhanced parts.
- No more than 60,000 part triangles for the reference craft containing six wheels, four legs, both engines, pod, tank, dish, and chute.
- No more than 6 MiB compressed transfer for all eight runtime GLBs.
- No more than 32 MiB shared GPU allocation for their geometry and textures.
- Maximum 1024x1024 textures for the pod and tank; maximum 512x512 elsewhere.
- Runtime GLBs may use Meshopt and KTX2 but do not retain source Draco payloads.

The compiler records deterministic fingerprints. Identical normalized inputs, recipes, compiler pins, and settings must produce identical canonical fingerprints.

## Testing

### Compiler and Content Tests

- Every model asset ID is unique and resolves to one generated manifest entry.
- Every generated GLB parses and satisfies bounds, anchor, triangle, texture, transfer, and GPU limits.
- Wheel radius, leg length, dish diameter, and stack interfaces match their authoritative definitions within the declared tolerance.
- Plume anchors point away from the mount and sit inside their nozzle openings.
- Repeating compilation with identical inputs produces identical canonical fingerprints.

### Runtime Unit and Integration Tests

- Model-backed and procedural parts render together.
- A missing or corrupt model uses its procedural fallback.
- Clones have independent transforms and shared render resources.
- The Mule creates three visual plumes and the Colt creates one.
- Part removal does not dispose shared geometry, materials, or textures.
- Imported visuals do not mutate mass, resources, attachment rules, collision dimensions, thrust, or staging.

### Browser Tests

- Place, select, drag, save, and reload the eight enhanced parts in the editor.
- Launch a craft containing the Colt and Mule and verify their plume groups follow staging and part transforms.
- Exercise a forced model-load failure and verify the workshop and flight loop remain usable with fallback geometry.
- Keep the existing full playable-loop and editor-interaction journeys green.

### Manual Acceptance

- Compare each model against its NASA reference from multiple angles.
- Confirm realistic materials and recognizable hardware character.
- Confirm no visible logos, flags, mission patches, vehicle names, or identifying text.
- Check for attachment gaps, floating details, reversed normals, clipping, and incorrect material color space.
- Confirm the Homecoming Chute remains visibly stowed in every state.
- Complete final attribution, branding, and usage review before production release.

## Source References

- NASA 3D Resources: https://science.nasa.gov/3d-resources/
- NASA Images and Media Usage Guidelines: https://www.nasa.gov/nasa-brand-center/images-and-media/
- Orion Capsule: https://science.nasa.gov/3d-resources/orion-capsule/
- Viking Lander: https://science.nasa.gov/3d-resources/viking-lander-2/
- Apollo Lunar Module: https://science.nasa.gov/3d-resources/apollo-lunar-module/
- TDRS-C: https://science.nasa.gov/3d-resources/tracking-and-data-relay-satellites-tdrs-c/
- Mars 2020 five-inch wheel: https://science.nasa.gov/3d-resources/mars-2020-5-inch-wheel/
- Space Shuttle (D): https://science.nasa.gov/3d-resources/space-shuttle-d/
- Space Shuttle Parts: https://science.nasa.gov/3d-resources/space-shuttle-parts/
