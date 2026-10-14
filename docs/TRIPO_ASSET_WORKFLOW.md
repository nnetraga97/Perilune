# Tripo asset generation and integration guide

Use this workflow for future Perilune assets: static props, spacecraft parts,
structures, articulated machinery and deforming models. Define the asset's role
and limits first, generate a useful starting mesh, then validate the compiled
result in the game. A successful generation or export is not finished integration.

## 1. Define the asset contract

Write a short brief before generating images or spending credits:

| Requirement | Specify |
|---|---|
| Purpose | Gameplay role, expected viewing distances and target quality tiers |
| Dimensions | Physical units, overall size and comparison with neighbouring assets |
| Coordinates | Origin, forward/up axes, ground contact and attachment points |
| Geometry | Silhouette, openings, thin details, static parts and moving parts |
| Motion | Rigid articulation or deformation, pivots, travel limits and clearances |
| Materials | Surface types, transparency, emissive regions and required PBR maps |
| Budgets | Triangles, draw calls, texture dimensions, transfer bytes and GPU memory |
| Integration | Loader, collision representation, state ownership and failure behaviour |
| Acceptance | Required views, motion states, lighting conditions and performance checks |

Choose budgets for the asset's role and expected instance count. A unique structure
and a frequently repeated small component should not inherit the same allowance.
Record limits in a machine-readable recipe; do not silently increase them to make
an export pass.

## 2. Design and approve the reference

Use image generation to establish silhouette, proportions and material intent.
Include a dimensioned comparison when fit matters. Show the asset from views that
reveal important openings and joints, and keep multiple views consistent.

Make required moving components visually distinct. Show hinge clearance and avoid
hiding attachment interfaces behind decorative detail. Specify whether cables,
windows, rails and gaps need geometry or can be represented by textures.

A good-looking image does not guarantee correct dimensions, separate mesh parts or
usable pivots. Review those requirements before submitting the reference to Tripo.
Keep the approved image and prompt so later revisions are reproducible.

## 3. Choose Tripo operations deliberately

Verify the account and balance used by the chosen workflow. Do not assume Studio
subscription credits are available to a plugin or API connection. If the user has
chosen Studio, use its export or Blender bridge workflow without requiring API
funding. Follow the user's authorization for browser access and paid operations.

Check the displayed operation cost before submission. Record task IDs, settings,
quoted credits and the resulting charge when available. Trials and promotional
prices are not a reusable price list. If only a before/after balance is visible,
label the difference as an observation rather than an itemized operation cost.
Do not retry a paid generation until its failure or existing result is established.

Use the available tools to address a specific defect:

| Need or defect | First action |
|---|---|
| Multiple independently moving components | Consider generation in parts; inspect the actual exported boundaries |
| Correct geometry, wrong dimensions | Measure and repair locally |
| Separate rigid pieces need motion | Create local pivots and transform animation |
| Deforming geometry needs motion | Evaluate a suitable skeletal rig and inspect skin weights |
| Fused parts across a required joint | Evaluate segmentation or part repair before deciding to regenerate |
| Unusable silhouette or melted structural detail | Revise the reference and regenerate geometry before further texture work |
| Poor UV allocation or seams | Inspect UVs and evaluate UV repair before increasing texture resolution |
| Too many maps or materials | Consolidate compatible materials and atlas where useful |
| Geometry exceeds its budget | Evaluate retopology or simplification while preserving silhouette and interfaces |
| Blurry critical markings | Check texel allocation and viewing distance before upscaling |
| Incorrect in-game placement | Check transforms and simulation timing before editing the model |

Tripo feature names, availability and costs can change. Verify the current options
for segmentation, part filling, retopology, UVs, texture editing, PBR, rigging and
animation rather than assuming every export supports them equally. After each
operation, inspect whether hierarchy, UVs and material assignments survived.

## 4. Preserve and inspect the raw result

Save the raw export before cleanup. Keep an editable authoring copy separate from
the compiled runtime asset. If the file passed through a bridge or conversion,
record that transformation; do not describe it as an untouched provider export.

Inspect the actual imported scene:

- Count meshes, triangles, materials, images, joints and animation clips.
- Measure world-space bounds, units, orientation and object transforms.
- Check disconnected scraps, missing faces, thin surfaces and fused components.
- Inspect normals, UV seams, texture colour spaces, transparency and PBR wiring.
- Look for baked lighting that conflicts with the game's dynamic illumination.
- Check whether required components are separate and whether pivots are usable.

Repair when the geometry is structurally useful and the corrections are bounded.
Regenerate when restoring the silhouette, topology or required separations would
cost more than a better reference and another generation. Explain substantial
reconstruction rather than silently presenting it as a minor cleanup.

Store provenance alongside the asset: provider and task IDs, generation date,
settings, reference/raw hashes, conversion history, plan and applicable usage terms.
Record observed cost separately from estimates. Verify applicable rights at the
time of use; do not infer them solely from an account label.

## 5. Optimize against measured bottlenecks

Measure geometry, transfer and GPU costs independently. A model can be within its
triangle budget while carrying excessive texture memory or draw calls. Avoid
simplifying useful geometry merely because that is the easiest visible metric.

### Geometry and submissions

Remove confirmed scraps and redundant surfaces first. Preserve silhouette,
attachment points, openings, joint boundaries and collision requirements. Merge
compatible static components only when it reduces submissions without harming
culling or reuse. Keep independently moving components separate. For repeated
static assets, evaluate instancing and shared resources.

One material does not imply one draw call. Meshes, material groups, shadow passes
and other rendering passes can all affect submission cost. Measure in the renderer.

### Textures and materials

Allocate texel density according to screen coverage and visual importance. Consider
atlasing compatible materials, with gutters appropriate to mipmapping and filtering.
Check UV orientation, tiling, wrapping and channel packing after rewriting UVs.
Atlasing can reduce material changes but can also reduce detail or hinder reuse.

Treat base colour and emissive colour as colour data; normal, roughness, metallic
and occlusion maps are data textures. Preserve their intended colour-space handling.
Use lossy colour compression only where artifacts are acceptable, and inspect data
maps carefully for compression damage. Avoid unnecessary alpha channels.

Distinguish three quantities:

| Metric | What it tells you |
|---|---|
| Encoded texture bytes | Network and storage payload |
| Decoded texture memory | Uncompressed image cost before GPU-specific compression |
| GPU allocation estimate or measurement | Runtime storage including mipmaps and format effects |

For an uncompressed RGBA8 texture, a full mip chain is approximately
`width × height × 4 × 4/3` bytes. Add geometry and animation buffers separately.
Label estimates as estimates; they omit some driver and runtime overhead.
JPEG can reduce transfer size without reducing the decoded GPU footprint.

Evaluate KTX2/Basis through the existing texture infrastructure when appropriate.
Compare supported GPU formats, normal-map quality, transfer size, memory and decode
time. Verify both compressed and fallback paths on supported devices.

### Performance comparison

Compare before and after at the same camera, viewport, quality tier, instance count
and simulation state. Warm up assets and shaders, close unrelated heavy previews,
and measure repeated samples. Report median and p95 frame time, draw calls,
triangles, memory estimates and loading/decode time where relevant.

Reduced triangles, smaller files or fewer materials alone do not prove faster
frames. Record which measurements are complete and which remain unverified.

## 6. Choose the right animation model

Static assets need no rig. Rigid machinery generally needs named parent pivots and
transform clips. Deforming assets need an appropriate skeleton and skin weights.
Do not use deformation where a rigid transform will preserve the shape more reliably.

Define stable node and clip names, valid ranges and expected endpoints. Set pivots
at the real joints, inspect the complete motion and check clearances against nearby
geometry. Define how the mechanism behaves when interrupted, reversed or resumed.

For articulated assets driven by gameplay, expose a normalized pose API such as
`setDeployFraction(clip, fraction)`. A Three.js implementation can use
`SkeletonUtils.clone` where required, one `AnimationMixer` per independently
animated instance, and actions sampled directly at the intended time. Preserve
resource sharing deliberately and dispose only resources owned by the instance.

Drive authoritative state from simulation time or saved mechanism state, not an
independent renderer clock. Persist enough information to reproduce the pose after
save/load, time warp and interruption. Define synchronization with gameplay events
such as movement permissions, collision changes or resource use.

Do not flatten, join or simplify across animated hierarchy. Read the emitted GLB
back and test repeated samples such as 0, 0.5, 1, 0, 1. Verify targets, transforms
and durations as well as clip names. For skeletal assets, also inspect deformation
at extreme poses and animation transitions.

## 7. Integrate coordinates, physics and rendering

Keep visual placement and gameplay placement under a shared coordinate contract.
When alignment fails, check these in order:

1. Physical units and axis conversion, including Blender Z-up and glTF Y-up.
2. Authored origin and attachment anchors versus the bounding-box centre.
3. Object origin versus centre of mass and child-part positions.
4. Parent/local/world frames, including body-fixed and inertial coordinates.
5. The exact simulation timestamp and interpolation convention for each pose.
6. Camera-relative transforms, terrain contact and floating-origin adjustments.
7. Effect anchors, collision geometry and clearance throughout motion.

A one-step timing mismatch can create a visible displacement on moving or rotating
reference frames even when both transforms are individually correct. Ensure that
related objects represent the same instant. Do not universally add `dt`: first
establish whether the engine stores start-of-step, end-of-step or interpolated state.

Do not translate a model until one screenshot looks right as a substitute for
fixing a coordinate or timing error. Verify placement at multiple times,
orientations, camera distances and supported simulation rates.

Bind materials to the game's lighting, tone mapping and atmospheric effects. Check
shadow flags, transparency, emissive surfaces and normal maps in representative
lighting. Keep collision geometry intentional; visual detail is not automatically
a suitable physics representation.

## 8. Build a checked asset pipeline

Separate authoring, compilation and runtime responsibilities:

| Layer | Responsibility |
|---|---|
| Source record | Provenance, hashes, settings, terms and observed costs |
| Authoring files | Editable geometry, materials, pivots and animation |
| Recipe | Units, dimensions, anchors, required nodes/clips and budgets |
| Compiler | Supported conversions, optimization, validation and deterministic output where feasible |
| Manifest | Runtime URL, checksum, sizes, counts and asset contract/version |
| Build check | Detect stale or missing outputs and budget/contract violations |
| Runtime loader | Load validation, material integration, ownership and failure handling |
| Gameplay adapter | Map simulation state to the asset's semantic controls |

Choose a failure mode appropriate to the asset: a procedural substitute, a safe
placeholder, or a clear load error for an essential asset. Handle late asynchronous
loads after disposal, repeated loads and shared resources. Keep optional visual
failures from corrupting simulation state.

Preserve semantic nodes used by terrain, attachment, collision or effects code.
A replacement model must satisfy those contracts even if its internal structure
looks different. Avoid introducing special-case offsets where a reusable anchor
or explicit asset convention would solve the problem.

## 9. Validate and hand off

Run checks appropriate to the asset:

- Recipe/schema validation and enforced budgets.
- Compiled-file checksum and actual binary readback.
- Required hierarchy, anchors, materials and animation targets.
- Deterministic pose sampling, interruption and save/load behaviour where applicable.
- Loader failure, late-load cleanup and disposal/resource ownership.
- In-game scale, attachment fit, motion clearance, effects and representative lighting.
- Repeatable performance comparison against the prior asset or fallback.
- Project typecheck, existing tests and production build.

Capture before/after views with comparable framing. Report source and compiled
paths, exact geometry and texture metrics, remaining budget, observed cost,
validation results and known limitations. Distinguish estimated GPU memory from
measured allocation and source inspection from actual in-game verification.

Use this reusable report template:

```text
Asset / purpose:
Provider task IDs / date / settings:
Reference and raw export paths / hashes:
Plan and applicable terms:
Quoted cost / observed charge / uncertainty:
Dimensions / origin / axes / attachment anchors:
Static, rigid or skinned / required clips:
Triangles / limit / remaining:
Draw calls at stated instance count:
Texture dimensions / encoded bytes:
GLB transfer bytes / limit / remaining:
GPU memory estimate or measurement / method / limit / remaining:
Before-and-after frame time / test conditions:
Build and test results:
In-game views and motion states checked:
Fallback and disposal checks:
Known limitations / next optimization experiment:
```
