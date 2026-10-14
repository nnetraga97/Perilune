import * as THREE from 'three';
import type { CompactPlanetVisualDef } from '../content/bodyVisuals';
import type { Body } from '../sim/universe';
import type { BodyMaterialDescriptor } from './bodyMaterial';
import type {
  BodyRenderer,
  BodyRendererStats,
  BodyRenderFrame,
  QualityTier,
  RuntimeBodyAssetPack,
} from './bodyRenderer';
import type { RenderCaps } from './context';
import {
  ATMOSPHERE_SCATTERING_GLSL,
  applyAtmosphereScatteringProfile,
  bindAtmosphereScatteringUniforms,
  createAtmosphereScatteringState,
  type AtmosphereScatteringState,
} from './atmosphereScattering';
import { BODY_FIXED_UV_GLSL } from './terrestrial/globalCoordinates';
import { createGlobalSphereGeometry } from './terrestrial/globalGeometry';

const DISK_FADE_START_PIXELS = 0.45;
const DISK_FADE_END_PIXELS = 1.4;
const POINT_SIZE_PIXELS = 4;

export type CompactPlanetPresentation = 'physical' | 'proxy' | 'transition' | 'point' | 'hidden';

export interface CompactPlanetPresentationState {
  readonly mode: CompactPlanetPresentation;
  readonly physicalOpacity: number;
  readonly proxyOpacity: number;
  readonly pointOpacity: number;
}

function smoothstep(minimum: number, maximum: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
  return t * t * (3 - 2 * t);
}

export function compactPlanetPresentation(
  projection: Readonly<BodyRenderFrame['projection']>,
): CompactPlanetPresentationState {
  const { visibility, projectedPixelRadius } = projection;
  if (visibility === 'inside' || !Number.isFinite(projectedPixelRadius)) {
    return Object.freeze({ mode: 'hidden', physicalOpacity: 0, proxyOpacity: 0, pointOpacity: 0 });
  }
  const diskOpacity = smoothstep(DISK_FADE_START_PIXELS, DISK_FADE_END_PIXELS, projectedPixelRadius);
  const pointOpacity = 1 - diskOpacity;
  const projectionPhysicalOpacity = projection.physicalOpacity ?? (visibility === 'physical' ? 1 : 0);
  const projectionProxyOpacity = projection.proxyOpacity ?? (visibility === 'physical' ? 0 : 1);
  const physicalOpacity = diskOpacity * projectionPhysicalOpacity;
  const proxyOpacity = diskOpacity * projectionProxyOpacity;
  const resolvedMode: CompactPlanetPresentation = diskOpacity <= 0
    ? 'point'
    : pointOpacity > 0 || (physicalOpacity > 0 && proxyOpacity > 0)
      ? 'transition'
      : physicalOpacity > 0 ? 'physical' : 'proxy';
  return Object.freeze({ mode: resolvedMode, physicalOpacity, proxyOpacity, pointOpacity });
}

function configureAlbedo(texture: THREE.Texture, maxAnisotropy: number): void {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = Math.max(1, maxAnisotropy);
  texture.needsUpdate = true;
}

function fallbackTexture(color: THREE.Color): THREE.DataTexture {
  const encoded = color.clone().convertLinearToSRGB();
  const texture = new THREE.DataTexture(new Uint8Array([
    Math.round(THREE.MathUtils.clamp(encoded.r, 0, 1) * 255),
    Math.round(THREE.MathUtils.clamp(encoded.g, 0, 1) * 255),
    Math.round(THREE.MathUtils.clamp(encoded.b, 0, 1) * 255),
    255,
  ]), 1, 1, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Key-light irradiance shared with the solar renderer's directional light. */
const COMPACT_SUN_ILLUMINANCE = 3.1;

export type CompactPhotometry = NonNullable<CompactPlanetVisualDef['photometry']>;

export function createCompactShadingState(): CompactShadingState {
  return {
    sunDirection: { value: new THREE.Vector3(1, 0, 0) },
    cameraUnit: { value: new THREE.Vector3(4, 0, 0) },
  };
}

/**
 * Scattering coefficients for a compact globe's haze. `exaggeration` thickens
 * the layer for small schematic globes (the map) while dividing the
 * coefficients by the same factor, so vertical optical depth is unchanged.
 */
export function createCompactAtmosphereScattering(
  radius: number,
  atmosphere: Readonly<NonNullable<CompactPlanetVisualDef['atmosphere']>>,
  exaggeration = 1,
): AtmosphereScatteringState {
  const scale = (values: readonly [number, number, number]) =>
    values.map((value) => value / exaggeration) as unknown as readonly [number, number, number];
  const scattering = createAtmosphereScatteringState();
  applyAtmosphereScatteringProfile(scattering, {
    radius,
    height: atmosphere.height * exaggeration,
    rayleighScaleHeight: atmosphere.scaleHeight * exaggeration,
    mieScaleHeight: atmosphere.scaleHeight * exaggeration,
    rayleigh: scale(atmosphere.rayleigh),
    mieScattering: scale(atmosphere.mieScattering),
    mieExtinction: scale(atmosphere.mieExtinction),
    absorption: [0, 0, 0],
    mieG: atmosphere.mieG,
    multipleScattering: atmosphere.multipleScattering,
    sunIlluminance: COMPACT_SUN_ILLUMINANCE,
  });
  return scattering;
}

const PHOTOMETRY_DEFINE: Record<CompactPhotometry, number> = {
  airless: 0,
  rocky: 1,
  'cloud-deck': 2,
  'gas-giant': 3,
};

/** Uniform values shared by every globe drawn for one body. */
export interface CompactShadingState {
  readonly sunDirection: { value: THREE.Vector3 };
  readonly cameraUnit: { value: THREE.Vector3 };
}

export function createCompactSurfaceMaterial(
  albedo: THREE.Texture,
  photometry: CompactPhotometry,
  visual: Readonly<CompactPlanetVisualDef>,
  shading: CompactShadingState,
): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    defines: { COMPACT_PHOTOMETRY: PHOTOMETRY_DEFINE[photometry] },
    uniforms: {
      uAlbedo: { value: albedo },
      uSunDirectionBodyFixed: shading.sunDirection,
      uCameraUnit: shading.cameraUnit,
      uOpacity: { value: 1 },
      uRelief: { value: visual.relief ?? 0 },
      uGain: { value: visual.gain ?? 1 },
      uSaturation: { value: visual.saturation ?? 1 },
      uSunIlluminance: { value: COMPACT_SUN_ILLUMINANCE },
    },
    vertexShader: /* glsl */ `
      attribute vec3 bodyDirection;
      varying vec3 vBodyDirection;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vBodyDirection = normalize(bodyDirection);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uAlbedo;
      uniform vec3 uSunDirectionBodyFixed;
      uniform vec3 uCameraUnit;
      uniform float uOpacity;
      uniform float uRelief;
      uniform float uGain;
      uniform float uSaturation;
      uniform float uSunIlluminance;
      varying vec3 vBodyDirection;
      ${BODY_FIXED_UV_GLSL}
      #include <common>
      #include <logdepthbuf_pars_fragment>

      float compactLuma(vec3 color) {
        return dot(color, vec3(0.2126, 0.7152, 0.0722));
      }

      vec3 sampleAlbedo(vec3 direction) {
        return texture2D(uAlbedo, bodyFixedUv(normalize(direction))).rgb;
      }

      // Recover plausible relief from albedo gradients. Mosaics are
      // photometrically flattened, so this restores crater rims, scarps, and
      // ridges under grazing light without a height channel.
      vec3 reliefNormal(vec3 normalDirection, float centerLuma) {
        if (uRelief <= 0.0) return normalDirection;
        vec3 east = normalize(vec3(-normalDirection.y, normalDirection.x, 0.0) + vec3(1e-6, 0.0, 0.0));
        vec3 north = cross(normalDirection, east);
        float texelAngle = 6.2831853 / float(textureSize(uAlbedo, 0).x);
        // Track the sampled mip so relief never aliases on small disks.
        vec2 uvDerivative = fwidth(bodyFixedUv(normalDirection) * vec2(textureSize(uAlbedo, 0)));
        float footprint = max(1.5, max(uvDerivative.x, uvDerivative.y) * 1.5);
        float delta = texelAngle * footprint;
        float lumaEast = compactLuma(sampleAlbedo(normalDirection + east * delta));
        float lumaWest = compactLuma(sampleAlbedo(normalDirection - east * delta));
        float lumaNorth = compactLuma(sampleAlbedo(normalDirection + north * delta));
        float lumaSouth = compactLuma(sampleAlbedo(normalDirection - north * delta));
        vec2 gradient = vec2(lumaEast - lumaWest, lumaNorth - lumaSouth) / (centerLuma + 0.08);
        return normalize(normalDirection - (east * gradient.x + north * gradient.y) * uRelief);
      }

      void main() {
        #include <logdepthbuf_fragment>
        vec3 normalDirection = normalize(vBodyDirection);
        vec3 albedo = sampleAlbedo(normalDirection);
        float luma = compactLuma(albedo);
        albedo = mix(vec3(luma), albedo, uSaturation) * uGain;
        vec3 sun = normalize(uSunDirectionBodyFixed);
        vec3 view = normalize(uCameraUnit - normalDirection);
        vec3 shadingNormal = reliefNormal(normalDirection, luma);
        float incidence = dot(shadingNormal, sun);
        float geometricIncidence = dot(normalDirection, sun);
        float emission = max(dot(normalDirection, view), 0.0);
        float phaseDegrees = degrees(acos(clamp(dot(sun, view), -1.0, 1.0)));
        float lit = max(incidence, 0.0);
        float reflectance;
#if COMPACT_PHOTOMETRY == 0
        // Lunar-Lambert (McEwen 1991): flat full disk, Lambert crescent.
        float limbParameter = clamp(1.0 - 0.019 * phaseDegrees + 2.42e-4 * phaseDegrees * phaseDegrees
          - 1.46e-6 * phaseDegrees * phaseDegrees * phaseDegrees, 0.0, 1.0);
        reflectance = (1.0 - limbParameter) * lit + 2.0 * limbParameter * lit / max(lit + emission, 1e-3);
        // Opposition surge from shadow hiding near zero phase.
        reflectance *= 1.0 + 0.35 * exp(-phaseDegrees / 6.0);
#elif COMPACT_PHOTOMETRY == 1
        float limbParameter = 0.45 * clamp(1.0 - 0.019 * phaseDegrees + 2.42e-4 * phaseDegrees * phaseDegrees, 0.0, 1.0);
        reflectance = (1.0 - limbParameter) * lit + 2.0 * limbParameter * lit / max(lit + emission, 1e-3);
#elif COMPACT_PHOTOMETRY == 2
        // Opaque cloud deck: soft multiply-scattered terminator, mild limb darkening.
        float wrapped = clamp((geometricIncidence + 0.08) / 1.08, 0.0, 1.0);
        reflectance = pow(wrapped, 0.8) * pow(max(emission, 0.05), -0.12);
#else
        // Minnaert limb darkening for a deep cloud-top atmosphere; the high
        // haze carries light a few degrees past the geometric terminator.
        float wrapped = clamp((geometricIncidence + 0.05) / 1.05, 0.0, 1.0);
        reflectance = pow(wrapped, 1.15) * pow(max(emission, 0.05), -0.1);
#endif
        float terminator = smoothstep(-0.05, 0.08, geometricIncidence);
        vec3 color = albedo * reflectance * terminator * uSunIlluminance / 3.14159265;
        color += albedo * 0.0015;
        gl_FragColor = vec4(color, uOpacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: true,
    toneMapped: true,
  });
  material.name = 'compact-planet-surface';
  material.userData.compactPlanetSurface = true;
  material.userData.photometry = photometry;
  return material;
}

/** Thin scattering shell over a compact globe, in unit-sphere (body radii) space. */
export function createCompactAtmosphereMaterial(
  scattering: AtmosphereScatteringState,
  shading: CompactShadingState,
  quality: QualityTier,
): THREE.ShaderMaterial {
  const uniforms: Record<string, THREE.IUniform> = {
    uSunDirectionBodyFixed: shading.sunDirection,
    uCameraUnit: shading.cameraUnit,
    uOpacity: { value: 1 },
  };
  bindAtmosphereScatteringUniforms({ uniforms }, scattering);
  const material = new THREE.ShaderMaterial({
    defines: { COMPACT_ATMOSPHERE_SAMPLES: quality === 'high' ? 16 : quality === 'medium' ? 12 : 8 },
    uniforms,
    vertexShader: /* glsl */ `
      attribute vec3 bodyDirection;
      varying vec3 vBodyDirection;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vBodyDirection = normalize(bodyDirection);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDirectionBodyFixed;
      uniform vec3 uCameraUnit;
      uniform float uOpacity;
      varying vec3 vBodyDirection;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      ${ATMOSPHERE_SCATTERING_GLSL}
      void main() {
        #include <logdepthbuf_fragment>
        vec3 shellPoint = normalize(vBodyDirection) * atmoTopRadius;
        vec3 rayDirection = normalize(shellPoint - uCameraUnit);
        vec2 outer = atmoRaySphere(uCameraUnit, rayDirection, atmoTopRadius);
        float rayStart = max(0.0, outer.x);
        float rayEnd = outer.y;
        vec2 ground = atmoRaySphere(uCameraUnit, rayDirection, 1.0);
        if (ground.x > 0.0 && ground.x < rayEnd) rayEnd = ground.x;
        if (rayEnd <= rayStart) discard;
        vec3 inscatter;
        vec3 transmittance;
        atmoIntegrate(uCameraUnit, rayDirection, rayStart, rayEnd, normalize(uSunDirectionBodyFixed),
          COMPACT_ATMOSPHERE_SAMPLES, inscatter, transmittance);
        float alpha = clamp(1.0 - dot(transmittance, vec3(0.333333)), 0.0, 1.0);
        gl_FragColor = vec4(inscatter, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        gl_FragColor *= uOpacity;
      }
    `,
    side: THREE.FrontSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    premultipliedAlpha: true,
    toneMapped: true,
  });
  material.name = 'compact-planet-atmosphere';
  material.userData.compactPlanetAtmosphere = true;
  return material;
}

function pointMaterial(color: THREE.Color): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uPointColor: { value: color },
      uPointSize: { value: POINT_SIZE_PIXELS },
      uOpacity: { value: 0 },
    },
    vertexShader: /* glsl */ `
      uniform float uPointSize;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = uPointSize;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uPointColor;
      uniform float uOpacity;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        vec2 centered = gl_PointCoord * 2.0 - 1.0;
        float radius = length(centered);
        float alpha = (1.0 - smoothstep(0.55, 1.0, radius)) * uOpacity;
        if (alpha < 0.001) discard;
        gl_FragColor = vec4(uPointColor, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  material.name = 'compact-planet-point';
  material.userData.compactPlanetPoint = true;
  return material;
}

export class CompactPlanetBodyRenderer implements BodyRenderer {
  readonly bodyId: string;
  readonly kind: 'compact-planet' | 'gas-giant';
  readonly root = new THREE.Group();
  private readonly geometry: THREE.SphereGeometry;
  private readonly fallbackAlbedo: THREE.DataTexture;
  private readonly physicalSurface: THREE.ShaderMaterial;
  private readonly proxySurface: THREE.ShaderMaterial;
  private readonly physicalAtmosphere: THREE.ShaderMaterial | null;
  private readonly proxyAtmosphere: THREE.ShaderMaterial | null;
  private readonly shading: CompactShadingState = createCompactShadingState();
  private readonly physicalGlobe = new THREE.Group();
  private readonly proxyGlobe = new THREE.Group();
  private readonly point: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly pointGeometry = new THREE.BufferGeometry();
  private presentationMode: BodyRendererStats['presentationMode'] = 'point';
  private lastAngularRadius = 0;
  private assetTier: QualityTier | 'procedural' = 'procedural';
  private assetBytes = 0;
  private disposed = false;
  private readonly observerDirection = new THREE.Vector3();

  constructor(
    private readonly body: Body,
    descriptor: Readonly<BodyMaterialDescriptor>,
    visual: Readonly<CompactPlanetVisualDef>,
    readonly caps: Readonly<RenderCaps>,
    readonly quality: QualityTier,
    rendererKind: 'compact-planet' | 'gas-giant' = 'compact-planet',
  ) {
    this.bodyId = body.id;
    this.kind = rendererKind;
    this.root.name = `${rendererKind}:${body.id}`;
    this.geometry = createGlobalSphereGeometry(quality);
    this.fallbackAlbedo = fallbackTexture(new THREE.Color(descriptor.albedo.mid));
    configureAlbedo(this.fallbackAlbedo, caps.maxAnisotropy);
    const photometry = visual.photometry ?? (rendererKind === 'gas-giant' ? 'gas-giant' : 'airless');
    this.physicalSurface = createCompactSurfaceMaterial(this.fallbackAlbedo, photometry, visual, this.shading);
    this.proxySurface = createCompactSurfaceMaterial(this.fallbackAlbedo, photometry, visual, this.shading);
    let atmosphereTop = 1;
    if (visual.atmosphere) {
      const scattering = createCompactAtmosphereScattering(body.equatorialRadius, visual.atmosphere);
      atmosphereTop = scattering.topRadius.value;
      this.physicalAtmosphere = createCompactAtmosphereMaterial(scattering, this.shading, quality);
      this.proxyAtmosphere = createCompactAtmosphereMaterial(scattering, this.shading, quality);
    } else {
      this.physicalAtmosphere = null;
      this.proxyAtmosphere = null;
    }
    const addGlobeMeshes = (
      globe: THREE.Group,
      surface: THREE.ShaderMaterial,
      atmosphere: THREE.ShaderMaterial | null,
      suffix: 'physical' | 'proxy',
    ) => {
      const surfaceMesh = new THREE.Mesh(this.geometry, surface);
      surfaceMesh.name = `${rendererKind}-surface:${body.id}:${suffix}`;
      surfaceMesh.renderOrder = suffix === 'physical' ? 4 : 5;
      globe.name = `${rendererKind}-globe:${body.id}:${suffix}`;
      globe.add(surfaceMesh);
      if (atmosphere) {
        const atmosphereMesh = new THREE.Mesh(this.geometry, atmosphere);
        atmosphereMesh.name = `${rendererKind}-atmosphere:${body.id}:${suffix}`;
        atmosphereMesh.scale.setScalar(atmosphereTop);
        atmosphereMesh.renderOrder = 6;
        globe.add(atmosphereMesh);
      }
    };
    addGlobeMeshes(this.physicalGlobe, this.physicalSurface, this.physicalAtmosphere, 'physical');
    addGlobeMeshes(this.proxyGlobe, this.proxySurface, this.proxyAtmosphere, 'proxy');
    this.pointGeometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    this.point = new THREE.Points(this.pointGeometry, pointMaterial(new THREE.Color(visual.pointColor)));
    this.point.name = `${rendererKind}-point:${body.id}`;
    this.point.frustumCulled = false;
    this.root.add(this.physicalGlobe, this.proxyGlobe, this.point);
  }

  get ready(): boolean { return !this.disposed; }

  stageAssets(pack: Readonly<RuntimeBodyAssetPack> | null): void {
    if (this.disposed) return;
    if (pack === null) {
      this.physicalSurface.uniforms.uAlbedo.value = this.fallbackAlbedo;
      this.proxySurface.uniforms.uAlbedo.value = this.fallbackAlbedo;
      this.assetTier = 'procedural';
      this.assetBytes = 0;
      return;
    }
    if (pack.bodyId !== this.bodyId || pack.tier !== this.quality) {
      throw new Error(`Cannot stage ${pack.bodyId}/${pack.tier} for ${this.bodyId}/${this.quality}`);
    }
    const channels = [...pack.textures.keys()];
    if (channels.length !== 1 || channels[0] !== 'albedo') {
      throw new Error(`${pack.bodyId}/${pack.tier} ${this.kind} pack must contain exact channel albedo`);
    }
    const albedo = pack.textures.get('albedo');
    if (!albedo) throw new Error(`${pack.bodyId}/${pack.tier} is missing albedo`);
    configureAlbedo(albedo, this.caps.maxAnisotropy);
    this.physicalSurface.uniforms.uAlbedo.value = albedo;
    this.proxySurface.uniforms.uAlbedo.value = albedo;
    this.assetTier = pack.tier;
    this.assetBytes = pack.gpuBytes;
  }

  update(frame: Readonly<BodyRenderFrame>): void {
    if (this.disposed) return;
    const presentation = compactPlanetPresentation(frame.projection);
    this.lastAngularRadius = frame.projection.angularRadius;
    this.presentationMode = presentation.mode === 'hidden' ? 'point' : presentation.mode;
    const sun = frame.bodySunDirection;
    const camera = frame.cameraBodyFixed;
    this.shading.sunDirection.value.set(sun.x, sun.y, sun.z).normalize();
    // Unit-sphere space: dividing by the ellipsoid axes maps an oblate globe
    // to radius 1. The angular-size proxy is a similarity transform of the
    // physical globe, so both presentations share this camera position.
    this.shading.cameraUnit.value.set(
      camera.x / this.body.equatorialRadius,
      camera.y / this.body.equatorialRadius,
      camera.z / this.body.polarRadius,
    );
    this.physicalSurface.uniforms.uOpacity.value = presentation.physicalOpacity;
    this.proxySurface.uniforms.uOpacity.value = presentation.proxyOpacity;
    if (this.physicalAtmosphere) this.physicalAtmosphere.uniforms.uOpacity.value = presentation.physicalOpacity;
    if (this.proxyAtmosphere) this.proxyAtmosphere.uniforms.uOpacity.value = presentation.proxyOpacity;
    const crossfadingProjection = presentation.physicalOpacity > 0 && presentation.proxyOpacity > 0;
    this.physicalSurface.depthWrite = !crossfadingProjection && presentation.physicalOpacity >= 0.999;
    this.proxySurface.depthWrite = !crossfadingProjection && presentation.proxyOpacity >= 0.999;

    const origin = frame.cameraRelativeOrigin;
    this.physicalGlobe.position.set(origin.x, origin.y, origin.z);
    this.physicalGlobe.scale.set(
      this.body.equatorialRadius,
      this.body.equatorialRadius,
      this.body.polarRadius,
    );
    const inverseDistance = 1 / (Math.hypot(origin.x, origin.y, origin.z) || 1);
    this.proxyGlobe.position.set(
      origin.x * inverseDistance * frame.projection.proxyDepth,
      origin.y * inverseDistance * frame.projection.proxyDepth,
      origin.z * inverseDistance * frame.projection.proxyDepth,
    );
    const proxyPolarRatio = this.body.polarRadius / this.body.equatorialRadius;
    this.proxyGlobe.scale.set(
      frame.projection.proxyRadius,
      frame.projection.proxyRadius,
      frame.projection.proxyRadius * proxyPolarRatio,
    );
    this.physicalGlobe.quaternion.set(
      frame.orientation.x,
      frame.orientation.y,
      frame.orientation.z,
      frame.orientation.w,
    );
    this.proxyGlobe.quaternion.copy(this.physicalGlobe.quaternion);
    this.physicalGlobe.visible = presentation.physicalOpacity > 0;
    this.proxyGlobe.visible = presentation.proxyOpacity > 0;

    this.point.position.set(
      origin.x * inverseDistance * frame.projection.proxyDepth,
      origin.y * inverseDistance * frame.projection.proxyDepth,
      origin.z * inverseDistance * frame.projection.proxyDepth,
    );
    const observerDirection = this.observerDirection.set(camera.x, camera.y, camera.z).normalize();
    const sunDirection = this.shading.sunDirection.value;
    const phaseAngle = Math.acos(THREE.MathUtils.clamp(observerDirection.dot(sunDirection), -1, 1));
    const phase = (Math.sin(phaseAngle) + (Math.PI - phaseAngle) * Math.cos(phaseAngle)) / Math.PI;
    this.point.material.uniforms.uOpacity.value = presentation.pointOpacity * Math.sqrt(Math.max(0, phase));
    this.point.visible = presentation.pointOpacity > 0 && presentation.mode !== 'hidden';
  }

  stats(): Readonly<BodyRendererStats> {
    return Object.freeze({
      chunks: 0,
      visible: this.physicalGlobe.visible || this.proxyGlobe.visible ? 1 : 0,
      terrainActive: false,
      exposure: 0,
      presentationMode: this.presentationMode,
      angularRadius: this.lastAngularRadius,
      assetTier: this.assetTier,
      assetBytes: this.assetBytes,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.geometry.dispose();
    this.pointGeometry.dispose();
    this.physicalSurface.dispose();
    this.proxySurface.dispose();
    this.physicalAtmosphere?.dispose();
    this.proxyAtmosphere?.dispose();
    this.point.material.dispose();
    this.fallbackAlbedo.dispose();
    this.root.clear();
  }
}
