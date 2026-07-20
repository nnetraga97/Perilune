/** Shared planetary terrain facade plus the legacy optional ocean pass. */
import * as THREE from 'three';
import { Vec3 } from '../core/vec3';
import type { Body } from '../sim/universe';
import type { QuaternionCoordinates, VectorCoordinates } from './bodyRenderer';
import { geometryByteLength } from './resourceAccounting';
import type { RenderDiagnosticContext, RenderDiagnosticsPort } from './renderDiagnostics';
import type { TerrainChunkWorkerPool } from './terrain/chunkWorkerPool';
import { DEFAULT_TERRAIN_GEOMETRY_BUDGET } from './resourceAccounting';
import { PlanetTerrainEngine } from './terrain/planetTerrainEngine';
import { TERRAIN_QUALITY_POLICY, type TerrainQualityPolicy } from './terrain/terrainPolicy';
import { createBodySurfaceProvider } from './terrain/surfaceProvider';
import {
  terrainFrustumPredicate,
  terrainFrustumSignature,
  type BodyFixedFrustumPlane,
} from './terrain/terrainFrustum';
import {
  createTerrainTileId,
  parseTerrainTileKey,
  terrainTileChildren,
  terrainTileKey,
  terrainTileParent,
  terrainTileUvBounds,
  type TerrainTileId,
} from './terrain/tile';

export { terrainGridIndices } from './terrain/chunkGeometry';


export interface PlanetQuality {
  /** Grid resolution per streamed tile edge. */
  readonly gridRes: number;
  /** Maximum worker submissions made by one frame. */
  readonly buildBudget: number;
}

export const PLANET_QUALITY: Readonly<Record<'low' | 'medium' | 'high', PlanetQuality>> = Object.freeze({
  low: Object.freeze({ gridRes: TERRAIN_QUALITY_POLICY.low.gridResolution, buildBudget: TERRAIN_QUALITY_POLICY.low.submissionsPerFrame }),
  medium: Object.freeze({ gridRes: TERRAIN_QUALITY_POLICY.medium.gridResolution, buildBudget: TERRAIN_QUALITY_POLICY.medium.submissionsPerFrame }),
  high: Object.freeze({ gridRes: TERRAIN_QUALITY_POLICY.high.gridResolution, buildBudget: TERRAIN_QUALITY_POLICY.high.submissionsPerFrame }),
});

export interface PlanetRenderProjection {
  readonly verticalFovRadians: number;
  readonly drawingBufferHeight: number;
  readonly viewDirectionBodyFixed?: VectorCoordinates;
  readonly bodyFixedFrustum?: readonly BodyFixedFrustumPlane[];
  readonly deltaSeconds: number;
  readonly framePressure: boolean;
}

const DEFAULT_PROJECTION: Readonly<PlanetRenderProjection> = Object.freeze({
  verticalFovRadians: Math.PI / 3,
  drawingBufferHeight: 1_080,
  deltaSeconds: 1 / 60,
  framePressure: false,
});

export interface PlanetRendererOptions {
  /** Ownership transfers to PlanetRenderer and is released by dispose(). */
  readonly material?: THREE.Material;
  /** Disable the compatibility ocean sphere when a separate ocean pass owns water. */
  readonly oceanEnabled?: boolean;
  /** Ownership transfers to PlanetRenderer and is released by dispose(). */
  readonly workerPool?: TerrainChunkWorkerPool;
  /** False when a longer-lived renderer owns and reuses the worker pool. */
  readonly ownsWorkerPool?: boolean;
  readonly terrainAllocationBytes?: number;
  readonly diagnostics?: RenderDiagnosticsPort;
  readonly now?: () => number;
  readonly diagnosticSource?: string;
}

export interface PlanetDiagnosticContext extends RenderDiagnosticContext {
  readonly terrainRequested: boolean;
}

export interface PlanetRendererStats {
  chunks: number;
  visible: number;
  built: number;
  triangles: number;
  coverageGaps: number;
  overlapChunks: number;
  scheduleMs: number;
  installMs: number;
  selectionMs: number;
  balanceMs: number;
  selectionPasses: number;
  selectionReused: boolean;
  geometryBytes: number;
  pending: number;
  activeTransitions: number;
}

export interface TerrainChunkKeyInfo {
  readonly key: string;
  readonly face: number;
  readonly depth: number;
  readonly u0: number;
  readonly v0: number;
  readonly parentKey: string | null;
  readonly childKeys: readonly [string, string, string, string];
}

function qualityTier(quality: Readonly<PlanetQuality>): 'low' | 'medium' | 'high' {
  if (quality.gridRes <= TERRAIN_QUALITY_POLICY.low.gridResolution) return 'low';
  if (quality.gridRes >= TERRAIN_QUALITY_POLICY.high.gridResolution) return 'high';
  return 'medium';
}

function enginePolicy(quality: Readonly<PlanetQuality>): TerrainQualityPolicy {
  const base = TERRAIN_QUALITY_POLICY[qualityTier(quality)];
  if (!Number.isInteger(quality.gridRes) || quality.gridRes < 2) {
    throw new Error(`Invalid planet grid resolution ${quality.gridRes}`);
  }
  if (!Number.isInteger(quality.buildBudget) || quality.buildBudget < 0) {
    throw new Error(`Invalid planet build budget ${quality.buildBudget}`);
  }
  return Object.freeze({
    ...base,
    gridResolution: quality.gridRes,
    submissionsPerFrame: quality.buildBudget,
  });
}

/** Retained for legacy diagnostics and recordings; production identity is integer based. */
function legacyTerrainChunkKeyInfo(key: string): TerrainChunkKeyInfo {
  const [faceText, depthText, uText, vText] = key.split(':');
  const face = Number(faceText);
  const depth = Number(depthText);
  const u0 = Number(uText);
  const v0 = Number(vText);
  if (
    !Number.isInteger(face) || face < 0 || face > 5
    || !Number.isInteger(depth) || depth < 0
    || !Number.isFinite(u0) || !Number.isFinite(v0)
  ) throw new Error(`Invalid terrain chunk key: ${key}`);
  const size = 2 / 2 ** depth;
  const x = Math.round((u0 + 1) / size);
  const y = Math.round((v0 + 1) / size);
  const id = createTerrainTileId(face, depth, x, y);
  const format = (tile: Readonly<TerrainTileId>): string => {
    const bounds = terrainTileUvBounds(tile);
    return `${tile.face}:${tile.depth}:${bounds.u0.toFixed(6)}:${bounds.v0.toFixed(6)}`;
  };
  const parent = terrainTileParent(id);
  return Object.freeze({
    key,
    face,
    depth,
    u0,
    v0,
    parentKey: parent ? format(parent) : null,
    childKeys: Object.freeze(terrainTileChildren(id).map(format)) as unknown as readonly [string, string, string, string],
  });
}

export function terrainChunkKeyInfo(key: string): TerrainChunkKeyInfo {
  if (key.includes(':')) return legacyTerrainChunkKeyInfo(key);
  let id: TerrainTileId;
  try { id = parseTerrainTileKey(key); } catch { throw new Error(`Invalid terrain chunk key: ${key}`); }
  const bounds = terrainTileUvBounds(id);
  const parent = terrainTileParent(id);
  return Object.freeze({
    key,
    face: id.face,
    depth: id.depth,
    u0: bounds.u0,
    v0: bounds.v0,
    parentKey: parent ? terrainTileKey(parent) : null,
    childKeys: Object.freeze(terrainTileChildren(id).map(terrainTileKey)) as unknown as readonly [string, string, string, string],
  });
}

/** Compatibility helper used by older tests and prototype UI. */
export function planetFaceOrder(cameraDirection: Readonly<Vec3>): number[] {
  const normals = [
    new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0),
    new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1),
  ];
  return normals.map((_, face) => face).sort(
    (a, b) => Vec3.dot(normals[b], cameraDirection) - Vec3.dot(normals[a], cameraDirection),
  );
}

export function terrainSkirtDepth(worldSize: number, gridRes: number): number {
  return Math.min(20, Math.max(2, (worldSize / Math.max(1, gridRes - 1)) * 0.08));
}

export function renderedTerrainHeight(height: number, hasOcean: boolean): number {
  void hasOcean;
  return height;
}

export class PlanetRenderer {
  readonly body: Body;
  readonly group = new THREE.Group();
  readonly engine: PlanetTerrainEngine;
  private readonly material: THREE.Material;
  private readonly oceanMaterial: THREE.MeshPhongMaterial | null;
  private readonly ocean: THREE.Mesh | null;
  private terrainVisible = true;
  private oceanVisible = true;
  private disposed = false;
  private readonly diagnostics: RenderDiagnosticsPort | undefined;
  private diagnosticContext: Readonly<PlanetDiagnosticContext> = { terrainRequested: false };
  stats: PlanetRendererStats = {
    chunks: 0, visible: 0, built: 0, triangles: 0, coverageGaps: 0,
    overlapChunks: 0, scheduleMs: 0, installMs: 0, geometryBytes: 0,
    selectionMs: 0, balanceMs: 0, selectionPasses: 0, selectionReused: false,
    pending: 0, activeTransitions: 0,
  };

  constructor(
    body: Body,
    quality: PlanetQuality = PLANET_QUALITY.medium,
    options: Readonly<PlanetRendererOptions> = {},
  ) {
    this.body = body;
    this.material = options.material ?? new THREE.MeshLambertMaterial({ vertexColors: true });
    this.diagnostics = options.diagnostics;
    const policy = enginePolicy(quality);
    const provider = createBodySurfaceProvider(body, {
      generation: 1,
      gridResolution: policy.gridResolution,
    });
    this.engine = new PlanetTerrainEngine({
      provider,
      quality: policy,
      material: this.material,
      terrainAllocationBytes: options.terrainAllocationBytes ?? DEFAULT_TERRAIN_GEOMETRY_BUDGET,
      workerPool: options.workerPool,
      ownsWorkerPool: options.ownsWorkerPool,
      now: options.now,
      diagnostics: options.diagnostics,
      diagnosticSource: options.diagnosticSource,
    });

    let oceanMaterial: THREE.MeshPhongMaterial | null = null;
    let ocean: THREE.Mesh | null = null;
    if (options.oceanEnabled !== false && body.def.terrain.oceanLevel > 0 && body.def.terrain.colorOcean) {
      oceanMaterial = new THREE.MeshPhongMaterial({
        color: new THREE.Color(body.def.terrain.colorOcean),
        shininess: 90,
        specular: new THREE.Color('#8fb8cc'),
        transparent: false,
        opacity: 1,
      });
      ocean = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), oceanMaterial);
      ocean.scale.setScalar(body.radius);
      this.group.add(ocean);
    }
    this.oceanMaterial = oceanMaterial;
    this.ocean = ocean;
    this.group.add(this.engine.group);
  }

  setShadowReceiver(enabled: boolean): void { this.engine.setShadowReceiver(enabled); }

  setOceanGlitter(enabled: boolean): void {
    if (!this.oceanMaterial) return;
    this.oceanMaterial.shininess = enabled ? 90 : 12;
    this.oceanMaterial.specular.set(enabled ? '#8fb8cc' : '#101820');
    this.oceanMaterial.needsUpdate = true;
  }

  setTerrainVisible(enabled: boolean): void {
    this.terrainVisible = enabled;
    this.engine.group.visible = enabled;
  }

  setOceanVisible(enabled: boolean): void {
    this.oceanVisible = enabled;
    if (this.ocean) this.ocean.visible = enabled;
  }

  coverageReady(): boolean { return this.engine.coverageReady(); }
  detailDemand(): readonly TerrainTileId[] { return this.engine.detailDemand(); }

  resourceGeometryBytes(): Readonly<{
    terrainGeometryBytes: number;
    oceanGeometryBytes: number;
    geometryCount: number;
  }> {
    return Object.freeze({
      terrainGeometryBytes: this.engine.stats.geometryBytes,
      oceanGeometryBytes: this.ocean ? geometryByteLength(this.ocean.geometry) : 0,
      geometryCount: this.engine.stats.chunks + (this.ocean ? 1 : 0),
    });
  }

  update(
    cameraBodyFixed: VectorCoordinates,
    orientation: QuaternionCoordinates,
    cameraRelativeOrigin: VectorCoordinates,
    cameraBodyFixedVelocity: VectorCoordinates = { x: 0, y: 0, z: 0 },
    diagnosticContext: Readonly<PlanetDiagnosticContext> = { terrainRequested: true },
    projection: Readonly<PlanetRenderProjection> = DEFAULT_PROJECTION,
  ): void {
    if (this.disposed) return;
    this.diagnosticContext = diagnosticContext;
    this.engine.update({
      cameraBodyFixed,
      cameraBodyFixedVelocity,
      viewDirectionBodyFixed: projection.viewDirectionBodyFixed,
      cameraRelativeOrigin,
      orientation,
      verticalFovRadians: projection.verticalFovRadians,
      drawingBufferHeight: projection.drawingBufferHeight,
      deltaSeconds: projection.deltaSeconds,
      framePressure: projection.framePressure,
      generation: this.engine.provider.generation,
      diagnosticContext,
      visible: projection.bodyFixedFrustum
        ? terrainFrustumPredicate(projection.bodyFixedFrustum, cameraBodyFixed)
        : undefined,
      visibilitySignature: projection.bodyFixedFrustum
        ? terrainFrustumSignature(projection.bodyFixedFrustum)
        : undefined,
    });
    this.engine.group.visible = this.terrainVisible;
    if (this.ocean) {
      this.ocean.visible = this.oceanVisible;
      this.ocean.position.set(cameraRelativeOrigin.x, cameraRelativeOrigin.y, cameraRelativeOrigin.z);
      this.ocean.quaternion.set(orientation.x, orientation.y, orientation.z, orientation.w);
    }
    const current = this.engine.stats;
    this.stats = Object.freeze({
      chunks: current.chunks,
      visible: this.terrainVisible ? current.visible : 0,
      built: current.building,
      triangles: current.triangles,
      coverageGaps: current.coverageGaps,
      overlapChunks: 0,
      scheduleMs: current.scheduleMs,
      installMs: current.installMs,
      selectionMs: current.selectionMs,
      balanceMs: current.balanceMs,
      selectionPasses: current.selectionPasses,
      selectionReused: current.selectionReused,
      geometryBytes: current.geometryBytes,
      pending: current.queued + current.building + current.ready,
      activeTransitions: current.activeTransitions,
    });
    void this.diagnostics;
    void this.diagnosticContext;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine.dispose();
    this.material.dispose();
    this.ocean?.geometry.dispose();
    this.oceanMaterial?.dispose();
    this.group.clear();
  }
}
