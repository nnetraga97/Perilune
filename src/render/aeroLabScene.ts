import * as THREE from 'three';
import type { PartModelLibrary } from './partModelLibrary';
import { buildVesselVisual, disposeVesselVisual, type VesselVisual } from './vesselMesh';
import { craftAxialVisualBounds, craftVisualRadius, type Craft } from '../sim/vessel';
import type { AeroLabCondition, AeroLabReading } from '../sim/aeroLab';
import type { AeroLabFieldResult } from './aeroLabAnalysis';

export type AeroLabSurfaceMode = 'flow' | 'load' | 'thermal' | 'shielding';

function heatColor(value: number, out: THREE.Color): THREE.Color {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  if (t < 0.5) return out.set('#247ba0').lerp(new THREE.Color('#ffd166'), t * 2);
  return out.set('#ffd166').lerp(new THREE.Color('#ef476f'), (t - 0.5) * 2);
}

export class AeroLabScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.05, 2_000);

  private readonly content = new THREE.Group();
  private visual: VesselVisual | null = null;
  private surface: THREE.Mesh | null = null;
  private surfaceMaterial: THREE.MeshStandardMaterial | null = null;
  private streamlines: THREE.LineSegments | null = null;
  private particles: THREE.Points | null = null;
  private shock: THREE.Mesh | null = null;
  private streamlinePositions = new Float32Array();
  private streamlineOffsets = new Uint32Array();
  private particlePhases = new Float32Array();
  private surfaceData: AeroLabFieldResult | null = null;
  private condition: AeroLabCondition | null = null;
  private reading: AeroLabReading | null = null;
  private mode: AeroLabSurfaceMode = 'flow';
  private radius = 4;
  private yaw = 0.72;
  private pitch = 0.18;
  private distance = 14;
  private time = 0;
  private paused = false;
  private readonly comMarker: THREE.Mesh;
  private readonly copMarker: THREE.Mesh;
  private readonly forceArrow = new THREE.ArrowHelper();

  constructor(private readonly models: PartModelLibrary) {
    this.scene.background = new THREE.Color('#061018');
    this.scene.fog = new THREE.FogExp2('#061018', 0.018);
    this.scene.add(new THREE.HemisphereLight('#b8e8ff', '#081018', 1.4));
    const key = new THREE.DirectionalLight('#fff4df', 2.2);
    key.position.set(7, 12, 9);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#43c8ff', 1.2);
    rim.position.set(-9, 2, -7);
    this.scene.add(rim);
    const grid = new THREE.GridHelper(80, 40, 0x2f6177, 0x163443);
    grid.position.y = -8;
    grid.material.transparent = true;
    grid.material.opacity = 0.24;
    this.scene.add(grid, this.content);

    const markerGeometry = new THREE.SphereGeometry(0.12, 14, 10);
    this.comMarker = new THREE.Mesh(markerGeometry, new THREE.MeshBasicMaterial({ color: '#65d6ff' }));
    this.copMarker = new THREE.Mesh(markerGeometry.clone(), new THREE.MeshBasicMaterial({ color: '#ffbf69' }));
    this.content.add(this.comMarker, this.copMarker, this.forceArrow);
  }

  setCraft(craft: Craft): void {
    this.clearCraft();
    this.visual = buildVesselVisual(craft, this.models);
    this.content.add(this.visual.group);
    const bounds = craftAxialVisualBounds(craft);
    this.content.position.y = -bounds.center;
    this.radius = craftVisualRadius(craft);
    this.distance = THREE.MathUtils.clamp(this.radius * 3.2, 6, 80);
    this.camera.near = Math.max(0.02, this.radius / 200);
    this.camera.far = Math.max(200, this.radius * 30);
    this.camera.updateProjectionMatrix();
  }

  setAnalysis(
    result: AeroLabFieldResult,
    condition: AeroLabCondition,
    reading: AeroLabReading,
  ): void {
    this.disposeAnalysis();
    this.surfaceData = result;
    this.condition = condition;
    this.reading = reading;

    const surfaceGeometry = new THREE.BufferGeometry();
    surfaceGeometry.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
    surfaceGeometry.setAttribute('normal', new THREE.BufferAttribute(result.normals, 3));
    surfaceGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(result.positions.length), 3));
    surfaceGeometry.computeBoundingBox();
    this.surfaceMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.72,
      roughness: 0.72,
      metalness: 0.05,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });
    this.surface = new THREE.Mesh(surfaceGeometry, this.surfaceMaterial);
    this.surface.renderOrder = 3;
    this.content.add(this.surface);

    const segmentPositions: number[] = [];
    for (let line = 0; line + 1 < result.streamlineOffsets.length; line++) {
      const start = result.streamlineOffsets[line];
      const end = result.streamlineOffsets[line + 1];
      for (let point = start; point + 1 < end; point++) {
        const a = point * 3;
        const b = (point + 1) * 3;
        segmentPositions.push(
          result.streamlinePositions[a], result.streamlinePositions[a + 1], result.streamlinePositions[a + 2],
          result.streamlinePositions[b], result.streamlinePositions[b + 1], result.streamlinePositions[b + 2],
        );
      }
    }
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(segmentPositions, 3));
    this.streamlines = new THREE.LineSegments(
      lineGeometry,
      new THREE.LineBasicMaterial({ color: '#79d8f2', transparent: true, opacity: 0.34 }),
    );
    this.content.add(this.streamlines);

    this.streamlinePositions = new Float32Array(result.streamlinePositions);
    this.streamlineOffsets = new Uint32Array(result.streamlineOffsets);
    const particleCount = Math.max(0, (result.streamlineOffsets.length - 1) * 3);
    this.particlePhases = new Float32Array(particleCount);
    const particleGeometry = new THREE.BufferGeometry();
    particleGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(particleCount * 3), 3));
    for (let i = 0; i < particleCount; i++) this.particlePhases[i] = (i % 3) / 3;
    this.particles = new THREE.Points(
      particleGeometry,
      new THREE.PointsMaterial({
        color: '#d8f7ff',
        size: Math.max(0.035, this.radius * 0.018),
        sizeAttenuation: true,
        transparent: true,
      }),
    );
    this.content.add(this.particles);
    this.updateSurface();
    this.updateShock();
    this.updateMarkers();
    this.updateParticles();
  }

  updateReading(condition: AeroLabCondition, reading: AeroLabReading): void {
    this.condition = condition;
    this.reading = reading;
    this.updateSurface();
    this.updateShock();
    this.updateMarkers();
  }

  setSurfaceMode(mode: AeroLabSurfaceMode): void {
    this.mode = mode;
    this.updateSurface();
  }

  clearAnalysis(): void {
    this.disposeAnalysis();
  }

  clearCraft(): void {
    if (!this.visual) return;
    this.content.remove(this.visual.group);
    disposeVesselVisual(this.visual);
    this.visual = null;
  }

  setAnalysisPending(pending: boolean): void {
    if (this.surfaceMaterial) this.surfaceMaterial.opacity = pending ? 0.22 : 0.72;
    if (this.streamlines) (this.streamlines.material as THREE.LineBasicMaterial).opacity = pending ? 0.1 : 0.34;
    if (this.particles) (this.particles.material as THREE.PointsMaterial).opacity = pending ? 0.25 : 1;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  orbitCamera(dx: number, dy: number): void {
    this.yaw -= dx * 0.006;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.006, -1.35, 1.35);
  }

  zoomCamera(factor: number): void {
    this.distance = THREE.MathUtils.clamp(this.distance * factor, this.radius * 1.4, this.radius * 12);
  }

  update(dt: number): void {
    if (!this.paused) {
      this.time += dt;
      this.updateParticles();
    }
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    if (this.camera.aspect !== aspect) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      Math.cos(this.yaw) * cp * this.distance,
      Math.sin(this.pitch) * this.distance,
      Math.sin(this.yaw) * cp * this.distance,
    );
    this.camera.lookAt(0, 0, 0);
  }

  dispose(): void {
    this.disposeAnalysis();
    this.clearCraft();
    this.comMarker.geometry.dispose();
    (this.comMarker.material as THREE.Material).dispose();
    this.copMarker.geometry.dispose();
    (this.copMarker.material as THREE.Material).dispose();
  }

  private updateSurface(): void {
    if (!this.surface || !this.surfaceMaterial || !this.surfaceData || !this.condition || !this.reading) return;
    this.surface.visible = this.mode !== 'flow';
    if (!this.surface.visible) return;
    const colors = this.surface.geometry.getAttribute('color') as THREE.BufferAttribute;
    const direction = new THREE.Vector3(
      Math.sin(this.condition.orientationDeg * Math.PI / 180),
      Math.cos(this.condition.orientationDeg * Math.PI / 180),
      0,
    );
    const normal = new THREE.Vector3();
    const color = new THREE.Color();
    for (let i = 0; i < colors.count; i++) {
      normal.fromArray(this.surfaceData.normals, i * 3);
      const incidence = Math.max(0, normal.dot(direction));
      const visible = 1 - this.surfaceData.shielding[i] * 0.88;
      let value = visible;
      if (this.mode === 'load') value = incidence * incidence * visible;
      else if (this.mode === 'thermal') {
        const partExposure = this.reading.thermalExposure.get(this.surfaceData.partKeys[i]) ?? 0.15;
        value = incidence * incidence * incidence * visible * partExposure;
      }
      heatColor(value, color);
      colors.setXYZ(i, color.r, color.g, color.b);
    }
    colors.needsUpdate = true;
  }

  private updateMarkers(): void {
    if (!this.reading) return;
    const scale = Math.max(0.08, this.radius * 0.035);
    this.comMarker.scale.setScalar(scale / 0.12);
    this.copMarker.scale.setScalar(scale / 0.12);
    this.comMarker.position.set(0, this.reading.comY, 0);
    this.copMarker.position.set(0, this.reading.copY, 0);
    const magnitude = this.reading.force.length();
    this.forceArrow.visible = magnitude > 1e-3;
    if (this.forceArrow.visible) {
      const direction = new THREE.Vector3(this.reading.force.x, this.reading.force.y, this.reading.force.z).normalize();
      this.forceArrow.position.copy(this.comMarker.position);
      this.forceArrow.setDirection(direction);
      this.forceArrow.setLength(this.radius * 1.35, this.radius * 0.2, this.radius * 0.1);
      this.forceArrow.setColor('#ff8c61');
    }
  }

  private updateShock(): void {
    if (this.shock) {
      this.content.remove(this.shock);
      this.shock.geometry.dispose();
      (this.shock.material as THREE.Material).dispose();
      this.shock = null;
    }
    if (!this.condition || !this.surface || this.condition.mach <= 1.2 || this.surfaceData?.shockDistance == null) return;
    const halfAngle = Math.asin(1 / this.condition.mach);
    const shockDistance = this.surfaceData!.shockDistance;
    const height = shockDistance * 2;
    const geometry = new THREE.ConeGeometry(Math.tan(halfAngle) * height, height, 32, 1, true);
    const material = new THREE.MeshBasicMaterial({
      color: '#ffbf69',
      wireframe: true,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    });
    this.shock = new THREE.Mesh(geometry, material);
    const upstream = new THREE.Vector3(
      Math.sin(this.condition.orientationDeg * Math.PI / 180),
      Math.cos(this.condition.orientationDeg * Math.PI / 180),
      0,
    );
    this.shock.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), upstream);
    this.shock.position.copy(this.surface.geometry.boundingBox!.getCenter(new THREE.Vector3()));
    this.content.add(this.shock);
  }

  private updateParticles(): void {
    if (!this.particles || this.streamlineOffsets.length < 2) return;
    const positions = this.particles.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let particle = 0; particle < positions.count; particle++) {
      const line = Math.floor(particle / 3);
      const start = this.streamlineOffsets[line];
      const end = this.streamlineOffsets[line + 1];
      const length = end - start;
      if (length < 2) continue;
      const progress = (this.particlePhases[particle] + this.time * 0.28) % 1;
      const index = start + Math.min(length - 2, Math.floor(progress * (length - 1)));
      const local = progress * (length - 1) - Math.floor(progress * (length - 1));
      const a = index * 3;
      const b = (index + 1) * 3;
      positions.setXYZ(
        particle,
        THREE.MathUtils.lerp(this.streamlinePositions[a], this.streamlinePositions[b], local),
        THREE.MathUtils.lerp(this.streamlinePositions[a + 1], this.streamlinePositions[b + 1], local),
        THREE.MathUtils.lerp(this.streamlinePositions[a + 2], this.streamlinePositions[b + 2], local),
      );
    }
    positions.needsUpdate = true;
  }

  private disposeAnalysis(): void {
    for (const object of [this.surface, this.streamlines, this.particles, this.shock]) {
      if (!object) continue;
      this.content.remove(object);
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    }
    this.surface = null;
    this.surfaceMaterial = null;
    this.streamlines = null;
    this.particles = null;
    this.shock = null;
    this.surfaceData = null;
  }
}
