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
import { Vec3 } from '../core/vec3';
import type { Quat } from '../core/quat';
import type { Body } from '../sim/universe';
import { terrainHeight } from '../sim/terrain';

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

export function terrainGridIndices(resolution: number): number[] {
  const indices: number[] = [];
  for (let j = 0; j < resolution - 1; j++) {
    for (let i = 0; i < resolution - 1; i++) {
      const a = j * resolution + i;
      const b = a + 1;
      const c = a + resolution;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  return indices;
}

const _p = new Vec3();
const _dir = new Vec3();
const _e = new Vec3();
const _w = new Vec3();
const _rotatedOrigin = new Vec3();

/** Map cube-face UV (with tan warp for even angular spacing) to unit sphere dir. */
function faceToDir(face: FaceBasis, u: number, v: number, out: Vec3): Vec3 {
  const su = Math.tan(u * (Math.PI / 4));
  const sv = Math.tan(v * (Math.PI / 4));
  out.set(
    face.n.x + face.ua.x * su + face.va.x * sv,
    face.n.y + face.ua.y * su + face.va.y * sv,
    face.n.z + face.ua.z * su + face.va.z * sv,
  );
  return out.normalize();
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
  private readonly chunks = new Map<string, Chunk>();
  private readonly material: THREE.Material;
  private readonly oceanMaterial: THREE.MeshPhongMaterial | null = null;
  private readonly maxDepth: number;
  private quality: PlanetQuality;
  private frame = 0;
  private buildsThisUpdate = 0;
  private readonly palette: { low: THREE.Color; mid: THREE.Color; high: THREE.Color; ocean: THREE.Color };
  private ocean: THREE.Mesh | null = null;
  private shadowReceiver = false;
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

  constructor(body: Body, quality: PlanetQuality = PLANET_QUALITY.medium) {
    this.body = body;
    this.quality = quality;
    this.maxDepth = Math.max(6, Math.min(16, Math.ceil(Math.log2(body.radius / 30))));
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.palette = {
      low: new THREE.Color(body.def.terrain.colorLow),
      mid: new THREE.Color(body.def.terrain.colorMid),
      high: new THREE.Color(body.def.terrain.colorHigh),
      ocean: new THREE.Color(body.def.terrain.colorOcean ?? body.def.terrain.colorLow),
    };
    if (body.def.terrain.oceanLevel > 0 && body.def.terrain.colorOcean) {
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
    }
  }

  setQuality(q: PlanetQuality): void {
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

  /**
   * Update LOD selection and chunk placement.
   * @param camBodyFixed camera position in body-fixed f64 coordinates
   * @param orientation body-fixed to inertial orientation
   * @param originWorld position of the BODY CENTER in camera-relative world
   *        coordinates (f64 subtraction happens before this call)
   */
  update(
    camBodyFixed: Readonly<Vec3>,
    orientation: Readonly<Quat>,
    originWorld: Readonly<Vec3>,
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

    const camDist = camBodyFixed.length();
    const camDir = _dir.copy(camBodyFixed).normalize();
    // Conservative horizon cull: chunks whose center is more than
    // horizonAngle + margin away from the camera direction can't be seen.
    const horizonCos =
      camDist > this.body.radius * 1.01
        ? Math.cos(Math.acos(Math.min(1, this.body.radius / camDist)) + 0.35)
        : -0.2; // near/below surface: keep a generous hemisphere

    const wanted = new Set<string>();
    const scheduleStart = performance.now();
    for (const f of planetFaceOrder(camDir)) {
      if (!this.selectNode(
        { face: f, depth: 0, u0: -1, v0: -1, size: 2, centerDir: faceToDir(FACES[f], 0, 0, new Vec3()), worldSize: this.body.radius * 1.57 },
        camBodyFixed,
        camDir,
        horizonCos,
        wanted,
      )) this.stats.coverageGaps++;
    }
    this.stats.scheduleMs = Math.max(0, performance.now() - scheduleStart - this.stats.installMs);
    this.stats.overlapChunks = countLodOverlaps(wanted);

    // Hide unneeded chunks, show wanted ones, place camera-relative.
    for (const chunk of this.chunks.values()) {
      const inUse = wanted.has(chunk.key);
      chunk.mesh.visible = inUse;
      if (inUse) {
        chunk.lastUsed = this.frame;
        orientation.rotate(chunk.origin, _rotatedOrigin);
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
        this.stats.visible++;
        const geo = chunk.mesh.geometry as THREE.BufferGeometry;
        const idx = geo.getIndex();
        this.stats.triangles += idx ? idx.count / 3 : 0;
      }
    }
    if (this.ocean) {
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
    cam: Readonly<Vec3>,
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
    if (!this.chunks.has(key) && (node.depth === 0 || this.buildsThisUpdate < this.quality.buildBudget)) {
      if (node.depth > 0) this.buildsThisUpdate++;
      this.stats.built++;
      this.buildChunk(key, node);
    }
    const hasFallback = this.chunks.has(key);

    const center = _p.copy(node.centerDir).scale(this.body.radius);
    const dist = Math.max(1, center.distanceTo(cam) - node.worldSize * 0.5);
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
        if (!this.chunks.has(childKey) && this.buildsThisUpdate < this.quality.buildBudget) {
          this.buildsThisUpdate++;
          this.stats.built++;
          this.buildChunk(childKey, child);
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

  private buildChunk(key: string, node: QuadNode): void {
    const installStart = performance.now();
    const res = this.quality.gridRes;
    const face = FACES[node.face];
    const vertCount = res * res + res * 4; // grid + skirt ring
    const positions = new Float32Array(vertCount * 3);
    const normals = new Float32Array(vertCount * 3);
    const colors = new Float32Array(vertCount * 3);

    // Chunk origin: center of chunk at ground level (f64, body-fixed).
    const centerDir = faceToDir(face, node.u0 + node.size / 2, node.v0 + node.size / 2, _dir);
    const hasOcean = this.body.def.terrain.oceanLevel > 0;
    const originH = this.body.radius + renderedTerrainHeight(terrainHeight(this.body, centerDir), hasOcean);
    const origin = new Vec3(centerDir.x * originH, centerDir.y * originH, centerDir.z * originH);

    const eps = Math.max(1e-5, node.size / (res * 8));
    let vi = 0;
    const color = new THREE.Color();
    const writeVertex = (u: number, v: number, sink: number) => {
      const dir = faceToDir(face, u, v, _p);
      const rawH = terrainHeight(this.body, dir);
      const h = renderedTerrainHeight(rawH, hasOcean);
      const r = this.body.radius + h - sink;
      positions[vi * 3] = dir.x * r - origin.x;
      positions[vi * 3 + 1] = dir.y * r - origin.y;
      positions[vi * 3 + 2] = dir.z * r - origin.z;

      // Normal from central differences of the height field.
      const du = faceToDir(face, u + eps, v, _e);
      const hu = renderedTerrainHeight(terrainHeight(this.body, du), hasOcean);
      du.scale(this.body.radius + hu);
      const dv = faceToDir(face, u, v + eps, _w);
      const hv = renderedTerrainHeight(terrainHeight(this.body, dv), hasOcean);
      dv.scale(this.body.radius + hv);
      const px = dir.x * (this.body.radius + h);
      const py = dir.y * (this.body.radius + h);
      const pz = dir.z * (this.body.radius + h);
      du.set(du.x - px, du.y - py, du.z - pz);
      dv.set(dv.x - px, dv.y - py, dv.z - pz);
      const n = Vec3.cross(du, dv, du).normalize();
      // Cube faces wind inconsistently; force outward-facing normals.
      if (n.x * dir.x + n.y * dir.y + n.z * dir.z < 0) n.negate();
      normals[vi * 3] = n.x;
      normals[vi * 3 + 1] = n.y;
      normals[vi * 3 + 2] = n.z;

      // Altitude/slope palette.
      const t = this.body.def.terrain;
      const rel = Math.min(1, Math.max(0, rawH / (t.amplitude * 0.8) + 0.5));
      if (hasOcean && rawH < 0) {
        color.copy(this.palette.ocean);
      } else if (rel < 0.5) {
        color.lerpColors(this.palette.low, this.palette.mid, rel * 2);
      } else {
        color.lerpColors(this.palette.mid, this.palette.high, (rel - 0.5) * 2);
      }
      const slopeShade = 0.75 + 0.25 * Math.max(0, n.x * dir.x + n.y * dir.y + n.z * dir.z);
      colors[vi * 3] = color.r * slopeShade;
      colors[vi * 3 + 1] = color.g * slopeShade;
      colors[vi * 3 + 2] = color.b * slopeShade;
      vi++;
    };

    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const u = node.u0 + (node.size * i) / (res - 1);
        const v = node.v0 + (node.size * j) / (res - 1);
        writeVertex(u, v, 0);
      }
    }
    // Skirt ring: copies of border vertices sunk toward the planet center.
    const skirtDepth = terrainSkirtDepth(node.worldSize, res);
    const border: Array<[number, number]> = [];
    for (let i = 0; i < res; i++) border.push([i, 0]);
    for (let i = 0; i < res; i++) border.push([i, res - 1]);
    for (let j = 0; j < res; j++) border.push([0, j]);
    for (let j = 0; j < res; j++) border.push([res - 1, j]);
    for (const [i, j] of border) {
      const u = node.u0 + (node.size * i) / (res - 1);
      const v = node.v0 + (node.size * j) / (res - 1);
      writeVertex(u, v, skirtDepth);
    }

    // Indices: grid triangles + skirt quads.
    const indices = terrainGridIndices(res);
    const skirtBase = res * res;
    const edge = (list: number[], skirtOffset: number) => {
      for (let k = 0; k < list.length - 1; k++) {
        const g0 = list[k];
        const g1 = list[k + 1];
        const s0 = skirtBase + skirtOffset + k;
        const s1 = s0 + 1;
        indices.push(g0, s0, g1, g1, s0, s1);
      }
    };
    edge(Array.from({ length: res }, (_, i) => i), 0); // v=0 edge
    edge(Array.from({ length: res }, (_, i) => (res - 1) * res + i), res); // v=1
    edge(Array.from({ length: res }, (_, j) => j * res), res * 2); // u=0
    edge(Array.from({ length: res }, (_, j) => j * res + (res - 1)), res * 3); // u=1

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, this.material);
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = true;
    mesh.receiveShadow = this.shadowReceiver;
    this.group.add(mesh);
    this.chunks.set(key, { key, mesh, origin, lastUsed: this.frame });
    this.geometryBytes += geometryByteLength(geo);
    this.stats.installMs += performance.now() - installStart;
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
    for (const chunk of this.chunks.values()) {
      this.group.remove(chunk.mesh);
      chunk.mesh.geometry.dispose();
    }
    this.chunks.clear();
    this.geometryBytes = 0;
    this.material.dispose();
    this.oceanMaterial?.dispose();
    if (this.ocean) this.ocean.geometry.dispose();
  }
}

function geometryByteLength(geometry: THREE.BufferGeometry): number {
  let bytes = 0;
  for (const attribute of Object.values(geometry.attributes)) {
    bytes += attribute.array.byteLength;
  }
  const index = geometry.getIndex();
  if (index) bytes += index.array.byteLength;
  return bytes;
}
