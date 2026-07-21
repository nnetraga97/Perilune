# Artemis IV source lock

`source.lock.json` separates mission facts from the generic Gateway reference
trajectory used by the replay. The checked runtime track was sampled from the
locked NASA/JPL DSG SPK, then transformed to a Moon-centered J2000 state with
the locked DE440s planetary ephemeris. It is an idealized Gateway engineering
reference—not an Artemis IV spacecraft ephemeris or prediction.

Raw kernels are authoring inputs and are intentionally ignored by Git. Runtime,
build, content validation, and tests read only the checked JSON artifact and do
not use SPICE or the network.

Reproduce the artifact from the repository root:

```bash
python3 -m venv .artemis-venv
.artemis-venv/bin/python -m pip install -r scripts/requirements-artemis-reference.txt
node scripts/fetch-artemis-reference-kernels.mjs
.artemis-venv/bin/python scripts/compile-artemis-reference-track.py
```

To prove that a checked artifact is byte-identical after fetching the kernels:

```bash
.artemis-venv/bin/python scripts/compile-artemis-reference-track.py --check
```
