/**
 * Streamed visual scatter for the terrestrial surface.
 *
 * Dense grass, shrubs, and rocks are generated deterministically per body-fixed
 * cell from the body seed and cell coordinates, streamed around the camera with
 * GPU instancing. These instances are decorative only: they never create
 * simulation objects and never change collision height. Density and mesh
 * complexity scale with the quality tier, but the deterministic seed and cell
 * grid do not, so the same patch of ground always grows the same field.
 */
import * as THREE from 'three';
import type { QualityTier, QuaternionCoordinates, VectorCoordinates } from '../bodyRenderer';
import { mulberry32 } from '../../sim/scatterRecipe';
import { instancedResourceBytes } from '../resourceAccounting';

/** Terrain query in body-fixed space: raw height (m) and unit surface normal. */
export type SurfaceSampler = (
  dirX: number,
  dirY: number,
  dirZ: number,
) => { height: number; normalX: number; normalY: number; normalZ: number };

/** Body-fixed sphere whose overlapping visual instances are suppressed. */
export interface SuppressionSphere {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
}

export type ScatterClass = 'grass' | 'shrub' | 'rock';
const SCATTER_CLASSES: readonly ScatterClass[] = ['grass', 'shrub', 'rock'];

export interface ScatterTierParams {
  /** Body-fixed streaming radius around the camera surface point (m). */
  readonly streamRadius: number;
  /** Body-fixed cell edge (m). */
  readonly cellSize: number;
  /** Instances generated per cell before quality culling. */
  readonly perCell: number;
  /** Fraction of generated instances kept (visual density). */
  readonly density: number;
  /** Per-class instance-buffer capacity. */
  readonly capacity: number;
}

export const SCATTER_TIERS: Record<QualityTier, ScatterTierParams> = {
  low: { streamRadius: 60, cellSize: 16, perCell: 24, density: 0.35, capacity: 4096 },
  medium: { streamRadius: 90, cellSize: 16, perCell: 24, density: 0.7, capacity: 12288 },
  high: { streamRadius: 120, cellSize: 16, perCell: 24, density: 1.0, capacity: 24576 },
};

interface ScatterInstanceData {
  readonly cls: ScatterClass;
  /** Body-fixed position (m). */
  readonly px: number;
  readonly py: number;
  readonly pz: number;
  /** Body-fixed unit surface normal. */
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly scale: number;
  readonly yaw: number;
}

interface ScatterCell {
  readonly key: string;
  readonly instances: readonly ScatterInstanceData[];
  lastSeen: number;
}

function hashCellSeed(seed: number, cx: number, cy: number, cz: number): number {
  let h = seed >>> 0;
  for (const value of [cx, cy, cz]) {
    h = (Math.imul(h ^ (value | 0), 0x9e3779b1) + 0x6d2b79f5) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic instance set for one body-fixed scatter cell. */
export function generateScatterCell(
  seed: number,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  tier: Readonly<ScatterTierParams>,
  sampler: SurfaceSampler,
): ScatterInstanceData[] {
  const random = mulberry32(hashCellSeed(seed, cx, cy, cz));
  const instances: ScatterInstanceData[] = [];
  const keep = Math.max(0, Math.min(tier.perCell, Math.round(tier.perCell * tier.density)));
  for (let index = 0; index < tier.perCell; index++) {
    // Draw the full stream so culling only removes the tail: density is a strict
    // subset ordering across tiers for the same cell.
    const ox = ((random() / 0xffffffff) - 0.5) * tier.cellSize;
    const oy = ((random() / 0xffffffff) - 0.5) * tier.cellSize;
    const oz = ((random() / 0xffffffff) - 0.5) * tier.cellSize;
    const classRoll = random() % 100;
    const scaleRoll = random() / 0xffffffff;
    const yawRoll = random() / 0xffffffff;
    if (index >= keep) continue;
    const bx = (cx + 0.5) * tier.cellSize + ox;
    const by = (cy + 0.5) * tier.cellSize + oy;
    const bz = (cz + 0.5) * tier.cellSize + oz;
    const length = Math.hypot(bx, by, bz) || 1;
    const dx = bx / length;
    const dy = by / length;
    const dz = bz / length;
    const surface = sampler(dx, dy, dz);
    if (surface.height < 0) continue; // never grow visual scatter underwater
    const surfaceRadius = radius + surface.height;
    const cls: ScatterClass = classRoll < 70 ? 'grass' : classRoll < 90 ? 'shrub' : 'rock';
    const scale = cls === 'grass' ? 0.5 + scaleRoll * 0.8
      : cls === 'shrub' ? 1.0 + scaleRoll * 1.4
        : 0.6 + scaleRoll * 1.2;
    instances.push({
      cls,
      px: dx * surfaceRadius,
      py: dy * surfaceRadius,
      pz: dz * surfaceRadius,
      nx: surface.normalX,
      ny: surface.normalY,
      nz: surface.normalZ,
      scale,
      yaw: yawRoll * Math.PI * 2,
    });
  }
  return instances;
}

function classGeometry(cls: ScatterClass): THREE.BufferGeometry {
  switch (cls) {
    case 'grass': {
      const geo = new THREE.PlaneGeometry(0.6, 1.0);
      geo.translate(0, 0.5, 0);
      return geo;
    }
    case 'shrub':
      return new THREE.IcosahedronGeometry(0.6, 0);
    case 'rock':
      return new THREE.DodecahedronGeometry(0.5, 0);
  }
}

const CLASS_COLOR: Record<ScatterClass, number> = {
  grass: 0x5f7a3a,
  shrub: 0x4c6330,
  rock: 0x6f6a63,
};

interface ScatterPool {
  readonly cls: ScatterClass;
  readonly mesh: THREE.InstancedMesh;
  count: number;
}

export interface TerrestrialScatterFrame {
  readonly cameraBodyFixed: VectorCoordinates;
  readonly orientation: QuaternionCoordinates;
  readonly cameraRelativeOrigin: VectorCoordinates;
  readonly suppression?: readonly SuppressionSphere[];
}

export interface TerrestrialScatterStats {
  readonly grass: number;
  readonly shrub: number;
  readonly rock: number;
  readonly activeCells: number;
  readonly bufferBytes: number;
  readonly droppedCells: number;
}

const _matrix = new THREE.Matrix4();
const _position = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _normal = new THREE.Vector3();

/**
 * Owns instanced grass/shrub/rock pools and streams deterministic visual scatter
 * around the body-fixed camera. Instances are stored relative to a per-frame
 * local origin so planet-scale positions never reach f32 instance matrices.
 */
/** Frames before a cell whose generation threw is retried from its stable seed. */
const FAILED_CELL_RETRY_FRAMES = 120;

export class TerrestrialScatter {
  readonly group = new THREE.Group();
  private pools: ScatterPool[] = [];
  private cells = new Map<string, ScatterCell>();
  /** Cells whose generation threw, mapped to the frame at which to retry. */
  private failedRetryAt = new Map<string, number>();
  private overflowedKeys = new Set<string>();
  private frameIndex = 0;
  private tier: QualityTier;
  private disposed = false;
  private droppedCells = 0;

  constructor(
    private readonly radius: number,
    private readonly seed: number,
    private readonly sampler: SurfaceSampler,
    tier: QualityTier,
  ) {
    this.tier = tier;
    this.group.name = 'terrestrial-scatter';
    this.buildPools();
  }

  private buildPools(): void {
    const capacity = SCATTER_TIERS[this.tier].capacity;
    this.pools = SCATTER_CLASSES.map((cls) => {
      const geometry = classGeometry(cls);
      const material = new THREE.MeshStandardMaterial({
        color: CLASS_COLOR[cls],
        roughness: 1,
        metalness: 0,
        side: cls === 'grass' ? THREE.DoubleSide : THREE.FrontSide,
      });
      const mesh = new THREE.InstancedMesh(geometry, material, capacity);
      mesh.name = `terrestrial-scatter:${cls}`;
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
      return { cls, mesh, count: 0 };
    });
  }

  setQuality(tier: QualityTier): void {
    if (tier === this.tier || this.disposed) return;
    this.tier = tier;
    for (const pool of this.pools) {
      this.group.remove(pool.mesh);
      pool.mesh.geometry.dispose();
      (pool.mesh.material as THREE.Material).dispose();
      pool.mesh.dispose();
    }
    this.cells.clear();
    this.failedRetryAt.clear();
    this.overflowedKeys.clear();
    this.buildPools();
  }

  /** Stream, regenerate, and place visible instances for one frame. */
  update(frame: Readonly<TerrestrialScatterFrame>): void {
    if (this.disposed) return;
    this.frameIndex++;
    const tier = SCATTER_TIERS[this.tier];
    const cam = frame.cameraBodyFixed;
    const camLength = Math.hypot(cam.x, cam.y, cam.z) || 1;
    const dirX = cam.x / camLength;
    const dirY = cam.y / camLength;
    const dirZ = cam.z / camLength;
    const surface = this.sampler(dirX, dirY, dirZ);
    const originRadius = this.radius + Math.max(0, surface.height);
    const localOrigin = { x: dirX * originRadius, y: dirY * originRadius, z: dirZ * originRadius };

    // Tangent basis for the streaming neighborhood.
    let ex = -dirY;
    let ey = dirX;
    let ez = 0;
    if (ex * ex + ey * ey + ez * ez < 1e-9) { ex = 1; ey = 0; ez = 0; }
    const eLen = Math.hypot(ex, ey, ez);
    ex /= eLen; ey /= eLen; ez /= eLen;
    const nx = dirY * ez - dirZ * ey;
    const ny = dirZ * ex - dirX * ez;
    const nz = dirX * ey - dirY * ex;

    const cs = tier.cellSize;
    const steps = Math.ceil(tier.streamRadius / cs);
    const active = new Set<string>();
    for (let iy = -steps; iy <= steps; iy++) {
      for (let ix = -steps; ix <= steps; ix++) {
        if (ix * ix + iy * iy > (steps + 0.5) * (steps + 0.5)) continue;
        const wx = localOrigin.x + ex * ix * cs + nx * iy * cs;
        const wy = localOrigin.y + ey * ix * cs + ny * iy * cs;
        const wz = localOrigin.z + ez * ix * cs + nz * iy * cs;
        const cx = Math.floor(wx / cs);
        const cy = Math.floor(wy / cs);
        const cz = Math.floor(wz / cs);
        const key = `${cx},${cy},${cz}`;
        if (active.has(key)) continue;
        active.add(key);
        const retryAt = this.failedRetryAt.get(key);
        if (retryAt !== undefined) {
          if (this.frameIndex < retryAt) continue;
          this.failedRetryAt.delete(key);
        }
        let cell = this.cells.get(key);
        if (!cell) {
          // A failed cell is discarded and deterministically regenerated on a
          // later update rather than failing the whole frame.
          let instances: readonly ScatterInstanceData[];
          try {
            instances = generateScatterCell(this.seed, cx, cy, cz, this.radius, tier, this.sampler);
          } catch {
            this.failedRetryAt.set(key, this.frameIndex + FAILED_CELL_RETRY_FRAMES);
            continue;
          }
          cell = { key, instances, lastSeen: this.frameIndex };
          this.cells.set(key, cell);
        }
        cell.lastSeen = this.frameIndex;
      }
    }

    // 20% distance hysteresis: retire cells whose center left the padded radius.
    const retireRadius = tier.streamRadius * 1.2;
    for (const [key, cell] of this.cells) {
      if (cell.lastSeen === this.frameIndex) continue;
      const [cx, cy, cz] = key.split(',').map(Number);
      const centerX = (cx + 0.5) * cs - localOrigin.x;
      const centerY = (cy + 0.5) * cs - localOrigin.y;
      const centerZ = (cz + 0.5) * cs - localOrigin.z;
      if (Math.hypot(centerX, centerY, centerZ) > retireRadius) this.cells.delete(key);
    }

    this.writeInstances(frame, localOrigin, tier.capacity);

    // Place the group so body-fixed-relative instance matrices map to world.
    _quaternion.set(frame.orientation.x, frame.orientation.y, frame.orientation.z, frame.orientation.w);
    _position.set(localOrigin.x, localOrigin.y, localOrigin.z).applyQuaternion(_quaternion);
    this.group.position.set(
      _position.x + frame.cameraRelativeOrigin.x,
      _position.y + frame.cameraRelativeOrigin.y,
      _position.z + frame.cameraRelativeOrigin.z,
    );
    this.group.quaternion.copy(_quaternion);
  }

  private writeInstances(
    frame: Readonly<TerrestrialScatterFrame>,
    localOrigin: VectorCoordinates,
    capacity: number,
  ): void {
    const counts: Record<ScatterClass, number> = { grass: 0, shrub: 0, rock: 0 };
    const suppression = frame.suppression ?? [];
    const overflowed = new Set<string>();
    for (const cell of this.cells.values()) {
      if (cell.lastSeen !== this.frameIndex) continue;
      for (const instance of cell.instances) {
        if (isSuppressed(instance, suppression)) continue;
        const pool = this.pools.find((candidate) => candidate.cls === instance.cls)!;
        if (counts[instance.cls] >= capacity) { overflowed.add(cell.key); continue; }
        _normal.set(instance.nx, instance.ny, instance.nz);
        if (_normal.lengthSq() < 1e-9) _normal.set(instance.px, instance.py, instance.pz).normalize();
        _quaternion.setFromUnitVectors(_up, _normal.normalize());
        _quaternion.multiply(_yawQuaternion(instance.yaw));
        _position.set(instance.px - localOrigin.x, instance.py - localOrigin.y, instance.pz - localOrigin.z);
        _scale.setScalar(instance.scale);
        _matrix.compose(_position, _quaternion, _scale);
        pool.mesh.setMatrixAt(counts[instance.cls]++, _matrix);
      }
    }
    // Overflowed cells stay cached — deleting them caused an every-frame
    // regenerate/overflow loop. Their remaining instances place naturally once
    // retiring cells free capacity; the stat counts new overflow events only.
    for (const key of overflowed) {
      if (!this.overflowedKeys.has(key)) this.droppedCells++;
    }
    this.overflowedKeys = overflowed;
    for (const pool of this.pools) {
      pool.count = counts[pool.cls];
      pool.mesh.count = pool.count;
      pool.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  stats(): Readonly<TerrestrialScatterStats> {
    let activeCells = 0;
    for (const cell of this.cells.values()) if (cell.lastSeen === this.frameIndex) activeCells++;
    const counts: Record<ScatterClass, number> = { grass: 0, shrub: 0, rock: 0 };
    let bytes = 0;
    for (const pool of this.pools) {
      counts[pool.cls] = pool.count;
      bytes += instancedResourceBytes(pool.mesh);
    }
    return Object.freeze({
      grass: counts.grass,
      shrub: counts.shrub,
      rock: counts.rock,
      activeCells,
      bufferBytes: bytes,
      droppedCells: this.droppedCells,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pool of this.pools) {
      this.group.remove(pool.mesh);
      pool.mesh.geometry.dispose();
      (pool.mesh.material as THREE.Material).dispose();
      pool.mesh.dispose();
    }
    this.pools = [];
    this.cells.clear();
    this.failedRetryAt.clear();
    this.overflowedKeys.clear();
  }
}

const _yaw = new THREE.Quaternion();
function _yawQuaternion(yaw: number): THREE.Quaternion {
  return _yaw.setFromAxisAngle(_up, yaw);
}

function isSuppressed(instance: ScatterInstanceData, spheres: readonly SuppressionSphere[]): boolean {
  for (const sphere of spheres) {
    const dx = instance.px - sphere.x;
    const dy = instance.py - sphere.y;
    const dz = instance.pz - sphere.z;
    if (dx * dx + dy * dy + dz * dz <= sphere.radius * sphere.radius) return true;
  }
  return false;
}
