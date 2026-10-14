import * as THREE from 'three';
import type { AtmosphereDef, Body } from '../../sim/universe';
import type { BodyRenderFrame } from '../bodyRenderer';
import { BODY_VISUALS, type BodyId } from '../../content/bodyVisuals';
import {
  ATMOSPHERE_SCATTERING_GLSL,
  applyAtmosphereScatteringProfile,
  bindAtmosphereScatteringUniforms,
  createAtmosphereScatteringState,
  atmosphereSurfaceHazeScale,
  integrateAtmosphere,
  type AtmosphereScatteringProfile,
  type AtmosphereScatteringState,
} from '../atmosphereScattering';
import { terrestrialScatteringProfile } from './atmosphereLuts';

/** Stable material.userData key shared by every terrestrial aerial consumer. */
export const TERRESTRIAL_AERIAL_USER_DATA_KEY = 'terrestrialAerialPerspective' as const;

export interface TerrestrialAerialPerspectiveState {
  readonly consumer: string;
  readonly cameraBodyFixed: { value: THREE.Vector3 };
  readonly bodyRadius: { value: number };
  readonly atmosphereHeight: { value: number };
  readonly scaleHeight: { value: number };
  readonly sunDirection: { value: THREE.Vector3 };
  readonly solarVisibleFraction: { value: number };
  readonly presentationVisibility: { value: number };
  readonly lookup: { value: THREE.Texture | null };
  readonly useLookup: { value: number };
  readonly scattering: AtmosphereScatteringState;
  profileKey: string | null;
}

export function createTerrestrialAerialPerspectiveState(
  consumer: string,
  bodyRadius = 1,
): TerrestrialAerialPerspectiveState {
  if (!consumer) throw new Error('Aerial perspective consumer requires a stable name');
  if (!(bodyRadius > 0) || !Number.isFinite(bodyRadius)) {
    throw new Error(`Invalid aerial perspective body radius ${bodyRadius}`);
  }
  return {
    consumer,
    cameraBodyFixed: { value: new THREE.Vector3() },
    bodyRadius: { value: bodyRadius },
    atmosphereHeight: { value: 0 },
    scaleHeight: { value: 1 },
    sunDirection: { value: new THREE.Vector3(1, 0, 0) },
    solarVisibleFraction: { value: 1 },
    presentationVisibility: { value: 1 },
    lookup: { value: null },
    useLookup: { value: 0 },
    scattering: createAtmosphereScatteringState(),
    profileKey: null,
  };
}

const PROFILE_CACHE = new Map<string, AtmosphereScatteringProfile>();

/** Scattering profile for an atmosphere-bearing body, shared by all consumers. */
export function bodyScatteringProfile(body: Readonly<Body>): AtmosphereScatteringProfile | null {
  const physical = body.def.atmosphere;
  if (!physical) return null;
  const visual = BODY_VISUALS[body.id as BodyId]?.atmosphereVisual ?? { wavelengthTint: [1, 1, 1] as const, strength: 1 };
  const key = `${body.id}:${body.radius}:${physical.height}:${physical.scaleHeight}:${physical.seaLevelDensity}`;
  let profile = PROFILE_CACHE.get(key);
  if (!profile) {
    profile = terrestrialScatteringProfile(body.radius, physical, visual);
    PROFILE_CACHE.set(key, profile);
  }
  return profile;
}

/** Load the body's scattering coefficients into an aerial state when they change. */
export function syncAerialScatteringProfile(
  state: TerrestrialAerialPerspectiveState,
  body: Readonly<Body>,
): void {
  const profile = bodyScatteringProfile(body);
  const key = profile ? `${body.id}:${profile.radius}` : null;
  if (key === state.profileKey) return;
  state.profileKey = key;
  if (profile) applyAtmosphereScatteringProfile(state.scattering, profile);
}

export function attachTerrestrialAerialPerspective(
  material: THREE.Material,
  state: TerrestrialAerialPerspectiveState,
): void {
  material.userData[TERRESTRIAL_AERIAL_USER_DATA_KEY] = state;
}

export function terrestrialAerialPerspectiveState(
  material: THREE.Material,
): TerrestrialAerialPerspectiveState | undefined {
  return material.userData[TERRESTRIAL_AERIAL_USER_DATA_KEY] as
    | TerrestrialAerialPerspectiveState
    | undefined;
}

export function bindTerrestrialAerialPerspectiveUniforms(
  shader: { uniforms: Record<string, { value: unknown }> },
  state: TerrestrialAerialPerspectiveState,
): void {
  shader.uniforms.terrestrialAerialCameraBodyFixed = state.cameraBodyFixed;
  shader.uniforms.terrestrialAerialBodyRadius = state.bodyRadius;
  shader.uniforms.terrestrialAerialAtmosphereHeight = state.atmosphereHeight;
  shader.uniforms.terrestrialAerialScaleHeight = state.scaleHeight;
  shader.uniforms.terrestrialAerialSunDirection = state.sunDirection;
  shader.uniforms.terrestrialAerialSolarVisibleFraction = state.solarVisibleFraction;
  shader.uniforms.terrestrialAerialPresentationVisibility = state.presentationVisibility;
  shader.uniforms.terrestrialAerialLut = state.lookup;
  shader.uniforms.useTerrestrialAerialLut = state.useLookup;
  bindAtmosphereScatteringUniforms(shader, state.scattering);
}

export function updateTerrestrialAerialPerspective(
  material: THREE.Material,
  body: Readonly<Body>,
  frame: Pick<BodyRenderFrame,
    'cameraBodyFixed' | 'bodySunDirection' | 'solarVisibleFraction'>,
  lookup?: THREE.Texture,
): void {
  const state = terrestrialAerialPerspectiveState(material);
  if (!state) return;
  state.cameraBodyFixed.value.set(
    frame.cameraBodyFixed.x,
    frame.cameraBodyFixed.y,
    frame.cameraBodyFixed.z,
  );
  state.bodyRadius.value = body.radius;
  state.atmosphereHeight.value = body.def.atmosphere?.height ?? 0;
  state.scaleHeight.value = body.def.atmosphere?.scaleHeight ?? 1;
  state.sunDirection.value.set(
    frame.bodySunDirection.x,
    frame.bodySunDirection.y,
    frame.bodySunDirection.z,
  ).normalize();
  state.solarVisibleFraction.value = Math.max(0, Math.min(1, frame.solarVisibleFraction));
  const cameraAltitude = Math.max(0, state.cameraBodyFixed.value.length() - body.radius);
  state.presentationVisibility.value = surfaceAerialPerspectiveWeight(
    cameraAltitude,
    body.def.atmosphere?.height ?? 0,
  );
  syncAerialScatteringProfile(state, body);
  state.lookup.value = lookup ?? null;
  state.useLookup.value = lookup ? 1 : 0;
}

/**
 * Shared fragment function. Consumers pass an explicit body-fixed shaded point
 * so no material has to infer coordinate conventions from another shader.
 */
export const TERRESTRIAL_AERIAL_FRAGMENT_GLSL = /* glsl */ `
${ATMOSPHERE_SCATTERING_GLSL}
uniform vec3 terrestrialAerialCameraBodyFixed;
uniform float terrestrialAerialBodyRadius;
uniform float terrestrialAerialAtmosphereHeight;
uniform float terrestrialAerialScaleHeight;
uniform vec3 terrestrialAerialSunDirection;
uniform float terrestrialAerialSolarVisibleFraction;
uniform float terrestrialAerialPresentationVisibility;
uniform sampler2D terrestrialAerialLut;
uniform float useTerrestrialAerialLut;
#ifndef TERRESTRIAL_AERIAL_STEPS
#define TERRESTRIAL_AERIAL_STEPS 6
#endif

// Physically integrated haze between the camera and an opaque surface point.
// The camera-inside-atmosphere case is owned here; from above the atmosphere
// the sky shell integrates the identical path, so this returns the base colour.
vec3 applyTerrestrialAerialPerspective(vec3 shadedPointBodyFixed, vec3 baseColor) {
  if (terrestrialAerialAtmosphereHeight <= 0.0 || terrestrialAerialPresentationVisibility <= 0.0) return baseColor;
  float inverseRadius = 1.0 / max(terrestrialAerialBodyRadius, 1.0);
  vec3 camera = terrestrialAerialCameraBodyFixed * inverseRadius;
  vec3 segment = shadedPointBodyFixed * inverseRadius - camera;
  float distance = length(segment);
  if (distance <= 1e-9) return baseColor;
  vec3 direction = segment / distance;
  vec2 top = atmoRaySphere(camera, direction, atmoTopRadius);
  float tStart = max(0.0, top.x);
  float tEnd = min(distance, top.y);
  if (tEnd <= tStart) return baseColor;
  vec3 inscatter;
  vec3 transmittance;
  atmoIntegrate(camera, direction, tStart, tEnd, normalize(terrestrialAerialSunDirection),
    TERRESTRIAL_AERIAL_STEPS, inscatter, transmittance);
  inscatter *= terrestrialAerialSolarVisibleFraction
    * atmoSurfaceHazeScale(normalize(shadedPointBodyFixed), direction);
  vec3 hazed = baseColor * transmittance + inscatter;
  return mix(baseColor, hazed, terrestrialAerialPresentationVisibility);
}

// Direct-light colour reaching a surface point through the atmosphere.
vec3 terrestrialSurfaceSunTint(vec3 shadedPointBodyFixed) {
  if (terrestrialAerialAtmosphereHeight <= 0.0) return vec3(1.0);
  return atmoSurfaceSunTint(shadedPointBodyFixed / max(terrestrialAerialBodyRadius, 1.0),
    normalize(terrestrialAerialSunDirection));
}
`;

export interface CpuAerialPerspectiveInput {
  readonly shadedPointBodyFixed: Readonly<{ x: number; y: number; z: number }>;
  readonly baseColor: readonly [number, number, number];
  readonly cameraBodyFixed: Readonly<{ x: number; y: number; z: number }>;
  readonly bodyRadius: number;
  readonly atmosphereHeight: number;
  readonly scaleHeight: number;
  readonly sunDirection: Readonly<{ x: number; y: number; z: number }>;
  readonly solarVisibleFraction: number;
  readonly lookupSample?: readonly [number, number, number, number];
}

export interface CpuAerialPerspectiveResult {
  readonly color: readonly [number, number, number];
  readonly amount: number;
  readonly airPath: number;
}

/**
 * Ownership of ground haze. Inside the atmosphere opaque consumers integrate
 * camera-to-surface haze themselves; above it the sky shell is rasterized in
 * front of the planet and integrates the same path. The switch happens at the
 * exact altitude where the shell flips from back to front faces, so the two
 * presentations agree at the boundary instead of double-counting below it.
 */
export function surfaceAerialPerspectiveWeight(
  altitudeMeters: number,
  atmosphereHeightMeters: number,
): number {
  if (!(atmosphereHeightMeters > 0)) return 0;
  return altitudeMeters < atmosphereHeightMeters ? 1 : 0;
}

function normalized(
  vector: Readonly<{ x: number; y: number; z: number }>,
): readonly [number, number, number] {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return length > 0 && Number.isFinite(length)
    ? [vector.x / length, vector.y / length, vector.z / length]
    : [1, 0, 0];
}

/** CPU mirror of applyTerrestrialAerialPerspective for an Earth-like profile. */
export function evaluateTerrestrialAerialPerspective(
  input: Readonly<CpuAerialPerspectiveInput>,
): CpuAerialPerspectiveResult {
  const cameraAltitude = Math.hypot(input.cameraBodyFixed.x, input.cameraBodyFixed.y, input.cameraBodyFixed.z)
    - input.bodyRadius;
  const weight = surfaceAerialPerspectiveWeight(cameraAltitude, input.atmosphereHeight);
  if (!(input.atmosphereHeight > 0) || weight <= 0) {
    return Object.freeze({ color: input.baseColor, amount: 0, airPath: 0 });
  }
  const profile = terrestrialScatteringProfile(input.bodyRadius, {
    seaLevelPressure: 101_325,
    scaleHeight: input.scaleHeight,
    height: input.atmosphereHeight,
    seaLevelDensity: 1.225,
    seaLevelTemperature: 288.15,
    hasOxygen: true,
  } satisfies AtmosphereDef, { wavelengthTint: [1, 1, 1], strength: 1 });
  const inverseRadius = 1 / input.bodyRadius;
  const camera = [
    input.cameraBodyFixed.x * inverseRadius,
    input.cameraBodyFixed.y * inverseRadius,
    input.cameraBodyFixed.z * inverseRadius,
  ] as const;
  const segment = [
    input.shadedPointBodyFixed.x * inverseRadius - camera[0],
    input.shadedPointBodyFixed.y * inverseRadius - camera[1],
    input.shadedPointBodyFixed.z * inverseRadius - camera[2],
  ];
  const distance = Math.hypot(segment[0], segment[1], segment[2]);
  if (!(distance > 0)) return Object.freeze({ color: input.baseColor, amount: 0, airPath: 0 });
  const direction = [segment[0] / distance, segment[1] / distance, segment[2] / distance] as const;
  const top = 1 + input.atmosphereHeight * inverseRadius;
  const b = camera[0] * direction[0] + camera[1] * direction[1] + camera[2] * direction[2];
  const c = camera[0] ** 2 + camera[1] ** 2 + camera[2] ** 2 - top * top;
  const discriminant = b * b - c;
  if (discriminant < 0) return Object.freeze({ color: input.baseColor, amount: 0, airPath: 0 });
  const root = Math.sqrt(discriminant);
  const tStart = Math.max(0, -b - root);
  const tEnd = Math.min(distance, -b + root);
  if (tEnd <= tStart) return Object.freeze({ color: input.baseColor, amount: 0, airPath: 0 });
  const result = integrateAtmosphere(profile, camera, direction, tStart, tEnd, normalized(input.sunDirection), 6);
  const pointRadius = Math.hypot(input.shadedPointBodyFixed.x, input.shadedPointBodyFixed.y, input.shadedPointBodyFixed.z) || 1;
  const viewCosine = -(
    input.shadedPointBodyFixed.x * direction[0]
    + input.shadedPointBodyFixed.y * direction[1]
    + input.shadedPointBodyFixed.z * direction[2]
  ) / pointRadius;
  const visibility = Math.max(0, Math.min(1, input.solarVisibleFraction)) * atmosphereSurfaceHazeScale(viewCosine);
  const color = input.baseColor.map((channel, index) => (
    channel * result.transmittance[index] + result.inscatter[index] * visibility
  )) as [number, number, number];
  const amount = 1 - (result.transmittance[0] + result.transmittance[1] + result.transmittance[2]) / 3;
  return Object.freeze({
    color: Object.freeze(color),
    amount,
    airPath: (tEnd - tStart) * input.bodyRadius,
  });
}
