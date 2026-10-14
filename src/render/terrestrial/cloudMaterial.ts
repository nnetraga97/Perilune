import * as THREE from 'three';
import {
  ATMOSPHERE_SCATTERING_GLSL,
  applyAtmosphereScatteringProfile,
  bindAtmosphereScatteringUniforms,
  createAtmosphereScatteringState,
  type AtmosphereScatteringProfile,
} from '../atmosphereScattering';

export interface CloudMaterialOptions {
  readonly textureScale: number;
  readonly opacity: number;
  readonly tint: THREE.ColorRepresentation;
  readonly shellRadius: number;
  readonly parallaxStrength: number;
  /** Atmosphere that lights the deck: sunset colour, planet shadow, sky fill, and haze. */
  readonly scattering?: Readonly<AtmosphereScatteringProfile>;
  readonly volume?: {
    readonly baseRadius: number;
    readonly topRadius: number;
    readonly samples: number;
    readonly noiseOctaves: 2 | 3;
  };
}

/**
 * Shared cloud lighting. Positions are in body radii in the cloud-fixed frame.
 * Sunlight arrives through the same atmosphere column as the sky, so tops stay
 * lit a little past the ground terminator, pass through sunset colour, and go
 * dark at night rather than holding a fixed daylight floor.
 */
const CLOUD_LIGHTING_GLSL = /* glsl */ `
vec3 cloudSunlight(vec3 unitPosition, vec3 sunDirection) {
  float r = max(length(unitPosition), 1.0);
  float mu = dot(unitPosition / r, sunDirection);
  // Thick decks scatter light around the terminator: wrap the cosine slightly.
  float wrapped = clamp((mu + 0.12) / 1.12, 0.0, 1.0);
  return atmoSunTransmittance(r, mu) * mix(0.3, 1.0, wrapped) * smoothstep(-0.12, 0.05, mu);
}

vec3 cloudSkyFill(vec3 unitPosition, vec3 sunDirection) {
  float mu = dot(normalize(unitPosition), sunDirection);
  return vec3(0.42, 0.55, 0.78) * atmoMultipleScatteringLight(mu) * 0.22;
}

float cloudHenyeyGreenstein(float cosine, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (12.5663706 * pow(max(1.0 + g2 - 2.0 * g * cosine, 1e-4), 1.5));
}

// Dual-lobe phase: strong forward silver lining plus a soft back lobe.
float cloudPhase(float cosine) {
  return mix(cloudHenyeyGreenstein(cosine, -0.25), cloudHenyeyGreenstein(cosine, 0.72), 0.32) * 12.5663706;
}

float cloudHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float cloudValueNoise(vec3 p) {
  vec3 cell = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(cloudHash(cell), cloudHash(cell + vec3(1.0, 0.0, 0.0)), f.x),
      mix(cloudHash(cell + vec3(0.0, 1.0, 0.0)), cloudHash(cell + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(cloudHash(cell + vec3(0.0, 0.0, 1.0)), cloudHash(cell + vec3(1.0, 0.0, 1.0)), f.x),
      mix(cloudHash(cell + vec3(0.0, 1.0, 1.0)), cloudHash(cell + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}
`;

export function createCloudMaterial(
  cloudTexture: THREE.Texture,
  options: Readonly<CloudMaterialOptions>,
): THREE.ShaderMaterial {
  cloudTexture.colorSpace = THREE.NoColorSpace;
  cloudTexture.wrapS = THREE.RepeatWrapping;
  cloudTexture.wrapT = THREE.ClampToEdgeWrapping;
  const scattering = createAtmosphereScatteringState();
  if (options.scattering) applyAtmosphereScatteringProfile(scattering, options.scattering);
  const bodyRadius = options.scattering?.radius ?? options.shellRadius;
  const uniforms: Record<string, THREE.IUniform> = {
    uCloudMap: { value: cloudTexture },
    uTextureScale: { value: options.textureScale },
    uOpacity: { value: options.opacity },
    uTint: { value: new THREE.Color(options.tint) },
    uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
    uSunCloudFixed: { value: new THREE.Vector3(1, 0, 0) },
    uSolarVisibility: { value: 1 },
    uCameraCloudFixed: { value: new THREE.Vector3() },
    uShellRadius: { value: options.shellRadius },
    uBodyRadius: { value: bodyRadius },
    uParallaxStrength: { value: options.parallaxStrength },
    uTime: { value: 0 },
    uHasAtmosphere: { value: options.scattering ? 1 : 0 },
    uVolumeBaseRadius: { value: options.volume?.baseRadius ?? options.shellRadius },
    uVolumeTopRadius: { value: options.volume?.topRadius ?? options.shellRadius },
  };
  bindAtmosphereScatteringUniforms({ uniforms }, scattering);
  const material = new THREE.ShaderMaterial({
    defines: {
      CLOUD_VOLUMETRIC: options.volume ? 1 : 0,
      CLOUD_VIEW_SAMPLES: options.volume?.samples ?? 1,
      CLOUD_NOISE_OCTAVES: options.volume?.noiseOctaves ?? 2,
    },
    uniforms,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vBodyDirection;
      void main() {
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        vBodyDirection = position;
        gl_Position = projectionMatrix * viewPosition;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      ${ATMOSPHERE_SCATTERING_GLSL}
      uniform sampler2D uCloudMap;
      uniform float uTextureScale;
      uniform float uOpacity;
      uniform vec3 uTint;
      uniform vec3 uSunCloudFixed;
      uniform float uSolarVisibility;
      uniform vec3 uCameraCloudFixed;
      uniform float uShellRadius;
      uniform float uBodyRadius;
      uniform float uParallaxStrength;
      uniform float uTime;
      uniform float uHasAtmosphere;
      uniform float uVolumeBaseRadius;
      uniform float uVolumeTopRadius;
      varying vec3 vBodyDirection;
      ${CLOUD_LIGHTING_GLSL}

      vec2 cloudUv(vec3 direction) {
        float longitude = atan(direction.y, direction.x) / 6.283185307179586 + 0.5;
        float u = fract(longitude);
        float v = 0.5 - asin(clamp(direction.z, -1.0, 1.0)) / 3.141592653589793;
        return vec2(fract(u * uTextureScale), v);
      }

      vec2 sampleCloud(vec3 direction) {
        return texture2D(uCloudMap, cloudUv(normalize(direction))).rg;
      }

      // Authored coverage keeps its fine satellite structure; only a gentle
      // curve lifts thin cirrus so it reads without turning into flat cards.
      float cloudCoverage(vec2 field) {
        return smoothstep(0.03, 0.78, field.r - (1.0 - field.g) * 0.05);
      }

      vec3 cloudLightFrom(vec3 direct, vec3 skyFill, float viewSunCosine, float thinness) {
        float phase = mix(1.0, cloudPhase(viewSunCosine), 0.35 + 0.45 * thinness);
        return uTint * (direct * phase * 0.82 + skyFill) * atmoSunIlluminance / 3.14159
          + uTint * 0.0035;
      }

      vec3 cloudLight(vec3 unitPosition, vec3 sun, float viewSunCosine, float thinness) {
        return cloudLightFrom(cloudSunlight(unitPosition, sun) * uSolarVisibility,
          cloudSkyFill(unitPosition, sun), viewSunCosine, thinness);
      }

      // Clouds composite after the sky and own only camera-to-cloud haze.
      vec3 cloudAerial(vec3 unitPoint, vec3 color) {
        vec3 camera = uCameraCloudFixed / uBodyRadius;
        if (uHasAtmosphere < 0.5) return color;
        vec3 segment = unitPoint - camera;
        float distance = length(segment);
        if (distance <= 1e-9) return color;
        vec3 inscatter;
        vec3 transmittance;
        vec2 top = atmoRaySphere(camera, segment / distance, atmoTopRadius);
        float start = max(0.0, top.x);
        float end = min(distance, top.y);
        if (end <= start) return color;
        atmoIntegrate(camera, segment / distance, start, end, normalize(uSunCloudFixed), 6,
          inscatter, transmittance);
        return color * transmittance + inscatter * uSolarVisibility;
      }

      vec2 cloudRaySphere(vec3 origin, vec3 direction, float radius) {
        float b = dot(origin, direction);
        float c = dot(origin, origin) - radius * radius;
        float discriminant = b * b - c;
        if (discriminant < 0.0) return vec2(1.0, -1.0);
        float root = sqrt(discriminant);
        return vec2(-b - root, -b + root);
      }

      void main() {
        #include <logdepthbuf_fragment>
        // Varyings are interpolated across each triangle. Renormalizing here is
        // essential: using the interpolated chord directly reveals the sphere's
        // latitude/triangle structure in the equirectangular lookup.
        vec3 direction = normalize(vBodyDirection);
        vec3 sun = normalize(uSunCloudFixed);
#if CLOUD_VOLUMETRIC == 1
        vec3 shellPoint = direction * uVolumeTopRadius;
        vec3 rayDirection = normalize(shellPoint - uCameraCloudFixed);
        vec2 outerHit = cloudRaySphere(uCameraCloudFixed, rayDirection, uVolumeTopRadius);
        float rayStart = max(0.0, outerHit.x);
        float rayEnd = outerHit.y;
        vec2 baseHit = cloudRaySphere(uCameraCloudFixed, rayDirection, uVolumeBaseRadius);
        if (baseHit.x > rayStart && baseHit.x < rayEnd) rayEnd = baseHit.x;
        if (rayEnd <= rayStart) discard;
        float stepLength = (rayEnd - rayStart) / float(CLOUD_VIEW_SAMPLES);
        float layerDepth = max(1.0, uVolumeTopRadius - uVolumeBaseRadius);
        float viewSunCosine = dot(rayDirection, sun);
        // Erosion detail is only meaningful where a 2-4 km feature spans
        // several pixels; from orbit the authored field carries the structure.
        float cameraRange = max(rayStart, 1.0);
        float detailWeight = 1.0 - smoothstep(60000.0, 900000.0, cameraRange);
        float detailFrequency = uBodyRadius / 2600.0;
        float viewTransmittance = 1.0;
        vec3 accumulated = vec3(0.0);
        float firstHit = -1.0;
        // Sunlight changes little across a 14 km deck; evaluate the
        // atmospheric column once at the layer midpoint along this ray.
        vec3 layerPoint = (uCameraCloudFixed + rayDirection * (0.5 * (rayStart + rayEnd))) / uBodyRadius;
        vec3 layerSunlight = cloudSunlight(layerPoint, sun) * uSolarVisibility;
        vec3 layerSkyFill = cloudSkyFill(layerPoint, sun);
        for (int sampleIndex = 0; sampleIndex < CLOUD_VIEW_SAMPLES; sampleIndex++) {
          float distance = rayStart + (float(sampleIndex) + 0.5) * stepLength;
          vec3 samplePosition = uCameraCloudFixed + rayDirection * distance;
          float sampleRadius = length(samplePosition);
          float heightFraction = (sampleRadius - uVolumeBaseRadius) / layerDepth;
          if (heightFraction > 0.0 && heightFraction < 1.0) {
            vec3 sampleDirection = samplePosition / sampleRadius;
            vec2 authored = sampleCloud(sampleDirection);
            float coverage = cloudCoverage(authored);
            // Thick systems tower; thin cover stays low in the layer.
            float ceiling = mix(0.35, 1.0, coverage * mix(0.6, 1.0, authored.g));
            float heightShape = smoothstep(0.0, 0.1, heightFraction) *
              (1.0 - smoothstep(ceiling * 0.7, ceiling, heightFraction));
            float density = coverage;
            // Skip erosion noise where the authored field is empty.
            if (detailWeight > 0.001 && coverage * heightShape > 0.01) {
              vec3 noisePosition = sampleDirection * detailFrequency + vec3(0.0, uTime * 0.002, heightFraction * 1.7);
              float detail = cloudValueNoise(noisePosition) * 0.62;
              detail += cloudValueNoise(noisePosition * 2.7 + 13.1) * 0.38;
              float erosion = detail * 0.55 * detailWeight;
              density = clamp((coverage - erosion) / max(1.0 - erosion, 0.35), 0.0, 1.0);
            }
            density *= heightShape * mix(0.6, 1.0, authored.g);
            if (density > 0.002) {
              if (firstHit < 0.0) firstHit = distance;
              float opticalStep = density * stepLength / layerDepth * 4.2;
              float segmentAlpha = 1.0 - exp(-opticalStep);
              // Cheap self-shadowing: light reaching lower parts of a thick
              // column is attenuated by the cloud above it.
              float selfShadow = mix(exp(-2.4 * coverage * authored.g * (1.0 - heightFraction)), 1.0, 0.3);
              vec3 light = cloudLightFrom(layerSunlight, layerSkyFill, viewSunCosine, 1.0 - density) * selfShadow;
              accumulated += viewTransmittance * light * segmentAlpha;
              viewTransmittance *= 1.0 - segmentAlpha;
              if (viewTransmittance < 0.015) break;
            }
          }
        }
        vec3 shellToCamera = normalize(uCameraCloudFixed - shellPoint);
        float tangentFade = smoothstep(0.015, 0.08, abs(dot(direction, shellToCamera)));
        float alpha = (1.0 - viewTransmittance) * uOpacity * tangentFade;
        if (alpha < 0.008) discard;
        vec3 color = accumulated / max(1.0 - viewTransmittance, 1e-4);
        vec3 hitPoint = (uCameraCloudFixed + rayDirection * max(firstHit, rayStart)) / uBodyRadius;
        color = cloudAerial(hitPoint, color);
        gl_FragColor = vec4(color, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        gl_FragColor.rgb *= alpha;
#else
        vec3 toCamera = uCameraCloudFixed - direction * uShellRadius;
        float cameraDistance = length(toCamera);
        vec3 bodyView = cameraDistance > 0.001 ? toCamera / cameraDistance : direction;
        float radialView = abs(dot(direction, bodyView));
        vec3 tangentVector = bodyView - direction * dot(direction, bodyView);
        float tangentLength = length(tangentVector);
        vec3 viewTangent = tangentLength > 0.0001 ? tangentVector / tangentLength : vec3(0.0);
        float parallaxSpan = uParallaxStrength * (1.0 - radialView) / max(1.0, uTextureScale);

        // Four nearby samples provide a restrained sense of thickness at
        // grazing angles without introducing a volumetric render pass.
        vec2 field0 = sampleCloud(direction - viewTangent * parallaxSpan * 0.50);
        vec2 field1 = sampleCloud(direction - viewTangent * parallaxSpan * 0.17);
        vec2 field2 = sampleCloud(direction + viewTangent * parallaxSpan * 0.17);
        vec2 field3 = sampleCloud(direction + viewTangent * parallaxSpan * 0.50);
        vec2 field = (field0 + field1 + field2 + field3) * 0.25;
        float peakCoverage = max(max(field0.r, field1.r), max(field2.r, field3.r));
        float coverage = cloudCoverage(vec2(field.r + (peakCoverage - field.r) * 0.32, field.g));
        float opticalDepth = clamp(field.g, 0.0, 1.0);

        // Relief from the coverage gradient toward the sun: sunward edges of
        // thick systems brighten, lee sides fall into soft shade.
        vec3 east = normalize(vec3(-direction.y, direction.x, 0.0) + vec3(1e-5, 0.0, 0.0));
        vec3 north = cross(direction, east);
        float reliefStep = 0.0022 / max(1.0, uTextureScale);
        float sunEast = dot(sun, east);
        float sunNorth = dot(sun, north);
        float towardSun = sampleCloud(direction + (east * sunEast + north * sunNorth) * reliefStep).r;
        float relief = clamp((field.r - towardSun) * 3.0, -0.35, 0.35);

        vec3 unitPoint = direction * uShellRadius / uBodyRadius;
        float viewSunCosine = dot(-bodyView, sun);
        vec3 color = cloudLight(unitPoint, sun, viewSunCosine, 1.0 - opticalDepth);
        float cameraOutside = step(uShellRadius, length(uCameraCloudFixed));
        // From below, thick cloud bases are darker than their sunlit tops.
        color *= mix(mix(0.42, 0.85, 1.0 - opticalDepth), 1.0, cameraOutside);
        color *= 1.0 + relief * cameraOutside;
        color = cloudAerial(unitPoint, color);

        float alpha = coverage * mix(0.45, 1.0, opticalDepth) * uOpacity;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(color, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
#endif
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    premultipliedAlpha: options.volume !== undefined,
  });
  material.userData.cloudModel = options.volume ? 'bounded-volume' : 'parallax-shell';
  material.userData.scattering = scattering;
  return material;
}
