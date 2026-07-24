import { describe, expect, it } from 'vitest';
import {
  SOL_VISUAL_REFERENCE_STATIONS,
  solVisualReferenceStation,
} from '../src/proto/solVisualReferenceStations';

describe('Sol visual reference stations', () => {
  it('uses unique, frozen, physically dimensioned station definitions', () => {
    expect(Object.isFrozen(SOL_VISUAL_REFERENCE_STATIONS)).toBe(true);
    expect(new Set(SOL_VISUAL_REFERENCE_STATIONS.map((station) => station.id)).size)
      .toBe(SOL_VISUAL_REFERENCE_STATIONS.length);
    for (const station of SOL_VISUAL_REFERENCE_STATIONS) {
      expect(Object.isFrozen(station)).toBe(true);
      expect(station.altitudeMeters).toBeGreaterThan(0);
      expect(station.fovDegrees).toBeGreaterThan(0);
      expect(station.fovDegrees).toBeLessThan(180);
      expect(Math.hypot(...station.sunDirection)).toBeGreaterThan(0);
    }
  });

  it('covers the Sun, global Earth, atmosphere descent, ocean, lunar matrix, and Mars orbit look', () => {
    const ids = new Set(SOL_VISUAL_REFERENCE_STATIONS.map((station) => station.id));
    for (const required of [
      'sun-from-earth', 'sun-zoomed-disk', 'sun-partial-occultation',
      'earth-day-full', 'earth-terminator-full', 'earth-night-full',
      'earth-limb-2000km', 'earth-low-orbit', 'earth-low-orbit-alt-sun', 'earth-100km', 'earth-20km',
      'earth-10km', 'earth-ksc-1km', 'earth-ksc-ground', 'earth-ksc-coast-transect',
      'earth-1km', 'earth-ground', 'earth-ocean-horizon',
      'moon-from-earth', 'moon-near-full', 'moon-far-full', 'moon-polar', 'moon-south-pole-orbit',
      'moon-detail-2000km', 'moon-detail-1100km', 'moon-detail-300km', 'moon-low-orbit', 'moon-surface',
      'moon-site01-10km', 'moon-site01-1km', 'moon-site01-surface',
      'mercury-day-full', 'mercury-terminator-full', 'mercury-proxy-handoff', 'mercury-far-point',
      'mars-day-full', 'mars-terminator-full', 'mars-proxy-handoff', 'mars-far-point',
    ]) expect(ids.has(required), required).toBe(true);
  });

  it('rejects unknown stations instead of silently changing the comparison view', () => {
    expect(() => solVisualReferenceStation('unknown')).toThrow(/unknown sol visual reference station/i);
  });
});
