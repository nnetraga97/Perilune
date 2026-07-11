import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AUREN_SYSTEM } from '../src/content/system';
import { Vec3 } from '../src/core/vec3';
import { recipeForBody } from '../src/sim/terrainRecipe';
import { solidHeight } from '../src/sim/terrain';
import { Universe } from '../src/sim/universe';

const root = resolve(import.meta.dirname, '..');
const recipesPath = resolve(root, 'assets/planets/recipes.json');
const manifestPath = resolve(root, 'assets/planets/manifest.json');
const outputPath = resolve(root, 'assets/planets/compiler-output.json');
const width = 64;
const height = 32;
const quantizationMeters = 0.5;

interface RecipeRecord {
  bodyId: string;
  version: number;
  hash: string;
}

function rawHeightFingerprint(body: ReturnType<Universe['get']>): string | null {
  if (body.def.surfaceKind !== 'solid') return null;
  const bytes = new Uint8Array(width * height * 2);
  const view = new DataView(bytes.buffer);
  const direction = new Vec3();
  for (let y = 0; y < height; y++) {
    const latitude = (0.5 - (y + 0.5) / height) * Math.PI;
    for (let x = 0; x < width; x++) {
      const longitude = ((x + 0.5) / width) * Math.PI * 2 - Math.PI;
      direction.set(
        Math.cos(latitude) * Math.cos(longitude),
        Math.cos(latitude) * Math.sin(longitude),
        Math.sin(latitude),
      );
      const surface = solidHeight(body, direction);
      if (surface.kind !== 'solid') throw new Error(`Missing solid height for ${body.id}`);
      const quantized = Math.round(surface.height / quantizationMeters);
      if (quantized < -32768 || quantized > 32767) {
        throw new Error(`${body.id} height exceeds signed-16-bit fingerprint range`);
      }
      view.setInt16((y * width + x) * 2, quantized, true);
    }
  }
  return createHash('sha256').update(bytes).digest('hex');
}

const recipeFile = JSON.parse(readFileSync(recipesPath, 'utf8')) as {
  schemaVersion: number;
  recipes: RecipeRecord[];
};
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  compiler: { imageLibraryVersion: string; compressionThreads: number };
};
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  devDependencies: Record<string, string>;
};
if (manifest.compiler.imageLibraryVersion !== `sharp@${packageJson.devDependencies.sharp}`) {
  throw new Error('Manifest image library does not match the pinned sharp dependency');
}
if (manifest.compiler.compressionThreads !== 1) {
  throw new Error('Planet compiler packaging must remain single-threaded');
}
const declared = new Map(recipeFile.recipes.map((recipe) => [recipe.bodyId, recipe]));
const universe = new Universe(AUREN_SYSTEM);
const bodies = [...universe.bodies.values()]
  .map((body) => {
    const runtimeRecipe = recipeForBody(body);
    const record = declared.get(body.id);
    if (!record || record.version !== runtimeRecipe.version || record.hash !== runtimeRecipe.hash) {
      throw new Error(`Recipe metadata drift for ${body.id}`);
    }
    return {
      bodyId: body.id,
      surfaceKind: body.def.surfaceKind,
      recipeVersion: runtimeRecipe.version,
      recipeHash: runtimeRecipe.hash,
      rawHeightSha256: rawHeightFingerprint(body),
    };
  })
  .sort((a, b) => a.bodyId.localeCompare(b.bodyId));

const output = `${JSON.stringify({
  schemaVersion: 1,
  compilerVersion: '1.0.0',
  fingerprint: { width, height, quantizationMeters, byteOrder: 'little-endian' },
  bodies,
}, null, 2)}\n`;

if (process.argv.includes('--write')) {
  writeFileSync(outputPath, output);
  console.log(`wrote ${outputPath}`);
} else {
  const existing = readFileSync(outputPath, 'utf8');
  if (existing !== output) throw new Error('Planet compiler output is stale; run compile:planet-assets -- --write');
  console.log(`planet compiler check passed: ${bodies.length} bodies`);
}
