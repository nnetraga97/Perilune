import * as THREE from 'three';
import type { Body } from '../../sim/universe';
import type { BodyRenderFrame } from '../bodyRenderer';

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
  };
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
  state.presentationVisibility.value = atmospherePresentationVisibility(
    cameraAltitude,
    body.def.atmosphere?.height ?? 0,
  );
  state.lookup.value = lookup ?? null;
  state.useLookup.value = lookup ? 1 : 0;
}

/**
 * Shared fragment function. Consumers pass an explicit body-fixed shaded point
 * so no material has to infer coordinate conventions from another shader.
 */
export const TERRESTRIAL_AERIAL_FRAGMENT_GLSL = /* glsl */ `
uniform vec3 terrestrialAerialCameraBodyFixed;
uniform float terrestrialAerialBodyRadius;
uniform float terrestrialAerialAtmosphereHeight;
uniform float terrestrialAerialScaleHeight;
uniform vec3 terrestrialAerialSunDirection;
uniform float terrestrialAerialSolarVisibleFraction;
uniform float terrestrialAerialPresentationVisibility;
uniform sampler2D terrestrialAerialLut;
uniform float useTerrestrialAerialLut;

vec3 applyTerrestrialAerialPerspective(vec3 shadedPointBodyFixed, vec3 baseColor) {
  if (terrestrialAerialAtmosphereHeight <= 0.0) return baseColor;
  vec3 radialDirection = normalize(shadedPointBodyFixed);
  vec3 viewSegment = terrestrialAerialCameraBodyFixed - shadedPointBodyFixed;
  float viewDistance = length(viewSegment);
  vec3 viewRay = viewDistance > 0.0 ? viewSegment / viewDistance : radialDirection;
  float viewUpCosine = max(0.025, abs(dot(viewRay, radialDirection)));
  float airPath = min(viewDistance, terrestrialAerialAtmosphereHeight / viewUpCosine);
  float cameraAltitude = max(0.0,
    length(terrestrialAerialCameraBodyFixed) - terrestrialAerialBodyRadius);
  float observerDensity = exp(-min(cameraAltitude, terrestrialAerialAtmosphereHeight)
    / max(terrestrialAerialScaleHeight, 1.0));
  float opticalDepth = airPath * 0.0000105 * mix(0.52, 1.0, observerDensity);
  float aerialAmount = clamp(1.0 - exp(-opticalDepth), 0.0, 0.94);
  vec2 aerialUv = vec2(clamp(airPath / 200000.0, 0.0, 1.0),
    clamp(cameraAltitude / max(terrestrialAerialAtmosphereHeight, 1.0), 0.0, 1.0));
  vec4 aerialLut = texture2D(terrestrialAerialLut, aerialUv);
  aerialAmount = mix(aerialAmount, min(0.94, aerialLut.a * 1.18),
    useTerrestrialAerialLut);
  aerialAmount *= terrestrialAerialPresentationVisibility;
  float sunElevation = dot(radialDirection, normalize(terrestrialAerialSunDirection));
  vec3 hazeColor = mix(vec3(0.30, 0.43, 0.62), vec3(0.48, 0.68, 0.96),
    smoothstep(-0.18, 0.34, sunElevation));
  hazeColor = mix(hazeColor, max(hazeColor, aerialLut.rgb * 1.7),
    useTerrestrialAerialLut);
  float occlusionLight = mix(0.08, 1.0, terrestrialAerialSolarVisibleFraction);
  return baseColor * (1.0 - aerialAmount * 0.86)
    + hazeColor * aerialAmount * occlusionLight;
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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Keep atmospheric wash in low flight, then remove it before the body becomes
 * an orbital presentation. The smooth band avoids a visible boundary pop.
 */
export function atmospherePresentationVisibility(
  altitudeMeters: number,
  atmosphereHeightMeters: number,
): number {
  if (!(atmosphereHeightMeters > 0)) return 0;
  const start = atmosphereHeightMeters;
  const end = atmosphereHeightMeters * 2;
  const t = clamp01((altitudeMeters - start) / Math.max(end - start, 1));
  const smooth = t * t * (3 - 2 * t);
  return 1 - smooth;
}

function normalized(
  vector: Readonly<{ x: number; y: number; z: number }>,
): readonly [number, number, number] {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return length > 0 && Number.isFinite(length)
    ? [vector.x / length, vector.y / length, vector.z / length]
    : [1, 0, 0];
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** CPU mirror of the analytic fallback and optional sampled-LUT blend. */
export function evaluateTerrestrialAerialPerspective(
  input: Readonly<CpuAerialPerspectiveInput>,
): CpuAerialPerspectiveResult {
  if (!(input.atmosphereHeight > 0)) {
    return Object.freeze({ color: input.baseColor, amount: 0, airPath: 0 });
  }
  const radial = normalized(input.shadedPointBodyFixed);
  const segment = {
    x: input.cameraBodyFixed.x - input.shadedPointBodyFixed.x,
    y: input.cameraBodyFixed.y - input.shadedPointBodyFixed.y,
    z: input.cameraBodyFixed.z - input.shadedPointBodyFixed.z,
  };
  const viewDistance = Math.hypot(segment.x, segment.y, segment.z);
  const viewRay = viewDistance > 0
    ? [segment.x / viewDistance, segment.y / viewDistance, segment.z / viewDistance] as const
    : radial;
  const viewUpCosine = Math.max(0.025, Math.abs(
    viewRay[0] * radial[0] + viewRay[1] * radial[1] + viewRay[2] * radial[2],
  ));
  const airPath = Math.min(viewDistance, input.atmosphereHeight / viewUpCosine);
  const cameraAltitude = Math.max(
    0,
    Math.hypot(input.cameraBodyFixed.x, input.cameraBodyFixed.y, input.cameraBodyFixed.z)
      - input.bodyRadius,
  );
  const observerDensity = Math.exp(
    -Math.min(cameraAltitude, input.atmosphereHeight) / Math.max(input.scaleHeight, 1),
  );
  let amount = clamp01(1 - Math.exp(
    -airPath * 0.0000105 * (0.52 + (1 - 0.52) * observerDensity),
  ));
  amount = Math.min(amount, 0.94);
  const lookup = input.lookupSample;
  if (lookup) amount = Math.min(0.94, lookup[3] * 1.18);
  amount *= atmospherePresentationVisibility(cameraAltitude, input.atmosphereHeight);
  const sun = normalized(input.sunDirection);
  const sunElevation = radial[0] * sun[0] + radial[1] * sun[1] + radial[2] * sun[2];
  const day = smoothstep(-0.18, 0.34, sunElevation);
  const haze: [number, number, number] = [
    0.30 + (0.48 - 0.30) * day,
    0.43 + (0.68 - 0.43) * day,
    0.62 + (0.96 - 0.62) * day,
  ];
  if (lookup) {
    haze[0] = Math.max(haze[0], lookup[0] * 1.7);
    haze[1] = Math.max(haze[1], lookup[1] * 1.7);
    haze[2] = Math.max(haze[2], lookup[2] * 1.7);
  }
  const visibility = clamp01(input.solarVisibleFraction);
  const occlusionLight = 0.08 + (1 - 0.08) * visibility;
  const color = input.baseColor.map((channel, index) => (
    channel * (1 - amount * 0.86) + haze[index] * amount * occlusionLight
  )) as [number, number, number];
  return Object.freeze({ color: Object.freeze(color), amount, airPath });
}
