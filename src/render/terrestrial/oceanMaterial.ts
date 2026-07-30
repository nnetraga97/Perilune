import * as THREE from 'three';
import type { QualityTier } from '../bodyRenderer';
import {
  attachTerrestrialAerialPerspective,
  bindTerrestrialAerialPerspectiveUniforms,
  createTerrestrialAerialPerspectiveState,
  TERRESTRIAL_AERIAL_FRAGMENT_GLSL,
} from './aerialPerspective';
import {
  KSC_SURFACE_CLASS_BOUNDS_DEGREES,
  SURFACE_CLASS_GLSL,
  configureSurfaceClassTexture,
  type SurfaceClassTextureSet,
} from './surfaceClass';

const GLITTER_BY_QUALITY: Readonly<Record<QualityTier, number>> = Object.freeze({
  low: 0.16,
  medium: 0.56,
  high: 0.9,
});

export interface OceanWaveComponent {
  readonly direction: readonly [number, number, number];
  readonly wavelengthMeters: number;
  readonly phaseSpeedRadiansPerSecond: number;
  readonly phaseOffset: number;
  readonly slopeAmplitude: number;
}

function unitDirection(x: number, y: number, z: number): readonly [number, number, number] {
  const length = Math.hypot(x, y, z);
  return Object.freeze([x / length, y / length, z / length]);
}

/** Restrained, body-fixed gravity-wave bands from long to short. */
export const OCEAN_WAVE_COMPONENTS: readonly OceanWaveComponent[] = Object.freeze([
  Object.freeze({
    direction: unitDirection(0.82, 0.31, 0.48),
    wavelengthMeters: 180,
    phaseSpeedRadiansPerSecond: 0.08,
    phaseOffset: 0.4,
    slopeAmplitude: 0.032,
  }),
  Object.freeze({
    direction: unitDirection(-0.24, 0.91, 0.33),
    wavelengthMeters: 54,
    phaseSpeedRadiansPerSecond: -0.19,
    phaseOffset: 2.1,
    slopeAmplitude: 0.038,
  }),
  Object.freeze({
    direction: unitDirection(0.46, -0.52, 0.72),
    wavelengthMeters: 21,
    phaseSpeedRadiansPerSecond: 0.34,
    phaseOffset: 4.7,
    slopeAmplitude: 0.025,
  }),
  Object.freeze({
    direction: unitDirection(-0.67, -0.18, 0.72),
    wavelengthMeters: 8,
    phaseSpeedRadiansPerSecond: -0.57,
    phaseOffset: 1.3,
    slopeAmplitude: 0.014,
  }),
]);

export const OCEAN_MAX_NORMAL_SLOPE = 0.1;

const WAVE_POLICY_BY_QUALITY: Readonly<Record<QualityTier, {
  readonly componentCount: number;
  readonly slopeScale: number;
}>> = Object.freeze({
  low: Object.freeze({ componentCount: 1, slopeScale: 0.65 }),
  medium: Object.freeze({ componentCount: 3, slopeScale: 0.85 }),
  high: Object.freeze({ componentCount: 4, slopeScale: 1 }),
});

export function oceanWavePolicy(quality: QualityTier) {
  return WAVE_POLICY_BY_QUALITY[quality];
}

export interface OceanWaveSample {
  readonly phases: readonly number[];
  readonly gradient: readonly [number, number, number];
  readonly slope: number;
}

/** CPU mirror for deterministic phase, continuity, and declared slope bounds. */
export function sampleOceanWaveGradient(
  bodyPoint: Readonly<{ x: number; y: number; z: number }>,
  timeSeconds: number,
  quality: QualityTier,
): OceanWaveSample {
  const normalLength = Math.hypot(bodyPoint.x, bodyPoint.y, bodyPoint.z);
  const normal = normalLength > 0 && Number.isFinite(normalLength)
    ? [bodyPoint.x / normalLength, bodyPoint.y / normalLength, bodyPoint.z / normalLength] as const
    : [1, 0, 0] as const;
  const policy = oceanWavePolicy(quality);
  const phases: number[] = [];
  let gx = 0;
  let gy = 0;
  let gz = 0;
  for (let index = 0; index < policy.componentCount; index++) {
    const component = OCEAN_WAVE_COMPONENTS[index];
    const direction = component.direction;
    const phase = (Math.PI * 2 / component.wavelengthMeters) * (
      bodyPoint.x * direction[0] + bodyPoint.y * direction[1] + bodyPoint.z * direction[2]
    ) + timeSeconds * component.phaseSpeedRadiansPerSecond + component.phaseOffset;
    phases.push(phase);
    const radial = direction[0] * normal[0] + direction[1] * normal[1] + direction[2] * normal[2];
    let tx = direction[0] - normal[0] * radial;
    let ty = direction[1] - normal[1] * radial;
    let tz = direction[2] - normal[2] * radial;
    const tangentLength = Math.hypot(tx, ty, tz);
    if (!(tangentLength > 1e-9)) continue;
    tx /= tangentLength;
    ty /= tangentLength;
    tz /= tangentLength;
    const amplitude = component.slopeAmplitude * Math.cos(phase) * policy.slopeScale;
    gx += tx * amplitude;
    gy += ty * amplitude;
    gz += tz * amplitude;
  }
  const rawSlope = Math.hypot(gx, gy, gz);
  if (rawSlope > OCEAN_MAX_NORMAL_SLOPE) {
    const scale = OCEAN_MAX_NORMAL_SLOPE / rawSlope;
    gx *= scale;
    gy *= scale;
    gz *= scale;
  }
  const gradient: [number, number, number] = [gx, gy, gz];
  return Object.freeze({
    phases: Object.freeze(phases),
    gradient: Object.freeze(gradient),
    slope: Math.min(rawSlope, OCEAN_MAX_NORMAL_SLOPE),
  });
}

const CAP_SEGMENTS_BY_QUALITY: Readonly<Record<QualityTier, number>> = Object.freeze({
  // Even Low stays dense enough for sub-metre chord error through the 5.5 km
  // low-flight presentation checkpoint. This is one mesh and one draw call.
  low: 144,
  medium: 160,
  high: 192,
});

const MAXIMUM_CAP_ANGLE_RADIANS = 0.55;
const HORIZON_MARGIN_RATIO = 1.25;
const HORIZON_MARGIN_RADIANS = 0.005;

function configureShoreMask(shoreMask: THREE.Texture | null): void {
  if (!shoreMask) return;
  shoreMask.colorSpace = THREE.NoColorSpace;
  shoreMask.wrapS = THREE.RepeatWrapping;
  shoreMask.wrapT = THREE.ClampToEdgeWrapping;
}

export function oceanCapSegments(quality: QualityTier): number {
  return CAP_SEGMENTS_BY_QUALITY[quality];
}

/**
 * Angular radius of the circle inscribed in the square gnomonic patch.
 * The margin keeps the geometric horizon away from the patch boundary while
 * the cap is recentered on the camera every frame.
 */
export function oceanCapAngle(bodyRadius: number, altitudeMeters: number): number {
  if (!(bodyRadius > 0) || !Number.isFinite(bodyRadius)) throw new Error(`Invalid ocean radius ${bodyRadius}`);
  const altitude = Number.isFinite(altitudeMeters) ? Math.max(0, altitudeMeters) : 0;
  const horizon = Math.acos(Math.min(1, bodyRadius / (bodyRadius + altitude)));
  return Math.min(
    MAXIMUM_CAP_ANGLE_RADIANS,
    horizon * HORIZON_MARGIN_RATIO + HORIZON_MARGIN_RADIANS,
  );
}

/** Whether the finite near-field cap still extends beyond the geometric horizon. */
export function oceanCapCoversHorizon(bodyRadius: number, altitudeMeters: number): boolean {
  if (!(bodyRadius > 0) || !Number.isFinite(bodyRadius)) throw new Error(`Invalid ocean radius ${bodyRadius}`);
  const altitude = Number.isFinite(altitudeMeters) ? Math.max(0, altitudeMeters) : 0;
  const horizon = Math.acos(Math.min(1, bodyRadius / (bodyRadius + altitude)));
  return oceanCapAngle(bodyRadius, altitude) > horizon;
}

/** Mirror of the cap vertex shader for geometry tests and CPU-side bounds. */
export function oceanCapDirection(
  anchor: Readonly<{ x: number; y: number; z: number }>,
  east: Readonly<{ x: number; y: number; z: number }>,
  north: Readonly<{ x: number; y: number; z: number }>,
  gridX: number,
  gridY: number,
  capAngle: number,
): Readonly<{ x: number; y: number; z: number }> {
  const extent = Math.tan(capAngle);
  const x = anchor.x + (gridX * east.x + gridY * north.x) * extent;
  const y = anchor.y + (gridX * east.y + gridY * north.y) * extent;
  const z = anchor.z + (gridX * east.z + gridY * north.z) * extent;
  const length = Math.hypot(x, y, z) || 1;
  return Object.freeze({ x: x / length, y: y / length, z: z / length });
}

const OCEAN_FRAGMENT_SHADER = /* glsl */ `
  #include <logdepthbuf_pars_fragment>
  ${TERRESTRIAL_AERIAL_FRAGMENT_GLSL}
  uniform sampler2D uShoreMask;
  uniform float uHasShoreMask;
  uniform vec3 uOceanColor;
  uniform float uBodyRadius;
  uniform vec3 uCameraBodyFixed;
  uniform vec3 uSunDirection;
  uniform float uGlitterStrength;
  uniform float uSolarVisibility;
  uniform float uTime;
  uniform float uWaveComponentCount;
  uniform float uWaveSlopeScale;
  uniform mat3 normalMatrix;
  varying vec3 vBodyDirection;
  varying vec3 vViewNormal;
  varying vec3 vViewDirection;

  vec2 bodyUv(vec3 direction) {
    float longitude = atan(direction.y, direction.x) / 6.283185307179586 + 0.5;
    return vec2(fract(longitude),
      0.5 - asin(clamp(direction.z, -1.0, 1.0)) / 3.141592653589793);
  }
  vec2 bodyFixedUv(vec3 direction) { return bodyUv(direction); }
  ${SURFACE_CLASS_GLSL}

  vec3 oceanWaveContribution(
    vec3 bodyPoint,
    vec3 bodyNormal,
    vec3 waveDirection,
    float wavelengthMeters,
    float phaseSpeed,
    float phaseOffset,
    float slopeAmplitude
  ) {
    vec3 tangent = waveDirection - bodyNormal * dot(waveDirection, bodyNormal);
    float tangentLength = length(tangent);
    if (tangentLength <= 0.000001) return vec3(0.0);
    float phase = 6.283185307179586 * dot(bodyPoint, waveDirection) / wavelengthMeters
      + uTime * phaseSpeed + phaseOffset;
    // Fade well before a wavelength becomes sub-pixel. The previous threshold
    // left diagonal moire bands across low-altitude ocean horizons.
    float phaseFootprint = fwidth(phase);
    float footprintFilter = 1.0 - smoothstep(0.18, 0.85, phaseFootprint);
    return tangent / tangentLength
      * (slopeAmplitude * cos(phase) * footprintFilter * uWaveSlopeScale);
  }

  vec3 filteredOceanWaveNormal(vec3 bodyPoint, vec3 bodyNormal) {
    vec3 gradient = vec3(0.0);
    if (uWaveComponentCount > 0.5) gradient += oceanWaveContribution(
      bodyPoint, bodyNormal,
      vec3(${OCEAN_WAVE_COMPONENTS[0].direction.join(', ')}),
      ${OCEAN_WAVE_COMPONENTS[0].wavelengthMeters.toFixed(1)},
      ${OCEAN_WAVE_COMPONENTS[0].phaseSpeedRadiansPerSecond.toFixed(2)},
      ${OCEAN_WAVE_COMPONENTS[0].phaseOffset.toFixed(1)},
      ${OCEAN_WAVE_COMPONENTS[0].slopeAmplitude.toFixed(3)}
    );
    if (uWaveComponentCount > 1.5) gradient += oceanWaveContribution(
      bodyPoint, bodyNormal,
      vec3(${OCEAN_WAVE_COMPONENTS[1].direction.join(', ')}),
      ${OCEAN_WAVE_COMPONENTS[1].wavelengthMeters.toFixed(1)},
      ${OCEAN_WAVE_COMPONENTS[1].phaseSpeedRadiansPerSecond.toFixed(2)},
      ${OCEAN_WAVE_COMPONENTS[1].phaseOffset.toFixed(1)},
      ${OCEAN_WAVE_COMPONENTS[1].slopeAmplitude.toFixed(3)}
    );
    if (uWaveComponentCount > 2.5) gradient += oceanWaveContribution(
      bodyPoint, bodyNormal,
      vec3(${OCEAN_WAVE_COMPONENTS[2].direction.join(', ')}),
      ${OCEAN_WAVE_COMPONENTS[2].wavelengthMeters.toFixed(1)},
      ${OCEAN_WAVE_COMPONENTS[2].phaseSpeedRadiansPerSecond.toFixed(2)},
      ${OCEAN_WAVE_COMPONENTS[2].phaseOffset.toFixed(1)},
      ${OCEAN_WAVE_COMPONENTS[2].slopeAmplitude.toFixed(3)}
    );
    if (uWaveComponentCount > 3.5) gradient += oceanWaveContribution(
      bodyPoint, bodyNormal,
      vec3(${OCEAN_WAVE_COMPONENTS[3].direction.join(', ')}),
      ${OCEAN_WAVE_COMPONENTS[3].wavelengthMeters.toFixed(1)},
      ${OCEAN_WAVE_COMPONENTS[3].phaseSpeedRadiansPerSecond.toFixed(2)},
      ${OCEAN_WAVE_COMPONENTS[3].phaseOffset.toFixed(1)},
      ${OCEAN_WAVE_COMPONENTS[3].slopeAmplitude.toFixed(3)}
    );
    float totalSlope = length(gradient);
    if (totalSlope > ${OCEAN_MAX_NORMAL_SLOPE.toFixed(3)}) {
      gradient *= ${OCEAN_MAX_NORMAL_SLOPE.toFixed(3)} / totalSlope;
    }
    return normalize(bodyNormal - gradient);
  }

  void main() {
    float exactClass = resolvedSurfaceClass(vBodyDirection);
    float oceanMask = useGlobalSurfaceClassMap > 0.5
      ? surfaceClassOcean(exactClass)
      : (uHasShoreMask > 0.5 ? texture2D(uShoreMask, bodyUv(vBodyDirection)).b : 1.0);
    if (oceanMask < 0.5) discard;
    #include <logdepthbuf_fragment>
    float shore = 4.0 * oceanMask * (1.0 - oceanMask);
    vec3 bodyPoint = normalize(vBodyDirection) * uBodyRadius;
    vec3 datumNormal = normalize(vBodyDirection);
    vec3 waveBodyNormal = filteredOceanWaveNormal(bodyPoint, datumNormal);
    vec3 waveViewNormal = normalize(normalMatrix * waveBodyNormal);
    float viewCosine = max(0.0, dot(waveViewNormal, normalize(vViewDirection)));
    float fresnel = 0.02 + 0.98 * pow(1.0 - viewCosine, 5.0);
    vec3 reflectedSun = reflect(-normalize(uSunDirection), waveBodyNormal);
    vec3 bodyView = normalize(uCameraBodyFixed - vBodyDirection * uBodyRadius);
    float reflectionAlignment = max(0.0, dot(reflectedSun, bodyView));
    float broadGlint = pow(reflectionAlignment, 28.0) * 0.12;
    float sharpGlint = pow(reflectionAlignment, 160.0) * 0.72;
    float glitter = (broadGlint + sharpGlint) * uGlitterStrength * uSolarVisibility;
    float waveSlope = clamp(length(waveBodyNormal - datumNormal) / ${OCEAN_MAX_NORMAL_SLOPE.toFixed(3)}, 0.0, 1.0);
    float sunFacing = max(0.0, dot(waveBodyNormal, normalize(uSunDirection)));
    vec3 facetDirection = normalize(bodyView + normalize(uSunDirection));
    float facetLight = dot(waveBodyNormal - datumNormal, facetDirection);
    float swellPhaseA = 6.283185307179586 * dot(bodyPoint,
      vec3(${OCEAN_WAVE_COMPONENTS[0].direction.join(', ')})) / ${OCEAN_WAVE_COMPONENTS[0].wavelengthMeters.toFixed(1)}
      + uTime * ${OCEAN_WAVE_COMPONENTS[0].phaseSpeedRadiansPerSecond.toFixed(2)};
    float swellPhaseB = 6.283185307179586 * dot(bodyPoint,
      vec3(${OCEAN_WAVE_COMPONENTS[1].direction.join(', ')})) / ${OCEAN_WAVE_COMPONENTS[1].wavelengthMeters.toFixed(1)}
      + uTime * ${OCEAN_WAVE_COMPONENTS[1].phaseSpeedRadiansPerSecond.toFixed(2)};
    float swellA = sin(swellPhaseA) * (1.0 - smoothstep(0.75, 2.5, fwidth(swellPhaseA)));
    float swellB = sin(swellPhaseB) * (1.0 - smoothstep(0.3, 1.2, fwidth(swellPhaseB)));
    float swellTint = (swellA * 0.48 + swellB * 0.24 + swellA * swellB * 0.28) * 0.1;
    vec3 deepWater = mix(
      uOceanColor * mix(0.86, 1.3, viewCosine),
      vec3(0.018, 0.085, 0.16),
      0.32
    );
    deepWater *= 0.94 + sunFacing * 0.12 + waveSlope * 0.035 + facetLight * 1.35;
    deepWater *= 1.0 + swellTint;
    vec3 skyReflection = mix(vec3(0.012, 0.045, 0.095), vec3(0.08, 0.24, 0.48),
      pow(1.0 - viewCosine, 0.72));
    vec3 depthTint = mix(deepWater, skyReflection, fresnel * 0.86);
    vec3 foam = vec3(0.72, 0.82, 0.84) * shore;
    vec3 oceanBaseColor = depthTint + foam * 0.52 + vec3(1.0, 0.86, 0.64) * glitter;
    vec3 oceanShadedColor = applyTerrestrialAerialPerspective(
      normalize(vBodyDirection) * uBodyRadius,
      oceanBaseColor
    );
    gl_FragColor = vec4(oceanShadedColor, 1.0);
  }
`;

export function createOceanCapMaterial(
  quality: QualityTier,
  shoreMask: THREE.Texture | null,
  oceanColor: THREE.ColorRepresentation,
  bodyRadius: number,
  surfaceClasses: Readonly<SurfaceClassTextureSet> | null = null,
): THREE.ShaderMaterial {
  configureShoreMask(shoreMask);
  if (surfaceClasses) {
    configureSurfaceClassTexture(surfaceClasses.global);
    configureSurfaceClassTexture(surfaceClasses.regional);
  }
  const aerialPerspective = createTerrestrialAerialPerspectiveState('ocean', bodyRadius);
  const wavePolicy = oceanWavePolicy(quality);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uShoreMask: { value: shoreMask },
      uHasShoreMask: { value: shoreMask ? 1 : 0 },
      uOceanColor: { value: new THREE.Color(oceanColor) },
      uBodyRadius: { value: bodyRadius },
      uCameraBodyFixed: { value: new THREE.Vector3() },
      uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
      uGlitterStrength: { value: GLITTER_BY_QUALITY[quality] },
      uSolarVisibility: { value: 1 },
      uTime: { value: 0 },
      uWaveComponentCount: { value: wavePolicy.componentCount },
      uWaveSlopeScale: { value: wavePolicy.slopeScale },
      uAnchorDirection: { value: new THREE.Vector3(0, 0, 1) },
      uEast: { value: new THREE.Vector3(1, 0, 0) },
      uNorth: { value: new THREE.Vector3(0, 1, 0) },
      uCapAngle: { value: HORIZON_MARGIN_RADIANS },
      globalSurfaceClassMap: { value: surfaceClasses?.global ?? shoreMask },
      regionalSurfaceClassMap: { value: surfaceClasses?.regional ?? shoreMask },
      useGlobalSurfaceClassMap: { value: surfaceClasses?.hasGlobal ? 1 : 0 },
      useRegionalSurfaceClassMap: { value: surfaceClasses?.hasRegional ? 1 : 0 },
      regionalSurfaceClassBoundsRadians: { value: new THREE.Vector4(
        THREE.MathUtils.degToRad(KSC_SURFACE_CLASS_BOUNDS_DEGREES[0]),
        THREE.MathUtils.degToRad(KSC_SURFACE_CLASS_BOUNDS_DEGREES[1]),
        THREE.MathUtils.degToRad(KSC_SURFACE_CLASS_BOUNDS_DEGREES[2]),
        THREE.MathUtils.degToRad(KSC_SURFACE_CLASS_BOUNDS_DEGREES[3]),
      ) },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      uniform vec3 uAnchorDirection;
      uniform vec3 uEast;
      uniform vec3 uNorth;
      uniform float uCapAngle;
      varying vec3 vBodyDirection;
      varying vec3 vViewNormal;
      varying vec3 vViewDirection;
      void main() {
        float extent = tan(uCapAngle);
        vec3 direction = normalize(
          uAnchorDirection + (position.x * uEast + position.y * uNorth) * extent
        );
        vBodyDirection = direction;
        vec4 viewPosition = modelViewMatrix * vec4(direction, 1.0);
        vViewNormal = normalize(normalMatrix * direction);
        vViewDirection = normalize(-viewPosition.xyz);
        gl_Position = projectionMatrix * viewPosition;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: OCEAN_FRAGMENT_SHADER,
    // Water is independently tinted, but it is the authoritative depth
    // surface. Blending the raw seafloor through it creates a second ground.
    transparent: false,
    depthWrite: true,
    side: THREE.FrontSide,
  });
  material.name = `terrestrial-ocean-cap:${quality}`;
  material.userData.quality = quality;
  material.userData.shoreMaskFallback = shoreMask === null;
  material.userData.oceanCap = true;
  attachTerrestrialAerialPerspective(material, aerialPerspective);
  bindTerrestrialAerialPerspectiveUniforms(material, aerialPerspective);
  material.customProgramCacheKey = () => `terrestrial-ocean-v5:${quality}:${surfaceClasses?.hasGlobal ? 'class' : 'legacy'}`;
  return material;
}
