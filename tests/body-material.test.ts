import { describe, expect, it } from 'vitest';
import { AUREN_SYSTEM } from '../src/content/system';
import { BODY_VISUALS } from '../src/content/bodyVisuals';
import { bodyFixedUv, bodyMaterialDescriptor } from '../src/render/bodyMaterial';

describe('body visual assignments', () => {
  it('covers every system body exactly once', () => {
    expect(Object.keys(BODY_VISUALS).sort()).toEqual(
      AUREN_SYSTEM.map((body) => body.id).sort(),
    );
  });

  it('activates only the star renderer while retaining explicit target archetypes', () => {
    expect(BODY_VISUALS.auren).toMatchObject({ renderer: 'star', targetArchetype: 'star' });

    for (const [bodyId, visual] of Object.entries(BODY_VISUALS)) {
      if (bodyId !== 'auren') expect(visual.renderer).toBe('legacy');
    }

    expect(BODY_VISUALS.veyra.targetArchetype).toBe('terrestrial');
    expect(BODY_VISUALS.palla.targetArchetype).toBe('airless');
    expect(BODY_VISUALS.tyran.targetArchetype).toBe('gas-giant');
  });

  it('assigns the remaining bounded body variants explicitly', () => {
    expect(Object.fromEntries(
      Object.entries(BODY_VISUALS).map(([id, visual]) => [id, visual.targetArchetype]),
    )).toEqual({
      auren: 'star',
      ashen: 'airless',
      vess: 'terrestrial',
      veyra: 'terrestrial',
      palla: 'airless',
      wisp: 'airless',
      rusk: 'terrestrial',
      tyran: 'gas-giant',
      brimm: 'airless',
      glacia: 'airless',
      mote: 'airless',
      farfall: 'airless',
    });
  });
});

describe('bodyMaterialDescriptor', () => {
  it('maps explicit visual identity and the authored terrain palette', () => {
    const star = bodyMaterialDescriptor(AUREN_SYSTEM.find((body) => body.id === 'auren')!);
    const gas = bodyMaterialDescriptor(AUREN_SYSTEM.find((body) => body.id === 'tyran')!);
    const solid = bodyMaterialDescriptor(AUREN_SYSTEM.find((body) => body.id === 'veyra')!);

    expect(star).toMatchObject({
      bodyId: 'auren',
      renderer: 'star',
      identity: 'star',
      orientationConvention: 'body-fixed-z-up-atan2-y-x',
    });
    expect(gas).toMatchObject({ bodyId: 'tyran', renderer: 'legacy', identity: 'gas' });
    expect(solid).toMatchObject({
      bodyId: 'veyra',
      renderer: 'legacy',
      identity: 'solid',
      albedo: {
        low: '#4a7c46',
        mid: '#8c8a5f',
        high: '#e8e6e1',
        ocean: '#1d4e6b',
      },
    });
  });

  it('uses the registry assignment rather than atmosphere or terrain amplitude', () => {
    const source = AUREN_SYSTEM.find((body) => body.id === 'palla')!;
    const altered = {
      ...source,
      surfaceKind: 'solid' as const,
      atmosphere: {
        seaLevelPressure: 1,
        scaleHeight: 1,
        height: 1,
        seaLevelDensity: 1,
        seaLevelTemperature: 1,
        hasOxygen: false,
      },
      terrain: { ...source.terrain, amplitude: 0 },
    };

    expect(bodyMaterialDescriptor(altered).renderer).toBe('legacy');
  });
});

describe('bodyFixedUv', () => {
  it.each([
    ['+X', { x: 1, y: 0, z: 0 }, { u: 0, v: 0.5 }],
    ['+Y', { x: 0, y: 1, z: 0 }, { u: 0.25, v: 0.5 }],
    ['-X', { x: -1, y: 0, z: 0 }, { u: 0.5, v: 0.5 }],
    ['-Y', { x: 0, y: -1, z: 0 }, { u: 0.75, v: 0.5 }],
    ['north', { x: 0, y: 0, z: 1 }, { u: 0, v: 1 }],
    ['south', { x: 0, y: 0, z: -1 }, { u: 0, v: 0 }],
  ])('maps the %s cardinal direction', (_name, direction, expected) => {
    expect(bodyFixedUv(direction)).toEqual(expected);
  });

  it('wraps once across the +X longitude seam', () => {
    const above = bodyFixedUv({ x: 1, y: 1e-9, z: 0 });
    const below = bodyFixedUv({ x: 1, y: -1e-9, z: 0 });

    expect(above.u).toBeGreaterThanOrEqual(0);
    expect(above.u).toBeLessThan(1e-8);
    expect(below.u).toBeGreaterThan(1 - 1e-8);
    expect(below.u).toBeLessThan(1);
  });
});
