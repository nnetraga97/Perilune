import * as THREE from 'three';
import type { Craft, PartInstance } from '../sim/vessel';
import { defOf } from '../sim/vessel';
import { deriveInterstageShroud, sanitizeInterstageShroudSpec } from '../sim/interstage';
import { interstageShroudGeometry } from './interstageShroud';
import { vesselPartGeometry } from './vesselMesh';

export interface AeroLabSurface {
  positions: Float32Array;
  normals: Float32Array;
  partKeys: Float32Array;
}

function partMatrix(part: PartInstance): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(part.position.x, part.position.y, part.position.z),
    new THREE.Quaternion(part.rotation.x, part.rotation.y, part.rotation.z, part.rotation.w),
    new THREE.Vector3(1, 1, 1),
  );
}

function appendGeometry(
  source: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
  partKey: number,
  positions: number[],
  normals: number[],
  partKeys: number[],
): void {
  const geometry = source.index ? source.toNonIndexed() : source.clone();
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
  const point = new THREE.Vector3();
  const direction = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    point.fromBufferAttribute(position, i).applyMatrix4(matrix);
    direction.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
    positions.push(point.x, point.y, point.z);
    normals.push(direction.x, direction.y, direction.z);
    partKeys.push(partKey);
  }
  geometry.dispose();
}

export function buildAeroLabSurface(craft: Craft): AeroLabSurface {
  const positions: number[] = [];
  const normals: number[] = [];
  const partKeys: number[] = [];
  for (const part of craft.parts) {
    const matrix = partMatrix(part);
    appendGeometry(vesselPartGeometry(defOf(part)), matrix, part.key, positions, normals, partKeys);
    const latched = sanitizeInterstageShroudSpec(part.interstageShroud);
    const shroud = (part.activated ? null : deriveInterstageShroud(craft, part)) ?? latched;
    if (shroud) {
      const geometry = interstageShroudGeometry(shroud);
      appendGeometry(geometry, matrix, part.key, positions, normals, partKeys);
      geometry.dispose();
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    partKeys: new Float32Array(partKeys),
  };
}

export function aeroLabFingerprint(craft: Craft): string {
  return craft.parts.map((part) => {
    const p = part.position;
    const q = part.rotation;
    const shroud = sanitizeInterstageShroudSpec(part.interstageShroud);
    return [
      part.key,
      part.defId,
      p.x,
      p.y,
      p.z,
      q.x,
      q.y,
      q.z,
      q.w,
      part.symmetry,
      part.activated ? 1 : 0,
      shroud ? `${shroud.lowerRadius}:${shroud.upperRadius}:${shroud.lowerY}:${shroud.upperY}` : '-',
    ].join(':');
  }).join('|');
}
