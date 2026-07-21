import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

describe('atmosphere shell seam geometry', () => {
  it.each([[96, 64], [144, 96], [192, 128]] as const)(
    'duplicates the longitude seam with identical positions and normals at %ix%i',
    (widthSegments, heightSegments) => {
      const geometry = new THREE.SphereGeometry(1, widthSegments, heightSegments);
      const position = geometry.getAttribute('position');
      const normal = geometry.getAttribute('normal');
      for (let row = 1; row < heightSegments; row++) {
        const first = row * (widthSegments + 1);
        const last = first + widthSegments;
        for (const attribute of [position, normal]) {
          expect(attribute.getX(first)).toBeCloseTo(attribute.getX(last), 6);
          expect(attribute.getY(first)).toBeCloseTo(attribute.getY(last), 6);
          expect(attribute.getZ(first)).toBeCloseTo(attribute.getZ(last), 6);
        }
      }
      geometry.dispose();
    },
  );
});
