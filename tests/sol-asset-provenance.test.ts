import { describe, expect, it } from 'vitest';
import sourceLock from '../assets/planets/sol-source-lock.json';
import localLock from '../assets/planets/local-material-source-lock.json';
import marsLock from '../assets/planets/sources/nasa-marstrek-viking/source.lock.json';
import mercuryLock from '../assets/planets/sources/nasa-messenger-mercury/source.lock.json';
import artifact from '../src/generated/checked-planet-manifest.json';

const sha256 = /^[0-9a-f]{64}$/;

describe('Sol visual source provenance', () => {
  it('pins authoritative Earth and Moon inputs by HTTPS URL and checksum', () => {
    expect(sourceLock.sources.map((source) => source.id)).toEqual(expect.arrayContaining([
      'nasa-bmng-earth-2004-07', 'nasa-blue-marble-clouds-2002',
      'nasa-black-marble-earth-2016', 'noaa-etopo-2022-earth-surface-60s',
      'nasa-lro-moon-color-8k', 'nasa-lola-moon-height',
    ]));
    for (const source of sourceLock.sources) {
      expect(source.url).toMatch(/^https:\/\//);
      expect(source.sha256).toMatch(sha256);
    }
  });

  it('pins CC0 local material sources and ships every Sol tier', () => {
    expect(localLock.license).toMatch(/CC0/i);
    expect(localLock.assets.length).toBeGreaterThanOrEqual(5);
    for (const material of localLock.assets) {
      expect(material.page).toMatch(/^https:\/\/polyhaven\.com\//);
      for (const [checksum] of Object.values(material.files)) expect(checksum).toMatch(sha256);
    }
    const packs = artifact.manifest.packs.filter((pack) => pack.bodyId === 'earth' || pack.bodyId === 'moon');
    expect(packs.map((pack) => `${pack.bodyId}/${pack.tier}`)).toEqual(expect.arrayContaining([
      'earth/low', 'earth/medium', 'earth/high', 'moon/low', 'moon/medium', 'moon/high',
    ]));
  });

  it('pins the NASA Mars Trek Viking mosaic and ships albedo-only Mars tiers', () => {
    expect(marsLock.productPage).toMatch(/^https:\/\/trek\.nasa\.gov\//);
    expect(marsLock.urlTemplate).toContain('Mars_Viking_MDIM21_ClrMosaic_global_232m');
    expect(marsLock.derivedSourceSha256).toMatch(sha256);
    expect(marsLock.sourceDimensions).toEqual([4096, 2048]);
    const packs = artifact.manifest.packs.filter((pack) => pack.bodyId === 'mars');
    expect(packs.map((pack) => pack.tier).sort()).toEqual(['high', 'low', 'medium']);
    for (const pack of packs) expect(pack.channels.map((channel) => channel.name)).toEqual(['albedo']);
  });

  it('pins the NASA MESSENGER map and ships albedo-only Mercury tiers', () => {
    expect(mercuryLock.productPage).toBe('https://science.nasa.gov/photojournal/enhanced-color-mercury-map/');
    expect(mercuryLock.sourceUrl).toMatch(/^https:\/\/assets\.science\.nasa\.gov\//);
    expect(mercuryLock.sourceSha256).toMatch(sha256);
    expect(mercuryLock.derivedSourceSha256).toMatch(sha256);
    expect(mercuryLock.sourceDimensions).toEqual([4096, 2048]);
    expect(mercuryLock).toMatchObject({
      sourceSeamLongitudeDegrees: 0,
      canonicalSeamLongitudeDegrees: -180,
    });
    const packs = artifact.manifest.packs.filter((pack) => pack.bodyId === 'mercury');
    expect(packs.map((pack) => pack.tier).sort()).toEqual(['high', 'low', 'medium']);
    for (const pack of packs) expect(pack.channels.map((channel) => channel.name)).toEqual(['albedo']);
  });
});
