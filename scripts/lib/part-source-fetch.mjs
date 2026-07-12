import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function hasExpectedChecksum(path, expected) {
  try {
    return await sha256File(path) === expected;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function fetchPinnedSource(source, destination, fetchImpl) {
  if (await hasExpectedChecksum(destination, source.sha256)) return 'verified';

  const partial = `${destination}.partial`;
  await mkdir(dirname(destination), { recursive: true });
  await rm(partial, { force: true });

  try {
    const response = await fetchImpl(source.url);
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }

    await pipeline(response.body, createWriteStream(partial, { flags: 'wx' }));
    const actual = await sha256File(partial);
    if (actual !== source.sha256) {
      throw new Error(`checksum mismatch: expected ${source.sha256}, got ${actual}`);
    }

    await rename(partial, destination);
    return 'downloaded';
  } catch (error) {
    await rm(partial, { force: true });
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Part source ${source.sourceId} download failed: ${detail}`, { cause: error });
  }
}
