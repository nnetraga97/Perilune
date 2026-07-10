/**
 * Cloud layer (M1 medium quality): a procedurally textured translucent
 * shell above the surface, self-generated from fBm noise — no external
 * assets. Slow drift animation; fades out near the layer to avoid a hard
 * "ceiling" when flying through.
 */
import * as THREE from 'three';
import { fbm3 } from '../core/noise';
import type { Body } from '../sim/universe';

export function makeCloudTexture(seed: number, size = 512): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size / 2;
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    const lat = (y / canvas.height - 0.5) * Math.PI;
    for (let x = 0; x < canvas.width; x++) {
      const lon = (x / canvas.width) * Math.PI * 2;
      const cx = Math.cos(lat) * Math.cos(lon);
      const cy = Math.cos(lat) * Math.sin(lon);
      const cz = Math.sin(lat);
      let n = fbm3(cx * 3.2, cy * 3.2, cz * 3.2, seed, 5);
      // Band structure + threshold for broken cloud fields.
      n += Math.sin(lat * 5 + n * 3) * 0.12;
      const a = Math.max(0, Math.min(1, (n - 0.06) * 2.6));
      const idx = (y * canvas.width + x) * 4;
      img.data[idx] = 255;
      img.data[idx + 1] = 255;
      img.data[idx + 2] = 255;
      img.data[idx + 3] = Math.round(a * 210);
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class CloudLayer {
  readonly mesh: THREE.Mesh;
  private material: THREE.MeshLambertMaterial;
  readonly altitude: number;

  constructor(body: Body) {
    this.altitude = (body.def.atmosphere?.height ?? 60_000) * 0.16;
    const radius = body.radius + this.altitude;
    this.material = new THREE.MeshLambertMaterial({
      map: makeCloudTexture(body.def.terrain.seed + 501),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      opacity: 0.92,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 72, 48), this.material);
    this.mesh.scale.setScalar(radius);
    this.mesh.renderOrder = 2;
  }

  /**
   * @param originWorld body center in camera-relative coordinates
   * @param spin body rotation (clouds drift slightly faster than the ground)
   * @param cameraAltitude camera altitude above surface (m)
   */
  update(originWorld: { x: number; y: number; z: number }, spin: number, time: number, cameraAltitude: number): void {
    this.mesh.position.set(originWorld.x, originWorld.y, originWorld.z);
    this.mesh.rotation.set(Math.PI / 2, 0, spin + time * 1.2e-5, 'ZXY');
    // Fade when the camera is close to / inside the layer.
    const d = Math.abs(cameraAltitude - this.altitude);
    const fade = Math.max(0, Math.min(1, (d - 800) / 2500));
    this.material.opacity = 0.92 * fade;
    this.mesh.visible = this.material.opacity > 0.02;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.map?.dispose();
    this.material.dispose();
  }
}
