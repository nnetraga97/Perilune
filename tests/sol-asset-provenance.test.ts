import { describe, expect, it } from 'vitest';
import sourceLock from '../assets/planets/sol-source-lock.json';
import localLock from '../assets/planets/local-material-source-lock.json';
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
});
