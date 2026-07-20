import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {
  assertJsonFingerprint,
  assertPlanetSourceLock,
  buildProbeUrl,
  sha256Bytes,
} from './lib/planet-source-registry.mjs';

const ROOT = process.cwd();
const LOCK_PATH = path.join(ROOT, 'assets/planets/sol-detail-source-lock.json');
const REPORT_PATH = path.join(ROOT, 'docs/performance/reference/sol-source-probe-2026-07-20.json');
const live = process.argv.includes('--live');
const writeReport = process.argv.includes('--write-report');
const lock = assertPlanetSourceLock(JSON.parse(await readFile(LOCK_PATH, 'utf8')));

async function boundedBody(response, maximumBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`declared ${declaredLength} bytes exceeds ${maximumBytes}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new Error(`received ${bytes.byteLength} bytes exceeds ${maximumBytes}`);
  }
  return bytes;
}

async function inspectImage(bytes, operation) {
  const image = sharp(bytes);
  const metadata = await image.metadata();
  if (operation.image) {
    if (metadata.width !== operation.image.width || metadata.height !== operation.image.height) {
      throw new Error(`image dimensions changed: expected ${operation.image.width}x${operation.image.height}, ` +
        `got ${metadata.width}x${metadata.height}`);
    }
  }
  let numeric;
  if (operation.numeric) {
    const { data, info } = await image.raw({ depth: 'float' }).toBuffer({ resolveWithObject: true });
    const values = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
    let minimum = Infinity;
    let maximum = -Infinity;
    for (let index = 0; index < values.length; index += info.channels) {
      minimum = Math.min(minimum, values[index]);
      maximum = Math.max(maximum, values[index]);
    }
    const tolerance = operation.numeric.tolerance;
    if (Math.abs(minimum - operation.numeric.minimum) > tolerance ||
        Math.abs(maximum - operation.numeric.maximum) > tolerance) {
      throw new Error(`numeric range changed: expected ${operation.numeric.minimum}..${operation.numeric.maximum} ` +
        `±${tolerance}, got ${minimum}..${maximum}`);
    }
    numeric = { minimum, maximum, channels: info.channels };
  }
  return { format: metadata.format, width: metadata.width, height: metadata.height, numeric };
}

async function probe(source, operation) {
  const url = buildProbeUrl(operation);
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: { 'user-agent': 'Perilune-source-probe/1.0' },
    });
    if (response.status !== 429 && response.status < 500) break;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
  if (!response) throw new Error('probe returned no response');
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const mime = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
  if (mime !== operation.expectedMime.toLowerCase()) {
    throw new Error(`MIME changed: expected ${operation.expectedMime}, got ${mime || '(missing)'}`);
  }
  if (operation.expectedCors && response.headers.get('access-control-allow-origin') !== operation.expectedCors) {
    throw new Error(`CORS changed: expected ${operation.expectedCors}, got ` +
      `${response.headers.get('access-control-allow-origin') ?? '(missing)'}`);
  }
  const bytes = await boundedBody(response, operation.maximumBytes);
  const digest = sha256Bytes(bytes);
  if (operation.sha256 && digest !== operation.sha256) {
    throw new Error(`body digest changed: expected ${operation.sha256}, got ${digest}`);
  }
  let decoded;
  if (mime.startsWith('image/')) decoded = await inspectImage(bytes, operation);
  if (operation.json) {
    const json = JSON.parse(new TextDecoder().decode(bytes));
    assertJsonFingerprint(json, operation.json, `${source.id}/${operation.id}`);
    decoded = { jsonFingerprint: operation.json };
  }
  return {
    datasetId: source.id,
    operationId: operation.id,
    url: url.toString(),
    status: response.status,
    mime,
    cors: response.headers.get('access-control-allow-origin'),
    cacheControl: response.headers.get('cache-control'),
    etag: response.headers.get('etag'),
    bytes: bytes.byteLength,
    sha256: digest,
    decoded,
  };
}

if (!live) {
  console.log(`Validated ${lock.sources.length} locked planet-detail datasets; pass --live to probe endpoints.`);
  process.exit(0);
}

const results = [];
const failures = [];
for (const source of lock.sources) {
  for (const operation of source.operations) {
    try {
      const result = await probe(source, operation);
      results.push(result);
      console.log(`PASS ${source.id}/${operation.id} ${result.bytes} bytes`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ datasetId: source.id, operationId: operation.id, message });
      console.error(`FAIL ${source.id}/${operation.id}: ${message}`);
    }
  }
}

const report = {
  schemaVersion: 1,
  sourceLockObservedAt: lock.observedAt,
  probedAt: new Date().toISOString(),
  results,
  failures,
};
if (writeReport) await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
if (failures.length) process.exitCode = 1;
