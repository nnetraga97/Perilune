import { describe, expect, it } from 'vitest';
import lockJson from '../assets/planets/sol-detail-source-lock.json';
import {
  assertPlanetSourceLock,
  buildProbeUrl,
  sourceById,
  validatePlanetSourceLock,
} from '../scripts/lib/planet-source-registry.mjs';

const lock = assertPlanetSourceLock(lockJson);

describe('Sol detail source lock', () => {
  it('separates numeric, categorical, and visual roles behind stable dataset IDs', () => {
    expect(lock.sources.map((source) => source.role)).toEqual(expect.arrayContaining([
      'height', 'surface-class', 'albedo',
    ]));
    expect(sourceById(lock, 'usgs-3dep-ksc-1m-86037').verticalDatum).toBe('NAVD88');
    const earthHeight = sourceById(lock, 'usgs-3dep-ksc-1m-86037') as unknown as {
      datumConversion: { tool: string; gridSize: number[]; correctionsMeters: number[]; reportedUncertaintyMeters: number };
    };
    expect(earthHeight.datumConversion).toMatchObject({
      tool: 'NOAA VDatum 4.8 Full API', gridSize: [3, 3], reportedUncertaintyMeters: 0.16,
    });
    expect(new Set(earthHeight.datumConversion.correctionsMeters).size).toBeGreaterThan(1);
    expect(sourceById(lock, 'nasa-moontrek-lola-global-128ppd-v04').verticalDatum)
      .toContain('1737400 m');
    expect(sourceById(lock, 'usda-naip-ksc-2025-29992').role).toBe('albedo');
    expect(sourceById(lock, 'usfws-nwi-ksc-snapshot-2026-07-20').role).toBe('surface-class');
  });

  it('never leaves mutable imagery or elevation mosaics unlocked', () => {
    for (const source of lock.sources) {
      expect(source.version.toLowerCase()).not.toMatch(/^latest$/);
    }
    expect(sourceById(lock, 'usda-naip-ksc-2025-29992').version).toContain('29992');
    expect(sourceById(lock, 'usgs-3dep-ksc-1m-86037').version).toContain('86037');
  });

  it('builds only HTTPS requests to explicitly allowed hosts', () => {
    for (const source of lock.sources) {
      for (const operation of source.operations) {
        const url = buildProbeUrl(operation);
        expect(url.protocol).toBe('https:');
        expect(lock.allowedHosts).toContain(url.hostname);
        expect(operation.maximumBytes).toBeLessThanOrEqual(2_097_152);
      }
    }
  });

  it('rejects an arbitrary probe host', () => {
    const changed = structuredClone(lockJson);
    changed.sources[0].operations[0].url = 'https://example.com/private';
    expect(validatePlanetSourceLock(changed)).toContain(
      'sources[0].operations[0].url is outside the HTTPS allowlist',
    );
  });
});
