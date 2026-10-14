import * as THREE from 'three';

export const SurfaceClass = Object.freeze({
  Unknown: 0,
  Land: 1,
  OpenOcean: 2,
  EstuarineDeepwater: 3,
  Intertidal: 4,
  InlandWater: 5,
  Wetland: 6,
} as const);

export type SurfaceClassCode = typeof SurfaceClass[keyof typeof SurfaceClass];
export const KSC_SURFACE_CLASS_BOUNDS_DEGREES = Object.freeze([-80.8, 28.45, -80.2, 28.75] as const);

export function decodeSurfaceClassByte(value: number): SurfaceClassCode {
  const code = Math.round(value);
  return code >= SurfaceClass.Unknown && code <= SurfaceClass.Wetland
    ? code as SurfaceClassCode
    : SurfaceClass.Unknown;
}

export function surfaceClassOwnsOcean(code: number): boolean {
  return code === SurfaceClass.OpenOcean || code === SurfaceClass.EstuarineDeepwater;
}

export function surfaceClassPermitsEarthScatter(code: number): boolean {
  return code === SurfaceClass.Land;
}

export function configureSurfaceClassTexture(texture: THREE.Texture): void {
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.anisotropy = 1;
  texture.needsUpdate = true;
}

export const SURFACE_CLASS_GLSL = /* glsl */ `
uniform sampler2D globalSurfaceClassMap;
uniform sampler2D regionalSurfaceClassMap;
uniform float useGlobalSurfaceClassMap;
uniform float useRegionalSurfaceClassMap;
uniform vec4 regionalSurfaceClassBoundsRadians;

float decodeSurfaceClass(float encoded) {
  return floor(encoded * 255.0 + 0.5);
}

float resolvedSurfaceClass(vec3 rawDirection) {
  vec3 direction = normalize(rawDirection);
  vec2 uv = bodyFixedUv(direction);
  float parentClass = useGlobalSurfaceClassMap > 0.5
    ? decodeSurfaceClass(texture2D(globalSurfaceClassMap, uv).r)
    : 0.0;
  if (useRegionalSurfaceClassMap < 0.5) return parentClass;
  float longitude = atan(direction.y, direction.x);
  float latitude = asin(clamp(direction.z, -1.0, 1.0));
  vec4 bounds = regionalSurfaceClassBoundsRadians;
  if (longitude < bounds.x || longitude > bounds.z || latitude < bounds.y || latitude > bounds.w) {
    return parentClass;
  }
  vec2 regionalUv = vec2(
    (longitude - bounds.x) / max(bounds.z - bounds.x, 1e-8),
    (bounds.w - latitude) / max(bounds.w - bounds.y, 1e-8)
  );
  float childClass = decodeSurfaceClass(texture2D(regionalSurfaceClassMap, regionalUv).r);
  return childClass > 0.5 ? childClass : parentClass;
}

float surfaceClassOcean(float code) {
  return (abs(code - 2.0) < 0.25 || abs(code - 3.0) < 0.25) ? 1.0 : 0.0;
}

// Presentation-only ocean coverage. The categorical class stays exact for
// gameplay, but shading a ~10 km nearest-sampled class texel snaps orbital
// coastlines into stair steps. Bilinearly blend the binary ocean indicator of
// the four surrounding parent texels instead; the finer regional map, where
// present, keeps its exact categorical edge.
float surfaceClassOceanCoverage(vec3 rawDirection) {
  vec3 direction = normalize(rawDirection);
  if (useRegionalSurfaceClassMap > 0.5) {
    float longitude = atan(direction.y, direction.x);
    float latitude = asin(clamp(direction.z, -1.0, 1.0));
    vec4 bounds = regionalSurfaceClassBoundsRadians;
    if (longitude >= bounds.x && longitude <= bounds.z && latitude >= bounds.y && latitude <= bounds.w) {
      return surfaceClassOcean(resolvedSurfaceClass(direction));
    }
  }
  if (useGlobalSurfaceClassMap < 0.5) return 0.0;
  vec2 size = vec2(textureSize(globalSurfaceClassMap, 0));
  vec2 texel = bodyFixedUv(direction) * size - 0.5;
  vec2 base = floor(texel);
  vec2 f = texel - base;
  vec2 inverseSize = 1.0 / size;
  float c00 = surfaceClassOcean(decodeSurfaceClass(texture2D(globalSurfaceClassMap, (base + vec2(0.5, 0.5)) * inverseSize).r));
  float c10 = surfaceClassOcean(decodeSurfaceClass(texture2D(globalSurfaceClassMap, (base + vec2(1.5, 0.5)) * inverseSize).r));
  float c01 = surfaceClassOcean(decodeSurfaceClass(texture2D(globalSurfaceClassMap, (base + vec2(0.5, 1.5)) * inverseSize).r));
  float c11 = surfaceClassOcean(decodeSurfaceClass(texture2D(globalSurfaceClassMap, (base + vec2(1.5, 1.5)) * inverseSize).r));
  float blended = mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
  return smoothstep(0.2, 0.8, blended);
}
`;

export interface SurfaceClassTextureSet {
  readonly global: THREE.Texture;
  readonly regional: THREE.Texture;
  readonly hasGlobal: boolean;
  readonly hasRegional: boolean;
  readonly owned: readonly THREE.Texture[];
}

function fallbackClassTexture(code: SurfaceClassCode): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array([code, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
  configureSurfaceClassTexture(texture);
  return texture;
}

export function resolveSurfaceClassTextures(textures: ReadonlyMap<string, THREE.Texture> | null): SurfaceClassTextureSet {
  const owned: THREE.Texture[] = [];
  const global = textures?.get('surfaceClass') ?? fallbackClassTexture(SurfaceClass.Unknown);
  const regional = textures?.get('surfaceClassRegional') ?? fallbackClassTexture(SurfaceClass.Unknown);
  if (!textures?.has('surfaceClass')) owned.push(global);
  if (!textures?.has('surfaceClassRegional')) owned.push(regional);
  configureSurfaceClassTexture(global);
  configureSurfaceClassTexture(regional);
  return {
    global,
    regional,
    hasGlobal: textures?.has('surfaceClass') === true,
    hasRegional: textures?.has('surfaceClassRegional') === true,
    owned,
  };
}

export function bindSurfaceClassUniforms(
  shader: { uniforms: Record<string, { value: unknown }> },
  textures: Readonly<SurfaceClassTextureSet>,
): void {
  shader.uniforms.globalSurfaceClassMap = { value: textures.global };
  shader.uniforms.regionalSurfaceClassMap = { value: textures.regional };
  shader.uniforms.useGlobalSurfaceClassMap = { value: textures.hasGlobal ? 1 : 0 };
  shader.uniforms.useRegionalSurfaceClassMap = { value: textures.hasRegional ? 1 : 0 };
  const degrees = KSC_SURFACE_CLASS_BOUNDS_DEGREES;
  shader.uniforms.regionalSurfaceClassBoundsRadians = { value: new THREE.Vector4(
    THREE.MathUtils.degToRad(degrees[0]),
    THREE.MathUtils.degToRad(degrees[1]),
    THREE.MathUtils.degToRad(degrees[2]),
    THREE.MathUtils.degToRad(degrees[3]),
  ) };
}
