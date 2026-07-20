import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(repoRoot, 'assets/sol/constants-source.json');
const cacheDirectory = path.join(repoRoot, 'assets/sol/sources');
const source = JSON.parse(await readFile(sourcePath, 'utf8'));
const downloadable = source.authorities.filter((entry) => entry.sha256);

await mkdir(cacheDirectory, { recursive: true });

for (const authority of downloadable) {
  const response = await fetch(authority.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Failed to fetch ${authority.id}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== authority.sha256) {
    throw new Error(`${authority.id} checksum mismatch: expected ${authority.sha256}, got ${digest}`);
  }
  const extension = path.extname(new URL(authority.url).pathname) || '.dat';
  const destination = path.join(cacheDirectory, `${authority.id}${extension}`);
  await writeFile(destination, bytes);
  console.log(`${authority.id}: ${digest}`);
}
