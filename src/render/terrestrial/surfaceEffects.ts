/**
 * Terrain-hugging decals and body-fixed dust for the terrestrial surface.
 *
 * Decals are pooled, normal-aligned quads placed deterministically on the
 * terrain near the camera (bare soil, rock breakup, wet shore, landing scuffs).
 * Dust is a bounded Points system advected by the vessel's body-fixed velocity
 * and biome dryness. Neither ever creates simulation state or changes collision
 * height, and dust motion is anchored in body-fixed meters so floating-origin
 * shifts cannot make it swim.
 */
import * as THREE from 'three';
import type { QualityTier, QuaternionCoordinates, VectorCoordinates } from '../bodyRenderer';
import { mulberry32 } from '../../sim/scatterRecipe';
import { instancedResourceBytes } from '../resourceAccounting';
import type { SurfaceSampler } from './scatter';

export type DecalKind = 'soil' | 'rock' | 'wet-shore' | 'scuff';
const DECAL_COLOR: Record<DecalKind, number> = {
  soil: 0x6b5638,
  rock: 0x585049,
  'wet-shore': 0x3b4a52,
  scuff: 0x2c2a27,
};

export interface SurfaceEffectsTierParams {
  readonly decalRadius: number;
  readonly decalCellSize: number;
  readonly decalCapacity: number;
  readonly dustCapacity: number;
}

export const SURFACE_EFFECTS_TIERS: Record<QualityTier, SurfaceEffectsTierParams> = {
  low: { decalRadius: 45, decalCellSize: 22, decalCapacity: 256, dustCapacity: 128 },
  medium: { decalRadius: 70, decalCellSize: 22, decalCapacity: 768, dustCapacity: 384 },
  high: { decalRadius: 95, decalCellSize: 22, decalCapacity: 1536, dustCapacity: 768 },
};

export interface TerrestrialSurfaceEffectsFrame {
  readonly cameraBodyFixed: VectorCoordinates;
  readonly cameraBodyFixedVelocity: VectorCoordinates;
  readonly orientation: QuaternionCoordinates;
  readonly cameraRelativeOrigin: VectorCoordinates;
  readonly altitude: number;
  readonly deltaSeconds: number;
  readonly time: number;
}

export interface TerrestrialSurfaceEffectsStats {
  readonly decals: number;
  readonly dust: number;
  readonly bufferBytes: number;
}

const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _normal = new THREE.Vector3();

function hashDecalSeed(seed: number, cx: number, cy: number, cz: number): number {
  let h = (seed ^ 0x2545f491) >>> 0;
  for (const value of [cx, cy, cz]) h = (Math.imul(h ^ (value | 0), 0x85ebca77) + 0xc2b2ae3d) >>> 0;
  return h >>> 0;
}

interface DecalData {
  px: number; py: number; pz: number;
  nx: number; ny: number; nz: number;
  scale: number; yaw: number; kind: DecalKind;
}

/** Deterministic decals for one body-fixed decal cell. */
export function generateDecalCell(
  seed: number,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  cellSize: number,
  sampler: SurfaceSampler,
): DecalData[] {
  const random = mulberry32(hashDecalSeed(seed, cx, cy, cz));
  const decals: DecalData[] = [];
  const count = random() % 3; // 0-2 decals per cell
  for (let index = 0; index < count; index++) {
    const ox = ((random() / 0xffffffff) - 0.5) * cellSize;
    const oy = ((random() / 0xffffffff) - 0.5) * cellSize;
    const oz = ((random() / 0xffffffff) - 0.5) * cellSize;
    const kindRoll = random() % 100;
    const scaleRoll = random() / 0xffffffff;
    const yawRoll = random() / 0xffffffff;
    const bx = (cx + 0.5) * cellSize + ox;
    const by = (cy + 0.5) * cellSize + oy;
    const bz = (cz + 0.5) * cellSize + oz;
    const length = Math.hypot(bx, by, bz) || 1;
    const dx = bx / length;
    const dy = by / length;
    const dz = bz / length;
    const surface = sampler(dx, dy, dz);
    const surfaceRadius = radius + surface.height;
    const kind: DecalKind = surface.height < 5 ? 'wet-shore'
      : kindRoll < 50 ? 'soil' : kindRoll < 85 ? 'rock' : 'scuff';
    decals.push({
      px: dx * surfaceRadius,
      py: dy * surfaceRadius,
      pz: dz * surfaceRadius,
      nx: surface.normalX,
      ny: surface.normalY,
      nz: surface.normalZ,
      scale: 1.5 + scaleRoll * 3.5,
      yaw: yawRoll * Math.PI * 2,
      kind,
    });
  }
  return decals;
}

export class TerrestrialSurfaceEffects {
  readonly group = new THREE.Group();
  private decalMesh!: THREE.InstancedMesh;
  private dustPoints!: THREE.Points;
  private dustPositions!: Float32Array;
  private dustSeeds!: Float32Array;
  private dustCount = 0;
  private decalCount = 0;
  private tier: QualityTier;
  private disposed = false;

  constructor(
    private readonly radius: number,
    private readonly seed: number,
    private readonly sampler: SurfaceSampler,
    tier: QualityTier,
  ) {
    this.tier = tier;
    this.group.name = 'terrestrial-surface-effects';
    this.build();
  }

  private build(): void {
    const params = SURFACE_EFFECTS_TIERS[this.tier];
    const decalGeometry = new THREE.PlaneGeometry(1, 1);
    decalGeometry.rotateX(-Math.PI / 2); // lie flat, normal +Y before alignment
    const decalMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1, metalness: 0,
      transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1,
    });
    this.decalMesh = new THREE.InstancedMesh(decalGeometry, decalMaterial, params.decalCapacity);
    this.decalMesh.name = 'terrestrial-decals';
    this.decalMesh.frustumCulled = false;
    this.decalMesh.count = 0;
    this.decalMesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(params.decalCapacity * 3), 3,
    );

    this.dustPositions = new Float32Array(params.dustCapacity * 3);
    this.dustSeeds = new Float32Array(params.dustCapacity);
    const dustGeometry = new THREE.BufferGeometry();
    dustGeometry.setAttribute('position', new THREE.BufferAttribute(this.dustPositions, 3));
    // Local body-fixed particle box; pin the bounds so Three never recomputes.
    dustGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 64);
    const dustMaterial = new THREE.PointsMaterial({
      color: 0x9a8266, size: 0.35, transparent: true, opacity: 0.5, depthWrite: false,
    });
    this.dustPoints = new THREE.Points(dustGeometry, dustMaterial);
    this.dustPoints.name = 'terrestrial-dust';
    this.dustPoints.frustumCulled = false;
    this.group.add(this.decalMesh, this.dustPoints);
  }

  setQuality(tier: QualityTier): void {
    if (tier === this.tier || this.disposed) return;
    this.tier = tier;
    this.releaseObjects();
    this.build();
  }

  update(frame: Readonly<TerrestrialSurfaceEffectsFrame>): void {
    if (this.disposed) return;
    const params = SURFACE_EFFECTS_TIERS[this.tier];
    const cam = frame.cameraBodyFixed;
    const camLength = Math.hypot(cam.x, cam.y, cam.z) || 1;
    const dirX = cam.x / camLength;
    const dirY = cam.y / camLength;
    const dirZ = cam.z / camLength;
    const surface = this.sampler(dirX, dirY, dirZ);
    const originRadius = this.radius + Math.max(0, surface.height);
    const localOrigin = { x: dirX * originRadius, y: dirY * originRadius, z: dirZ * originRadius };

    this.updateDecals(params, localOrigin, dirX, dirY, dirZ);
    this.updateDust(frame, params, localOrigin);

    _quaternion.set(frame.orientation.x, frame.orientation.y, frame.orientation.z, frame.orientation.w);
    _position.set(localOrigin.x, localOrigin.y, localOrigin.z).applyQuaternion(_quaternion);
    this.group.position.set(
      _position.x + frame.cameraRelativeOrigin.x,
      _position.y + frame.cameraRelativeOrigin.y,
      _position.z + frame.cameraRelativeOrigin.z,
    );
    this.group.quaternion.copy(_quaternion);
  }

  private updateDecals(
    params: SurfaceEffectsTierParams,
    localOrigin: VectorCoordinates,
    dirX: number, dirY: number, dirZ: number,
  ): void {
    let ex = -dirY, ey = dirX, ez = 0;
    if (ex * ex + ey * ey + ez * ez < 1e-9) { ex = 1; ey = 0; ez = 0; }
    const eLen = Math.hypot(ex, ey, ez);
    ex /= eLen; ey /= eLen; ez /= eLen;
    const fx = dirY * ez - dirZ * ey;
    const fy = dirZ * ex - dirX * ez;
    const fz = dirX * ey - dirY * ex;
    const cs = params.decalCellSize;
    const steps = Math.ceil(params.decalRadius / cs);
    const colors = this.decalMesh.instanceColor!;
    const seen = new Set<string>();
    let count = 0;
    for (let iy = -steps; iy <= steps && count < params.decalCapacity; iy++) {
      for (let ix = -steps; ix <= steps && count < params.decalCapacity; ix++) {
        const wx = localOrigin.x + ex * ix * cs + fx * iy * cs;
        const wy = localOrigin.y + ey * ix * cs + fy * iy * cs;
        const wz = localOrigin.z + ez * ix * cs + fz * iy * cs;
        const cx = Math.floor(wx / cs);
        const cy = Math.floor(wy / cs);
        const cz = Math.floor(wz / cs);
        const key = `${cx},${cy},${cz}`;
        if (seen.has(key)) continue;
        seen.add(key);
        for (const decal of generateDecalCell(this.seed, cx, cy, cz, this.radius, cs, this.sampler)) {
          if (count >= params.decalCapacity) break;
          _normal.set(decal.nx, decal.ny, decal.nz);
          if (_normal.lengthSq() < 1e-9) _normal.set(decal.px, decal.py, decal.pz);
          _quaternion.setFromUnitVectors(_up, _normal.normalize());
          _quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(_up, decal.yaw));
          _position.set(decal.px - localOrigin.x, decal.py - localOrigin.y, decal.pz - localOrigin.z);
          _scale.set(decal.scale, decal.scale, decal.scale);
          _matrix.compose(_position, _quaternion, _scale);
          this.decalMesh.setMatrixAt(count, _matrix);
          const color = new THREE.Color(DECAL_COLOR[decal.kind]);
          colors.setXYZ(count, color.r, color.g, color.b);
          count++;
        }
      }
    }
    this.decalCount = count;
    this.decalMesh.count = count;
    this.decalMesh.instanceMatrix.needsUpdate = true;
    colors.needsUpdate = true;
  }

  private updateDust(
    frame: Readonly<TerrestrialSurfaceEffectsFrame>,
    params: SurfaceEffectsTierParams,
    localOrigin: VectorCoordinates,
  ): void {
    // Dryness rises as altitude falls near the surface; dust only kicks up low.
    const dryness = Math.max(0, 1 - Math.max(0, frame.altitude) / 400);
    const speed = Math.hypot(
      frame.cameraBodyFixedVelocity.x,
      frame.cameraBodyFixedVelocity.y,
      frame.cameraBodyFixedVelocity.z,
    );
    const target = Math.round(params.dustCapacity * dryness * Math.min(1, speed / 40));
    const box = 30;
    for (let i = 0; i < params.dustCapacity; i++) {
      if (i >= target) {
        // Park inactive particles at a finite point; drawRange hides them, and
        // finite values keep boundingSphere computation NaN-free.
        this.dustPositions[i * 3] = 0;
        this.dustPositions[i * 3 + 1] = 0;
        this.dustPositions[i * 3 + 2] = 0;
        continue;
      }
      if (this.dustSeeds[i] === 0) this.dustSeeds[i] = ((i + 1) * 0x9e3779b1) >>> 0;
      const random = mulberry32((this.dustSeeds[i] ^ Math.floor(frame.time * 2)) >>> 0);
      // Body-fixed drift: advect by velocity, wrap in a local box around the camera.
      const phase = (frame.time * 0.7 + i) % 1;
      const bx = ((random() / 0xffffffff) - 0.5) * box + frame.cameraBodyFixedVelocity.x * phase;
      const by = ((random() / 0xffffffff) - 0.5) * box + frame.cameraBodyFixedVelocity.y * phase + 0.5 + phase * 2;
      const bz = ((random() / 0xffffffff) - 0.5) * box + frame.cameraBodyFixedVelocity.z * phase;
      this.dustPositions[i * 3] = ((bx % box) + box) % box - box / 2;
      this.dustPositions[i * 3 + 1] = by;
      this.dustPositions[i * 3 + 2] = ((bz % box) + box) % box - box / 2;
    }
    this.dustCount = target;
    this.dustPoints.geometry.setDrawRange(0, target);
    (this.dustPoints.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    void localOrigin;
  }

  stats(): Readonly<TerrestrialSurfaceEffectsStats> {
    const bytes = instancedResourceBytes(this.decalMesh) + this.dustPositions.byteLength;
    return Object.freeze({ decals: this.decalCount, dust: this.dustCount, bufferBytes: bytes });
  }

  private releaseObjects(): void {
    this.group.remove(this.decalMesh, this.dustPoints);
    this.decalMesh.geometry.dispose();
    (this.decalMesh.material as THREE.Material).dispose();
    this.decalMesh.dispose();
    this.dustPoints.geometry.dispose();
    (this.dustPoints.material as THREE.Material).dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseObjects();
  }
}
