import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
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
  private readonly controls: OrbitControls;
  private visual: VesselVisual | null = null;
  private surface: THREE.Mesh | null = null;
  private surfaceMaterial: THREE.MeshStandardMaterial | null = null;
  private streamlines: THREE.LineSegments | null = null;
  private streamlineMaterial: THREE.ShaderMaterial | null = null;
  private smoke: THREE.Points | null = null;
  private smokeMaterial: THREE.ShaderMaterial | null = null;
  private shock: THREE.Mesh | null = null;
  private surfaceData: AeroLabFieldResult | null = null;
  private condition: AeroLabCondition | null = null;
  private reading: AeroLabReading | null = null;
  private mode: AeroLabSurfaceMode = 'flow';
  private radius = 4;
  private time = 0;
  private paused = false;
  private readonly comMarker: THREE.Mesh;
  private readonly copMarker: THREE.Mesh;
  private readonly forceArrow = new THREE.ArrowHelper();

  constructor(private readonly models: PartModelLibrary, canvas: HTMLCanvasElement) {
    this.scene.background = new THREE.Color('#071014');
    this.scene.fog = new THREE.FogExp2('#071014', 0.014);
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

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enabled = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
  }

  setCraft(craft: Craft): void {
    this.clearCraft();
    this.visual = buildVesselVisual(craft, this.models);
    this.content.add(this.visual.group);
    const bounds = craftAxialVisualBounds(craft);
    this.content.position.y = -bounds.center;
    this.radius = craftVisualRadius(craft);
    this.controls.minDistance = Math.max(2, this.radius * 1.35);
    this.controls.maxDistance = Math.max(30, this.radius * 12);
    this.camera.near = Math.max(0.02, this.radius / 200);
    this.camera.far = Math.max(200, this.radius * 30);
    this.camera.updateProjectionMatrix();
    this.resetCamera();
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
    const segmentProgress: number[] = [];
    const smokePositions: number[] = [];
    const smokeProgress: number[] = [];
    for (let line = 0; line + 1 < result.streamlineOffsets.length; line++) {
      const start = result.streamlineOffsets[line];
      const end = result.streamlineOffsets[line + 1];
      const lineLength = Math.max(1, end - start - 1);
      const phaseOffset = (line * 0.61803398875) % 1;
      for (let point = start; point + 1 < end; point++) {
        const a = point * 3;
        const b = (point + 1) * 3;
        const progressA = (point - start) / lineLength + phaseOffset;
        const progressB = (point + 1 - start) / lineLength + phaseOffset;
        segmentPositions.push(
          result.streamlinePositions[a], result.streamlinePositions[a + 1], result.streamlinePositions[a + 2],
          result.streamlinePositions[b], result.streamlinePositions[b + 1], result.streamlinePositions[b + 2],
        );
        segmentProgress.push(progressA, progressB);
        for (let sample = 0; sample < 3; sample++) {
          const t = sample / 3;
          smokePositions.push(
            THREE.MathUtils.lerp(result.streamlinePositions[a], result.streamlinePositions[b], t),
            THREE.MathUtils.lerp(result.streamlinePositions[a + 1], result.streamlinePositions[b + 1], t),
            THREE.MathUtils.lerp(result.streamlinePositions[a + 2], result.streamlinePositions[b + 2], t),
          );
          smokeProgress.push(THREE.MathUtils.lerp(progressA, progressB, t));
        }
      }
    }
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(segmentPositions, 3));
    lineGeometry.setAttribute('lineProgress', new THREE.Float32BufferAttribute(segmentProgress, 1));
    this.streamlineMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: this.time },
        uOpacity: { value: 1 },
      },
      vertexShader: `
        attribute float lineProgress;
        varying float vProgress;
        void main() {
          vProgress = lineProgress;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uOpacity;
        varying float vProgress;
        void main() {
          float phase = fract(vProgress * 6.0 - uTime * 0.7);
          float pulse = smoothstep(0.58, 0.88, phase) * (1.0 - smoothstep(0.88, 1.0, phase));
          vec3 base = vec3(0.31, 0.62, 0.59);
          vec3 highlight = vec3(0.78, 0.92, 0.72);
          gl_FragColor = vec4(mix(base, highlight, pulse), (0.04 + pulse * 0.16) * uOpacity);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.streamlines = new THREE.LineSegments(
      lineGeometry,
      this.streamlineMaterial,
    );
    this.content.add(this.streamlines);

    const smokeGeometry = new THREE.BufferGeometry();
    smokeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(smokePositions, 3));
    smokeGeometry.setAttribute('flowProgress', new THREE.Float32BufferAttribute(smokeProgress, 1));
    this.smokeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: this.time },
        uOpacity: { value: 1 },
      },
      vertexShader: `
        attribute float flowProgress;
        uniform float uTime;
        varying float vPulse;
        varying float vNoise;
        void main() {
          float phase = fract(flowProgress * 5.0 - uTime * 0.55);
          vPulse = smoothstep(0.52, 0.84, phase) * (1.0 - smoothstep(0.84, 1.0, phase));
          vNoise = 0.5 + 0.5 * sin(flowProgress * 31.0 + uTime * 0.8);
          vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * viewPosition;
          gl_PointSize = 10.0 + vPulse * 8.0 + vNoise * 4.0;
        }
      `,
      fragmentShader: `
        uniform float uOpacity;
        varying float vPulse;
        varying float vNoise;
        void main() {
          float distanceFromCenter = length(gl_PointCoord - vec2(0.5)) * 2.0;
          float softness = pow(max(0.0, 1.0 - distanceFromCenter), 1.35);
          vec3 smokeColor = mix(vec3(0.42, 0.6, 0.58), vec3(0.78, 0.9, 0.73), vPulse);
          float opacity = (0.035 + vPulse * 0.12) * (0.72 + vNoise * 0.28);
          gl_FragColor = vec4(smokeColor, softness * opacity * uOpacity);
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    this.smoke = new THREE.Points(smokeGeometry, this.smokeMaterial);
    this.content.add(this.smoke);
    this.updateSurface();
    this.updateShock();
    this.updateMarkers();
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
    if (this.streamlineMaterial) this.streamlineMaterial.uniforms.uOpacity.value = pending ? 0.2 : 1;
    if (this.smokeMaterial) this.smokeMaterial.uniforms.uOpacity.value = pending ? 0.2 : 1;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  setControlsEnabled(enabled: boolean): void {
    this.controls.enabled = enabled;
  }

  resetCamera(): void {
    const distance = THREE.MathUtils.clamp(this.radius * 2.9, 6, 80);
    this.camera.position.set(distance * 0.74, distance * 0.18, distance * 0.65);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  update(dt: number): void {
    if (!this.paused) this.time += dt;
    if (this.streamlineMaterial) this.streamlineMaterial.uniforms.uTime.value = this.time;
    if (this.smokeMaterial) this.smokeMaterial.uniforms.uTime.value = this.time;
    this.controls.update();
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    if (this.camera.aspect !== aspect) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
  }

  dispose(): void {
    this.disposeAnalysis();
    this.clearCraft();
    this.controls.dispose();
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

  private disposeAnalysis(): void {
    for (const object of [this.surface, this.streamlines, this.smoke, this.shock]) {
      if (!object) continue;
      this.content.remove(object);
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    }
    this.surface = null;
    this.surfaceMaterial = null;
    this.streamlines = null;
    this.streamlineMaterial = null;
    this.smoke = null;
    this.smokeMaterial = null;
    this.shock = null;
    this.surfaceData = null;
  }
}
