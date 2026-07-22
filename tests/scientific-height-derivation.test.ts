import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import sourceLock from '../assets/planets/sol-source-lock.json';
import {
  deriveScientificHeight,
  encodeHalfMetreInt16,
  HEIGHT_SOURCE_DEFINITIONS,
  NUMERIC_HEIGHT_KERNEL,
  sourceSha256,
} from '../scripts/lib/scientific-height-derivation.mjs';
import { CHECKED_HEIGHT_GRIDS } from '../src/generated/checked-height-authority';

const AUTHORING_HEIGHT_SOURCES = [
  HEIGHT_SOURCE_DEFINITIONS.earthSurface,
  HEIGHT_SOURCE_DEFINITIONS.moon,
];
const authoringSourcesAvailable = AUTHORING_HEIGHT_SOURCES.every((definition) => (
  existsSync(resolve(process.cwd(), definition.relativePath))
));

describe('direct scientific height derivation', () => {
  it('points every runtime derivative at a numeric source rather than a visual output', () => {
    for (const grid of CHECKED_HEIGHT_GRIDS) {
      expect(grid.sourcePath).toMatch(/^assets\/planets\/sources\//);
      expect(grid.sourcePath).not.toContain('/generated/');
      expect(grid.sourcePath).not.toMatch(/heightMacro\.png$/);
      expect(grid.derivationKernel).toBe(NUMERIC_HEIGHT_KERNEL);
      expect(grid.noDataCount).toBe(0);
      expect(grid.worstQuantizationErrorMeters).toBeLessThanOrEqual(0.25);
      expect(grid.rmsQuantizationErrorMeters).toBeLessThanOrEqual(0.15);
    }
  });

  it('pins raw source dimensions, datum, and checksum metadata', () => {
    for (const definition of AUTHORING_HEIGHT_SOURCES) {
      const grid = CHECKED_HEIGHT_GRIDS.find((candidate) => candidate.bodyId === definition.bodyId)!;
      const source = sourceLock.sources.find((candidate) => candidate.id === definition.sourceId)!;
      expect(grid.sourceDimensions).toEqual(definition.sourceDimensions);
      expect(grid.verticalDatum).toBe(definition.verticalDatum);
      expect(grid.sourceSha256).toBe(source.sha256);
    }
  });

  it('records final half-metre quantization error independently', () => {
    const heights = new Float32Array([-10.24, -0.26, 0, 0.24, 123.26]);
    const quantized = encodeHalfMetreInt16(heights);
    expect(quantized.scaleMeters).toBe(0.5);
    expect(quantized.offsetMeters).toBe(0);
    expect(quantized.worstQuantizationErrorMeters).toBeLessThanOrEqual(0.25);
  });
});

describe.skipIf(!authoringSourcesAvailable)('direct scientific height derivation with authoring sources', () => {
  it('matches the pinned source checksums', async () => {
    for (const definition of AUTHORING_HEIGHT_SOURCES) {
      const source = sourceLock.sources.find((candidate) => candidate.id === definition.sourceId)!;
      expect(await sourceSha256(process.cwd(), definition)).toBe(source.sha256);
    }
  });

  it('derives repeatable scalar levels directly from the source decoder', async () => {
    for (const definition of AUTHORING_HEIGHT_SOURCES) {
      const first = await deriveScientificHeight(process.cwd(), definition, 16, 8);
      const second = await deriveScientificHeight(process.cwd(), definition, 16, 8);
      expect(first.sourcePath).toBe(definition.relativePath);
      expect(first.heights).toEqual(second.heights);
      expect(first.minimum).toBeLessThan(first.maximum);
      expect(first.noDataCount).toBe(0);
    }
  }, 30_000);
});
