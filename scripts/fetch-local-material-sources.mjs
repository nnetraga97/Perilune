import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const lock = JSON.parse(await readFile(path.join(root, 'assets/planets/local-material-source-lock.json'), 'utf8'));
const output = path.join(root, 'assets/planets/sources/polyhaven-local');
await mkdir(output, { recursive: true });

for (const asset of lock.assets) {
  for (const [map, [expected, filename]] of Object.entries(asset.files)) {
    const target = path.join(output, filename);
    const temporary = `${target}.part`;
    const url = `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/${lock.resolution}/${asset.id}/${filename}`;
    let bytes;
    try { bytes = await readFile(target); } catch { bytes = null; }
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expected) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed ${response.status} fetching ${asset.id}/${map}`);
      bytes = Buffer.from(await response.arrayBuffer());
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== expected) throw new Error(`${asset.id}/${map} checksum mismatch: ${actual}`);
      await writeFile(temporary, bytes);
      await rename(temporary, target);
    }
    await rm(temporary, { force: true });
  }
}
console.log(`Verified ${lock.assets.length} CC0 local material sources`);
