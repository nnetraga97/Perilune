import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { makeStarfield } from '../src/render/starfield';

function values(attribute: THREE.BufferAttribute): number[] {
  return Array.from(attribute.array as ArrayLike<number>);
}

describe('procedural space starfield', () => {
  it('is deterministic for a seed while distinct seeds produce distinct fields', () => {
    const first = makeStarfield(512, 77);
    const second = makeStarfield(512, 77);
    const different = makeStarfield(512, 78);

    expect(values(first.geometry.getAttribute('position') as THREE.BufferAttribute))
      .toEqual(values(second.geometry.getAttribute('position') as THREE.BufferAttribute));
    expect(values(first.geometry.getAttribute('color') as THREE.BufferAttribute))
      .toEqual(values(second.geometry.getAttribute('color') as THREE.BufferAttribute));
    expect(values(first.geometry.getAttribute('pointSize') as THREE.BufferAttribute))
      .toEqual(values(second.geometry.getAttribute('pointSize') as THREE.BufferAttribute));
    expect(values(first.geometry.getAttribute('position') as THREE.BufferAttribute))
      .not.toEqual(values(different.geometry.getAttribute('position') as THREE.BufferAttribute));
  });

  it('keeps finite stars on one far sphere with mostly faint, bounded point sizes', () => {
    const count = 4000;
    const starfield = makeStarfield(count);
    const position = starfield.geometry.getAttribute('position') as THREE.BufferAttribute;
    const pointSize = starfield.geometry.getAttribute('pointSize') as THREE.BufferAttribute;
    const color = starfield.geometry.getAttribute('color') as THREE.BufferAttribute;

    expect(position.count).toBe(count);
    expect(pointSize.count).toBe(count);
    expect(color.count).toBe(count);

    const sizes = values(pointSize);
    expect(sizes.every(Number.isFinite)).toBe(true);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(0.72);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(2.2);
    expect(sizes.filter((size) => size <= 1.1).length / count).toBeGreaterThan(0.85);
    const brightFraction = sizes.filter((size) => size >= 1.65).length / count;
    expect(brightFraction).toBeGreaterThan(0.005);
    expect(brightFraction).toBeLessThan(0.025);

    for (let i = 0; i < count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)).toBe(true);
      // Positions are stored as f32 at a 500 Mm radius.
      expect(Math.abs(Math.hypot(x, y, z) - 5e8)).toBeLessThan(32);
    }
    expect(values(color).every((component) => Number.isFinite(component)
      && component >= 0 && component <= 1)).toBe(true);
  });

  it('adds a restrained density bias around its fixed tilted plane', () => {
    const position = makeStarfield(4000).geometry.getAttribute('position') as THREE.BufferAttribute;
    const tiltX = 0.49;
    const tiltZ = -0.31;
    const normal = new THREE.Vector3(
      -Math.cos(tiltX) * Math.sin(tiltZ),
      Math.cos(tiltX) * Math.cos(tiltZ),
      Math.sin(tiltX),
    );
    const direction = new THREE.Vector3();
    let nearPlane = 0;
    for (let i = 0; i < position.count; i++) {
      direction.set(position.getX(i), position.getY(i), position.getZ(i)).normalize();
      if (Math.abs(direction.dot(normal)) < Math.sin(0.08)) nearPlane++;
    }
    const fraction = nearPlane / position.count;
    expect(fraction).toBeGreaterThan(0.15);
    expect(fraction).toBeLessThan(0.25);
  });

  it('uses one texture-free points material with a round soft falloff', () => {
    const starfield = makeStarfield(32);
    expect(starfield).toBeInstanceOf(THREE.Points);
    expect(Array.isArray(starfield.material)).toBe(false);
    expect(starfield.material).toBeInstanceOf(THREE.ShaderMaterial);
    const material = starfield.material as THREE.ShaderMaterial;
    expect(material.uniforms).not.toHaveProperty('map');
    expect(material.vertexShader).toContain('attribute float pointSize');
    expect(material.vertexShader).toContain('mat3(modelViewMatrix)');
    expect(material.vertexShader).toContain('clipPosition.xyww');
    expect(material.fragmentShader).toContain('gl_PointCoord');
    expect(material.fragmentShader).toContain('smoothstep');
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
  });
});
