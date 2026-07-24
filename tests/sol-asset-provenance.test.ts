import { describe, expect, it } from 'vitest';
import sourceLock from '../assets/planets/sol-source-lock.json';
import localLock from '../assets/planets/local-material-source-lock.json';
import marsLock from '../assets/planets/sources/nasa-marstrek-viking/source.lock.json';
import mercuryLock from '../assets/planets/sources/nasa-messenger-mercury/source.lock.json';
import venusLock from '../assets/planets/sources/jpl-venus-clouds/source.lock.json';
import jupiterLock from '../assets/planets/sources/nasa-cassini-jupiter/source.lock.json';
import callistoLock from '../assets/planets/sources/usgs-callisto-galileo-voyager/source.lock.json';
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

  it('pins the representative JPL cloud deck and ships albedo-only Venus tiers', () => {
    expect(venusLock.productPage).toBe('https://maps.jpl.nasa.gov/tmaps/venus.html');
    expect(venusLock.sourceUrl).toBe('https://maps.jpl.nasa.gov/tmaps/pix/ven0mss2.tif');
    expect(venusLock.sourceSha256).toMatch(sha256);
    expect(venusLock.derivedSourceSha256).toBe(venusLock.sourceSha256);
    expect(venusLock.sourceDimensions).toEqual([1440, 720]);
    expect(venusLock.sourceCharacter).toMatch(/representative.*not a time-resolved global measurement/i);
    const source = artifact.manifest.sources.find((entry) => entry.bodies?.includes('venus'));
    expect(source?.observation).toMatch(/representative static cloud texture/i);
    const packs = artifact.manifest.packs.filter((pack) => pack.bodyId === 'venus');
    expect(packs.map((pack) => pack.tier).sort()).toEqual(['high', 'low', 'medium']);
    for (const pack of packs) expect(pack.channels.map((channel) => channel.name)).toEqual(['albedo']);
  });

  it('pins the NASA/JPL Cassini cloud mosaic and ships albedo-only Jupiter tiers', () => {
    expect(jupiterLock.productPage).toContain('jpl.nasa.gov/images/pia07782');
    expect(jupiterLock.sourceUrl).toMatch(/^https:\/\/assets\.science\.nasa\.gov\//);
    expect(jupiterLock.sourceSha256).toMatch(sha256);
    expect(jupiterLock.derivedSourceSha256).toMatch(sha256);
    expect(jupiterLock.sourceCharacter).toMatch(/close to human-eye.*not strict true color/i);
    const packs = artifact.manifest.packs.filter((pack) => pack.bodyId === 'jupiter');
    expect(packs.map((pack) => pack.tier).sort()).toEqual(['high', 'low', 'medium']);
    for (const pack of packs) expect(pack.channels.map((channel) => channel.name)).toEqual(['albedo']);
  });

  it('pins the USGS Callisto mosaic and its NASA/JPL color reference', () => {
    expect(callistoLock.productPage).toMatch(/^https:\/\/astrogeology\.usgs\.gov\//);
    expect(callistoLock.sourceSha256).toMatch(sha256);
    expect(callistoLock.colorReferenceSha256).toMatch(sha256);
    expect(callistoLock.derivedSourceSha256).toMatch(sha256);
    expect(callistoLock).toMatchObject({
      sourceLongitudeDirection: 'west-positive',
      canonicalLongitudeDirection: 'east-positive',
      canonicalSeamLongitudeDegrees: -180,
    });
    expect(callistoLock.sourceCharacter).toMatch(/not spatially measured global color/i);
    const packs = artifact.manifest.packs.filter((pack) => pack.bodyId === 'callisto');
    expect(packs.map((pack) => pack.tier).sort()).toEqual(['high', 'low', 'medium']);
    for (const pack of packs) expect(pack.channels.map((channel) => channel.name)).toEqual(['albedo']);
  });
});
