import * as THREE from 'three';
import type { BodyVisualDef } from '../content/bodyVisuals';
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

function surfaceMaterial(albedo: THREE.Texture, gasGiant: boolean): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uAlbedo: { value: albedo },
      uSunDirectionBodyFixed: { value: new THREE.Vector3(1, 0, 0) },
      uOpacity: { value: 1 },
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
      uniform float uOpacity;
      varying vec3 vBodyDirection;
      ${BODY_FIXED_UV_GLSL}
      #include <common>
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        vec3 normalDirection = normalize(vBodyDirection);
        vec3 albedo = texture2D(uAlbedo, bodyFixedUv(normalDirection)).rgb;
        float solarCosine = dot(normalDirection, normalize(uSunDirectionBodyFixed));
        float terminator = smoothstep(${gasGiant ? '-0.16, 0.08' : '-0.08, 0.06'}, solarCosine);
        float diffuse = max(solarCosine, 0.0);
        vec3 day = albedo * (${gasGiant ? '0.24 + diffuse * 0.96' : '0.16 + diffuse * 1.08'});
        vec3 night = albedo * ${gasGiant ? '0.02' : '0.012'};
        gl_FragColor = vec4(mix(night, day, terminator), uOpacity);
      }
    `,
    transparent: true,
    depthWrite: true,
    toneMapped: true,
  });
  material.name = 'compact-planet-surface';
  material.userData.compactPlanetSurface = true;
  return material;
}

function limbMaterial(color: THREE.Color, strength: number): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uLimbColor: { value: color },
      uLimbStrength: { value: strength },
      uSunDirectionBodyFixed: { value: new THREE.Vector3(1, 0, 0) },
      uViewDirectionBodyFixed: { value: new THREE.Vector3(1, 0, 0) },
      uOpacity: { value: 1 },
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
      uniform vec3 uLimbColor;
      uniform float uLimbStrength;
      uniform vec3 uSunDirectionBodyFixed;
      uniform vec3 uViewDirectionBodyFixed;
      uniform float uOpacity;
      varying vec3 vBodyDirection;
      #include <common>
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        vec3 normalDirection = normalize(vBodyDirection);
        float viewCosine = abs(dot(normalDirection, normalize(uViewDirectionBodyFixed)));
        float limb = pow(clamp(1.0 - viewCosine, 0.0, 1.0), 3.2);
        float daylight = smoothstep(-0.32, 0.18,
          dot(normalDirection, normalize(uSunDirectionBodyFixed)));
        float alpha = limb * daylight * uLimbStrength * uOpacity;
        if (alpha < 0.001) discard;
        gl_FragColor = vec4(uLimbColor, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    toneMapped: true,
  });
  material.name = 'compact-planet-limb';
  material.userData.compactPlanetLimb = true;
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
  private readonly physicalLimb: THREE.ShaderMaterial;
  private readonly proxyLimb: THREE.ShaderMaterial;
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
    visual: Readonly<NonNullable<BodyVisualDef['compactPlanetVisual']>>,
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
    this.physicalSurface = surfaceMaterial(this.fallbackAlbedo, rendererKind === 'gas-giant');
    this.proxySurface = surfaceMaterial(this.fallbackAlbedo, rendererKind === 'gas-giant');
    this.physicalLimb = limbMaterial(new THREE.Color(visual.limbColor), visual.limbStrength);
    this.proxyLimb = limbMaterial(new THREE.Color(visual.limbColor), visual.limbStrength);
    const addGlobeMeshes = (
      globe: THREE.Group,
      surface: THREE.ShaderMaterial,
      limb: THREE.ShaderMaterial,
      suffix: 'physical' | 'proxy',
    ) => {
      const surfaceMesh = new THREE.Mesh(this.geometry, surface);
      surfaceMesh.name = `${rendererKind}-surface:${body.id}:${suffix}`;
      surfaceMesh.renderOrder = suffix === 'physical' ? 4 : 5;
      const limbMesh = new THREE.Mesh(this.geometry, limb);
      limbMesh.name = `${rendererKind}-limb:${body.id}:${suffix}`;
      limbMesh.scale.setScalar(1.018);
      limbMesh.renderOrder = 6;
      globe.name = `${rendererKind}-globe:${body.id}:${suffix}`;
      globe.add(surfaceMesh, limbMesh);
    };
    addGlobeMeshes(this.physicalGlobe, this.physicalSurface, this.physicalLimb, 'physical');
    addGlobeMeshes(this.proxyGlobe, this.proxySurface, this.proxyLimb, 'proxy');
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
    for (const surface of [this.physicalSurface, this.proxySurface]) {
      surface.uniforms.uSunDirectionBodyFixed.value.set(sun.x, sun.y, sun.z).normalize();
    }
    for (const limb of [this.physicalLimb, this.proxyLimb]) {
      limb.uniforms.uSunDirectionBodyFixed.value.set(sun.x, sun.y, sun.z).normalize();
      limb.uniforms.uViewDirectionBodyFixed.value.set(camera.x, camera.y, camera.z).normalize();
    }
    this.physicalSurface.uniforms.uOpacity.value = presentation.physicalOpacity;
    this.proxySurface.uniforms.uOpacity.value = presentation.proxyOpacity;
    this.physicalLimb.uniforms.uOpacity.value = presentation.physicalOpacity;
    this.proxyLimb.uniforms.uOpacity.value = presentation.proxyOpacity;
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
    const sunDirection = this.physicalSurface.uniforms.uSunDirectionBodyFixed.value as THREE.Vector3;
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
    this.physicalLimb.dispose();
    this.proxyLimb.dispose();
    this.point.material.dispose();
    this.fallbackAlbedo.dispose();
    this.root.clear();
  }
}
