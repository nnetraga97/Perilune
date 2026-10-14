import * as THREE from 'three';

/**
 * Physically based single scattering with an approximate multiple-scattering
 * fill, shared by every atmosphere consumer: sky shells, surface aerial
 * perspective, cloud lighting, and compact-planet limb haze.
 *
 * All shader math runs in units of the body radius. Orbital camera positions
 * then stay near 1.0 in float32, and one profile scales to any planet size.
 * Sun transmittance uses an analytic Chapman grazing-incidence approximation,
 * so terminator reddening and the planet's shadow fall out of the same column
 * density instead of hand-tuned day/night blends.
 */
export interface AtmosphereScatteringProfile {
  /** Reference surface radius in metres. */
  readonly radius: number;
  /** Top of the rendered atmosphere above the reference surface, metres. */
  readonly height: number;
  readonly rayleighScaleHeight: number;
  readonly mieScaleHeight: number;
  /** Rayleigh scattering at the reference surface, per metre (RGB). */
  readonly rayleigh: readonly [number, number, number];
  /** Aerosol scattering at the reference surface, per metre (RGB). */
  readonly mieScattering: readonly [number, number, number];
  /** Aerosol extinction at the reference surface, per metre (RGB). */
  readonly mieExtinction: readonly [number, number, number];
  /** Absorption that follows the Rayleigh column (ozone-like), per metre (RGB). */
  readonly absorption: readonly [number, number, number];
  /** Henyey-Greenstein asymmetry for aerosols. */
  readonly mieG: number;
  /** Strength of the isotropic multiple-scattering fill (0 disables). */
  readonly multipleScattering: number;
  /** Solar irradiance in scene radiance units; matches the key light. */
  readonly sunIlluminance: number;
}

export interface AtmosphereScatteringState {
  readonly topRadius: { value: number };
  readonly rayleighScaleHeight: { value: number };
  readonly mieScaleHeight: { value: number };
  readonly rayleigh: { value: THREE.Vector3 };
  readonly mieScattering: { value: THREE.Vector3 };
  readonly mieExtinction: { value: THREE.Vector3 };
  readonly absorption: { value: THREE.Vector3 };
  readonly mieG: { value: number };
  readonly multipleScattering: { value: number };
  readonly sunIlluminance: { value: number };
}

/** Earth-like defaults (Bruneton/Hillaire reference coefficients). */
export const EARTH_RAYLEIGH_SCATTERING = [5.802e-6, 13.558e-6, 33.1e-6] as const;
export const EARTH_MIE_SCATTERING = 3.996e-6;
export const EARTH_MIE_EXTINCTION = 4.44e-6;
export const EARTH_OZONE_ABSORPTION = [0.65e-6, 1.881e-6, 0.085e-6] as const;

export function createAtmosphereScatteringState(): AtmosphereScatteringState {
  return {
    topRadius: { value: 1 },
    rayleighScaleHeight: { value: 1 },
    mieScaleHeight: { value: 1 },
    rayleigh: { value: new THREE.Vector3() },
    mieScattering: { value: new THREE.Vector3() },
    mieExtinction: { value: new THREE.Vector3() },
    absorption: { value: new THREE.Vector3() },
    mieG: { value: 0.8 },
    multipleScattering: { value: 0 },
    sunIlluminance: { value: 1 },
  };
}

/** Load a metre-based profile into radius-normalized shader uniforms. */
export function applyAtmosphereScatteringProfile(
  state: AtmosphereScatteringState,
  profile: Readonly<AtmosphereScatteringProfile>,
): void {
  const r = profile.radius;
  if (!(r > 0) || !Number.isFinite(r)) throw new Error(`Invalid atmosphere radius ${r}`);
  state.topRadius.value = 1 + profile.height / r;
  state.rayleighScaleHeight.value = profile.rayleighScaleHeight / r;
  state.mieScaleHeight.value = profile.mieScaleHeight / r;
  state.rayleigh.value.set(profile.rayleigh[0] * r, profile.rayleigh[1] * r, profile.rayleigh[2] * r);
  state.mieScattering.value.set(
    profile.mieScattering[0] * r,
    profile.mieScattering[1] * r,
    profile.mieScattering[2] * r,
  );
  state.mieExtinction.value.set(
    profile.mieExtinction[0] * r,
    profile.mieExtinction[1] * r,
    profile.mieExtinction[2] * r,
  );
  state.absorption.value.set(profile.absorption[0] * r, profile.absorption[1] * r, profile.absorption[2] * r);
  state.mieG.value = profile.mieG;
  state.multipleScattering.value = profile.multipleScattering;
  state.sunIlluminance.value = profile.sunIlluminance;
}

export function bindAtmosphereScatteringUniforms(
  shader: { uniforms: Record<string, { value: unknown }> },
  state: AtmosphereScatteringState,
): void {
  shader.uniforms.atmoTopRadius = state.topRadius;
  shader.uniforms.atmoRayleighScaleHeight = state.rayleighScaleHeight;
  shader.uniforms.atmoMieScaleHeight = state.mieScaleHeight;
  shader.uniforms.atmoRayleigh = state.rayleigh;
  shader.uniforms.atmoMieScattering = state.mieScattering;
  shader.uniforms.atmoMieExtinction = state.mieExtinction;
  shader.uniforms.atmoAbsorption = state.absorption;
  shader.uniforms.atmoMieG = state.mieG;
  shader.uniforms.atmoMultipleScattering = state.multipleScattering;
  shader.uniforms.atmoSunIlluminance = state.sunIlluminance;
}

/**
 * Shared GLSL. Include once per program; the guard makes repeated inclusion
 * through several snippets harmless.
 */
/** Fraction of in-scattered light kept over ground seen near-vertically. */
export const ATMOSPHERE_SURFACE_HAZE = 0.55;

/** CPU mirror of atmoSurfaceHazeScale. */
export function atmosphereSurfaceHazeScale(viewCosine: number): number {
  const t = Math.min(1, Math.max(0, (Math.max(viewCosine, 0) - 0.05) / 0.3));
  return 1 + (ATMOSPHERE_SURFACE_HAZE - 1) * t * t * (3 - 2 * t);
}

export const ATMOSPHERE_SCATTERING_GLSL = /* glsl */ `
#ifndef PERILUNE_ATMOSPHERE_SCATTERING
#define PERILUNE_ATMOSPHERE_SCATTERING
uniform float atmoTopRadius;
uniform float atmoRayleighScaleHeight;
uniform float atmoMieScaleHeight;
uniform vec3 atmoRayleigh;
uniform vec3 atmoMieScattering;
uniform vec3 atmoMieExtinction;
uniform vec3 atmoAbsorption;
uniform float atmoMieG;
uniform float atmoMultipleScattering;
uniform float atmoSunIlluminance;

vec2 atmoRaySphere(vec3 origin, vec3 direction, float radius) {
  float b = dot(origin, direction);
  float c = dot(origin, origin) - radius * radius;
  float discriminant = b * b - c;
  if (discriminant < 0.0) return vec2(1.0, -1.0);
  float root = sqrt(discriminant);
  return vec2(-b - root, -b + root);
}

// Column of normalized density from radius r toward zenith cosine mu, for an
// exponential layer of scale height H (all in body radii). Schuler-style
// Chapman approximation; below the local horizon the ray descends to its
// tangent point and climbs out, which reddens and then extinguishes sunlight.
float atmoColumn(float r, float mu, float scaleHeight) {
  float x = r / scaleHeight;
  float altitude = (r - 1.0) / scaleHeight;
  float horizontal = sqrt(1.5707963 * x);
  float climb = 1.0 / (abs(mu) + 1.0 / horizontal);
  if (mu >= 0.0) return scaleHeight * exp(-altitude) * climb;
  float sinChi = sqrt(max(0.0, 1.0 - mu * mu));
  float tangentX = x * sinChi;
  float tangentAltitude = (r * sinChi - 1.0) / scaleHeight;
  float descent = 2.0 * sqrt(1.5707963 * tangentX) * exp(-max(tangentAltitude, -40.0));
  return scaleHeight * max(descent - exp(-altitude) * climb, 0.0);
}

vec3 atmoExtinctionForColumns(float rayleighColumn, float mieColumn) {
  return (atmoRayleigh + atmoAbsorption) * rayleighColumn + atmoMieExtinction * mieColumn;
}

// Fraction of the solar disk above the planet's limb as seen from radius r.
float atmoPlanetShadow(float r, float mu) {
  float horizonMu = -sqrt(max(0.0, 1.0 - 1.0 / (r * r)));
  return smoothstep(horizonMu - 0.006, horizonMu + 0.006, mu);
}

vec3 atmoSunTransmittance(float r, float mu) {
  float rayleighColumn = atmoColumn(r, mu, atmoRayleighScaleHeight);
  float mieColumn = atmoColumn(r, mu, atmoMieScaleHeight);
  return exp(-atmoExtinctionForColumns(rayleighColumn, mieColumn)) * atmoPlanetShadow(r, mu);
}

// Direct sunlight colour at a surface point relative to a high noon sun.
vec3 atmoSurfaceSunTint(vec3 unitPosition, vec3 sunDirection) {
  float r = max(length(unitPosition), 1.0);
  float mu = dot(unitPosition / max(length(unitPosition), 1e-6), sunDirection);
  vec3 zenith = atmoSunTransmittance(r, 1.0);
  return atmoSunTransmittance(r, mu) / max(zenith, vec3(1e-4));
}

float atmoRayleighPhase(float cosine) {
  return 0.0596831 * (1.0 + cosine * cosine);
}

float atmoMiePhase(float cosine, float g) {
  float g2 = g * g;
  return 0.1193662 * (1.0 - g2) * (1.0 + cosine * cosine)
    / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * cosine, 1e-4), 1.5));
}

// Sky irradiance proxy for the multiple-scattering fill: present while any
// part of the sky column is sunlit, fading through astronomical twilight.
float atmoMultipleScatteringLight(float mu) {
  return atmoMultipleScattering * smoothstep(-0.28, 0.12, mu);
}

// Integrate in-scattered radiance (scaled by solar illuminance) and view
// transmittance over [tStart, tEnd] along origin + direction * t. Samples are
// clustered toward the lowest point of the segment, where density peaks: the
// tangent point for limb rays and the ground for downward rays.
void atmoIntegrate(
  vec3 origin,
  vec3 direction,
  float tStart,
  float tEnd,
  vec3 sunDirection,
  int steps,
  out vec3 inscatter,
  out vec3 transmittance
) {
  inscatter = vec3(0.0);
  transmittance = vec3(1.0);
  if (tEnd <= tStart) return;
  float tLowest = clamp(-dot(origin, direction), tStart, tEnd);
  float span = tEnd - tStart;
  float split = (tLowest - tStart) / span;
  float cosine = dot(direction, sunDirection);
  float phaseR = atmoRayleighPhase(cosine);
  float phaseM = atmoMiePhase(cosine, atmoMieG);
  float stepCount = float(steps);
  for (int index = 0; index < 48; index++) {
    if (index >= steps) break;
    float s = (float(index) + 0.5) / stepCount;
    float t;
    float dt;
    if (s < split) {
      float local = 1.0 - s / split;
      t = tLowest - (tLowest - tStart) * local * local;
      dt = 2.0 * (tLowest - tStart) * local / (split * stepCount);
    } else {
      float local = (s - split) / max(1.0 - split, 1e-5);
      t = tLowest + (tEnd - tLowest) * local * local;
      dt = 2.0 * (tEnd - tLowest) * local / (max(1.0 - split, 1e-5) * stepCount);
    }
    vec3 samplePosition = origin + direction * t;
    float r = length(samplePosition);
    float altitude = max(r - 1.0, 0.0);
    float densityR = exp(-altitude / atmoRayleighScaleHeight);
    float densityM = exp(-altitude / atmoMieScaleHeight);
    float sunMu = dot(samplePosition / max(r, 1e-6), sunDirection);
    vec3 sunlight = atmoSunTransmittance(max(r, 1.0), sunMu);
    float ambient = atmoMultipleScatteringLight(sunMu) * 0.0795775;
    vec3 scattering = atmoRayleigh * densityR * (sunlight * phaseR + ambient)
      + atmoMieScattering * densityM * (sunlight * phaseM + ambient);
    vec3 extinction = (atmoRayleigh + atmoAbsorption) * densityR + atmoMieExtinction * densityM;
    vec3 segmentTransmittance = exp(-extinction * dt);
    // Energy-conserving segment integral (Hillaire 2015).
    vec3 safeExtinction = max(extinction, vec3(1e-7));
    inscatter += transmittance * scattering * (1.0 - segmentTransmittance) / safeExtinction;
    transmittance *= segmentTransmittance;
  }
  inscatter *= atmoSunIlluminance;
}

// Art-directed share of in-scattered light kept over opaque ground. Physical
// path radiance outshines vegetation in blue (uncorrected satellite imagery);
// a camera or eye sees the corrected scene. Grazing views keep full haze so
// the horizon and limb stay continuous with sky rays that miss the ground.
float atmoSurfaceHazeScale(vec3 surfaceUnitNormal, vec3 viewDirection) {
  float viewCosine = max(dot(surfaceUnitNormal, -viewDirection), 0.0);
  return mix(1.0, ${ATMOSPHERE_SURFACE_HAZE.toFixed(3)}, smoothstep(0.05, 0.35, viewCosine));
}

// Per-channel view transmittance over [tStart, tEnd], density only. Used by
// the multiplicative shell pass: one alpha cannot carry the red/blue split, and
// a grey alpha over-dims red and under-dims blue beneath the haze.
vec3 atmoTransmittanceAlong(vec3 origin, vec3 direction, float tStart, float tEnd, int steps) {
  if (tEnd <= tStart) return vec3(1.0);
  float tLowest = clamp(-dot(origin, direction), tStart, tEnd);
  float span = tEnd - tStart;
  float split = (tLowest - tStart) / span;
  float stepCount = float(steps);
  float rayleighColumn = 0.0;
  float mieColumn = 0.0;
  for (int index = 0; index < 48; index++) {
    if (index >= steps) break;
    float s = (float(index) + 0.5) / stepCount;
    float t;
    float dt;
    if (s < split) {
      float local = 1.0 - s / split;
      t = tLowest - (tLowest - tStart) * local * local;
      dt = 2.0 * (tLowest - tStart) * local / (split * stepCount);
    } else {
      float local = (s - split) / max(1.0 - split, 1e-5);
      t = tLowest + (tEnd - tLowest) * local * local;
      dt = 2.0 * (tEnd - tLowest) * local / (max(1.0 - split, 1e-5) * stepCount);
    }
    float altitude = max(length(origin + direction * t) - 1.0, 0.0);
    rayleighColumn += exp(-altitude / atmoRayleighScaleHeight) * dt;
    mieColumn += exp(-altitude / atmoMieScaleHeight) * dt;
  }
  return exp(-atmoExtinctionForColumns(rayleighColumn, mieColumn));
}
#endif
`;

// ---------------------------------------------------------------------------
// CPU mirror used by tests and by CPU-side lighting decisions.

function columnDensity(r: number, mu: number, scaleHeight: number): number {
  const x = r / scaleHeight;
  const altitude = (r - 1) / scaleHeight;
  const horizontal = Math.sqrt(1.5707963 * x);
  const climb = 1 / (Math.abs(mu) + 1 / horizontal);
  if (mu >= 0) return scaleHeight * Math.exp(-altitude) * climb;
  const sinChi = Math.sqrt(Math.max(0, 1 - mu * mu));
  const tangentX = x * sinChi;
  const tangentAltitude = (r * sinChi - 1) / scaleHeight;
  const descent = 2 * Math.sqrt(1.5707963 * tangentX) * Math.exp(-Math.max(tangentAltitude, -40));
  return scaleHeight * Math.max(descent - Math.exp(-altitude) * climb, 0);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Sun transmittance (RGB) at an altitude for a solar zenith cosine. */
export function atmosphereSunTransmittance(
  profile: Readonly<AtmosphereScatteringProfile>,
  altitudeMeters: number,
  sunZenithCosine: number,
): [number, number, number] {
  const r = 1 + Math.max(0, altitudeMeters) / profile.radius;
  const rayleighColumn = columnDensity(r, sunZenithCosine, profile.rayleighScaleHeight / profile.radius);
  const mieColumn = columnDensity(r, sunZenithCosine, profile.mieScaleHeight / profile.radius);
  const horizonMu = -Math.sqrt(Math.max(0, 1 - 1 / (r * r)));
  const shadow = smoothstep(horizonMu - 0.006, horizonMu + 0.006, sunZenithCosine);
  return [0, 1, 2].map((channel) => {
    const extinction = (profile.rayleigh[channel] + profile.absorption[channel]) * rayleighColumn
      + profile.mieExtinction[channel] * mieColumn;
    return Math.exp(-extinction * profile.radius) * shadow;
  }) as [number, number, number];
}

export interface AtmosphereIntegration {
  readonly inscatter: [number, number, number];
  readonly transmittance: [number, number, number];
}

/** CPU mirror of atmoIntegrate; positions and distances are in body radii. */
export function integrateAtmosphere(
  profile: Readonly<AtmosphereScatteringProfile>,
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
  tStart: number,
  tEnd: number,
  sunDirection: readonly [number, number, number],
  steps: number,
): AtmosphereIntegration {
  const inscatter: [number, number, number] = [0, 0, 0];
  const transmittance: [number, number, number] = [1, 1, 1];
  if (!(tEnd > tStart)) return { inscatter, transmittance };
  const r0 = profile.radius;
  const hr = profile.rayleighScaleHeight / r0;
  const hm = profile.mieScaleHeight / r0;
  const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const tLowest = Math.max(tStart, Math.min(tEnd, -dot(origin, direction)));
  const split = (tLowest - tStart) / (tEnd - tStart);
  const cosine = dot(direction, sunDirection);
  const phaseR = 0.0596831 * (1 + cosine * cosine);
  const g = profile.mieG;
  const phaseM = 0.1193662 * (1 - g * g) * (1 + cosine * cosine)
    / ((2 + g * g) * Math.pow(Math.max(1 + g * g - 2 * g * cosine, 1e-4), 1.5));
  for (let index = 0; index < steps; index++) {
    const s = (index + 0.5) / steps;
    let t: number;
    let dt: number;
    if (s < split) {
      const local = 1 - s / split;
      t = tLowest - (tLowest - tStart) * local * local;
      dt = 2 * (tLowest - tStart) * local / (split * steps);
    } else {
      const span = Math.max(1 - split, 1e-5);
      const local = (s - split) / span;
      t = tLowest + (tEnd - tLowest) * local * local;
      dt = 2 * (tEnd - tLowest) * local / (span * steps);
    }
    const position = [origin[0] + direction[0] * t, origin[1] + direction[1] * t, origin[2] + direction[2] * t];
    const r = Math.hypot(position[0], position[1], position[2]);
    const altitude = Math.max(r - 1, 0);
    const densityR = Math.exp(-altitude / hr);
    const densityM = Math.exp(-altitude / hm);
    const sunMu = dot(position, sunDirection) / Math.max(r, 1e-6);
    const sunlight = atmosphereSunTransmittance(profile, altitude * r0, sunMu);
    const ambient = profile.multipleScattering * smoothstep(-0.28, 0.12, sunMu) * 0.0795775;
    for (let channel = 0; channel < 3; channel++) {
      const rayleigh = profile.rayleigh[channel] * r0;
      const mieScattering = profile.mieScattering[channel] * r0;
      const scattering = rayleigh * densityR * (sunlight[channel] * phaseR + ambient)
        + mieScattering * densityM * (sunlight[channel] * phaseM + ambient);
      const extinction = (rayleigh + profile.absorption[channel] * r0) * densityR
        + profile.mieExtinction[channel] * r0 * densityM;
      const segment = Math.exp(-extinction * dt);
      inscatter[channel] += transmittance[channel] * scattering * (1 - segment) / Math.max(extinction, 1e-7);
      transmittance[channel] *= segment;
    }
  }
  for (let channel = 0; channel < 3; channel++) inscatter[channel] *= profile.sunIlluminance;
  return { inscatter, transmittance };
}
