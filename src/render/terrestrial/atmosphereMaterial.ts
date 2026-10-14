import * as THREE from 'three';
import type { RenderCaps } from '../context';
import type { QualityTier } from '../bodyRenderer';
import type { AtmosphereDef } from '../../sim/universe';
import { createAtmosphereLuts, terrestrialScatteringProfile } from './atmosphereLuts';
import {
  ATMOSPHERE_SCATTERING_GLSL,
  applyAtmosphereScatteringProfile,
  bindAtmosphereScatteringUniforms,
  createAtmosphereScatteringState,
} from '../atmosphereScattering';

export interface AtmosphereVisualCoefficients {
  readonly wavelengthTint: readonly [number, number, number];
  readonly strength: number;
}

export interface AtmosphereMaterialBundle {
  readonly material: THREE.ShaderMaterial;
  readonly lookupTextures: readonly THREE.DataTexture[];
}

const TRANSMITTANCE_FRAGMENT = /* glsl */ `
  #include <common>
  #include <logdepthbuf_pars_fragment>
  ${ATMOSPHERE_SCATTERING_GLSL}
  uniform float uBodyRadius;
  uniform vec3 uCameraBodyFixed;
  uniform float uPresentationVisibility;
  varying vec3 vBodyNormal;

  void main() {
    #include <logdepthbuf_fragment>
    vec3 camera = uCameraBodyFixed / uBodyRadius;
    vec3 shellPoint = normalize(vBodyNormal) * atmoTopRadius;
    vec3 rayDirection = normalize(shellPoint - camera);
    vec2 atmosphereHit = atmoRaySphere(camera, rayDirection, atmoTopRadius);
    float rayStart = max(0.0, atmosphereHit.x);
    float rayEnd = atmosphereHit.y;
    vec2 groundHit = atmoRaySphere(camera, rayDirection, 1.0);
    if (groundHit.x > 0.0 && groundHit.x < rayEnd) rayEnd = groundHit.x;
    if (rayEnd <= rayStart) discard;
    vec3 transmittance = atmoTransmittanceAlong(camera, rayDirection, rayStart, rayEnd,
      groundHit.x > 0.0 && groundHit.x <= rayEnd ? 6 : ATMOSPHERE_TRANSMITTANCE_SAMPLES);
    gl_FragColor = vec4(mix(vec3(1.0), transmittance, uPresentationVisibility), 1.0);
  }
`;

/**
 * Multiplicative companion to the in-scatter shell: dst *= T(view ray). It
 * shares the scattering material's uniform objects, so updates to either apply
 * to both.
 */
export function createAtmosphereTransmittanceMaterial(source: THREE.ShaderMaterial): THREE.ShaderMaterial {
  const samples = Math.max(4, Math.round(Number(source.defines.ATMOSPHERE_VIEW_SAMPLES ?? 8) * 0.5));
  const material = new THREE.ShaderMaterial({
    defines: { ATMOSPHERE_TRANSMITTANCE_SAMPLES: samples },
    uniforms: source.uniforms,
    vertexShader: source.vertexShader,
    fragmentShader: TRANSMITTANCE_FRAGMENT,
    side: source.side,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
    blendEquationAlpha: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    toneMapped: false,
  });
  material.name = `${source.name}:transmittance`;
  return material;
}

export function createAtmosphereMaterial(
  path: RenderCaps['atmospherePath'],
  radius: number,
  physical: Readonly<AtmosphereDef>,
  visual: Readonly<AtmosphereVisualCoefficients>,
  quality: QualityTier = 'medium',
): AtmosphereMaterialBundle {
  const luts = createAtmosphereLuts(radius, physical, visual);
  const scatteringState = createAtmosphereScatteringState();
  applyAtmosphereScatteringProfile(scatteringState, terrestrialScatteringProfile(radius, physical, visual));
  // Samples are clustered at the lowest point of each ray, so limb rays keep
  // their tangent-point density without a long uniform march.
  const viewSamples = path === 'analytic'
    ? quality === 'high' ? 16 : quality === 'medium' ? 12 : 8
    : path === 'lookup'
      ? quality === 'high' ? 12 : quality === 'medium' ? 10 : 8
      : quality === 'high' ? 8 : quality === 'medium' ? 6 : 5;
  const uniforms: Record<string, THREE.IUniform> = {
    uBodyRadius: { value: radius },
    uAtmosphereRadius: { value: radius + physical.height },
    uAtmosphereHeight: { value: physical.height },
    uSeaLevelPressure: { value: physical.seaLevelPressure },
    uSeaLevelDensity: { value: physical.seaLevelDensity },
    uScaleHeight: { value: physical.scaleHeight },
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
  };
  bindAtmosphereScatteringUniforms({ uniforms }, scatteringState);
  const material = new THREE.ShaderMaterial({
    defines: {
      ATMOSPHERE_ANALYTIC: path === 'analytic' ? 1 : 0,
      ATMOSPHERE_LOOKUP: path === 'lookup' ? 1 : 0,
      ATMOSPHERE_LIMB_HAZE: path === 'limb-haze' ? 1 : 0,
      ATMOSPHERE_LUT_SCATTERING: 1,
      ATMOSPHERE_VIEW_SAMPLES: viewSamples,
    },
    uniforms,
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
      ${ATMOSPHERE_SCATTERING_GLSL}
      uniform float uBodyRadius;
      uniform vec3 uCameraBodyFixed;
      uniform vec3 uSunDirection;
      uniform float uSolarVisibility;
      uniform float uPresentationVisibility;
      varying vec3 vBodyNormal;

      vec2 atmosphereRaySphere(vec3 origin, vec3 direction, float radius) {
        return atmoRaySphere(origin, direction, radius);
      }

      void main() {
        #include <logdepthbuf_fragment>
        // Radius-normalized frame: orbital cameras stay near 1.0 in float32.
        vec3 camera = uCameraBodyFixed / uBodyRadius;
        vec3 sun = normalize(uSunDirection);
        vec3 shellPoint = normalize(vBodyNormal) * atmoTopRadius;
        vec3 rayDirection = normalize(shellPoint - camera);
        vec2 atmosphereHit = atmosphereRaySphere(camera, rayDirection, atmoTopRadius);
        float rayStart = max(0.0, atmosphereHit.x);
        float rayEnd = atmosphereHit.y;
        vec2 groundHit = atmosphereRaySphere(camera, rayDirection, 1.0);
        bool hitsGround = groundHit.x > 0.0 && groundHit.x < rayEnd;
        if (hitsGround) rayEnd = groundHit.x;
        if (rayEnd <= rayStart) discard;

        vec3 inscatter;
        vec3 viewTransmittance;
        atmoIntegrate(camera, rayDirection, rayStart, rayEnd, sun,
          hitsGround ? 6 : ATMOSPHERE_VIEW_SAMPLES, inscatter, viewTransmittance);
        if (hitsGround) {
          inscatter *= atmoSurfaceHazeScale(normalize(camera + rayDirection * rayEnd), rayDirection);
        }
        // Eclipse occlusion dims the direct and ambient light together; the
        // sunTransmittance term inside the integral already owns planet shadow.
        inscatter *= uSolarVisibility;
        // Additive: the transmittance child pass has already attenuated
        // whatever lies behind (ground, clouds, or stars) per channel.
        gl_FragColor = vec4(inscatter, 0.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        gl_FragColor *= uPresentationVisibility;
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
  material.userData.scattering = scatteringState;
  material.name = `terrestrial-atmosphere:${path}`;
  material.userData.atmospherePath = path;
  material.userData.quality = quality;
  material.userData.atmosphereModel = 'hillaire-lut-foundation';
  return { material, lookupTextures: luts.textures };
}
