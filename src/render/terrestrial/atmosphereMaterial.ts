import * as THREE from 'three';
import type { RenderCaps } from '../context';
import type { AtmosphereDef } from '../../sim/universe';

export interface AtmosphereVisualCoefficients {
  readonly wavelengthTint: readonly [number, number, number];
  readonly strength: number;
}

export interface AtmosphereMaterialBundle {
  readonly material: THREE.ShaderMaterial;
  readonly lookupTexture: THREE.DataTexture | null;
}

function opticalDepthLookup(): THREE.DataTexture {
  const width = 64;
  const height = 32;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const limb = y / (height - 1);
    for (let x = 0; x < width; x++) {
      const altitude = x / (width - 1);
      const density = Math.exp(-altitude * 7.5);
      data[y * width + x] = Math.round(Math.min(1, density * (0.18 + Math.pow(limb, 1.7))) * 255);
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RedFormat);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

export function createAtmosphereMaterial(
  path: RenderCaps['atmospherePath'],
  radius: number,
  physical: Readonly<AtmosphereDef>,
  visual: Readonly<AtmosphereVisualCoefficients>,
): AtmosphereMaterialBundle {
  const lookupTexture = path === 'lookup' ? opticalDepthLookup() : null;
  const material = new THREE.ShaderMaterial({
    defines: {
      ATMOSPHERE_ANALYTIC: path === 'analytic' ? 1 : 0,
      ATMOSPHERE_LOOKUP: path === 'lookup' ? 1 : 0,
      ATMOSPHERE_LIMB_HAZE: path === 'limb-haze' ? 1 : 0,
    },
    uniforms: {
      uBodyRadius: { value: radius },
      uAtmosphereHeight: { value: physical.height },
      uSeaLevelPressure: { value: physical.seaLevelPressure },
      uSeaLevelDensity: { value: physical.seaLevelDensity },
      uScaleHeight: { value: physical.scaleHeight },
      uWavelengthTint: { value: new THREE.Vector3(...visual.wavelengthTint) },
      uVisualStrength: { value: visual.strength },
      uCameraBodyFixed: { value: new THREE.Vector3(radius + physical.height * 2, 0, 0) },
      uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
      uInsideAtmosphere: { value: 0 },
      uAerialPerspective: { value: 0 },
      uOpticalDepthLut: { value: lookupTexture },
    },
    vertexShader: /* glsl */ `
      varying vec3 vBodyNormal;
      varying vec3 vViewNormal;
      varying vec3 vViewDirection;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vBodyNormal = normalize(position);
        vViewNormal = normalize(normalMatrix * normal);
        vViewDirection = normalize(-viewPosition.xyz);
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uBodyRadius;
      uniform float uAtmosphereHeight;
      uniform float uSeaLevelPressure;
      uniform float uSeaLevelDensity;
      uniform float uScaleHeight;
      uniform vec3 uWavelengthTint;
      uniform float uVisualStrength;
      uniform vec3 uCameraBodyFixed;
      uniform vec3 uSunDirection;
      uniform float uInsideAtmosphere;
      uniform float uAerialPerspective;
      uniform sampler2D uOpticalDepthLut;
      varying vec3 vBodyNormal;
      varying vec3 vViewNormal;
      varying vec3 vViewDirection;

      void main() {
        float limb = clamp(1.0 - dot(normalize(vViewNormal), normalize(vViewDirection)), 0.0, 1.0);
        float cameraAltitude = max(0.0, length(uCameraBodyFixed) - uBodyRadius);
        float heightFraction = clamp(cameraAltitude / max(uAtmosphereHeight, 1.0), 0.0, 1.0);
        float opticalDepth = 0.0;
        #if ATMOSPHERE_ANALYTIC == 1
          for (int sampleIndex = 0; sampleIndex < 8; sampleIndex++) {
            float t = (float(sampleIndex) + 0.5) / 8.0;
            float sampleAltitude = mix(cameraAltitude, uAtmosphereHeight, t);
            opticalDepth += exp(-sampleAltitude / max(uScaleHeight, 1.0));
          }
          opticalDepth = opticalDepth / 8.0 * (0.2 + pow(limb, 1.65));
        #elif ATMOSPHERE_LOOKUP == 1
          opticalDepth = texture2D(uOpticalDepthLut, vec2(heightFraction, limb)).r;
        #else
          opticalDepth = pow(limb, 2.1) * mix(0.72, 0.36, heightFraction);
        #endif
        float sunPhase = 0.28 + 0.72 * max(0.0, dot(normalize(vBodyNormal), normalize(uSunDirection)));
        float physicalScale = clamp(uSeaLevelPressure / 101325.0, 0.05, 8.0) *
          clamp(uSeaLevelDensity / 1.225, 0.05, 8.0);
        float alpha = clamp(opticalDepth * sqrt(physicalScale) * uVisualStrength +
          uAerialPerspective * 0.16, 0.0, mix(0.82, 0.56, uInsideAtmosphere));
        gl_FragColor = vec4(uWavelengthTint * (0.38 + sunPhase * 0.82), alpha);
      }
    `,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: true,
  });
  material.name = `terrestrial-atmosphere:${path}`;
  material.userData.atmospherePath = path;
  return { material, lookupTexture };
}
