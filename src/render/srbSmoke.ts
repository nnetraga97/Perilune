/**
 * One scene-wide SRB smoke pool. Particles are simulated in f64 absolute space
 * and only converted to camera-relative f32 coordinates for the GPU, so the
 * trail remains stable while both the vessel and floating origin move.
 */
import * as THREE from 'three';
import type { QualityTier, VectorCoordinates } from './bodyRenderer';

interface SmokeBudget {
  capacity: number;
  maxSpawnRate: number;
  ignitionHeadroom: number;
  pointSizeLimit: number;
}

const BUDGETS: Record<QualityTier, SmokeBudget> = {
  low: { capacity: 384, maxSpawnRate: 150, ignitionHeadroom: 32, pointSizeLimit: 72 },
  medium: { capacity: 1024, maxSpawnRate: 288, ignitionHeadroom: 64, pointSizeLimit: 104 },
  high: { capacity: 1600, maxSpawnRate: 420, ignitionHeadroom: 96, pointSizeLimit: 132 },
};

export interface SrbSmokeEmission {
  /** Stable vessel/part/nozzle identity, used to detect a fresh ignition. */
  readonly emitterId: string;
  readonly position: Readonly<VectorCoordinates>;
  readonly direction: Readonly<VectorCoordinates>;
  readonly inheritedVelocity: Readonly<VectorCoordinates>;
  readonly up: Readonly<VectorCoordinates>;
  readonly pressureFrac: number;
  readonly plumeScale: number;
}

const smokeVertexShader = /* glsl */ `
  attribute float aSize;
  attribute float aLife;
  attribute float aSeed;
  uniform float uPointSizeLimit;
  varying float vLife;
  varying float vSeed;

  void main() {
    vLife = aLife;
    vSeed = aSeed;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float expansion = 1.0 + aLife * 2.45;
    gl_PointSize = min(uPointSizeLimit, aSize * expansion * (430.0 / max(1.0, -mvPosition.z)));
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const smokeFragmentShader = /* glsl */ `
  varying float vLife;
  varying float vSeed;

  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float angle = atan(p.y, p.x);
    float lobe = 1.0 + 0.085 * sin(angle * 5.0 + vSeed * 19.0);
    float radius = length(p) / lobe;
    float body = 1.0 - smoothstep(0.25, 0.5, radius);
    float detail = 0.88 + 0.12 * sin((p.x + p.y) * 31.0 + vSeed * 23.0);
    float fadeIn = smoothstep(0.0, 0.055, vLife);
    float fadeOut = 1.0 - smoothstep(0.58, 1.0, vLife);
    float alpha = body * detail * fadeIn * fadeOut * 0.72;
    if (alpha < 0.008) discard;
    vec3 warmGrey = mix(vec3(0.27, 0.255, 0.235), vec3(0.68, 0.66, 0.62), fract(vSeed * 7.13));
    vec3 color = mix(warmGrey * 0.78, warmGrey, smoothstep(0.0, 0.45, vLife));
    gl_FragColor = vec4(color, alpha);
  }
`;

const _direction = new THREE.Vector3();
const _reference = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _bitangent = new THREE.Vector3();

export class SrbSmokePool {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;

  private budget: SmokeBudget;
  private count = 0;
  private frameDt = 0;
  private frameSpawnRemaining = 0;
  private cameraX = 0;
  private cameraY = 0;
  private cameraZ = 0;
  private rngState = 0x8f3a2d71;

  private positions = new Float32Array(0);
  private sizes = new Float32Array(0);
  private lifeFractions = new Float32Array(0);
  private seeds = new Float32Array(0);
  private absolutePositions = new Float64Array(0);
  private velocities = new Float64Array(0);
  private ups = new Float32Array(0);
  private ages = new Float32Array(0);
  private lifetimes = new Float32Array(0);

  private activeEmitters = new Set<string>();
  private currentEmitters = new Set<string>();
  private emissionRemainders = new Map<string, number>();

  constructor(quality: QualityTier) {
    this.budget = BUDGETS[quality];
    const material = new THREE.ShaderMaterial({
      uniforms: { uPointSizeLimit: { value: this.budget.pointSizeLimit } },
      vertexShader: smokeVertexShader,
      fragmentShader: smokeFragmentShader,
      transparent: true,
      blending: THREE.NormalBlending,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    });
    this.points = new THREE.Points(new THREE.BufferGeometry(), material);
    this.points.name = 'srb-world-smoke';
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    this.allocate(this.budget.capacity);
  }

  setQuality(quality: QualityTier): void {
    const next = BUDGETS[quality];
    if (next === this.budget) return;
    this.budget = next;
    this.points.material.uniforms.uPointSizeLimit.value = next.pointSizeLimit;
    this.allocate(next.capacity);
    this.clear();
  }

  beginFrame(dt: number, cameraAbsolute: Readonly<VectorCoordinates>): void {
    this.frameDt = Math.min(1 / 15, Math.max(0, dt));
    this.frameSpawnRemaining = Math.ceil(this.budget.maxSpawnRate * this.frameDt) + this.budget.ignitionHeadroom;
    this.cameraX = cameraAbsolute.x;
    this.cameraY = cameraAbsolute.y;
    this.cameraZ = cameraAbsolute.z;
    this.currentEmitters.clear();

    let index = 0;
    while (index < this.count) {
      const age = this.ages[index] + this.frameDt;
      if (age >= this.lifetimes[index]) {
        this.removeAt(index);
        continue;
      }
      this.ages[index] = age;
      const offset = index * 3;
      this.velocities[offset] += this.ups[offset] * 0.42 * this.frameDt;
      this.velocities[offset + 1] += this.ups[offset + 1] * 0.42 * this.frameDt;
      this.velocities[offset + 2] += this.ups[offset + 2] * 0.42 * this.frameDt;
      this.absolutePositions[offset] += this.velocities[offset] * this.frameDt;
      this.absolutePositions[offset + 1] += this.velocities[offset + 1] * this.frameDt;
      this.absolutePositions[offset + 2] += this.velocities[offset + 2] * this.frameDt;
      // Preserve inherited root-frame velocity. Damping this full vector would
      // incorrectly erase planetary/orbital motion and eject smoke from the
      // camera-relative scene by kilometres per frame.
      this.writeCameraRelative(index);
      this.lifeFractions[index] = age / this.lifetimes[index];
      index++;
    }
  }

  emit(input: Readonly<SrbSmokeEmission>): void {
    this.currentEmitters.add(input.emitterId);
    const pressure = THREE.MathUtils.smoothstep(
      THREE.MathUtils.clamp(input.pressureFrac, 0, 1),
      0.015,
      0.35,
    );
    if (pressure <= 0 || this.frameSpawnRemaining <= 0) return;

    const justIgnited = !this.activeEmitters.has(input.emitterId);
    const largeMotor = input.plumeScale > 1.3;
    const rate = (largeMotor ? 136 : 94) * pressure;
    const accumulated = (this.emissionRemainders.get(input.emitterId) ?? 0) + rate * this.frameDt;
    let spawnCount = Math.floor(accumulated);
    this.emissionRemainders.set(input.emitterId, accumulated - spawnCount);
    if (justIgnited) spawnCount += Math.round((largeMotor ? 28 : 17) * pressure);
    spawnCount = Math.min(spawnCount, this.frameSpawnRemaining, this.budget.capacity - this.count);
    if (spawnCount <= 0) return;

    _direction.set(input.direction.x, input.direction.y, input.direction.z).normalize();
    _reference.set(Math.abs(_direction.y) < 0.9 ? 0 : 1, Math.abs(_direction.y) < 0.9 ? 1 : 0, 0);
    _tangent.crossVectors(_direction, _reference).normalize();
    _bitangent.crossVectors(_direction, _tangent).normalize();
    const plumeScale = Math.max(0.25, input.plumeScale);

    for (let n = 0; n < spawnCount; n++) {
      const index = this.count++;
      const offset = index * 3;
      const angle = this.random() * Math.PI * 2;
      const radial = Math.sqrt(this.random()) * 0.12 * plumeScale;
      const tangentX = _tangent.x * Math.cos(angle) + _bitangent.x * Math.sin(angle);
      const tangentY = _tangent.y * Math.cos(angle) + _bitangent.y * Math.sin(angle);
      const tangentZ = _tangent.z * Math.cos(angle) + _bitangent.z * Math.sin(angle);
      const downstream = (0.08 + this.random() * 0.22) * plumeScale;
      this.absolutePositions[offset] = input.position.x + _direction.x * downstream + tangentX * radial;
      this.absolutePositions[offset + 1] = input.position.y + _direction.y * downstream + tangentY * radial;
      this.absolutePositions[offset + 2] = input.position.z + _direction.z * downstream + tangentZ * radial;

      const exhaustSpeed = (3.8 + this.random() * 4.6) * Math.sqrt(plumeScale);
      const lateralSpeed = (this.random() - 0.5) * 1.25;
      this.velocities[offset] = input.inheritedVelocity.x + _direction.x * exhaustSpeed + tangentX * lateralSpeed;
      this.velocities[offset + 1] = input.inheritedVelocity.y + _direction.y * exhaustSpeed + tangentY * lateralSpeed;
      this.velocities[offset + 2] = input.inheritedVelocity.z + _direction.z * exhaustSpeed + tangentZ * lateralSpeed;
      this.ups[offset] = input.up.x;
      this.ups[offset + 1] = input.up.y;
      this.ups[offset + 2] = input.up.z;
      this.ages[index] = 0;
      this.lifetimes[index] = 2.65 + this.random() * 1.45;
      this.sizes[index] = (0.29 + this.random() * 0.24) * plumeScale;
      this.lifeFractions[index] = 0;
      this.seeds[index] = this.random();
      this.writeCameraRelative(index);
    }
    this.frameSpawnRemaining -= spawnCount;
  }

  endFrame(): void {
    this.activeEmitters = new Set(this.currentEmitters);
    for (const emitterId of this.emissionRemainders.keys()) {
      if (!this.currentEmitters.has(emitterId)) this.emissionRemainders.delete(emitterId);
    }
    this.points.geometry.setDrawRange(0, this.count);
    for (const name of ['position', 'aSize', 'aLife', 'aSeed']) {
      const attribute = this.points.geometry.getAttribute(name) as THREE.BufferAttribute;
      attribute.needsUpdate = true;
    }
    this.points.visible = this.count > 0;
  }

  particleCount(): number { return this.count; }

  clear(): void {
    this.count = 0;
    this.activeEmitters.clear();
    this.currentEmitters.clear();
    this.emissionRemainders.clear();
    this.points.geometry.setDrawRange(0, 0);
    this.points.visible = false;
  }

  dispose(): void {
    this.clear();
    this.points.geometry.dispose();
    this.points.material.dispose();
  }

  private allocate(capacity: number): void {
    const previousGeometry = this.points.geometry;
    this.positions = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.lifeFractions = new Float32Array(capacity);
    this.seeds = new Float32Array(capacity);
    this.absolutePositions = new Float64Array(capacity * 3);
    this.velocities = new Float64Array(capacity * 3);
    this.ups = new Float32Array(capacity * 3);
    this.ages = new Float32Array(capacity);
    this.lifetimes = new Float32Array(capacity);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    geometry.setAttribute('aLife', new THREE.BufferAttribute(this.lifeFractions, 1));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(this.seeds, 1));
    geometry.setDrawRange(0, 0);
    this.points.geometry = geometry;
    previousGeometry.dispose();
  }

  private writeCameraRelative(index: number): void {
    const offset = index * 3;
    this.positions[offset] = this.absolutePositions[offset] - this.cameraX;
    this.positions[offset + 1] = this.absolutePositions[offset + 1] - this.cameraY;
    this.positions[offset + 2] = this.absolutePositions[offset + 2] - this.cameraZ;
  }

  private removeAt(index: number): void {
    const last = --this.count;
    if (index === last) return;
    this.ages[index] = this.ages[last];
    this.lifetimes[index] = this.lifetimes[last];
    this.sizes[index] = this.sizes[last];
    this.lifeFractions[index] = this.lifeFractions[last];
    this.seeds[index] = this.seeds[last];
    const to = index * 3;
    const from = last * 3;
    for (let axis = 0; axis < 3; axis++) {
      this.absolutePositions[to + axis] = this.absolutePositions[from + axis];
      this.velocities[to + axis] = this.velocities[from + axis];
      this.ups[to + axis] = this.ups[from + axis];
    }
  }

  private random(): number {
    let x = this.rngState | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return this.rngState / 0x1_0000_0000;
  }
}
