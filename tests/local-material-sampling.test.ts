import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SOL_SYSTEM } from '../src/content/system';
import { Body } from '../src/sim/universe';
import { bodyMaterialDescriptor } from '../src/render/bodyMaterial';
import type { RuntimeBodyAssetPack } from '../src/render/bodyRenderer';
import { createTerrestrialSurfaceMaterial } from '../src/render/terrestrial/surfaceMaterial';
import { createAirlessSurfaceMaterial } from '../src/render/airless/surfaceMaterial';

function texture(): THREE.DataTexture {
  const value = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, THREE.RGBAFormat);
  value.needsUpdate = true;
  return value;
}

function pack(bodyId: 'earth' | 'moon'): RuntimeBodyAssetPack {
  return {
    bodyId, tier: 'medium', width: 2048, height: 1024, manifestDigest: 'a'.repeat(64), gpuBytes: 1,
    textures: new Map([
      ['albedo', texture()], ['normal', texture()], ['material', texture()],
      ['heightMacro', texture()], ['localDetail', texture()],
      ...(bodyId === 'earth' ? [['clouds', texture()] as [string, THREE.Texture]] : []),
    ]),
  };
}

function body(bodyId: 'earth' | 'moon'): Body {
  return new Body(structuredClone(SOL_SYSTEM.find((definition) => definition.id === bodyId)!), null);
}

describe('sourced local material sampling', () => {
  it('uses a dominant-class Earth atlas with bounded albedo and footprint fade', () => {
    const earth = body('earth');
    const authored = pack('earth');
    const material = createTerrestrialSurfaceMaterial(authored, bodyMaterialDescriptor(earth), 'medium', 8);
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>',
    };
    material.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
    expect(shader.uniforms.localDetailMap.value).toBe(authored.textures.get('localDetail'));
    expect(shader.fragmentShader).toContain('sampleLocalDetailTriplanar');
    expect(shader.fragmentShader).toContain('surfLocalFade');
    expect(shader.fragmentShader).toContain('surfLocalDetail.r), surfLocalFade * 0.5');
    expect(shader.fragmentShader).toContain('textureGrad(localDetailMap');
    expect(shader.fragmentShader).toContain('surfLocalFade * 0.12');
    // One dominant atlas cell with three packed material projections and
    // three oriented-normal projections: six bounded fetches rather than a
    // class-by-axis explosion (plus the helper declaration).
    expect(shader.fragmentShader.match(/sampleLocalDetailCell\(/g)?.length).toBe(7);
    material.dispose();
  });

  it('uses the pinned lunar regolith atlas without displacement authority', () => {
    const moon = body('moon');
    const authored = pack('moon');
    const material = createAirlessSurfaceMaterial(authored, bodyMaterialDescriptor(moon), 'medium', 8);
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>',
      fragmentShader: '#include <common>\n#include <map_fragment>\n#include <roughnessmap_fragment>\n#include <normal_fragment_maps>',
    };
    material.onBeforeCompile(shader as never, {} as THREE.WebGLRenderer);
    expect(shader.uniforms.airlessLocalDetailMap.value).toBe(authored.textures.get('localDetail'));
    expect(shader.fragmentShader).toContain('sampleAirlessLocalTriplanar');
    expect(shader.fragmentShader).toContain('airlessLocalFade');
    expect(shader.vertexShader).not.toContain('airlessLocalDetailMap');
    material.dispose();
  });
});
