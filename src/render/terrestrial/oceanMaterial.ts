import * as THREE from 'three';
import type { QualityTier } from '../bodyRenderer';
import {
  attachTerrestrialAerialPerspective,
  bindTerrestrialAerialPerspectiveUniforms,
  createTerrestrialAerialPerspectiveState,
  TERRESTRIAL_AERIAL_FRAGMENT_GLSL,
} from './aerialPerspective';

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
    wavelengthMeters: 46,
    phaseSpeedRadiansPerSecond: 0.16,
    phaseOffset: 0.4,
    slopeAmplitude: 0.045,
  }),
  Object.freeze({
    direction: unitDirection(-0.24, 0.91, 0.33),
    wavelengthMeters: 19,
    phaseSpeedRadiansPerSecond: -0.31,
    phaseOffset: 2.1,
    slopeAmplitude: 0.030,
  }),
  Object.freeze({
    direction: unitDirection(0.46, -0.52, 0.72),
    wavelengthMeters: 7.5,
    phaseSpeedRadiansPerSecond: 0.54,
    phaseOffset: 4.7,
    slopeAmplitude: 0.018,
  }),
]);

export const OCEAN_MAX_NORMAL_SLOPE = 0.1;

const WAVE_POLICY_BY_QUALITY: Readonly<Record<QualityTier, {
  readonly componentCount: number;
  readonly slopeScale: number;
}>> = Object.freeze({
  low: Object.freeze({ componentCount: 1, slopeScale: 0.65 }),
  medium: Object.freeze({ componentCount: 2, slopeScale: 0.85 }),
  high: Object.freeze({ componentCount: 3, slopeScale: 1 }),
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
    // A component fades before its phase footprint exceeds a stable pixel.
    float phaseFootprint = fwidth(phase);
    float footprintFilter = 1.0 - smoothstep(0.75, 2.5, phaseFootprint);
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
    float totalSlope = length(gradient);
    if (totalSlope > ${OCEAN_MAX_NORMAL_SLOPE.toFixed(3)}) {
      gradient *= ${OCEAN_MAX_NORMAL_SLOPE.toFixed(3)} / totalSlope;
    }
    return normalize(bodyNormal - gradient);
  }

  void main() {
    float oceanMask = uHasShoreMask > 0.5 ? texture2D(uShoreMask, bodyUv(vBodyDirection)).b : 1.0;
    if (uHasShoreMask > 0.5 && oceanMask <= 0.01) discard;
    #include <logdepthbuf_fragment>
    float shore = 4.0 * oceanMask * (1.0 - oceanMask);
    vec3 bodyPoint = normalize(vBodyDirection) * uBodyRadius;
    vec3 waveBodyNormal = filteredOceanWaveNormal(bodyPoint, normalize(vBodyDirection));
    vec3 waveViewNormal = normalize(normalMatrix * waveBodyNormal);
    float fresnel = pow(1.0 - max(0.0, dot(waveViewNormal, normalize(vViewDirection))), 4.0);
    vec3 reflectedSun = reflect(-normalize(uSunDirection), waveBodyNormal);
    vec3 bodyView = normalize(uCameraBodyFixed - vBodyDirection * uBodyRadius);
    float glitter = pow(max(0.0, dot(reflectedSun, bodyView)), 96.0) *
      uGlitterStrength * uSolarVisibility;
    vec3 skyReflection = mix(vec3(0.025, 0.09, 0.18), vec3(0.32, 0.55, 0.82),
      pow(1.0 - max(0.0, dot(waveViewNormal, normalize(vViewDirection))), 0.65));
    vec3 depthTint = mix(uOceanColor * 1.18, skyReflection, 0.26 + fresnel * 0.64);
    vec3 foam = vec3(0.72, 0.82, 0.84) * shore;
    vec3 oceanBaseColor = depthTint + foam * 0.64 + glitter * 0.62;
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
): THREE.ShaderMaterial {
  configureShoreMask(shoreMask);
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
  material.customProgramCacheKey = () => `terrestrial-ocean-v3:${quality}`;
  return material;
}
