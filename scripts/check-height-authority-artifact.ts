import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CHECKED_HEIGHT_ARTIFACT_SHA256,
  CHECKED_HEIGHT_AUTHORITY_VERSION,
  CHECKED_HEIGHT_GRIDS,
} from '../src/generated/checked-height-authority';
import { checkedHeightArtifactDigest } from './lib/height-authority-artifact.mjs';

interface SourceLock {
  readonly id: string;
  readonly path: string;
  readonly sha256: string;
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Checked height authority is invalid: ${message}`);
}

const root = resolve(import.meta.dirname, '..');
const sourceLock = JSON.parse(readFileSync(resolve(root, 'assets/planets/sol-source-lock.json'), 'utf8')) as {
  readonly sources: readonly SourceLock[];
};
const locksById = new Map(sourceLock.sources.map((entry) => [entry.id, entry]));
const expectedBodies = new Set(['earth', 'moon']);

requireCondition(/^[a-f0-9]{64}$/.test(CHECKED_HEIGHT_AUTHORITY_VERSION), 'source version must be SHA-256');
requireCondition(/^[a-f0-9]{64}$/.test(CHECKED_HEIGHT_ARTIFACT_SHA256), 'artifact digest must be SHA-256');
requireCondition(CHECKED_HEIGHT_GRIDS.length === expectedBodies.size, 'exactly Earth and Moon grids are required');

const seenBodies = new Set<string>();
for (const grid of CHECKED_HEIGHT_GRIDS) {
  requireCondition(expectedBodies.has(grid.bodyId) && !seenBodies.has(grid.bodyId), `unexpected or duplicate body ${grid.bodyId}`);
  seenBodies.add(grid.bodyId);
  const lock = locksById.get(grid.sourceId);
  requireCondition(lock, `missing source lock ${grid.sourceId}`);
  requireCondition(grid.sourcePath === `assets/planets/${lock.path}`, `${grid.bodyId} source path does not match its lock`);
  requireCondition(grid.sourceSha256 === lock.sha256, `${grid.bodyId} source digest does not match its lock`);
  requireCondition(grid.width === 512 && grid.height === 256, `${grid.bodyId} grid dimensions changed`);
  requireCondition(grid.noDataCount === 0, `${grid.bodyId} contains nodata`);
  requireCondition(grid.derivationKernel === 'lanczos3', `${grid.bodyId} kernel changed`);
  requireCondition(Number.isFinite(grid.minimumHeightMeters) && Number.isFinite(grid.maximumHeightMeters)
    && grid.minimumHeightMeters <= grid.maximumHeightMeters, `${grid.bodyId} height range is invalid`);
  requireCondition(grid.quantizationScaleMeters > 0 && Number.isFinite(grid.quantizationOffsetMeters), `${grid.bodyId} quantization is invalid`);
  requireCondition(grid.worstQuantizationErrorMeters >= 0
    && grid.worstQuantizationErrorMeters <= grid.quantizationScaleMeters * 0.5 + 1e-9, `${grid.bodyId} quantization error is invalid`);
  requireCondition(grid.rmsQuantizationErrorMeters >= 0
    && grid.rmsQuantizationErrorMeters <= grid.worstQuantizationErrorMeters, `${grid.bodyId} RMS error is invalid`);

  const encoded = Buffer.from(grid.encodedInt16Base64, 'base64');
  requireCondition(encoded.toString('base64') === grid.encodedInt16Base64, `${grid.bodyId} base64 is not canonical`);
  requireCondition(encoded.byteLength === grid.width * grid.height * 2, `${grid.bodyId} encoded byte count changed`);
  let minimum = Infinity;
  let maximum = -Infinity;
  for (let offset = 0; offset < encoded.byteLength; offset += 2) {
    const height = encoded.readInt16LE(offset) * grid.quantizationScaleMeters + grid.quantizationOffsetMeters;
    minimum = Math.min(minimum, height);
    maximum = Math.max(maximum, height);
  }
  requireCondition(Math.abs(minimum - grid.minimumHeightMeters) <= grid.worstQuantizationErrorMeters + 1e-6,
    `${grid.bodyId} encoded minimum disagrees with metadata`);
  requireCondition(Math.abs(maximum - grid.maximumHeightMeters) <= grid.worstQuantizationErrorMeters + 1e-6,
    `${grid.bodyId} encoded maximum disagrees with metadata`);
}

const artifactGrids = CHECKED_HEIGHT_GRIDS.map((grid) => ({
  bodyId: grid.bodyId,
  sourceId: grid.sourceId,
  sourcePath: grid.sourcePath,
  sourceSha256: grid.sourceSha256,
  sourceDimensions: [...grid.sourceDimensions],
  verticalDatum: grid.verticalDatum,
  derivationKernel: grid.derivationKernel,
  width: grid.width,
  height: grid.height,
  minimumHeightMeters: grid.minimumHeightMeters,
  maximumHeightMeters: grid.maximumHeightMeters,
  noDataCount: grid.noDataCount,
  quantizationScaleMeters: grid.quantizationScaleMeters,
  quantizationOffsetMeters: grid.quantizationOffsetMeters,
  worstQuantizationErrorMeters: grid.worstQuantizationErrorMeters,
  rmsQuantizationErrorMeters: grid.rmsQuantizationErrorMeters,
  encodedInt16Base64: grid.encodedInt16Base64,
}));
requireCondition(checkedHeightArtifactDigest(artifactGrids) === CHECKED_HEIGHT_ARTIFACT_SHA256,
  'generated artifact digest mismatch');

console.log(`Checked committed height authority artifact (${CHECKED_HEIGHT_ARTIFACT_SHA256})`);
