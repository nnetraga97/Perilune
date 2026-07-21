# Pre-Sol visual baseline — 2026-07-19

The comparison baseline is production `main` commit `a6c015b`, captured with the existing Veyra diagnostic harness before the Sol branch is committed. It represents the compact fictional system and is not a physical-scale reference.

## Procedure

1. Check out `a6c015b` in an isolated worktree.
2. Run the same locked Node modules and Chromium version used for final captures.
3. Start Vite without modifying checked assets.
4. Run `e2e/veyra-render-diagnostics.spec.ts` at 1280 by 720, DPR 1, using its fixed diagnostic craft/stations.
5. Keep PNGs under ignored `test-results`; commit the JSON environment and performance summary only.

## Known baseline defects

- fictional compact body scale rather than Sun/Earth/Moon scale;
- kilometre-scale near color detail and a strong global-normal override;
- no production shadow map or caster chain;
- atmosphere shell does not apply distance haze to opaque ground;
- fixed ambient light;
- legacy flat-color body families and no physical solar angular presentation;
- previously diagnosed compact/terrain pop, chunk-edge, and cloud-horizon artifact families.

The baseline is used to compare resource and stability cost, not to preserve its art direction.
