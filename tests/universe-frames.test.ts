import { describe, expect, it } from 'vitest';
import { Vec3 } from '../src/core/vec3';
import { Universe } from '../src/sim/universe';
import { AUREN_SYSTEM } from '../src/content/system';

const universe = new Universe([...AUREN_SYSTEM]);
const T = 12_345.678;

describe('Universe frame math', () => {
  it('places a body at the origin of its own frame', () => {
    for (const body of universe.bodies.values()) {
      const out = new Vec3();
      universe.relativePosition(body, body, T, out);
      expect(out.length()).toBeLessThan(1e-6);
    }
  });

  it('reduces a child relative to its parent to the child local position', () => {
    for (const body of universe.bodies.values()) {
      if (!body.parent) continue;
      const local = new Vec3();
      universe.localPosition(body, T, local);
      const relative = new Vec3();
      universe.relativePosition(body, body.parent, T, relative);
      expect(relative.x).toBeCloseTo(local.x, 3);
      expect(relative.y).toBeCloseTo(local.y, 3);
      expect(relative.z).toBeCloseTo(local.z, 3);
    }
  });

  it('keeps absolute positions consistent with relative positions', () => {
    const anchor = universe.get('veyra');
    const anchorAbsolute = new Vec3();
    universe.absolutePosition(anchor, T, anchorAbsolute);
    for (const body of universe.bodies.values()) {
      const absolute = new Vec3();
      universe.absolutePosition(body, T, absolute);
      const expected = absolute.clone().sub(anchorAbsolute);
      const relative = new Vec3();
      universe.relativePosition(body, anchor, T, relative);
      expect(relative.x).toBeCloseTo(expected.x, 3);
      expect(relative.y).toBeCloseTo(expected.y, 3);
      expect(relative.z).toBeCloseTo(expected.z, 3);
    }
  });

  it('is antisymmetric', () => {
    const a = universe.get('palla');
    const b = universe.get('rusk');
    const ab = new Vec3();
    const ba = new Vec3();
    universe.relativePosition(a, b, T, ab);
    universe.relativePosition(b, a, T, ba);
    expect(ab.x).toBeCloseTo(-ba.x, 3);
    expect(ab.y).toBeCloseTo(-ba.y, 3);
    expect(ab.z).toBeCloseTo(-ba.z, 3);
  });

  it('reports relative velocity consistent with absolute velocities', () => {
    const anchor = universe.get('veyra');
    const anchorVelocity = new Vec3();
    universe.absolutePosition(anchor, T, new Vec3(), anchorVelocity);
    const body = universe.get('wisp');
    const bodyVelocity = new Vec3();
    universe.absolutePosition(body, T, new Vec3(), bodyVelocity);
    const expected = bodyVelocity.clone().sub(anchorVelocity);
    const relative = new Vec3();
    universe.relativePosition(body, anchor, T, new Vec3(), relative);
    expect(relative.x).toBeCloseTo(expected.x, 6);
    expect(relative.y).toBeCloseTo(expected.y, 6);
    expect(relative.z).toBeCloseTo(expected.z, 6);
  });
});
