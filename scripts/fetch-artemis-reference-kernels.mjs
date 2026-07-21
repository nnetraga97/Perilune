#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertArtemisSourceLock } from './lib/artemis-source-registry.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultLockPath = resolve(root, 'assets/missions/artemis-iv/sources/source.lock.json');
const defaultOutputDir = resolve(root, 'assets/missions/artemis-iv/sources/kernels');

function usage() {
  console.log(`Usage: node scripts/fetch-artemis-reference-kernels.mjs [options]

Explicitly downloads the authoring-only SPICE kernels locked for the Artemis IV
reference track. This script is never called by build, test, or gameplay.

Options:
  --output-dir PATH  Kernel destination (default: assets/missions/artemis-iv/sources/kernels)
  --source-lock PATH Alternate source lock
  --verify-only      Verify already-downloaded files without network access
  --help             Show this help`);
}

function parseArgs(argv) {
  const options = {
    outputDir: defaultOutputDir,
    sourceLock: defaultLockPath,
    verifyOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      usage();
      process.exit(0);
    } else if (argument === '--verify-only') {
      options.verifyOnly = true;
    } else if (argument === '--output-dir' || argument === '--source-lock') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a path`);
      options[argument === '--output-dir' ? 'outputDir' : 'sourceLock'] = resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

async function sha256File(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

async function verifyKernel(path, artifact) {
  if (!existsSync(path)) return { ok: false, reason: 'missing' };
  const fileStat = await stat(path);
  if (fileStat.size !== artifact.byteLength) {
    return { ok: false, reason: `expected ${artifact.byteLength} bytes, got ${fileStat.size}` };
  }
  const digest = await sha256File(path);
  if (digest !== artifact.sha256) {
    return { ok: false, reason: `expected SHA-256 ${artifact.sha256}, got ${digest}` };
  }
  return { ok: true };
}

async function fetchKernel(source, outputDir) {
  const destination = resolve(outputDir, source.artifact.filename);
  const existing = await verifyKernel(destination, source.artifact);
  if (existing.ok) {
    console.log(`verified ${source.artifact.filename}`);
    return;
  }
  if (existing.reason !== 'missing') {
    throw new Error(
      `${source.artifact.filename} already exists but is not the locked artifact (${existing.reason}); ` +
      'move it aside before fetching',
    );
  }

  const response = await fetch(source.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} while fetching ${source.url}`);
  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
  if (contentLength !== null && Number.isFinite(contentLength) && contentLength !== source.artifact.byteLength) {
    throw new Error(
      `${source.artifact.filename} Content-Length changed: expected ${source.artifact.byteLength}, got ${contentLength}`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== source.artifact.byteLength) {
    throw new Error(
      `${source.artifact.filename} byte length changed: expected ${source.artifact.byteLength}, got ${bytes.byteLength}`,
    );
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== source.artifact.sha256) {
    throw new Error(
      `${source.artifact.filename} SHA-256 changed: expected ${source.artifact.sha256}, got ${digest}`,
    );
  }
  const partial = `${destination}.partial-${process.pid}`;
  await writeFile(partial, bytes, { flag: 'wx' });
  try {
    await rename(partial, destination);
  } catch (error) {
    await unlink(partial).catch(() => undefined);
    throw error;
  }
  console.log(`fetched and verified ${source.artifact.filename}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const lock = assertArtemisSourceLock(JSON.parse(await readFile(options.sourceLock, 'utf8')));
  const kernels = lock.sources.filter((source) => source.kind === 'kernel');
  if (!kernels.length) throw new Error('Source lock contains no kernels');
  await mkdir(options.outputDir, { recursive: true });
  for (const source of kernels) {
    const destination = resolve(options.outputDir, source.artifact.filename);
    if (options.verifyOnly) {
      const result = await verifyKernel(destination, source.artifact);
      if (!result.ok) throw new Error(`${source.artifact.filename}: ${result.reason}`);
      console.log(`verified ${source.artifact.filename}`);
    } else {
      await fetchKernel(source, options.outputDir);
    }
  }
  console.log(`${options.verifyOnly ? 'verified' : 'ready'} ${kernels.length} locked Artemis reference kernels`);
}

main().catch((error) => {
  console.error(`Artemis reference kernel fetch failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
