import * as THREE from 'three';
import type { PartDef } from '../content/parts';
import type { PartModelLibrary } from '../render/partModelLibrary';
import { buildVesselVisual, disposeVesselVisual } from '../render/vesselMesh';
import { addPart, createCraft } from '../sim/vessel';

const PORTRAIT_SIZE = 128;
const studios = new WeakMap<THREE.WebGLRenderer, PartPortraitStudio>();

function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  return canvas.getContext('2d');
}

/** Last-resort placeholder for a lost/unavailable WebGL context. */
function drawFallback(canvas: HTMLCanvasElement, def: PartDef): void {
  const context = canvasContext(canvas);
  if (!context) return;
  context.clearRect(0, 0, PORTRAIT_SIZE, PORTRAIT_SIZE);
  context.save();
  context.translate(PORTRAIT_SIZE / 2, PORTRAIT_SIZE / 2);
  context.fillStyle = def.color ?? '#b9c4ca';
  context.strokeStyle = def.accent ?? '#4f7186';
  context.lineWidth = 5;
  const height = Math.min(92, Math.max(34, def.shape.height * 36));
  const width = Math.min(82, Math.max(24, (def.shape.width ?? (def.shape.radiusBottom ?? 0.4) * 2) * 31));
  context.beginPath();
  if (def.shape.kind === 'cone') {
    const top = Math.max(6, (def.shape.radiusTop ?? 0.1) * 31);
    context.moveTo(-top, -height / 2);
    context.lineTo(top, -height / 2);
    context.lineTo(width / 2, height / 2);
    context.lineTo(-width / 2, height / 2);
    context.closePath();
  } else if (def.shape.kind === 'capsule' || def.shape.kind === 'dome') {
    context.ellipse(0, 0, width / 2, height / 2, 0, 0, Math.PI * 2);
  } else {
    context.rect(-width / 2, -height / 2, width, height);
  }
  context.fill();
  context.stroke();
  context.restore();
}

class PartPortraitStudio {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  private readonly target = new THREE.WebGLRenderTarget(PORTRAIT_SIZE, PORTRAIT_SIZE, {
    depthBuffer: true,
    stencilBuffer: false,
  });
  private readonly pixels = new Uint8Array(PORTRAIT_SIZE * PORTRAIT_SIZE * 4);
  private readonly cache = new Map<string, ImageData>();
  private readonly savedClearColor = new THREE.Color();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.target.texture.colorSpace = THREE.SRGBColorSpace;
    this.target.texture.name = 'workshop-part-portrait';

    this.scene.add(new THREE.HemisphereLight('#d8efff', '#182531', 2.35));
    const key = new THREE.DirectionalLight('#fff0d8', 4.2);
    key.position.set(4, 7, 5);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight('#72b5d7', 2.1);
    fill.position.set(-5, 2, 4);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight('#8fc8df', 2.7);
    rim.position.set(2, 4, -6);
    this.scene.add(rim);
  }

  render(canvas: HTMLCanvasElement, def: PartDef, models?: PartModelLibrary): void {
    const context = canvasContext(canvas);
    if (!context) return;
    const cached = this.cache.get(def.id);
    if (cached) {
      context.putImageData(cached, 0, 0);
      return;
    }

    const craft = createCraft(`portrait-${def.id}`);
    addPart(craft, def.id, null, 'root', { x: 0, y: 0, z: 0 });
    const visual = buildVesselVisual(craft, models);
    // Plumes are hidden in normal editor rendering, but Box3 still includes
    // invisible descendants. Detach them so engines are framed around their
    // hardware rather than several metres of non-rendered exhaust geometry.
    for (const plume of visual.plumes.values()) plume.removeFromParent();
    const turntable = new THREE.Group();
    turntable.add(visual.group);
    // The camera already supplies the three-quarter view. Keep broad, flat
    // parts near face-on so wings, arrays, and heat shields remain legible at
    // palette scale.
    turntable.rotation.set(-0.06, 0.12, 0);
    this.scene.add(turntable);

    try {
      turntable.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(turntable);
      const center = bounds.getCenter(new THREE.Vector3());
      turntable.position.sub(center);
      turntable.updateMatrixWorld(true);
      bounds.setFromObject(turntable);

      const sphere = bounds.getBoundingSphere(new THREE.Sphere());
      const radius = Math.max(sphere.radius, 0.08);
      const frame = radius * 1.06;
      this.camera.left = -frame;
      this.camera.right = frame;
      this.camera.top = frame;
      this.camera.bottom = -frame;
      this.camera.near = radius * 0.01;
      this.camera.far = radius * 12;
      this.camera.position.set(radius * 3.4, radius * 2.1, radius * 4.5);
      this.camera.lookAt(0, 0, 0);
      this.camera.updateProjectionMatrix();

      const previousTarget = this.renderer.getRenderTarget();
      const previousClearAlpha = this.renderer.getClearAlpha();
      this.renderer.getClearColor(this.savedClearColor);
      const previousAutoClear = this.renderer.autoClear;
      try {
        this.renderer.autoClear = true;
        this.renderer.setRenderTarget(this.target);
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.clear(true, true, true);
        this.renderer.render(this.scene, this.camera);
        this.renderer.readRenderTargetPixels(
          this.target,
          0,
          0,
          PORTRAIT_SIZE,
          PORTRAIT_SIZE,
          this.pixels,
        );
      } finally {
        this.renderer.setRenderTarget(previousTarget);
        this.renderer.setClearColor(this.savedClearColor, previousClearAlpha);
        this.renderer.autoClear = previousAutoClear;
      }

      const flipped = new Uint8ClampedArray(this.pixels.length);
      const stride = PORTRAIT_SIZE * 4;
      for (let y = 0; y < PORTRAIT_SIZE; y += 1) {
        const source = y * stride;
        const destination = (PORTRAIT_SIZE - y - 1) * stride;
        flipped.set(this.pixels.subarray(source, source + stride), destination);
      }
      const image = new ImageData(flipped, PORTRAIT_SIZE, PORTRAIT_SIZE);
      this.cache.set(def.id, image);
      context.putImageData(image, 0, 0);
    } finally {
      this.scene.remove(turntable);
      disposeVesselVisual(visual);
    }
  }
}

/**
 * Render the same authored/procedural 3D visual used on the vehicle into a
 * compact workshop portrait. A shared off-screen target avoids extra WebGL
 * contexts and caches each immutable part after its first render.
 */
export function partPortrait(
  def: PartDef,
  models?: PartModelLibrary,
  renderer?: THREE.WebGLRenderer,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = PORTRAIT_SIZE;
  canvas.height = PORTRAIT_SIZE;
  canvas.className = 'ed-part-thumb';
  canvas.setAttribute('aria-hidden', 'true');
  if (!renderer) {
    drawFallback(canvas, def);
    return canvas;
  }

  let studio = studios.get(renderer);
  if (!studio) {
    studio = new PartPortraitStudio(renderer);
    studios.set(renderer, studio);
  }
  try {
    studio.render(canvas, def, models);
    canvas.dataset.portrait = def.modelAssetId ? 'authored' : 'procedural';
  } catch (error) {
    console.warn(`Unable to render workshop portrait for ${def.id}:`, error);
    drawFallback(canvas, def);
    canvas.dataset.portrait = 'fallback';
  }
  return canvas;
}
