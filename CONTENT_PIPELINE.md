# Content Pipeline

Planet content has two authorities:

- `src/content/system.ts` assigns explicit body kinds and terrain-recipe
  versions.
- `src/sim/terrainRecipe.ts` constructs immutable, content-addressed recipes;
  `src/sim/terrain.ts` is the only collision-scale height API.

Checked metadata lives under `assets/planets/`. `recipes.json` records the
runtime recipe hashes, `manifest.json` records compiler pins, provenance,
formats, and budgets, and `compiler-output.json` records deterministic raw
height fingerprints. Run:

```bash
npm run validate:content
npm run compile:planet-assets
```

Veyra's authoring source is fetched explicitly, never by `prebuild`:

```bash
npm run fetch:planet-source
npm run compile:planet-assets:container
```

The fetch command downloads the original Natural Earth II 3.2.0 archive to an
ignored authoring directory and verifies its SHA-256 before every extraction.
It always extracts the TIFF to a sibling partial file and atomically replaces
the prior TIFF only after `unzip` succeeds, so a stale or edited extracted file
cannot bypass the archive checksum. Neither the 69 MiB archive nor the
extracted 16200x8100 TIFF is committed. A clean checkout validates the pinned
provenance record and committed runtime packs without downloading inputs.

`compile:planet-assets:container` is the authoritative write path. It builds
`tools/planet-assets/Dockerfile` for `linux/amd64`, whose Node base image and
KTX-Software 4.4.2 archive are digest/checksum pinned, then bind-mounts
`assets/planets` and `src/generated` so generated files and the checked
manifest return to the host. It runs compilation with `--write` and content
validation inside that same image. Docker Desktop may use amd64 emulation on
Apple silicon. For non-authoritative local iteration only, use
`KTX_CLI=/path/to/ktx npm run compile:planet-assets -- --write`.

To intentionally refresh compiler fingerprints after a reviewed recipe
change, run `npm run compile:planet-assets -- --write`, inspect the diff, and
commit the recipe and output together. Production builds never download
authoring sources. `prebuild` verifies the signed checked-manifest digest and
every runtime package/fallback checksum while copying only approved files.
Run `npm run validate:content` explicitly after authoring/compiler changes.

Every declared runtime channel must include a KTX2 package and its specified
fallback file. Validation derives the complete mip-chain allocation from the
declared dimensions and GPU block format, plus a conservative RGBA8 mip-chain
allocation for conventional PNG/WebP uploads. Each channel declares its exact
fallback layout and supported transcode targets. Validation sums the actual
package sizes and budgets the larger of the compressed and conventional upload
paths, including renderer base allocation, before enforcing active-body,
transient, and total-renderer ceilings. Budget declarations therefore cannot
hide a larger artifact or omit the files the runtime needs.

Veyra must declare exactly one Low, Medium, and High pack, each with exactly
albedo, normal, material, and clouds. KTX2 validation reads the complete header,
level index, DFD, KVD, and supercompression-global-data bounds; requires the
exact full mip count and in-bounds, non-overlapping level payloads; and checks
the encoded DFD contract. Albedo is ETC1S with BasisLZ scheme 1. Normal,
material, and clouds are UASTC with Zstandard scheme 2, including the exact
uncompressed UASTC block size for every mip. Identifier-only, truncated, or
wrongly encoded files are rejected even if their checksums match the manifest.

The Veyra canonical signed-16 height artifact is derived from `solidHeight` at
0.5-meter quantization; it does not replace or independently redefine that
collision-height authority. Validation checks its declared byte length and
checksum, then recomputes an identity over the recipe, source archive,
compiler/container pins, canonical raw hashes, dimensions, quantization, and
height checksum. The manifest and `compiler-output.json` must agree on that
identity and height metadata before a checked runtime manifest is emitted.

Veyra is evaluated once at 8192x4096 in body-fixed coordinates (+Z north,
longitude `atan2(y,x)`). One `solidHeight` grid owns the ocean sign, packed
material mask, and finite-difference oct normals. Canonical raw channel hashes
are recorded before encoding. Low, Medium, and High are derived from those
canonical buffers with Lanczos3 at 1024x512, 2048x1024, and 4096x2048.
Albedo uses BasisLZ/ETC1S KTX2 plus WebP; linear normal, material, and cloud
data use UASTC KTX2 plus PNG. Encoding is single-threaded and the production
Linux x86_64 KTX-Software 4.4.2 archive is checksum-pinned in both the compiler
lock and container.

Third-party planet sources are admitted only through manifest records with an
exact source URL, author, license URL, attribution, SHA-256 checksum,
transformations, bodies, and channels. Accepted identifiers are CC0-1.0,
Public-Domain, and CC-BY-4.0. NASA/JPL records require the additional case
review fields enforced by the validator. SA, NC, ND, unknown, and ambiguous
licenses fail validation.

## NASA-style part models

Eight parts (`pod-voyager`, `leg-lander`, `eng-colt`, `ant-dish`, `wheel-mesa`,
`eng-mule`, `tank-s4`, `chute-main`) render an optional checked model on top of
their guaranteed procedural fallback. The authoring path is explicit and never
runs during `prebuild`:

```bash
npm run fetch:part-sources
blender --version
npm run compile:part-assets:container
npm run validate:content
npm run build
```

`fetch:part-sources` downloads each checksum-pinned NASA-3D-Resources source to
the ignored `assets/parts/sources/` directory and verifies its SHA-256 before
use; those downloads are never committed. The reviewed Blender intermediates in
`assets/parts/authoring/*.glb` and the compiled runtime assets in
`assets/parts/generated/*.glb` **are** committed, along with the opaque
`src/generated/checked-part-manifest.json` boundary that the runtime validates
and brands before loading. `sync:renderer-assets` copies only checksum-verified
generated GLBs into `public/parts/`.

`compile:part-assets:container` is the authoritative write path: it runs the
pinned glTF Transform CLI (Meshopt + KTX2, per-part triangle/texture limits and
visual bounds from `assets/parts/recipes.json`) inside the pinned KTX container,
then validates. The bare `compile:part-assets` defaults to dry-run verification;
only `--write` replaces generated files.

Development validation (`validate:content`) is **technical only** — schema,
unique IDs, safe paths, SHA-256 formats, numeric bounds, and the combined
triangle/transfer/GPU and reference-craft budgets. NASA branding and usage
review (no logos, flags, mission patches, vehicle names, or identifying text in
runtime assets) is a **manual gate before production**, not a validator check;
missing review metadata never fails development validation. The stowed
`chute-main` housing is custom work derived only from Orion visual language and
ships with no canopy or deployment animation (`animationPolicy: "none"`).

## Runtime Content

All content is data-driven TypeScript modules under `src/content/`:

- `system.ts` — celestial bodies (BodyDef): orbits, atmospheres, terrain
  parameters (seed/amplitude/palette), science multipliers, lore text.
- `parts.ts` — PartDef records: mass, cost, shapes (procedural geometry),
  attachment rules, resources, module behaviors (engine/tank/pod/…).
- `science.ts` — ExperimentDef records with valid situations and values.

Adding a part or body = adding one record; geometry, physics, UI cards,
and science hooks derive automatically. Validation lives in tests
(`vessel.test.ts` checks every part for sane data).

Planned (M3+, see MODDING.md): externalized JSON5 definitions with schema
validation and safe loading for user content — the record shapes above are
already serialization-friendly by design.
