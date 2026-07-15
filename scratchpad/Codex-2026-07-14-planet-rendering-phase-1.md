# Planet rendering phase 1

## Goal

Improve Veyra's global texture, atmosphere, and cloud fidelity without rewriting terrain streaming.

Primary shipping target: medium quality. New planet-scale effects must look complete there; high scales sample count/detail upward, and low remains the fallback.

## Decisions

- Preserve authored RGB structure in the generated global albedo instead of reducing it to faint averaged luminance.
- Treat the global normal map as a macro normal and blend it with the streamed terrain's procedural normal.
- Apply renderer-supported anisotropy consistently to the land maps.
- Use trilinear mip filtering for authored planet maps while keeping 1x1 fallbacks non-mipmapped.
- Scale the compact globe from 64x40 to 160x96 segments across quality tiers.
- Let map view borrow the committed authored pack instead of rendering Veyra as a 32x20 palette sphere.
- Keep KTX2 and the existing quality tiers; compression and delivery are not the primary problem.
- Verify with focused shader/asset tests, content validation, a production build, and localhost inspection.

## Verification state

- Focused map/material/renderer/transaction suite: 68 passing.
- Full unit suite: 581 passing; the sole remaining stale-compiler guard is expected until asset compilation completes.
- Typecheck and diff whitespace checks pass.
- LUT-atmosphere focused suite: 25 passing; direct Vite production bundle passes.
- Medium budgets: 8 LUT-assisted atmosphere view samples and the parallax cloud shell; bounded volume remains high-only.

## Planet-scale roadmap

- Replace the painted atmosphere shell with LUT scattering first.
- Add volumetric clouds on the high tier next.
- Integrate cloud shadows with atmosphere and clouds after both layers are stable.
- Consider virtual textures or planet-wide terrain tiles only after those visual layers.
