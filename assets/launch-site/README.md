# KSC launch pad

The user supplied the textured Tripo Studio model through the Blender bridge. Raw backups and the reference image are in `~/Desktop/perilunetemp`; hashes and source task IDs are in `sources.json`. No regeneration or paid API call is needed for these repairs.

The repaired model has a 19.6 m foundation diameter and a 52 m tower above the physical deck. Static tower geometry is scaled vertically while moving components retain their proportions. Two single-triangle scraps were removed. Fifteen mesh components share three 2048 px atlases (base colour, tangent normal, metallic/roughness). This is still generated geometry, not a surveyed LC-39B reconstruction.

Seven rigid transform clips each span 0–1 seconds: crew access arm, two umbilicals and four clamps. Runtime scrubs them using saved simulation timestamps. Crew access retracts first, then umbilicals, then clamps. The rocket is held for four simulation seconds before fuel-consuming thrust integration starts. Throttle cancellation before release resets the sequence; after release the pad stays clear. Arbitrary sandbox craft are not automatically fitted to the fixed-height arms.

The pad keeps the existing deck collision and terrain footprint. A checksum or load failure preserves the procedural pad. The open-ended terrain skirt preserves `launch-pad-foundation` without filling the exhaust opening with a cylinder cap. A physics fix advances a held rocket to the end-of-step Earth rotation, matching the rendered pad time.

Rebuild authoring from the raw backup:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background "$HOME/Desktop/perilunetemp/launch-pad-raw-bridge.blend" --python scripts/blender/prepare-launch-pad.py
npm run compile:launch-site
npm run check:launch-site
```

`npm run build` checks the compiled asset. Never flatten or join animated hierarchy. Budgets are isolated from spacecraft part budgets: 40,000 triangles, 2048 px textures, 8 MiB transfer, 70 MiB estimated GPU memory including RGBA mip chains and accessors. The current manifest records 37,107 triangles, 7,879,200 transfer bytes, 6,513,429 texture bytes and 68,460,088 estimated GPU bytes. GPU figures are a conservative asset estimate, not a driver allocation measurement.
