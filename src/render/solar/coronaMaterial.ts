import * as THREE from 'three';

export interface CoronaMaterial extends THREE.ShaderMaterial {
  readonly uniforms: {
    uOpacity: THREE.IUniform<number>;
    uVisibleSolarFraction: THREE.IUniform<number>;
  };
}

export function createCoronaMaterial(): CoronaMaterial {
  const material = new THREE.ShaderMaterial({
    name: 'sol-corona',
    uniforms: {
      uOpacity: { value: 0.2 },
      uVisibleSolarFraction: { value: 1 },
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
      void main() {
        float radius = length(vDisk);
        if (radius < 0.54 || radius > 1.0) discard;
        float halo = pow(max(0.0, 1.0 - (radius - 0.54) / 0.46), 3.5);
        float alpha = halo * uOpacity * smoothstep(0.0, 0.12, uVisibleSolarFraction);
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
