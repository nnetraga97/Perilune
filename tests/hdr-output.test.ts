import { expect, it } from 'vitest';
import * as THREE from 'three';
import { HdrOutput } from '../src/render/hdrOutput';

it('counts the scene and output pass together and bounds quality allocations', () => {
  const hdr = new HdrOutput(4);
  const info = { autoReset: true, render: { calls: 99, triangles: 99 }, reset() { this.render.calls = this.render.triangles = 0; } };
  let target: THREE.WebGLRenderTarget | null = null;
  const allocations: number[][] = [];
  const scene = new THREE.Scene();
  const renderer = {
    info,
    getDrawingBufferSize: (size: THREE.Vector2) => size.set(3840, 2160),
    getRenderTarget: () => target,
    setRenderTarget: (next: THREE.WebGLRenderTarget | null) => { target = next; },
    render: (next: THREE.Scene) => {
      if (info.autoReset) info.reset();
      info.render.calls += next === scene ? 12 : 1;
      info.render.triangles += next === scene ? 500 : 2;
      if (target) allocations.push([target.width, target.height, target.samples]);
    },
  } as unknown as THREE.WebGLRenderer;
  hdr.render(renderer, scene, new THREE.Camera());
  expect(info.render).toEqual({ calls: 13, triangles: 502 });
  expect(info.autoReset).toBe(true);
  expect(target).toBeNull();
  hdr.setQuality('low');
  hdr.render(renderer, scene, new THREE.Camera());
  expect(info.render).toEqual({ calls: 13, triangles: 502 });
  expect(allocations).toEqual([[2560, 1440, 4], [1280, 720, 0]]);
  hdr.dispose();
});
