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
import { evaluateRecipeHeight, type BodyFeatureRecipe } from '../../sim/terrainRecipe';
import {
  bindFlightAerialPerspective,
  type FlightAerialPerspectiveController,
} from '../flightAerialPerspective';
import { surfaceClassPermitsEarthScatter } from './surfaceClass';

/** Terrain query in body-fixed space: raw height (m) and unit surface normal. */
export type SurfaceSampler = (
  dirX: number,
  dirY: number,
  dirZ: number,
) => { height: number; normalX: number; normalY: number; normalZ: number };
export type SurfaceClassSampler = (dirX: number, dirY: number, dirZ: number) => number;

/** Body-fixed sphere whose overlapping visual instances are suppressed. */
export interface SuppressionSphere {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
}

export type ScatterClass = 'grass' | 'shrub' | 'rock';

export type ScatterProfileName = 'veyra' | 'earth-geology' | 'moon-regolith';

export interface ScatterClassDef {
  /** Stable profile-local identifier used for instance pools and diagnostics. */
  readonly id: string;
  /** Existing low-cost geometry archetype reused by this visual class. */
  readonly archetype: ScatterClass;
  /** Integer share of the deterministic class roll. */
  readonly rollWeight: number;
  readonly color: THREE.ColorRepresentation;
  readonly scaleBase: number;
  readonly scaleSpread: number;
  readonly roughness: number;
}

export interface ScatterProfile {
  readonly name: ScatterProfileName;
  /** `dry-land` preserves the ocean exclusion; `solid` includes below-datum basins. */
  readonly placement: 'dry-land' | 'solid';
  /** Body-specific fraction of the tier population and fixed pool reservation. */
  readonly densityScale: number;
  readonly capacityScale: number;
  readonly classes: readonly ScatterClassDef[];
}

function freezeProfile(profile: ScatterProfile): ScatterProfile {
  if (profile.classes.length === 0) throw new Error(`${profile.name} scatter profile has no classes`);
  if (!(profile.densityScale > 0) || profile.densityScale > 1
    || !(profile.capacityScale > 0) || profile.capacityScale > 1) {
    throw new Error(`${profile.name} has invalid density or capacity scaling`);
  }
  const ids = new Set<string>();
  for (const cls of profile.classes) {
    if (!cls.id || ids.has(cls.id)) throw new Error(`${profile.name} has an invalid or duplicate class id`);
    if (!Number.isInteger(cls.rollWeight) || cls.rollWeight <= 0) {
      throw new Error(`${profile.name}/${cls.id} has invalid roll weight`);
    }
    if (!Number.isFinite(cls.scaleBase) || cls.scaleBase <= 0
      || !Number.isFinite(cls.scaleSpread) || cls.scaleSpread < 0
      || !Number.isFinite(cls.roughness) || cls.roughness < 0 || cls.roughness > 1) {
      throw new Error(`${profile.name}/${cls.id} has invalid material or scale parameters`);
    }
    ids.add(cls.id);
  }
  return Object.freeze({
    ...profile,
    classes: Object.freeze(profile.classes.map((cls) => Object.freeze({ ...cls }))),
  });
}

export const VEYRA_SCATTER_PROFILE = freezeProfile({
  name: 'veyra',
  placement: 'dry-land',
  densityScale: 1,
  capacityScale: 1,
  classes: [
    { id: 'grass', archetype: 'grass', rollWeight: 70, color: 0x5f7a3a, scaleBase: 0.5, scaleSpread: 0.8, roughness: 1 },
    { id: 'shrub', archetype: 'shrub', rollWeight: 20, color: 0x4c6330, scaleBase: 1, scaleSpread: 1.4, roughness: 1 },
    { id: 'rock', archetype: 'rock', rollWeight: 10, color: 0x6f6a63, scaleBase: 0.6, scaleSpread: 1.2, roughness: 1 },
  ],
});

export const EARTH_GEOLOGY_SCATTER_PROFILE = freezeProfile({
  name: 'earth-geology',
  placement: 'dry-land',
  densityScale: 0.03,
  capacityScale: 0.1,
  classes: [
    { id: 'stone', archetype: 'rock', rollWeight: 64, color: 0x9b9488, scaleBase: 0.12, scaleSpread: 0.33, roughness: 1 },
    { id: 'clast', archetype: 'shrub', rollWeight: 36, color: 0x827d74, scaleBase: 0.07, scaleSpread: 0.13, roughness: 1 },
  ],
});

export const MOON_REGOLITH_SCATTER_PROFILE = freezeProfile({
  name: 'moon-regolith',
  placement: 'solid',
  densityScale: 0.16,
  capacityScale: 0.2,
  classes: [
    { id: 'boulder', archetype: 'rock', rollWeight: 72, color: 0xa09d97, scaleBase: 0.25, scaleSpread: 0.65, roughness: 1 },
    { id: 'clast', archetype: 'shrub', rollWeight: 28, color: 0x8d8984, scaleBase: 0.1, scaleSpread: 0.25, roughness: 1 },
  ],
});

const SCATTER_PROFILES: Readonly<Record<ScatterProfileName, ScatterProfile>> = Object.freeze({
  veyra: VEYRA_SCATTER_PROFILE,
  'earth-geology': EARTH_GEOLOGY_SCATTER_PROFILE,
  'moon-regolith': MOON_REGOLITH_SCATTER_PROFILE,
});

export function scatterProfileByName(name: ScatterProfileName): ScatterProfile {
  return SCATTER_PROFILES[name];
}

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

/** Altitude above which a local scatter pool cannot contribute useful pixels. */
export function scatterStreamCeiling(tier: QualityTier): number {
  return SCATTER_TIERS[tier].streamRadius * 25;
}

export function scatterPoolCapacity(
  tier: QualityTier,
  profile: Pick<ScatterProfile, 'capacityScale'>,
): number {
  return Math.max(1, Math.floor(SCATTER_TIERS[tier].capacity * profile.capacityScale));
}

function normalizedDirection(x: number, y: number, z: number): readonly [number, number, number] {
  const length = Math.hypot(x, y, z);
  if (!(length > 0) || !Number.isFinite(length)) return [1, 0, 0];
  return [x / length, y / length, z / length];
}

/**
 * Finite-difference sampler over the canonical terrain recipe. All offset
 * directions are renormalized before evaluation so source-map latitude and
 * launch-site distance logic receive unit vectors even at the poles.
 */
export function createRecipeSurfaceSampler(
  recipe: BodyFeatureRecipe,
  stepMeters = 2,
): SurfaceSampler {
  if (!(recipe.radiusMeters > 0) || !Number.isFinite(recipe.radiusMeters)) {
    throw new Error(`Invalid scatter recipe radius ${recipe.radiusMeters}`);
  }
  if (!(stepMeters > 0) || !Number.isFinite(stepMeters)) {
    throw new Error(`Invalid scatter normal step ${stepMeters}`);
  }
  const angularStep = stepMeters / recipe.radiusMeters;
  return (inputX, inputY, inputZ) => {
    const [dirX, dirY, dirZ] = normalizedDirection(inputX, inputY, inputZ);
    let eastX = -dirY;
    let eastY = dirX;
    let eastZ = 0;
    if (eastX * eastX + eastY * eastY < 1e-12) {
      eastX = 1;
      eastY = 0;
      eastZ = 0;
    }
    [eastX, eastY, eastZ] = normalizedDirection(eastX, eastY, eastZ);
    const northX = dirY * eastZ - dirZ * eastY;
    const northY = dirZ * eastX - dirX * eastZ;
    const northZ = dirX * eastY - dirY * eastX;
    const [eastSampleX, eastSampleY, eastSampleZ] = normalizedDirection(
      dirX + eastX * angularStep,
      dirY + eastY * angularStep,
      dirZ + eastZ * angularStep,
    );
    const [northSampleX, northSampleY, northSampleZ] = normalizedDirection(
      dirX + northX * angularStep,
      dirY + northY * angularStep,
      dirZ + northZ * angularStep,
    );
    const height = evaluateRecipeHeight(recipe, { x: dirX, y: dirY, z: dirZ });
    const eastHeight = evaluateRecipeHeight(recipe, {
      x: eastSampleX, y: eastSampleY, z: eastSampleZ,
    });
    const northHeight = evaluateRecipeHeight(recipe, {
      x: northSampleX, y: northSampleY, z: northSampleZ,
    });
    const eastSlope = (eastHeight - height) / stepMeters;
    const northSlope = (northHeight - height) / stepMeters;
    const [normalX, normalY, normalZ] = normalizedDirection(
      dirX - eastX * eastSlope - northX * northSlope,
      dirY - eastY * eastSlope - northY * northSlope,
      dirZ - eastZ * eastSlope - northZ * northSlope,
    );
    return {
      height,
      normalX,
      normalY,
      normalZ,
    };
  };
}

interface ScatterInstanceData {
  readonly cls: string;
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
  profile: Readonly<ScatterProfile> = VEYRA_SCATTER_PROFILE,
  surfaceClassSampler?: SurfaceClassSampler,
): ScatterInstanceData[] {
  const random = mulberry32(hashCellSeed(seed, cx, cy, cz));
  const instances: ScatterInstanceData[] = [];
  const keep = Math.max(0, Math.min(
    tier.perCell,
    Math.round(tier.perCell * tier.density * profile.densityScale),
  ));
  const totalRollWeight = profile.classes.reduce((sum, cls) => sum + cls.rollWeight, 0);
  for (let index = 0; index < tier.perCell; index++) {
    // Draw the full stream so culling only removes the tail: density is a strict
    // subset ordering across tiers for the same cell.
    const ox = ((random() / 0xffffffff) - 0.5) * tier.cellSize;
    const oy = ((random() / 0xffffffff) - 0.5) * tier.cellSize;
    const oz = ((random() / 0xffffffff) - 0.5) * tier.cellSize;
    const classRoll = random() % totalRollWeight;
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
    const earthClassRejected = profile.name === 'earth-geology' && surfaceClassSampler
      ? !surfaceClassPermitsEarthScatter(surfaceClassSampler(dx, dy, dz))
      : false;
    if (!Number.isFinite(surface.height)
      || !Number.isFinite(surface.normalX)
      || !Number.isFinite(surface.normalY)
      || !Number.isFinite(surface.normalZ)
      || earthClassRejected
      || (profile.placement === 'dry-land' && !surfaceClassSampler && surface.height < 0)) continue;
    const surfaceRadius = radius + surface.height;
    let cursor = 0;
    const classDef = profile.classes.find((candidate) => {
      cursor += candidate.rollWeight;
      return classRoll < cursor;
    }) ?? profile.classes[profile.classes.length - 1];
    const scale = classDef.scaleBase + scaleRoll * classDef.scaleSpread;
    instances.push({
      cls: classDef.id,
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

function classGeometry(archetype: ScatterClass): THREE.BufferGeometry {
  switch (archetype) {
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

interface ScatterPool {
  readonly cls: string;
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
  readonly total: number;
  readonly byClass: Readonly<Record<string, number>>;
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
  private shadowsEnabled = false;

  constructor(
    private readonly radius: number,
    private readonly seed: number,
    private readonly sampler: SurfaceSampler,
    tier: QualityTier,
    private readonly profile: Readonly<ScatterProfile> = VEYRA_SCATTER_PROFILE,
    private readonly aerialController?: FlightAerialPerspectiveController,
    private readonly surfaceClassSampler?: SurfaceClassSampler,
  ) {
    this.tier = tier;
    this.group.name = 'terrestrial-scatter';
    this.buildPools();
  }

  private buildPools(): void {
    const capacity = scatterPoolCapacity(this.tier, this.profile);
    this.pools = this.profile.classes.map((cls) => {
      const geometry = classGeometry(cls.archetype);
      const material = new THREE.MeshStandardMaterial({
        color: cls.color,
        roughness: cls.roughness,
        metalness: 0,
        side: cls.archetype === 'grass' ? THREE.DoubleSide : THREE.FrontSide,
      });
      if (this.aerialController) bindFlightAerialPerspective(material, this.aerialController);
      const mesh = new THREE.InstancedMesh(geometry, material, capacity);
      mesh.name = `terrestrial-scatter:${cls.id}`;
      mesh.frustumCulled = false;
      mesh.castShadow = this.shadowsEnabled;
      mesh.receiveShadow = this.shadowsEnabled;
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
      return { cls: cls.id, mesh, count: 0 };
    });
  }

  setShadows(enabled: boolean): void {
    if (this.disposed || enabled === this.shadowsEnabled) return;
    this.shadowsEnabled = enabled;
    for (const pool of this.pools) {
      pool.mesh.castShadow = enabled;
      pool.mesh.receiveShadow = enabled;
    }
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
    const originHeight = this.profile.placement === 'solid'
      ? surface.height
      : Math.max(0, surface.height);
    const originRadius = this.radius + originHeight;
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
            instances = generateScatterCell(
              this.seed, cx, cy, cz, this.radius, tier, this.sampler, this.profile,
              this.surfaceClassSampler,
            );
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

    this.writeInstances(frame, localOrigin, scatterPoolCapacity(this.tier, this.profile));

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
    const counts: Record<string, number> = Object.fromEntries(this.pools.map((pool) => [pool.cls, 0]));
    const suppression = frame.suppression ?? [];
    const overflowed = new Set<string>();
    for (const cell of this.cells.values()) {
      if (cell.lastSeen !== this.frameIndex) continue;
      for (const instance of cell.instances) {
        if (isSuppressed(instance, suppression)) continue;
        const pool = this.pools.find((candidate) => candidate.cls === instance.cls)!;
        if ((counts[instance.cls] ?? 0) >= capacity) { overflowed.add(cell.key); continue; }
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
    const counts: Record<string, number> = {};
    let bytes = 0;
    for (const pool of this.pools) {
      counts[pool.cls] = pool.count;
      bytes += instancedResourceBytes(pool.mesh);
    }
    return Object.freeze({
      grass: counts.grass ?? 0,
      shrub: counts.shrub ?? 0,
      rock: counts.rock ?? 0,
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      byClass: Object.freeze({ ...counts }),
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
