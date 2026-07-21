import * as THREE from 'three';

export interface PhotosphereMaterial extends THREE.ShaderMaterial {
  readonly uniforms: {
    uTime: THREE.IUniform<number>;
    uOpacity: THREE.IUniform<number>;
    uColor: THREE.IUniform<THREE.Color>;
    uGranulationStrength: THREE.IUniform<number>;
    uActivityMap: THREE.IUniform<THREE.Texture>;
    uUseActivity: THREE.IUniform<number>;
    uActivityStrength: THREE.IUniform<number>;
    uOccluderCenter: THREE.IUniform<THREE.Vector2>;
    uOccluderRadius: THREE.IUniform<number>;
    uUseOccluder: THREE.IUniform<number>;
  };
}

export function createPhotosphereMaterial(
  color: THREE.ColorRepresentation,
  neutralActivity: THREE.Texture,
): PhotosphereMaterial {
  const material = new THREE.ShaderMaterial({
    name: 'sol-photosphere',
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 1 },
      uColor: { value: new THREE.Color(color) },
      uGranulationStrength: { value: 0.055 },
      uActivityMap: { value: neutralActivity },
      uUseActivity: { value: 0 },
      uActivityStrength: { value: 0.42 },
      uOccluderCenter: { value: new THREE.Vector2() },
      uOccluderRadius: { value: 0 },
      uUseOccluder: { value: 0 },
    },
    vertexShader: `
      #include <common>
      varying vec2 vDisk;
      #include <logdepthbuf_pars_vertex>
      void main() {
        vDisk = position.xy;
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewPosition;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec2 vDisk;
      uniform float uTime;
      uniform float uOpacity;
      uniform vec3 uColor;
      uniform float uGranulationStrength;
      uniform sampler2D uActivityMap;
      uniform float uUseActivity;
      uniform float uActivityStrength;
      uniform vec2 uOccluderCenter;
      uniform float uOccluderRadius;
      uniform float uUseOccluder;
      #include <logdepthbuf_pars_fragment>

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
        if (r2 > 1.0) discard;
        if (uUseOccluder > 0.5 && distance(vDisk, uOccluderCenter) <= uOccluderRadius) discard;
        float mu = sqrt(max(0.0, 1.0 - r2));
        // Four-term visual-light approximation: restrained center-to-limb falloff.
        float limb = 0.47 + 0.38 * mu + 0.15 * mu * mu;
        vec2 footprintFiltered = vDisk * 86.0;
        float footprint = max(length(dFdx(footprintFiltered)), length(dFdy(footprintFiltered)));
        float granulationFade = 1.0 - smoothstep(0.35, 1.4, footprint);
        float granulation = (valueNoise(footprintFiltered) - 0.5) * granulationFade;
        float broad = valueNoise(vDisk * 9.0 + vec2(17.0, 31.0)) - 0.5;
        vec2 activityUv = vec2(vDisk.x * 0.5 + 0.5, 0.5 - vDisk.y * 0.5);
        float activity = (texture2D(uActivityMap, activityUv).r * 255.0 - 128.0) / 112.0;
        float modulation = 1.0 + granulation * uGranulationStrength + broad * 0.012
          + activity * uActivityStrength * uUseActivity;
        gl_FragColor = vec4(uColor * limb * modulation, uOpacity);
        #include <logdepthbuf_fragment>
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
