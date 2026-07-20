import * as THREE from 'three';
import type { RenderCaps } from '../context';
import type { QualityTier } from '../bodyRenderer';
import type { AtmosphereDef } from '../../sim/universe';
import { atmosphereScatteringCoefficients, createAtmosphereLuts } from './atmosphereLuts';

export interface AtmosphereVisualCoefficients {
  readonly wavelengthTint: readonly [number, number, number];
  readonly strength: number;
}

export interface AtmosphereMaterialBundle {
  readonly material: THREE.ShaderMaterial;
  readonly lookupTextures: readonly THREE.DataTexture[];
}

export function createAtmosphereMaterial(
  path: RenderCaps['atmospherePath'],
  radius: number,
  physical: Readonly<AtmosphereDef>,
  visual: Readonly<AtmosphereVisualCoefficients>,
  quality: QualityTier = 'medium',
): AtmosphereMaterialBundle {
  const luts = createAtmosphereLuts(radius, physical, visual);
  const scattering = atmosphereScatteringCoefficients(physical, visual);
  const viewSamples = path === 'analytic'
    ? quality === 'high' ? 16 : quality === 'medium' ? 8 : 6
    : path === 'lookup'
      ? quality === 'high' ? 10 : quality === 'medium' ? 6 : 4
      : quality === 'high' ? 6 : quality === 'medium' ? 5 : 4;
  const material = new THREE.ShaderMaterial({
    defines: {
      ATMOSPHERE_ANALYTIC: path === 'analytic' ? 1 : 0,
      ATMOSPHERE_LOOKUP: path === 'lookup' ? 1 : 0,
      ATMOSPHERE_LIMB_HAZE: path === 'limb-haze' ? 1 : 0,
      ATMOSPHERE_LUT_SCATTERING: 1,
      ATMOSPHERE_VIEW_SAMPLES: viewSamples,
    },
    uniforms: {
      uBodyRadius: { value: radius },
      uAtmosphereRadius: { value: radius + physical.height },
      uAtmosphereHeight: { value: physical.height },
      uSeaLevelPressure: { value: physical.seaLevelPressure },
      uSeaLevelDensity: { value: physical.seaLevelDensity },
      uScaleHeight: { value: physical.scaleHeight },
      uMieScaleHeight: { value: scattering.mieScaleHeight },
      uRayleighScattering: { value: new THREE.Vector3(...scattering.rayleigh) },
      // Veyra is much smaller than Earth, so its tangent path over-amplifies
      // white Mie in-scattering. Retain Mie extinction but let Rayleigh own the limb color.
      uMieScattering: { value: scattering.mie * 0.35 },
      uMieExtinction: { value: scattering.mie * 1.1 },
      uWavelengthTint: { value: new THREE.Vector3(...visual.wavelengthTint) },
      uVisualStrength: { value: visual.strength },
      uCameraBodyFixed: { value: new THREE.Vector3(radius + physical.height * 2, 0, 0) },
      uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
      uInsideAtmosphere: { value: 0 },
      uSolarVisibility: { value: 1 },
      uPresentationVisibility: { value: 1 },
      uTransmittanceLut: { value: luts.transmittance },
      uMultipleScatteringLut: { value: luts.multipleScattering },
      uSkyViewLut: { value: luts.skyView },
      uAerialPerspectiveLut: { value: luts.aerialPerspective },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vBodyNormal;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vBodyNormal = normalize(position);
        gl_Position = projectionMatrix * viewPosition;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uBodyRadius;
      uniform float uAtmosphereRadius;
      uniform float uAtmosphereHeight;
      uniform float uSeaLevelPressure;
      uniform float uSeaLevelDensity;
      uniform float uScaleHeight;
      uniform float uMieScaleHeight;
      uniform vec3 uRayleighScattering;
      uniform float uMieScattering;
      uniform float uMieExtinction;
      uniform vec3 uWavelengthTint;
      uniform float uVisualStrength;
      uniform vec3 uCameraBodyFixed;
      uniform vec3 uSunDirection;
      uniform float uInsideAtmosphere;
      uniform float uSolarVisibility;
      uniform float uPresentationVisibility;
      uniform sampler2D uTransmittanceLut;
      uniform sampler2D uMultipleScatteringLut;
      uniform sampler2D uSkyViewLut;
      uniform sampler2D uAerialPerspectiveLut;
      varying vec3 vBodyNormal;

      vec2 atmosphereRaySphere(vec3 origin, vec3 direction, float radius) {
        float b = dot(origin, direction);
        float c = dot(origin, origin) - radius * radius;
        float discriminant = b * b - c;
        if (discriminant < 0.0) return vec2(1.0, -1.0);
        float root = sqrt(discriminant);
        return vec2(-b - root, -b + root);
      }

      vec2 atmosphereLutUv(float altitude, float zenithCosine) {
        float heightUnit = sqrt(clamp(altitude / max(uAtmosphereHeight, 1.0), 0.0, 1.0));
        return vec2(heightUnit, zenithCosine * 0.5 + 0.5);
      }

      float rayleighPhase(float cosineTheta) {
        return 0.0596831 * (1.0 + cosineTheta * cosineTheta);
      }

      float miePhase(float cosineTheta) {
        const float g = 0.8;
        float g2 = g * g;
        return 0.1193662 * (1.0 - g2) * (1.0 + cosineTheta * cosineTheta) /
          ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * cosineTheta, 0.001), 1.5));
      }

      void main() {
        #include <logdepthbuf_fragment>
        vec3 shellPoint = normalize(vBodyNormal) * uAtmosphereRadius;
        vec3 rayDirection = normalize(shellPoint - uCameraBodyFixed);
        vec2 atmosphereHit = atmosphereRaySphere(uCameraBodyFixed, rayDirection, uAtmosphereRadius);
        float rayStart = max(0.0, atmosphereHit.x);
        float rayEnd = atmosphereHit.y;
        vec2 groundHit = atmosphereRaySphere(uCameraBodyFixed, rayDirection, uBodyRadius);
        if (groundHit.x > rayStart && groundHit.x < rayEnd) rayEnd = groundHit.x;
        if (rayEnd <= rayStart) discard;

        float stepLength = (rayEnd - rayStart) / float(ATMOSPHERE_VIEW_SAMPLES);
        vec3 viewTransmittance = vec3(1.0);
        vec3 radiance = vec3(0.0);
        float scatteringCosine = dot(rayDirection, normalize(uSunDirection));
        float phaseRayleigh = rayleighPhase(scatteringCosine);
        float phaseMie = miePhase(scatteringCosine);
        for (int sampleIndex = 0; sampleIndex < ATMOSPHERE_VIEW_SAMPLES; sampleIndex++) {
          float distance = rayStart + (float(sampleIndex) + 0.5) * stepLength;
          vec3 samplePosition = uCameraBodyFixed + rayDirection * distance;
          float sampleRadius = length(samplePosition);
          float altitude = max(0.0, sampleRadius - uBodyRadius);
          vec3 sampleUp = samplePosition / max(sampleRadius, 1.0);
          float sunZenith = dot(sampleUp, normalize(uSunDirection));
          vec2 lutUv = atmosphereLutUv(altitude, sunZenith);
          vec3 sunTransmittance = texture2D(uTransmittanceLut, lutUv).rgb;
          vec3 multipleScattering = texture2D(uMultipleScatteringLut, lutUv).rgb;
          float rayleighDensity = exp(-altitude / max(uScaleHeight, 1.0));
          float mieDensity = exp(-altitude / max(uMieScaleHeight, 1.0));
          vec3 extinction = uRayleighScattering * rayleighDensity + vec3(uMieExtinction * mieDensity);
          vec3 singleScattering = sunTransmittance * (
            uRayleighScattering * rayleighDensity * phaseRayleigh +
            vec3(uMieScattering * mieDensity * phaseMie)
          );
          singleScattering *= uSolarVisibility;
          vec3 isotropicScattering = multipleScattering * (
            uRayleighScattering * rayleighDensity + vec3(uMieScattering * mieDensity)
          );
          radiance += viewTransmittance * (singleScattering + isotropicScattering) * stepLength;
          viewTransmittance *= exp(-extinction * stepLength);
        }
        float alpha = clamp(1.0 - dot(viewTransmittance, vec3(0.333333)), 0.0, 1.0)
          * uPresentationVisibility;
        vec3 color = radiance * 3.2 * uVisualStrength;
        vec3 skyView = texture2D(uSkyViewLut, vec2(scatteringCosine * 0.5 + 0.5,
          dot(normalize(shellPoint), normalize(uSunDirection)) * 0.5 + 0.5)).rgb;
        color += skyView * 0.10 * uVisualStrength;
        color *= mix(vec3(1.0), uWavelengthTint, 0.10);
        float skyLuminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
        color = mix(color, mix(vec3(skyLuminance), color, 0.82), uInsideAtmosphere);
        // The material uses premultiplied alpha. Leaving RGB unscaled makes
        // low-density samples outside the limb composite as a broad glow.
        gl_FragColor = vec4(color * alpha, alpha);
      }
    `,
    // Outside cameras must rasterize the near shell so the atmosphere remains
    // in front of the opaque planet depth. TerrestrialAtmosphere flips this to
    // BackSide after the camera crosses inside the shell.
    side: THREE.FrontSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    premultipliedAlpha: true,
    toneMapped: true,
  });
  material.name = `terrestrial-atmosphere:${path}`;
  material.userData.atmospherePath = path;
  material.userData.quality = quality;
  material.userData.atmosphereModel = 'hillaire-lut-foundation';
  return { material, lookupTextures: luts.textures };
}
