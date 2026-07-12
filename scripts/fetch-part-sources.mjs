import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPartAssetInputs } from './lib/part-asset-schema.mjs';
import { fetchPinnedSource } from './lib/part-source-fetch.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(root, 'assets/parts');
const { sources } = loadPartAssetInputs(root);

await mkdir(resolve(sourceRoot, 'sources'), { recursive: true });
for (const source of sources.sources) {
  const destination = resolve(sourceRoot, source.localPath);
  const status = await fetchPinnedSource(source, destination, fetch);
  console.log(`part source ${source.sourceId}: ${status}`);
}
