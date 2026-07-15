# Planet Assets and Orbit Performance

## Intent

- Ship authored Medium textures for Palla and Wisp through the validated planet asset pipeline.
- Preserve packed roughness and AO data so airless surfaces render as matte regolith.
- Keep ordinary orbits on compact planet globes and activate streamed terrain only during landing approach.

## Delivery

1. Add native ARM64 compiler support, two-core texture packaging, and targeted body/tier builds.
2. Compile and integrate Palla/Wisp albedo, normal, and material packs.
3. Disable PNG palette rewriting for packed material data and keep its unused alpha opaque.
4. Share safe-orbit and terrain-presentation altitude policy across terrestrial and legacy solid-body renderers.
5. Verify with unit/integration tests, content validation, typecheck, and production build.
