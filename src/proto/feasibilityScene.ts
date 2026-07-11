import * as THREE from 'three';
import { Vec3 } from '../core/vec3';
import type { Quat } from '../core/quat';
import { CloudLayer } from '../render/clouds';
import { PlanetRenderer, PLANET_QUALITY } from '../render/planet';
import { terrainHeight } from '../sim/terrain';
import type { Body } from '../sim/universe';
import type { FeasibilityFeatureConfig } from './feasibilityMetrics';

export interface ScatterRecords {
  readonly ids: Uint32Array;
  /** Per record: tangent U, tangent V, scale, yaw in normalized units/radians. */
  readonly transforms: Float32Array;
}

export interface FeasibilityFixtureSpec {
  readonly visualScatterCount: number;
  readonly physicalProxyCount: 128;
  readonly physicalProxyIds: Uint32Array;
  readonly cloudLayerCount: 1 | 2;
  readonly atmosphereSamples: number;
  readonly transitionMeshCount: 2;
  readonly cloudShadows: boolean;
  readonly oceanGlitter: boolean;
  readonly terrainEnabled: true;
}

interface Disposable {
  dispose(): void;
}

export class DisposableBag {
  private readonly resources = new Set<Disposable>();
  private disposed = false;

  add<T extends Disposable>(resource: T): T {
    if (this.disposed) throw new Error('Disposable bag is already disposed');
    this.resources.add(resource);
    return resource;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const resource of this.resources) resource.dispose();
    this.resources.clear();
  }
}

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

export function generateScatterRecords(seed: number, count: number): ScatterRecords {
  if (!Number.isInteger(count) || count < 0) throw new Error(`Invalid scatter count ${count}`);
  const ids = new Uint32Array(count);
  const transforms = new Float32Array(count * 4);
  let state = mix32(seed) || 0x6d2b79f5;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
  for (let index = 0; index < count; index++) {
    // Multiplication by an odd integer is a bijection modulo 2^32, so IDs
    // remain unique for every index even before recipe/cell IDs are added.
    ids[index] = (mix32(seed) + Math.imul(index, 0x9e3779b1)) >>> 0;
    transforms[index * 4] = random() * 2 - 1;
    transforms[index * 4 + 1] = random() * 2 - 1;
    transforms[index * 4 + 2] = 0.55 + random() * 1.45;
    transforms[index * 4 + 3] = random() * Math.PI * 2;
  }
  return { ids, transforms };
}

export function physicalProxyIds(seed: number, count: number): Uint32Array {
  const records = new Uint32Array(count);
  const origin = mix32(seed ^ 0x50524f58);
  for (let index = 0; index < count; index++) {
    records[index] = (origin + Math.imul(index, 0x85ebca6b)) >>> 0;
  }
  return records;
}

export function feasibilityFixtureSpec(
  features: Readonly<FeasibilityFeatureConfig>,
  seed: number,
): Readonly<FeasibilityFixtureSpec> {
  return Object.freeze({
    visualScatterCount: features.visualScatterCount,
    physicalProxyCount: features.physicalProxyCount,
    physicalProxyIds: physicalProxyIds(seed, features.physicalProxyCount),
    cloudLayerCount: features.secondCloudScale ? 2 : 1,
    atmosphereSamples: features.atmosphereSamples,
    transitionMeshCount: 2,
    cloudShadows: features.cloudShadows,
    oceanGlitter: features.oceanGlitter,
    terrainEnabled: true,
  });
}

const PATCH_DIRECTION = new Vec3(0, -1, 0);
const ROTATED_PATCH_ORIGIN = new Vec3();
const THREE_UP = new THREE.Vector3(0, 1, 0);

export interface FeasibilitySceneStats extends FeasibilityFixtureSpec {
  readonly terrainChunks: number;
  readonly terrainVisible: number;
  readonly terrainCoverageGaps: number;
  readonly terrainScheduleMs: number;
  readonly terrainInstallMs: number;
  readonly estimatedGpuBytes: number;
}

/** Combined performance fixture. It is deliberately not the Phase 3 renderer API. */
export class FeasibilityScene {
  readonly group = new THREE.Group();
  readonly planet: PlanetRenderer;
  private readonly resources = new DisposableBag();
  private readonly clouds: readonly [CloudLayer, CloudLayer];
  private readonly atmosphere: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly localRoot = new THREE.Group();
  private readonly scatter: THREE.InstancedMesh;
  private readonly proxies: THREE.InstancedMesh;
  private readonly transitionMeshes: readonly [THREE.Mesh, THREE.Mesh];
  private readonly patchOrigin: Vec3;
  private features: Readonly<FeasibilityFeatureConfig>;
  private readonly seed: number;

  constructor(body: Body, features: Readonly<FeasibilityFeatureConfig>) {
    if (body.def.surfaceKind !== 'solid') throw new Error('Feasibility scene requires a solid body');
    this.features = features;
    this.seed = body.def.terrain.seed;
    this.planet = new PlanetRenderer(body, PLANET_QUALITY.medium);
    this.planet.setShadowReceiver(true);
    this.group.add(this.planet.group);

    this.atmosphere = this.makeAtmosphere(body);
    this.group.add(this.atmosphere);

    this.clouds = [
      new CloudLayer(body, { seedOffset: 501, altitudeFraction: 0.13, driftRate: 1.2e-5, castShadow: true }),
      new CloudLayer(body, { seedOffset: 877, altitudeFraction: 0.19, driftRate: -7e-6, opacity: 0.5 }),
    ];
    for (const cloud of this.clouds) this.group.add(cloud.mesh);

    const patchRadius = body.radius + terrainHeight(body, PATCH_DIRECTION);
    this.patchOrigin = new Vec3(
      PATCH_DIRECTION.x * patchRadius,
      PATCH_DIRECTION.y * patchRadius,
      PATCH_DIRECTION.z * patchRadius,
    );
    this.scatter = this.makeScatter(body);
    this.proxies = this.makeProxies(body);
    this.transitionMeshes = this.makeTransitionMeshes();
    this.localRoot.add(this.scatter, this.proxies, ...this.transitionMeshes);
    this.group.add(this.localRoot);
    this.setFeatures(features);
  }

  setFeatures(features: Readonly<FeasibilityFeatureConfig>): void {
    this.features = features;
    this.scatter.count = features.visualScatterCount;
    this.proxies.count = features.physicalProxyCount;
    this.clouds[0].setShadowEnabled(features.cloudShadows);
    this.clouds[1].setShadowEnabled(false);
    this.clouds[1].mesh.visible = features.secondCloudScale;
    this.atmosphere.material.uniforms.uSamples.value = features.atmosphereSamples;
    this.planet.setOceanGlitter(features.oceanGlitter);
  }

  update(
    camBodyFixed: Readonly<Vec3>,
    orientation: Readonly<Quat>,
    originWorld: Readonly<Vec3>,
    time: number,
    cameraAltitude: number,
  ): void {
    this.planet.update(camBodyFixed, orientation, originWorld);
    this.atmosphere.position.set(originWorld.x, originWorld.y, originWorld.z);
    for (const cloud of this.clouds) cloud.update(originWorld, orientation, time, cameraAltitude);
    this.clouds[1].mesh.visible = this.features.secondCloudScale && this.clouds[1].mesh.visible;

    orientation.rotate(this.patchOrigin, ROTATED_PATCH_ORIGIN);
    this.localRoot.position.set(
      ROTATED_PATCH_ORIGIN.x + originWorld.x,
      ROTATED_PATCH_ORIGIN.y + originWorld.y,
      ROTATED_PATCH_ORIGIN.z + originWorld.z,
    );
    this.localRoot.quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w);
  }

  stats(): Readonly<FeasibilitySceneStats> {
    const fixture = feasibilityFixtureSpec(this.features, this.seed);
    const instanceBytes = this.scatter.instanceMatrix.array.byteLength + this.proxies.instanceMatrix.array.byteLength;
    return Object.freeze({
      ...fixture,
      terrainChunks: this.planet.stats.chunks,
      terrainVisible: this.planet.stats.visible,
      terrainCoverageGaps: this.planet.stats.coverageGaps,
      terrainScheduleMs: this.planet.stats.scheduleMs,
      terrainInstallMs: this.planet.stats.installMs,
      estimatedGpuBytes: this.planet.stats.geometryBytes + instanceBytes,
    });
  }

  dispose(): void {
    this.planet.dispose();
    for (const cloud of this.clouds) cloud.dispose();
    this.resources.dispose();
    this.group.clear();
  }

  private makeAtmosphere(body: Body): THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> {
    const geometry = this.resources.add(new THREE.SphereGeometry(1, 96, 64));
    const material = this.resources.add(new THREE.ShaderMaterial({
      uniforms: {
        uSamples: { value: this.features.atmosphereSamples },
        uColor: { value: new THREE.Color('#62a9d8') },
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vNormal = normalize(normalMatrix * normal);
          vView = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform int uSamples;
        uniform vec3 uColor;
        varying vec3 vNormal;
        varying vec3 vView;
        void main() {
          float opticalDepth = 0.0;
          float limb = 1.0 - max(0.0, dot(vNormal, vView));
          for (int i = 0; i < 12; i++) {
            if (i >= uSamples) break;
            float t = (float(i) + 0.5) / float(uSamples);
            opticalDepth += exp(-t * 3.0) * (0.5 + limb);
          }
          opticalDepth /= float(max(uSamples, 1));
          float alpha = clamp(pow(limb, 1.7) * 0.72 + opticalDepth * 0.08, 0.0, 0.82);
          gl_FragColor = vec4(uColor * (0.55 + opticalDepth), alpha);
        }
      `,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.setScalar(body.radius + (body.def.atmosphere?.height ?? 60_000) * 1.05);
    mesh.renderOrder = 4;
    return mesh;
  }

  private makeScatter(body: Body): THREE.InstancedMesh {
    const geometry = this.resources.add(new THREE.ConeGeometry(0.65, 3.2, 3));
    geometry.translate(0, 1.6, 0);
    const material = this.resources.add(new THREE.MeshLambertMaterial({ color: '#667753' }));
    const mesh = new THREE.InstancedMesh(geometry, material, 50_000);
    const records = generateScatterRecords(this.seed, 50_000);
    this.populateInstances(mesh, body, records, 650, 1);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.frustumCulled = false;
    return mesh;
  }

  private makeProxies(body: Body): THREE.InstancedMesh {
    const geometry = this.resources.add(new THREE.IcosahedronGeometry(4.5, 1));
    const material = this.resources.add(new THREE.MeshStandardMaterial({
      color: '#59616a', roughness: 0.88, metalness: 0,
    }));
    const mesh = new THREE.InstancedMesh(geometry, material, 128);
    const records = generateScatterRecords(this.seed ^ 0x50524f58, 128);
    this.populateInstances(mesh, body, records, 580, 2.2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    return mesh;
  }

  private populateInstances(
    mesh: THREE.InstancedMesh,
    body: Body,
    records: ScatterRecords,
    spanMeters: number,
    scaleMultiplier: number,
  ): void {
    const position = new THREE.Vector3();
    const direction = new Vec3();
    const directionThree = new THREE.Vector3();
    const align = new THREE.Quaternion();
    const yaw = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    for (let index = 0; index < records.ids.length; index++) {
      const u = records.transforms[index * 4] * spanMeters;
      const v = records.transforms[index * 4 + 1] * spanMeters;
      direction.set(u, -body.radius, v).normalize();
      const radius = body.radius + terrainHeight(body, direction);
      position.set(
        direction.x * radius - this.patchOrigin.x,
        direction.y * radius - this.patchOrigin.y,
        direction.z * radius - this.patchOrigin.z,
      );
      directionThree.set(direction.x, direction.y, direction.z);
      align.setFromUnitVectors(THREE_UP, directionThree);
      yaw.setFromAxisAngle(THREE_UP, records.transforms[index * 4 + 3]);
      align.multiply(yaw);
      const uniformScale = records.transforms[index * 4 + 2] * scaleMultiplier;
      scale.setScalar(uniformScale);
      matrix.compose(position, align, scale);
      mesh.setMatrixAt(index, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  private makeTransitionMeshes(): readonly [THREE.Mesh, THREE.Mesh] {
    const geometry = this.resources.add(new THREE.PlaneGeometry(1_300, 1_300, 48, 48));
    const makeMaterial = (child: boolean) => this.resources.add(new THREE.ShaderMaterial({
      uniforms: { uChild: { value: child } },
      vertexShader: `
        varying vec3 vNormal;
        void main() {
          vNormal = normalMatrix * normal;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform bool uChild;
        varying vec3 vNormal;
        void main() {
          float mask = mod(floor(gl_FragCoord.x) + floor(gl_FragCoord.y), 2.0);
          if ((uChild && mask < 0.5) || (!uChild && mask >= 0.5)) discard;
          float light = 0.45 + 0.45 * abs(normalize(vNormal).z);
          gl_FragColor = vec4(vec3(0.22, 0.29, 0.18) * light, 1.0);
        }
      `,
      depthWrite: true,
      polygonOffset: child,
      polygonOffsetFactor: child ? -1 : 0,
    }));
    const parent = new THREE.Mesh(geometry, makeMaterial(false));
    const child = new THREE.Mesh(geometry, makeMaterial(true));
    const tangentRotation = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(PATCH_DIRECTION.x, PATCH_DIRECTION.y, PATCH_DIRECTION.z),
    );
    parent.quaternion.copy(tangentRotation);
    child.quaternion.copy(tangentRotation);
    parent.receiveShadow = true;
    child.receiveShadow = true;
    parent.renderOrder = 1;
    child.renderOrder = 1;
    return [parent, child];
  }
}
