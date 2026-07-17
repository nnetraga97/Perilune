import { describe, expect, it } from 'vitest';
import { buildReentryGeometry, craftReentryFingerprint } from '../src/render/reentryGeometry';
import { addPart, createCraft } from '../src/sim/vessel';
import { createWayfarerDemonstrator } from '../src/content/crafts';
import { buildAeroModel } from '../src/sim/aero';

describe('reentry envelope geometry', () => {
  it('builds bounded merged envelope and two-layer fin geometry', () => {
    const craft = createCraft('Entry test');
    addPart(craft, 'pod-voyager', null, 'root', { x: 0, y: 0, z: 0 });
    addPart(craft, 'tank-s1', 1, 'stack-bottom', { x: 0, y: -1, z: 0 });
    const geometry = buildReentryGeometry(craft, new Map([[1, 1], [2, 0]]), 'low');
    expect(geometry.envelopeTriangles).toBeGreaterThan(0);
    expect(geometry.finSources).toBeGreaterThan(0);
    expect(geometry.finSources).toBeLessThanOrEqual(1_200);
    expect(geometry.fins.getAttribute('aLayer').count).toBe(geometry.finSources * 12);
    expect(geometry.fins.getAttribute('aTrailT').count).toBe(geometry.finSources * 12);
    expect(geometry.bytes).toBeGreaterThan(0);
    geometry.envelope.dispose();
    geometry.fins.dispose();
  });

  it('fingerprints activation and latched shroud changes', () => {
    const craft = createCraft('Fingerprint');
    const part = addPart(craft, 'dec-interstage-ms', null, 'root', { x: 0, y: 0, z: 0 });
    const before = craftReentryFingerprint(craft);
    part.activated = true;
    expect(craftReentryFingerprint(craft)).not.toBe(before);
    const activated = craftReentryFingerprint(craft);
    part.interstageShroud = { lowerRadius: 1, upperRadius: 0.6, lowerY: -1, upperY: 1 };
    expect(craftReentryFingerprint(craft)).not.toBe(activated);
  });

  it('includes the live interstage shell in the merged occluder envelope', () => {
    const withShroud = createWayfarerDemonstrator();
    const withGeometry = buildReentryGeometry(withShroud, buildAeroModel(withShroud).axialFrac, 'medium');
    const withoutShroud = createWayfarerDemonstrator();
    withoutShroud.parts.find((part) => part.defId === 'dec-interstage-ms')!.activated = true;
    const withoutGeometry = buildReentryGeometry(withoutShroud, buildAeroModel(withoutShroud).axialFrac, 'medium');
    expect(withGeometry.envelopeTriangles - withoutGeometry.envelopeTriangles).toBe(1_152);
    withGeometry.envelope.dispose();
    withGeometry.fins.dispose();
    withoutGeometry.envelope.dispose();
    withoutGeometry.fins.dispose();
  });
});
