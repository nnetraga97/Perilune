/**
 * Planet surface renderer: cube-sphere quadtree LOD.
 *
 * - Six cube faces, each a quadtree of chunks; chunks split by distance.
 * - Chunk vertices are chunk-local f32; each chunk's origin is kept in f64
 *   body-fixed coordinates and converted to camera-relative world position
 *   every frame (floating origin — the GPU never sees planet-scale floats).
 * - Terrain height comes from src/sim/terrain.ts, the same function physics
 *   uses, so rendering and ground contact can never disagree.
 * - Skirts hide LOD cracks; horizon + frustum culling keep draw calls low.
 * - Chunk builds are budgeted per frame to avoid hitches.
 */
import * as THREE from 'three';
import { geometryByteLength } from './resourceAccounting';
import { Vec3 } from '../core/vec3';
import type { Body } from '../sim/universe';
import { recipeForBody } from '../sim/terrainRecipe';
import type { QuaternionCoordinates, VectorCoordinates } from './bodyRenderer';
import {
  buildTerrainChunkGeometry,
  terrainFaceToDirection,
  type TerrainChunkGeometryRequest,
  type TerrainChunkGeometryResult,
} from './terrain/chunkGeometry';
import type { TerrainChunkWorkerPool } from './terrain/chunkWorkerPool';

export { terrainGridIndices } from './terrain/chunkGeometry';

interface FaceBasis {
  n: Vec3;
  ua: Vec3;
  va: Vec3;
}

const FACES: FaceBasis[] = [
  { n: new Vec3(1, 0, 0), ua: new Vec3(0, 1, 0), va: new Vec3(0, 0, 1) },
  { n: new Vec3(-1, 0, 0), ua: new Vec3(0, -1, 0), va: new Vec3(0, 0, 1) },
  { n: new Vec3(0, 1, 0), ua: new Vec3(0, 0, 1), va: new Vec3(1, 0, 0) },
  { n: new Vec3(0, -1, 0), ua: new Vec3(0, 0, -1), va: new Vec3(1, 0, 0) },
  { n: new Vec3(0, 0, 1), ua: new Vec3(1, 0, 0), va: new Vec3(0, 1, 0) },
  { n: new Vec3(0, 0, -1), ua: new Vec3(-1, 0, 0), va: new Vec3(0, 1, 0) },
];

export function planetFaceOrder(cameraDirection: Readonly<Vec3>): number[] {
  return FACES.map((_, index) => index).sort(
    (a, b) => Vec3.dot(FACES[b].n, cameraDirection) - Vec3.dot(FACES[a].n, cameraDirection),
  );
}

const _p = new Vec3();
const _dir = new Vec3();
const _rotatedOrigin = new Vec3();

function rotateCoordinates(
  q: QuaternionCoordinates,
  value: VectorCoordinates,
  out: Vec3,
): Vec3 {
  const tx = 2 * (q.y * value.z - q.z * value.y);
  const ty = 2 * (q.z * value.x - q.x * value.z);
  const tz = 2 * (q.x * value.y - q.y * value.x);
  return out.set(
    value.x + q.w * tx + (q.y * tz - q.z * ty),
    value.y + q.w * ty + (q.z * tx - q.x * tz),
    value.z + q.w * tz + (q.x * ty - q.y * tx),
  );
}

/** Map cube-face UV (with tan warp for even angular spacing) to unit sphere dir. */
function faceToDir(face: FaceBasis, u: number, v: number, out: Vec3): Vec3 {
  return terrainFaceToDirection(FACES.indexOf(face), u, v, out);
}

interface Chunk {
  key: string;
  mesh: THREE.Mesh;
  /** Chunk origin in body-fixed f64 coordinates. */
  origin: Vec3;
  lastUsed: number;
}

interface QuadNode {
  face: number;
  depth: number;
  u0: number;
  v0: number;
  size: number; // uv span
  centerDir: Vec3; // unit, body-fixed
  worldSize: number; // approx meters
}

export interface PlanetQuality {
  /** Grid resolution per chunk edge (vertices). */
  gridRes: number;
  /** Distance multiple that triggers subdivision. */
  splitFactor: number;
  /** Cap on cached chunk meshes. */
  cacheSize: number;
  /** Chunk builds allowed per update call. */
  buildBudget: number;
}

export const PLANET_QUALITY: Record<'low' | 'medium' | 'high', PlanetQuality> = {
  low: { gridRes: 9, splitFactor: 2.0, cacheSize: 320, buildBudget: 3 },
  medium: { gridRes: 17, splitFactor: 2.5, cacheSize: 480, buildBudget: 4 },
  high: { gridRes: 33, splitFactor: 3.0, cacheSize: 640, buildBudget: 5 },
};

/** Small overlap curtain for LOD seams; capped to avoid visible terrain walls. */
export function terrainSkirtDepth(worldSize: number, gridRes: number): number {
  return Math.min(20, Math.max(2, (worldSize / Math.max(1, gridRes - 1)) * 0.08));
}

export function renderedTerrainHeight(height: number, hasOcean: boolean): number {
  void hasOcean;
  return height;
}

export interface PlanetRendererOptions {
  /** Ownership transfers to PlanetRenderer and is released by dispose(). */
  readonly material?: THREE.Material;
  /** Disable the legacy datum sphere when a separate ocean pass owns water. */
  readonly oceanEnabled?: boolean;
  /** Ownership transfers to PlanetRenderer and is released by dispose(). */
  readonly workerPool?: TerrainChunkWorkerPool;
}

function countLodOverlaps(keys: ReadonlySet<string>): number {
  let overlaps = 0;
  for (const key of keys) {
    const [faceText, depthText, uText, vText] = key.split(':');
    const depth = Number(depthText);
    const u = Number(uText);
    const v = Number(vText);
    for (let ancestorDepth = depth - 1; ancestorDepth >= 0; ancestorDepth--) {
      const size = 2 / 2 ** ancestorDepth;
      const au = -1 + Math.floor((u + 1 + 1e-7) / size) * size;
      const av = -1 + Math.floor((v + 1 + 1e-7) / size) * size;
      if (keys.has(`${faceText}:${ancestorDepth}:${au.toFixed(6)}:${av.toFixed(6)}`)) {
        overlaps++;
        break;
      }
    }
  }
  return overlaps;
}

export class PlanetRenderer {
  readonly body: Body;
  readonly group = new THREE.Group();
  private chunks = new Map<string, Chunk>();
  private replacementChunks: Map<string, Chunk> | null = null;
  private readonly material: THREE.Material;
  private readonly workerPool: TerrainChunkWorkerPool | null;
  private readonly pendingChunks = new Map<string, number>();
  private generation = 1;
  private readonly oceanMaterial: THREE.MeshPhongMaterial | null = null;
  private readonly maxDepth: number;
  private quality: PlanetQuality;
  private frame = 0;
  private buildsThisUpdate = 0;
  private readonly palette: { low: THREE.Color; mid: THREE.Color; high: THREE.Color; ocean: THREE.Color };
  private ocean: THREE.Mesh | null = null;
  private shadowReceiver = false;
  private terrainVisible = true;
  private oceanVisible = true;
  private geometryBytes = 0;
  /** Stats for the perf overlay. */
  stats = {
    chunks: 0,
    visible: 0,
    built: 0,
    triangles: 0,
    coverageGaps: 0,
    overlapChunks: 0,
    scheduleMs: 0,
    installMs: 0,
    geometryBytes: 0,
  };

  constructor(
    body: Body,
    quality: PlanetQuality = PLANET_QUALITY.medium,
    options: Readonly<PlanetRendererOptions> = {},
  ) {
    this.body = body;
    this.quality = quality;
    this.maxDepth = Math.max(6, Math.min(16, Math.ceil(Math.log2(body.radius / 30))));
    this.material = options.material ?? new THREE.MeshLambertMaterial({ vertexColors: true });
    this.workerPool = options.workerPool ?? null;
    this.palette = {
      low: new THREE.Color(body.def.terrain.colorLow),
      mid: new THREE.Color(body.def.terrain.colorMid),
      high: new THREE.Color(body.def.terrain.colorHigh),
      ocean: new THREE.Color(body.def.terrain.colorOcean ?? body.def.terrain.colorLow),
    };
    if (options.oceanEnabled !== false && body.def.terrain.oceanLevel > 0 && body.def.terrain.colorOcean) {
      this.oceanMaterial = new THREE.MeshPhongMaterial({
        color: new THREE.Color(body.def.terrain.colorOcean),
        shininess: 90,
        specular: new THREE.Color('#8fb8cc'),
        transparent: false,
        opacity: 1,
      });
      // Ocean as a moderately tessellated sphere; near-ground the terrain
      // shoreline detail carries the look. Positioned camera-relative with
      // the group each frame.
      const geo = new THREE.SphereGeometry(1, 96, 64);
      this.ocean = new THREE.Mesh(geo, this.oceanMaterial);
      this.ocean.scale.setScalar(body.radius);
      this.group.add(this.ocean);
      this.geometryBytes += geometryByteLength(geo);
    }
  }

  setQuality(q: PlanetQuality): void {
    if (q === this.quality) return;
    this.workerPool?.cancelGeneration(this.generation);
    if (this.replacementChunks) this.disposeChunks(this.replacementChunks);
    this.generation++;
    this.pendingChunks.clear();
    this.replacementChunks = new Map();
    this.quality = q;
  }

  setShadowReceiver(enabled: boolean): void {
    this.shadowReceiver = enabled;
    for (const chunk of this.chunks.values()) chunk.mesh.receiveShadow = enabled;
  }

  setOceanGlitter(enabled: boolean): void {
    if (!this.oceanMaterial) return;
    this.oceanMaterial.shininess = enabled ? 90 : 12;
    this.oceanMaterial.specular.set(enabled ? '#8fb8cc' : '#101820');
    this.oceanMaterial.needsUpdate = true;
  }

  setTerrainVisible(enabled: boolean): void {
    this.terrainVisible = enabled;
  }

  setOceanVisible(enabled: boolean): void {
    this.oceanVisible = enabled;
    if (this.ocean) this.ocean.visible = enabled;
  }

  /** True only when the currently displayed terrain set covers the visible body without holes. */
  coverageReady(): boolean {
    return this.stats.visible > 0 && this.stats.coverageGaps === 0;
  }

  resourceGeometryBytes(): Readonly<{ terrainGeometryBytes: number; oceanGeometryBytes: number; geometryCount: number }> {
    const terrainChunks = [
      ...this.chunks.values(),
      ...(this.replacementChunks?.values() ?? []),
    ];
    const terrainGeometryBytes = terrainChunks
      .reduce((sum, chunk) => sum + geometryByteLength(chunk.mesh.geometry as THREE.BufferGeometry), 0);
    const oceanGeometryBytes = this.ocean ? geometryByteLength(this.ocean.geometry) : 0;
    return Object.freeze({
      terrainGeometryBytes,
      oceanGeometryBytes,
      geometryCount: terrainChunks.length + (this.ocean ? 1 : 0),
    });
  }

  /**
   * Update LOD selection and chunk placement.
   * @param camBodyFixed camera position in body-fixed f64 coordinates
   * @param orientation body-fixed to inertial orientation
   * @param originWorld position of the BODY CENTER in camera-relative world
   *        coordinates (f64 subtraction happens before this call)
   */
  update(
    camBodyFixed: VectorCoordinates,
    orientation: QuaternionCoordinates,
    originWorld: VectorCoordinates,
    cameraBodyFixedVelocity: VectorCoordinates = { x: 0, y: 0, z: 0 },
  ): void {
    this.frame++;
    this.buildsThisUpdate = 0;
    this.stats.visible = 0;
    this.stats.built = 0;
    this.stats.triangles = 0;
    this.stats.coverageGaps = 0;
    this.stats.overlapChunks = 0;
    this.stats.scheduleMs = 0;
    this.stats.installMs = 0;

    if (this.workerPool) {
      const installStart = performance.now();
      for (const result of this.workerPool.drainCompleted()) {
        if (this.pendingChunks.get(result.jobKey) === result.generation) {
          this.pendingChunks.delete(result.jobKey);
        }
        if (result.generation === this.generation) {
          const target = this.replacementChunks ?? this.chunks;
          if (!target.has(result.jobKey)) this.installChunk(result, target);
        }
      }
      this.commitReplacementIfReady();
      this.stats.installMs = performance.now() - installStart;
    }

    const camDist = Math.hypot(camBodyFixed.x, camBodyFixed.y, camBodyFixed.z);
    const camDir = _dir.set(camBodyFixed.x, camBodyFixed.y, camBodyFixed.z).normalize();
    // Conservative horizon cull: chunks whose center is more than
    // horizonAngle + margin away from the camera direction can't be seen.
    const horizonCos =
      camDist > this.body.radius * 1.01
        ? Math.cos(Math.acos(Math.min(1, this.body.radius / camDist)) + 0.35)
        : -0.2; // near/below surface: keep a generous hemisphere

    const wanted = new Set<string>();
    const scheduleStart = performance.now();
    const orderedFaces = planetFaceOrder(camDir);
    const buildTarget = this.replacementChunks ?? this.chunks;
    // Establish the six root fallbacks before spending budget on refinement.
    for (const f of orderedFaces) {
      const key = `${f}:0:-1.000000:-1.000000`;
      if (buildTarget.has(key) || this.pendingChunks.get(key) === this.generation) continue;
      if (this.workerPool && this.buildsThisUpdate >= this.quality.buildBudget) break;
      if (this.workerPool) this.buildsThisUpdate++;
      this.stats.built++;
      this.requestChunk(key, {
        face: f,
        depth: 0,
        u0: -1,
        v0: -1,
        size: 2,
        centerDir: faceToDir(FACES[f], 0, 0, new Vec3()),
        worldSize: this.body.radius * 1.57,
      });
    }
    this.commitReplacementIfReady();
    // While replacement roots stage, committed terrain remains the only
    // selectable coverage and refinement waits for the atomic swap.
    if (this.replacementChunks) this.buildsThisUpdate = this.quality.buildBudget;
    for (const f of orderedFaces) {
      if (!this.selectNode(
        { face: f, depth: 0, u0: -1, v0: -1, size: 2, centerDir: faceToDir(FACES[f], 0, 0, new Vec3()), worldSize: this.body.radius * 1.57 },
        camBodyFixed,
        camDir,
        horizonCos,
        wanted,
      )) this.stats.coverageGaps++;
    }
    if (this.workerPool && this.buildsThisUpdate < this.quality.buildBudget) {
      const predictionSeconds = 0.5;
      const predictedCamera = {
        x: camBodyFixed.x + cameraBodyFixedVelocity.x * predictionSeconds,
        y: camBodyFixed.y + cameraBodyFixedVelocity.y * predictionSeconds,
        z: camBodyFixed.z + cameraBodyFixedVelocity.z * predictionSeconds,
      };
      const predictedDirection = new Vec3(
        predictedCamera.x,
        predictedCamera.y,
        predictedCamera.z,
      ).normalize();
      const predictedWanted = new Set<string>();
      for (const f of planetFaceOrder(predictedDirection)) {
        this.selectNode(
          { face: f, depth: 0, u0: -1, v0: -1, size: 2, centerDir: faceToDir(FACES[f], 0, 0, new Vec3()), worldSize: this.body.radius * 1.57 },
          predictedCamera,
          predictedDirection,
          horizonCos,
          predictedWanted,
        );
        if (this.buildsThisUpdate >= this.quality.buildBudget) break;
      }
    }
    this.stats.scheduleMs = Math.max(0, performance.now() - scheduleStart);
    this.stats.overlapChunks = countLodOverlaps(wanted);

    // Hide unneeded chunks, show wanted ones, place camera-relative.
    for (const chunk of this.chunks.values()) {
      const inUse = wanted.has(chunk.key);
      chunk.mesh.visible = inUse && this.terrainVisible;
      if (inUse) {
        chunk.lastUsed = this.frame;
        rotateCoordinates(orientation, chunk.origin, _rotatedOrigin);
        chunk.mesh.position.set(
          _rotatedOrigin.x + originWorld.x,
          _rotatedOrigin.y + originWorld.y,
          _rotatedOrigin.z + originWorld.z,
        );
        chunk.mesh.quaternion.set(
          orientation.x,
          orientation.y,
          orientation.z,
          orientation.w,
        );
        if (this.terrainVisible) this.stats.visible++;
        const geo = chunk.mesh.geometry as THREE.BufferGeometry;
        const idx = geo.getIndex();
        this.stats.triangles += idx ? idx.count / 3 : 0;
      }
    }
    if (this.ocean) {
      this.ocean.visible = this.oceanVisible;
      this.ocean.position.set(originWorld.x, originWorld.y, originWorld.z);
      this.ocean.quaternion.set(
        orientation.x,
        orientation.y,
        orientation.z,
        orientation.w,
      );
    }

    this.evictStale();
    this.stats.chunks = this.chunks.size;
    this.stats.geometryBytes = this.geometryBytes;
  }

  private selectNode(
    node: QuadNode,
    cam: VectorCoordinates,
    camDir: Readonly<Vec3>,
    horizonCos: number,
    wanted: Set<string>,
  ): boolean {
    // Horizon cull (skip for shallow nodes which can wrap the horizon).
    if (node.depth >= 3) {
      const chunkAngular = node.worldSize / this.body.radius;
      if (Vec3.dot(node.centerDir, camDir) < horizonCos - chunkAngular) return true;
    }

    const key = `${node.face}:${node.depth}:${node.u0.toFixed(6)}:${node.v0.toFixed(6)}`;
    if (!this.chunks.has(key) && this.pendingChunks.get(key) !== this.generation && this.buildsThisUpdate < this.quality.buildBudget) {
      this.buildsThisUpdate++;
      this.stats.built++;
      this.requestChunk(key, node);
    }
    const hasFallback = this.chunks.has(key);

    const center = _p.copy(node.centerDir).scale(this.body.radius);
    const dist = Math.max(1, Math.hypot(center.x - cam.x, center.y - cam.y, center.z - cam.z) - node.worldSize * 0.5);
    if (node.depth < this.maxDepth && dist < node.worldSize * this.quality.splitFactor) {
      const half = node.size / 2;
      const children: QuadNode[] = [];
      for (let q = 0; q < 4; q++) {
        const cu = node.u0 + (q & 1 ? half : 0);
        const cv = node.v0 + (q & 2 ? half : 0);
        children.push({
          face: node.face,
          depth: node.depth + 1,
          u0: cu,
          v0: cv,
          size: half,
          centerDir: faceToDir(FACES[node.face], cu + half / 2, cv + half / 2, new Vec3()),
          worldSize: node.worldSize / 2,
        });
      }

      // Build all four immediate child fallbacks before descending. This lets
      // each quadrant refine independently without ever drawing a parent over
      // only part of its child set.
      for (const child of children) {
        const childKey = `${child.face}:${child.depth}:${child.u0.toFixed(6)}:${child.v0.toFixed(6)}`;
        if (!this.chunks.has(childKey) && this.pendingChunks.get(childKey) !== this.generation && this.buildsThisUpdate < this.quality.buildBudget) {
          this.buildsThisUpdate++;
          this.stats.built++;
          this.requestChunk(childKey, child);
        }
      }
      if (children.some((child) => !this.chunks.has(`${child.face}:${child.depth}:${child.u0.toFixed(6)}:${child.v0.toFixed(6)}`))) {
        if (hasFallback) wanted.add(key);
        return hasFallback;
      }

      let childrenReady = true;
      const childWanted = new Set<string>();
      for (const child of children) {
        childrenReady = this.selectNode(
          child,
          cam,
          camDir,
          horizonCos,
          childWanted,
        ) && childrenReady;
      }
      if (childrenReady) {
        for (const childKey of childWanted) wanted.add(childKey);
        return true;
      }
      if (hasFallback) wanted.add(key);
      return hasFallback;
    }

    if (hasFallback) wanted.add(key);
    return hasFallback;
  }

  private requestChunk(key: string, node: QuadNode): void {
    const request = this.chunkRequest(key, node);
    if (!this.workerPool) {
      const installStart = performance.now();
      this.installChunk(buildTerrainChunkGeometry(request), this.replacementChunks ?? this.chunks);
      this.stats.installMs += performance.now() - installStart;
      return;
    }
    const requestGeneration = request.generation;
    this.pendingChunks.set(key, requestGeneration);
    void this.workerPool.submit(request).catch(() => {
      if (this.pendingChunks.get(key) === requestGeneration) this.pendingChunks.delete(key);
    });
  }

  private chunkRequest(key: string, node: QuadNode): TerrainChunkGeometryRequest {
    const recipe = recipeForBody(this.body);
    const snapshot = Object.freeze({
      ...recipe,
      terrain: Object.freeze({ ...recipe.terrain }),
      craters: Object.freeze(recipe.craters.map((crater) => Object.freeze({
        ...crater,
        center: Object.freeze({ ...crater.center }),
      }))),
    });
    const tuple = (value: THREE.Color): [number, number, number] => [value.r, value.g, value.b];
    return {
      jobKey: key,
      generation: this.generation,
      recipe: snapshot,
      radius: this.body.radius,
      face: node.face,
      u0: node.u0,
      v0: node.v0,
      size: node.size,
      resolution: this.quality.gridRes,
      skirtDepth: terrainSkirtDepth(node.worldSize, this.quality.gridRes),
      palette: {
        low: tuple(this.palette.low),
        mid: tuple(this.palette.mid),
        high: tuple(this.palette.high),
        ocean: tuple(this.palette.ocean),
      },
    };
  }

  private installChunk(result: TerrainChunkGeometryResult, target = this.chunks): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(result.position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(result.normal, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(result.color, 3));
    geo.setAttribute('bodyDirection', new THREE.BufferAttribute(result.bodyDirection, 3));
    geo.setAttribute('bodyFixedDetailAnchor', new THREE.BufferAttribute(result.bodyFixedDetailAnchor, 3));
    geo.setIndex(new THREE.BufferAttribute(result.index, 1));
    geo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(...result.bounds.center),
      result.bounds.radius,
    );

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = true;
    mesh.receiveShadow = this.shadowReceiver;
    mesh.visible = false;
    this.group.add(mesh);
    const origin = new Vec3(...result.origin);
    target.set(result.jobKey, { key: result.jobKey, mesh, origin, lastUsed: this.frame });
    this.geometryBytes += geometryByteLength(geo);
  }

  private commitReplacementIfReady(): void {
    const replacement = this.replacementChunks;
    if (!replacement) return;
    for (let face = 0; face < FACES.length; face++) {
      if (!replacement.has(`${face}:0:-1.000000:-1.000000`)) return;
    }
    this.disposeChunks(this.chunks);
    this.chunks = replacement;
    this.replacementChunks = null;
  }

  private disposeChunks(chunks: Map<string, Chunk>): void {
    for (const chunk of chunks.values()) {
      this.group.remove(chunk.mesh);
      this.geometryBytes -= geometryByteLength(chunk.mesh.geometry as THREE.BufferGeometry);
      chunk.mesh.geometry.dispose();
    }
    chunks.clear();
  }

  private evictStale(): void {
    if (this.chunks.size <= this.quality.cacheSize) return;
    const entries = [...this.chunks.values()].sort((a, b) => a.lastUsed - b.lastUsed);
    const toRemove = this.chunks.size - this.quality.cacheSize;
    for (let i = 0; i < toRemove; i++) {
      const chunk = entries[i];
      if (chunk.lastUsed === this.frame) break; // never evict in-use chunks
      this.group.remove(chunk.mesh);
      this.geometryBytes -= geometryByteLength(chunk.mesh.geometry as THREE.BufferGeometry);
      chunk.mesh.geometry.dispose();
      this.chunks.delete(chunk.key);
    }
  }

  dispose(): void {
    this.workerPool?.cancelGeneration(this.generation);
    this.workerPool?.dispose();
    this.pendingChunks.clear();
    this.disposeChunks(this.chunks);
    if (this.replacementChunks) this.disposeChunks(this.replacementChunks);
    this.replacementChunks = null;
    this.geometryBytes = 0;
    this.material.dispose();
    this.oceanMaterial?.dispose();
    if (this.ocean) this.ocean.geometry.dispose();
  }
}
