import * as THREE from 'three';

export interface SolarGlareMaterial extends THREE.ShaderMaterial {
  readonly uniforms: {
    uIntensity: THREE.IUniform<number>;
    /** Glare quad radius in units of the solar disk radius. */
    uExtent: THREE.IUniform<number>;
    /** Projected solar disk radius in drawing-buffer pixels. */
    uDiskPixels: THREE.IUniform<number>;
  };
}

/**
 * Eye/camera veiling glare around the Sun. The scene has no bloom pass, so
 * an unresolved Sun would otherwise be a few bright pixels. The profile is
 * defined in screen pixels, so it reads the same at any field of view, and is
 * scaled by the visible solar fraction so eclipses and limb occultations dim
 * it together with the direct light.
 */
export function createSolarGlareMaterial(): SolarGlareMaterial {
  const material = new THREE.ShaderMaterial({
    name: 'sol-glare',
    uniforms: {
      uIntensity: { value: 1 },
      uExtent: { value: 1 },
      uDiskPixels: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vDisk;
      void main() {
        vDisk = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vDisk;
      uniform float uIntensity;
      uniform float uExtent;
      uniform float uDiskPixels;
      void main() {
        // Distance from the disk edge in pixels.
        float diskRadius = length(vDisk * uExtent);
        float pixels = max(diskRadius - 1.0, 0.0) * uDiskPixels;
        float core = exp(-pixels / 6.0);
        float halo = 1.0 / (1.0 + pixels * pixels / 1600.0);
        float veil = exp(-pixels / 140.0) * 0.14;
        float edge = 1.0 - smoothstep(0.6, 1.0, length(vDisk));
        // A resolved photosphere keeps its own limb darkening and granulation.
        float resolved = smoothstep(8.0, 20.0, uDiskPixels);
        float outside = mix(1.0, smoothstep(0.995, 1.01, diskRadius), resolved);
        float glare = (core * 0.9 + halo * 0.6 + veil) * edge * outside * uIntensity;
        if (glare < 0.002) discard;
        vec3 tint = mix(vec3(1.0, 0.86, 0.66), vec3(1.0, 0.97, 0.92), core);
        gl_FragColor = vec4(tint * glare, glare);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  }) as SolarGlareMaterial;
  material.userData.solarGlare = true;
  return material;
}
