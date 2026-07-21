import * as THREE from 'three';

export interface CoronaMaterial extends THREE.ShaderMaterial {
  readonly uniforms: {
    uOpacity: THREE.IUniform<number>;
    uVisibleSolarFraction: THREE.IUniform<number>;
    uOccluderCenter: THREE.IUniform<THREE.Vector2>;
    uOccluderRadius: THREE.IUniform<number>;
    uUseOccluder: THREE.IUniform<number>;
    uProjectedRadiusPixels: THREE.IUniform<number>;
  };
}

export function createCoronaMaterial(): CoronaMaterial {
  const material = new THREE.ShaderMaterial({
    name: 'sol-corona',
    uniforms: {
      uOpacity: { value: 0.2 },
      uVisibleSolarFraction: { value: 1 },
      uOccluderCenter: { value: new THREE.Vector2() },
      uOccluderRadius: { value: 0 },
      uUseOccluder: { value: 0 },
      uProjectedRadiusPixels: { value: 0 },
    },
    vertexShader: `
      varying vec2 vDisk;
      void main() {
        vDisk = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec2 vDisk;
      uniform float uOpacity;
      uniform float uVisibleSolarFraction;
      uniform vec2 uOccluderCenter;
      uniform float uOccluderRadius;
      uniform float uUseOccluder;
      uniform float uProjectedRadiusPixels;
      void main() {
        float radius = length(vDisk);
        if (radius < 1.0 || radius > 1.85) discard;
        if (uUseOccluder > 0.5 && distance(vDisk, uOccluderCenter) <= uOccluderRadius) discard;
        float halo = pow(max(0.0, 1.0 - (radius - 1.0) / 0.85), 3.5);
        float angle = atan(vDisk.y, vDisk.x);
        float anisotropy = 0.76 + 0.24 * pow(abs(cos(angle * 2.0 - 0.35)), 1.7);
        float resolved = smoothstep(1.5, 14.0, uProjectedRadiusPixels);
        float eclipseGain = mix(1.2, 0.55, smoothstep(0.0, 0.35, uVisibleSolarFraction));
        float alpha = halo * anisotropy * uOpacity * eclipseGain * resolved;
        gl_FragColor = vec4(vec3(1.0, 0.94, 0.78) * alpha, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    toneMapped: true,
  }) as CoronaMaterial;
  material.userData.solarCorona = true;
  return material;
}
