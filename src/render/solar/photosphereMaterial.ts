import * as THREE from 'three';

export interface PhotosphereMaterial extends THREE.ShaderMaterial {
  readonly uniforms: {
    uTime: THREE.IUniform<number>;
    uOpacity: THREE.IUniform<number>;
    uColor: THREE.IUniform<THREE.Color>;
    uGranulationStrength: THREE.IUniform<number>;
    uSphereMode: THREE.IUniform<number>;
  };
}

export function createPhotosphereMaterial(color: THREE.ColorRepresentation): PhotosphereMaterial {
  const material = new THREE.ShaderMaterial({
    name: 'sol-photosphere',
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 1 },
      uColor: { value: new THREE.Color(color) },
      uGranulationStrength: { value: 0.055 },
      uSphereMode: { value: 0 },
    },
    vertexShader: `
      varying vec2 vDisk;
      varying vec3 vViewNormal;
      varying vec3 vViewPosition;
      void main() {
        vDisk = position.xy;
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vViewPosition = viewPosition.xyz;
        vViewNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec2 vDisk;
      varying vec3 vViewNormal;
      varying vec3 vViewPosition;
      uniform float uTime;
      uniform float uOpacity;
      uniform vec3 uColor;
      uniform float uGranulationStrength;
      uniform float uSphereMode;

      float hash21(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      float valueNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
                   mix(hash21(i + vec2(0.0, 1.0)), hash21(i + 1.0), f.x), f.y);
      }

      void main() {
        float r2 = dot(vDisk, vDisk);
        if (uSphereMode < 0.5 && r2 > 1.0) discard;
        float mu = uSphereMode > 0.5
          ? max(0.0, dot(normalize(vViewNormal), normalize(-vViewPosition)))
          : sqrt(max(0.0, 1.0 - r2));
        // Four-term visual-light approximation: restrained center-to-limb falloff.
        float limb = 0.47 + 0.38 * mu + 0.15 * mu * mu;
        vec2 footprintFiltered = (uSphereMode > 0.5 ? vViewNormal.xy : vDisk) * 86.0;
        float granulation = valueNoise(footprintFiltered + vec2(uTime * 0.002, 0.0)) - 0.5;
        float broad = valueNoise(vDisk * 9.0 + vec2(17.0, 31.0)) - 0.5;
        float modulation = 1.0 + granulation * uGranulationStrength + broad * 0.025;
        gl_FragColor = vec4(uColor * limb * modulation, uOpacity);
      }
    `,
    transparent: true,
    depthWrite: true,
    depthTest: true,
    toneMapped: true,
  }) as PhotosphereMaterial;
  material.userData.solarPhotosphere = true;
  return material;
}
