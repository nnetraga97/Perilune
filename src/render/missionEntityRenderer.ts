import * as THREE from 'three';

export interface MissionVectorCoordinates {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface MissionQuaternionCoordinates extends MissionVectorCoordinates {
  readonly w: number;
}

export type MissionProxyVisualId = 'gateway' | 'orion' | 'i-hab' | 'generic';

/**
 * Render-owned, structural view of an evaluated mission entity. Mission-domain
 * objects can satisfy this shape without importing Three.js or render code.
 * Positions and velocities are inertial metres relative to the focus body.
 */
export interface MissionRenderableEntity {
  readonly id: string;
  readonly label: string;
  readonly position: MissionVectorCoordinates;
  readonly velocity?: MissionVectorCoordinates;
  readonly attitude: MissionQuaternionCoordinates;
  /** Visual-provider key. `kind` remains as a convenient structural alias. */
  readonly visual?: MissionProxyVisualId | string | {
    readonly providerId: string;
    readonly scalePolicy?: 'physical' | 'minimum-pixel-size';
    readonly minimumPixels?: number;
  };
  readonly kind?: string;
  readonly visible?: boolean;
  /** Physical model scale. This never changes the trajectory position. */
  readonly scale?: number;
  /** Optional, explicitly presentational minimum apparent diameter. */
  readonly minimumPixelSize?: number;
}

export interface MissionVisualInstance {
  readonly root: THREE.Group;
  /** Approximate unscaled diameter used only for minimum-pixel presentation. */
  readonly physicalDiameter: number;
  dispose(): void;
}

export type MissionVisualProvider = (
  entity: Readonly<MissionRenderableEntity>,
) => MissionVisualInstance;

export interface MissionEntityRendererOptions {
  readonly providers?: Readonly<Record<string, MissionVisualProvider>>;
  /** Defaults to 0: consumers must deliberately opt into visual enlargement. */
  readonly defaultMinimumPixelSize?: number;
}

export type MissionRenderPathKind = 'reference-orbit' | 'approach-corridor';

export interface MissionRenderPath {
  readonly id: string;
  readonly kind: MissionRenderPathKind;
  /** Focus-body-relative inertial points, metres. */
  readonly points: readonly Readonly<MissionVectorCoordinates>[];
  readonly color?: THREE.ColorRepresentation;
  readonly closed?: boolean;
  readonly visible?: boolean;
}

export interface MissionRenderLayers {
  readonly referenceOrbit?: boolean;
  readonly approachCorridor?: boolean;
  readonly labels?: boolean;
}

export interface MissionEntityRendererStats {
  readonly visuals: number;
  readonly proxyVisuals: number;
  readonly paths: number;
}

interface LiveVisual {
  readonly providerKey: string;
  readonly instance: MissionVisualInstance;
}

interface LivePath {
  readonly kind: MissionRenderPathKind;
  readonly line: THREE.Line;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.LineBasicMaterial;
}

const DEFAULT_PROXY_LABELS: Readonly<Record<MissionProxyVisualId, string>> = Object.freeze({
  gateway: 'GATEWAY — PROXY VISUAL',
  orion: 'ORION — PROXY VISUAL',
  'i-hab': 'LUNAR I-HAB — PROXY VISUAL',
  generic: 'MISSION OBJECT — PROXY VISUAL',
});

/**
 * Stable, replaceable mission visuals. The renderer never reparents an entity:
 * every world pose is reapplied from the evaluated frame, including docking.
 */
export class MissionEntityRenderer {
  readonly root = new THREE.Group();
  readonly pathRoot = new THREE.Group();
  private readonly visuals = new Map<string, LiveVisual>();
  private readonly paths = new Map<string, LivePath>();
  private readonly providers = new Map<string, MissionVisualProvider>();
  private readonly defaultMinimumPixelSize: number;
  private disposed = false;

  constructor(
    private readonly scene: THREE.Scene,
    options: Readonly<MissionEntityRendererOptions> = {},
  ) {
    this.root.name = 'mission-entity-layer';
    this.root.userData.presentation = 'mission-replay';
    this.providers.set('gateway', createGatewayProxy);
    this.providers.set('orion', createOrionProxy);
    this.providers.set('i-hab', createIHabProxy);
    this.providers.set('generic', createGenericProxy);
    for (const [key, provider] of Object.entries(options.providers ?? {})) {
      this.providers.set(key, provider);
    }
    this.defaultMinimumPixelSize = Math.max(0, options.defaultMinimumPixelSize ?? 0);
    this.pathRoot.name = 'mission-path-layer';
    this.pathRoot.userData.presentation = 'mission-replay';
    this.scene.add(this.pathRoot, this.root);
  }

  update(
    entities: readonly Readonly<MissionRenderableEntity>[],
    cameraBodyRelative: Readonly<MissionVectorCoordinates>,
    camera: Readonly<THREE.PerspectiveCamera>,
    drawingBufferHeight: number,
    paths: readonly Readonly<MissionRenderPath>[] = [],
    layers: Readonly<MissionRenderLayers> = {},
  ): void {
    if (this.disposed) throw new Error('Mission entity renderer is disposed');
    const liveIds = new Set<string>();
    for (const entity of entities) {
      liveIds.add(entity.id);
      const providerKey = visualKeyFor(entity);
      let live = this.visuals.get(entity.id);
      if (!live || live.providerKey !== providerKey) {
        if (live) this.releaseVisual(entity.id, live);
        const provider = this.providers.get(providerKey) ?? this.providers.get('generic');
        if (!provider) throw new Error('Generic mission visual provider is unavailable');
        const instance = provider(entity);
        instance.root.name = `mission-entity:${entity.id}`;
        instance.root.userData.entityId = entity.id;
        instance.root.userData.displayLabel = entity.label;
        instance.root.userData.fidelity = 'proxy-visual';
        instance.root.userData.visualProvider = providerKey;
        this.root.add(instance.root);
        live = { providerKey, instance };
        this.visuals.set(entity.id, live);
      }

      const group = live.instance.root;
      group.visible = entity.visible !== false;
      group.position.set(
        entity.position.x - cameraBodyRelative.x,
        entity.position.y - cameraBodyRelative.y,
        entity.position.z - cameraBodyRelative.z,
      );
      group.quaternion.set(
        entity.attitude.x,
        entity.attitude.y,
        entity.attitude.z,
        entity.attitude.w,
      ).normalize();
      const physicalScale = finitePositive(entity.scale) ? entity.scale : 1;
      const visualPolicy = typeof entity.visual === 'object' ? entity.visual : undefined;
      const minimumPixels = Math.max(
        0,
        entity.minimumPixelSize
          ?? (visualPolicy?.scalePolicy === 'minimum-pixel-size' ? visualPolicy.minimumPixels : undefined)
          ?? this.defaultMinimumPixelSize,
      );
      const presentationScale = minimumPixels > 0
        ? minimumApparentScale(
          group.position.length(),
          camera.fov,
          Math.max(1, drawingBufferHeight),
          minimumPixels,
          live.instance.physicalDiameter,
          physicalScale,
        )
        : physicalScale;
      group.scale.setScalar(presentationScale);
      group.userData.physicalScale = physicalScale;
      group.userData.presentationScale = presentationScale;
      group.userData.minimumPixelSize = minimumPixels;
      const labelObject = group.getObjectByName('proxy-visual-label');
      if (labelObject) labelObject.visible = layers.labels !== false;
    }

    for (const [id, live] of this.visuals) {
      if (!liveIds.has(id)) this.releaseVisual(id, live);
    }
    this.updatePaths(paths, cameraBodyRelative, layers);
  }

  entityObject(id: string): THREE.Group | null {
    return this.visuals.get(id)?.instance.root ?? null;
  }

  stats(): Readonly<MissionEntityRendererStats> {
    return Object.freeze({
      visuals: this.visuals.size,
      proxyVisuals: this.visuals.size,
      paths: this.paths.size,
    });
  }

  reset(): void {
    for (const [id, live] of [...this.visuals]) this.releaseVisual(id, live);
    for (const [id, live] of [...this.paths]) this.releasePath(id, live);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reset();
    this.scene.remove(this.root);
    this.scene.remove(this.pathRoot);
    this.root.clear();
    this.pathRoot.clear();
  }

  private releaseVisual(id: string, live: LiveVisual): void {
    this.root.remove(live.instance.root);
    live.instance.dispose();
    this.visuals.delete(id);
  }

  private updatePaths(
    paths: readonly Readonly<MissionRenderPath>[],
    cameraBodyRelative: Readonly<MissionVectorCoordinates>,
    layers: Readonly<MissionRenderLayers>,
  ): void {
    const liveIds = new Set<string>();
    for (const path of paths) {
      liveIds.add(path.id);
      let live = this.paths.get(path.id);
      if (!live || live.kind !== path.kind) {
        if (live) this.releasePath(path.id, live);
        const geometry = new THREE.BufferGeometry();
        const material = new THREE.LineBasicMaterial({
          color: path.color ?? (path.kind === 'reference-orbit' ? '#62b9d2' : '#d5a85a'),
          transparent: true,
          opacity: path.kind === 'reference-orbit' ? 0.58 : 0.78,
          depthWrite: false,
        });
        const line = new THREE.Line(geometry, material);
        line.name = `mission-path:${path.id}`;
        line.userData.pathId = path.id;
        line.userData.pathKind = path.kind;
        line.frustumCulled = false;
        this.pathRoot.add(line);
        live = { kind: path.kind, line, geometry, material };
        this.paths.set(path.id, live);
      }
      if (path.color !== undefined) live.material.color.set(path.color);
      const pointCount = path.points.length + (path.closed && path.points.length > 1 ? 1 : 0);
      let positions = live.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!positions || positions.count !== pointCount) {
        positions = new THREE.BufferAttribute(new Float32Array(pointCount * 3), 3);
        live.geometry.setAttribute('position', positions);
      }
      for (let index = 0; index < pointCount; index++) {
        const point = path.points[index % path.points.length];
        positions.setXYZ(
          index,
          point.x - cameraBodyRelative.x,
          point.y - cameraBodyRelative.y,
          point.z - cameraBodyRelative.z,
        );
      }
      positions.needsUpdate = true;
      live.geometry.computeBoundingSphere();
      const layerVisible = path.kind === 'reference-orbit'
        ? layers.referenceOrbit !== false
        : layers.approachCorridor !== false;
      live.line.visible = path.visible !== false && layerVisible && pointCount >= 2;
    }
    for (const [id, live] of this.paths) {
      if (!liveIds.has(id)) this.releasePath(id, live);
    }
  }

  private releasePath(id: string, live: LivePath): void {
    this.pathRoot.remove(live.line);
    live.geometry.dispose();
    live.material.dispose();
    this.paths.delete(id);
  }
}

export function minimumApparentScale(
  distance: number,
  verticalFovDegrees: number,
  drawingBufferHeight: number,
  minimumPixels: number,
  physicalDiameter: number,
  physicalScale = 1,
): number {
  if (
    !(distance > 0)
    || !(drawingBufferHeight > 0)
    || !(minimumPixels > 0)
    || !(physicalDiameter > 0)
  ) return physicalScale;
  const worldHeight = 2 * distance * Math.tan(THREE.MathUtils.degToRad(verticalFovDegrees) / 2);
  const minimumDiameter = worldHeight * minimumPixels / drawingBufferHeight;
  return Math.max(physicalScale, minimumDiameter / physicalDiameter);
}

function visualKeyFor(entity: Readonly<MissionRenderableEntity>): string {
  const explicit = typeof entity.visual === 'object' ? entity.visual.providerId : entity.visual;
  const normalized = `${explicit ?? ''} ${entity.id} ${entity.label}`.toLowerCase();
  if (normalized.includes('gateway')) return 'gateway';
  if (normalized.includes('orion')) return 'orion';
  if (normalized.includes('i-hab') || normalized.includes('ihab') || normalized.includes('habitat')) return 'i-hab';
  if (explicit) return explicit;
  return 'generic';
}

function finitePositive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function createGatewayProxy(entity: Readonly<MissionRenderableEntity>): MissionVisualInstance {
  const group = proxyRoot(entity, 'gateway');
  const structure = material('#d6d9d5', 0.72, 0.34);
  const dark = material('#30363a', 0.78, 0.45);
  const array = material('#315d83', 0.62, 0.22, '#07101a');
  const halo = cylinder(3.1, 9.5, structure, Math.PI / 2, 'HALO proxy');
  halo.position.x = -5;
  group.add(halo);
  const power = cylinder(3.4, 8, dark, Math.PI / 2, 'PPE proxy');
  power.position.x = 4;
  group.add(power);
  const node = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 15), dark);
  node.name = 'Gateway truss proxy';
  group.add(node);
  for (const z of [-12, 12]) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(24, 0.18, 7), array);
    panel.name = 'Gateway solar array proxy';
    panel.position.z = z;
    group.add(panel);
  }
  addProxyLabel(group, DEFAULT_PROXY_LABELS.gateway, 20);
  return ownedVisual(group, 32);
}

function createOrionProxy(entity: Readonly<MissionRenderableEntity>): MissionVisualInstance {
  const group = proxyRoot(entity, 'orion');
  const shell = material('#e3e0d7', 0.72, 0.16);
  const service = material('#b8bdc2', 0.66, 0.34);
  const dark = material('#22292f', 0.78, 0.32);
  const array = material('#315d83', 0.64, 0.18, '#07101a');
  const capsule = new THREE.Mesh(new THREE.ConeGeometry(2.5, 3.3, 24), shell);
  capsule.name = 'Orion crew module proxy';
  capsule.rotation.z = -Math.PI / 2;
  capsule.position.x = 3.2;
  group.add(capsule);
  const serviceModule = cylinder(2.35, 4.5, service, Math.PI / 2, 'Orion service module proxy');
  serviceModule.position.x = -0.6;
  group.add(serviceModule);
  const engine = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 1.25, 1.8, 20), dark);
  engine.rotation.z = Math.PI / 2;
  engine.position.x = -3.7;
  group.add(engine);
  for (const z of [-6.5, 6.5]) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.12, 3.2), array);
    panel.name = 'Orion solar array proxy';
    panel.position.z = z;
    group.add(panel);
  }
  addProxyLabel(group, DEFAULT_PROXY_LABELS.orion, 10);
  return ownedVisual(group, 16);
}

function createIHabProxy(entity: Readonly<MissionRenderableEntity>): MissionVisualInstance {
  const group = proxyRoot(entity, 'i-hab');
  const shell = material('#d8d8cf', 0.76, 0.18);
  const ring = material('#5f666a', 0.67, 0.42);
  const module = cylinder(2.8, 8.4, shell, Math.PI / 2, 'Lunar I-Hab proxy');
  group.add(module);
  for (const x of [-4.2, 4.2]) {
    const end = cylinder(3, 0.5, ring, Math.PI / 2, 'I-Hab docking ring proxy');
    end.position.x = x;
    group.add(end);
  }
  addProxyLabel(group, DEFAULT_PROXY_LABELS['i-hab'], 10);
  return ownedVisual(group, 10);
}

function createGenericProxy(entity: Readonly<MissionRenderableEntity>): MissionVisualInstance {
  const group = proxyRoot(entity, 'generic');
  const shell = material('#d7dde1', 0.7, 0.25);
  const marker = new THREE.Mesh(new THREE.OctahedronGeometry(2.5, 1), shell);
  marker.name = 'Generic mission object proxy';
  group.add(marker);
  addProxyLabel(group, entity.label || DEFAULT_PROXY_LABELS.generic, 6);
  return ownedVisual(group, 5);
}

function proxyRoot(entity: Readonly<MissionRenderableEntity>, visual: MissionProxyVisualId): THREE.Group {
  const group = new THREE.Group();
  group.userData.proxyVisual = true;
  group.userData.proxyVisualId = visual;
  group.userData.displayLabel = entity.label;
  return group;
}

function material(
  color: THREE.ColorRepresentation,
  roughness: number,
  metalness: number,
  emissive: THREE.ColorRepresentation = '#000000',
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, emissive });
}

function cylinder(
  radius: number,
  length: number,
  surface: THREE.Material,
  rotationZ: number,
  name: string,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 24), surface);
  mesh.rotation.z = rotationZ;
  mesh.name = name;
  return mesh;
}

/** A browser label is optional; semantic metadata remains present in tests. */
function addProxyLabel(root: THREE.Group, label: string, y: number): void {
  root.userData.proxyLabel = label;
  if (typeof document === 'undefined') return;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 72;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'rgba(4, 10, 15, 0.82)';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = 'rgba(116, 197, 220, 0.9)';
  context.lineWidth = 3;
  context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
  context.fillStyle = '#e6f1f3';
  context.font = '600 25px monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(label, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    depthTest: false,
  }));
  sprite.name = 'proxy-visual-label';
  sprite.position.y = y;
  sprite.scale.set(22, 3.1, 1);
  sprite.userData.ownedTexture = texture;
  root.add(sprite);
}

function ownedVisual(root: THREE.Group, physicalDiameter: number): MissionVisualInstance {
  let disposed = false;
  return {
    root,
    physicalDiameter,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      disposeOwnedProxy(root);
    },
  };
}

function disposeOwnedProxy(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    const maybeGeometry = (object as THREE.Mesh).geometry;
    if (maybeGeometry instanceof THREE.BufferGeometry && object instanceof THREE.Mesh) {
      geometries.add(maybeGeometry);
    }
    const maybeMaterial = (object as THREE.Mesh | THREE.Sprite).material;
    if (maybeMaterial) {
      const owned = Array.isArray(maybeMaterial) ? maybeMaterial : [maybeMaterial];
      for (const surface of owned) {
        materials.add(surface);
        const map = (surface as THREE.MeshStandardMaterial | THREE.SpriteMaterial).map;
        if (map) textures.add(map);
      }
    }
    const explicitTexture = object.userData.ownedTexture;
    if (explicitTexture instanceof THREE.Texture) textures.add(explicitTexture);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
  root.clear();
}
