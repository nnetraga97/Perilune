import * as THREE from 'three';
import type { QualityTier } from '../bodyRenderer';

const GLITTER_BY_QUALITY: Readonly<Record<QualityTier, number>> = Object.freeze({
  low: 0.16,
  medium: 0.56,
  high: 0.9,
});

export function createOceanMaterial(
  quality: QualityTier,
  shoreMask: THREE.Texture | null,
  oceanColor: THREE.ColorRepresentation,
  bodyRadius: number,
): THREE.ShaderMaterial {
  if (shoreMask) {
    shoreMask.colorSpace = THREE.NoColorSpace;
    shoreMask.wrapS = THREE.RepeatWrapping;
    shoreMask.wrapT = THREE.ClampToEdgeWrapping;
  }
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uShoreMask: { value: shoreMask },
      uHasShoreMask: { value: shoreMask ? 1 : 0 },
      uOceanColor: { value: new THREE.Color(oceanColor) },
      uBodyRadius: { value: bodyRadius },
      uCameraBodyFixed: { value: new THREE.Vector3() },
      uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
      uGlitterStrength: { value: GLITTER_BY_QUALITY[quality] },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vBodyDirection;
      varying vec3 vViewNormal;
      varying vec3 vViewDirection;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vBodyDirection = normalize(position);
        vViewNormal = normalize(normalMatrix * normal);
        vViewDirection = normalize(-viewPosition.xyz);
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uShoreMask;
      uniform float uHasShoreMask;
      uniform vec3 uOceanColor;
      uniform float uBodyRadius;
      uniform vec3 uCameraBodyFixed;
      uniform vec3 uSunDirection;
      uniform float uGlitterStrength;
      uniform float uTime;
      varying vec3 vBodyDirection;
      varying vec3 vViewNormal;
      varying vec3 vViewDirection;

      vec2 bodyUv(vec3 direction) {
        float longitude = atan(direction.y, direction.x) / 6.283185307179586;
        return vec2(longitude < 0.0 ? longitude + 1.0 : longitude,
          0.5 - asin(clamp(direction.z, -1.0, 1.0)) / 3.141592653589793);
      }

      void main() {
        float oceanMask = uHasShoreMask > 0.5 ? texture2D(uShoreMask, bodyUv(vBodyDirection)).a : 1.0;
        if (uHasShoreMask > 0.5 && oceanMask <= 0.01) discard;
        float shore = 1.0 - abs(oceanMask * 2.0 - 1.0);
        float fresnel = pow(1.0 - max(0.0, dot(normalize(vViewNormal), normalize(vViewDirection))), 4.0);
        vec3 reflectedSun = reflect(-normalize(uSunDirection), normalize(vBodyDirection));
        vec3 bodyView = normalize(uCameraBodyFixed - vBodyDirection * uBodyRadius);
        float wave = sin(vBodyDirection.x * 170.0 + uTime * 0.7) *
          sin(vBodyDirection.y * 143.0 - uTime * 0.53);
        float glitter = pow(max(0.0, dot(reflectedSun, bodyView)), 96.0) *
          (0.55 + 0.45 * wave) * uGlitterStrength;
        vec3 depthTint = mix(uOceanColor * 0.48, uOceanColor * 1.18, fresnel);
        vec3 foam = vec3(0.72, 0.82, 0.84) * shore;
        gl_FragColor = vec4(depthTint + foam * 0.72 + glitter, clamp(0.72 + fresnel * 0.24, 0.0, 0.98));
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  material.name = `terrestrial-ocean:${quality}`;
  material.userData.quality = quality;
  material.userData.shoreMaskFallback = shoreMask === null;
  return material;
}
