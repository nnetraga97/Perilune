import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fetchPinnedSource, type FetchResponseLike } from '../scripts/lib/part-source-fetch.mjs';

const bytes = Buffer.from('nasa part source bytes');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const source = { sourceId: 'nasa-x', url: 'https://example.test/x.glb', sha256 };

const tempDir = () => mkdtempSync(join(tmpdir(), 'part-fetch-'));
const streamOf = (data: Buffer): FetchResponseLike => ({ ok: true, status: 200, body: Readable.from([data]) });

describe('fetchPinnedSource', () => {
  it('writes through a .partial file and renames only after checksum verification', async () => {
    const dest = join(tempDir(), 'nested', 'x.glb');
    const result = await fetchPinnedSource(source, dest, async () => streamOf(bytes));
    expect(result).toBe('downloaded');
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(`${dest}.partial`)).toBe(false);
    expect(readFileSync(dest).equals(bytes)).toBe(true);
  });

  it('reuses a verified destination without fetching again', async () => {
    const dest = join(tempDir(), 'x.glb');
    writeFileSync(dest, bytes);
    let fetched = false;
    const result = await fetchPinnedSource(source, dest, async () => {
      fetched = true;
      throw new Error('should not fetch a verified destination');
    });
    expect(result).toBe('verified');
    expect(fetched).toBe(false);
  });

  it('removes the partial bytes and refuses the destination on a checksum mismatch', async () => {
    const dest = join(tempDir(), 'x.glb');
    const tampered = Buffer.from('tampered payload');
    await expect(fetchPinnedSource(source, dest, async () => streamOf(tampered))).rejects.toThrow(/checksum mismatch/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.partial`)).toBe(false);
  });
});
