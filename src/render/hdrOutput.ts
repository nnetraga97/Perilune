/**
 * Linear HDR scene target with a single display transform.
 *
 * Rendering straight to the canvas tone-maps and sRGB-encodes every material
 * on its own, so transparent layers (atmosphere shells, cloud decks, ocean
 * haze) blend in display space. A 10% linear haze then reads as a ~35% veil
 * and every colour beneath it desaturates. Rendering into a half-float target
 * keeps blending linear; ACES and sRGB encoding run once on the composite.
 *
 * Three.js already drops tone mapping and output encoding for materials drawn
 * into a render target, so scene materials need no changes.
 */
import * as THREE from 'three';

const OUTPUT_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const OUTPUT_FRAGMENT = /* glsl */ `
  uniform sampler2D tScene;
  varying vec2 vUv;
  void main() {
    gl_FragColor = vec4(texture2D(tScene, vUv).rgb, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class HdrOutput {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly quad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly outputScene = new THREE.Scene();
  private readonly outputCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly size = new THREE.Vector2();

  private quality: 'low' | 'medium' | 'high' = 'high';

  constructor(private readonly maxSamples = 4, type: THREE.TextureDataType = THREE.HalfFloatType) {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
      samples: maxSamples,
    });
    this.target.texture.name = 'hdr-scene';
    this.target.texture.generateMipmaps = false;
    this.target.texture.minFilter = THREE.LinearFilter;
    this.target.texture.magFilter = THREE.LinearFilter;
    this.quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        name: 'hdr-output',
        uniforms: { tScene: { value: this.target.texture } },
        vertexShader: OUTPUT_VERTEX,
        fragmentShader: OUTPUT_FRAGMENT,
        depthTest: false,
        depthWrite: false,
        toneMapped: true,
      }),
    );
    this.quad.frustumCulled = false;
    this.outputScene.add(this.quad);
  }

  setQuality(quality: 'low' | 'medium' | 'high'): void {
    this.quality = quality;
    const samples = quality === 'low' ? 0 : this.maxSamples;
    if (samples !== this.target.samples) {
      this.target.dispose();
      this.target.samples = samples;
    }
  }

  /** Renders `scene` linearly, then writes the tone-mapped image to the canvas. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    renderer.getDrawingBufferSize(this.size);
    // Bound the offscreen allocation independently of the display's DPR.
    const maxPixels = this.quality === 'low' ? 1280 * 720
      : this.quality === 'medium' ? 1920 * 1080 : 2560 * 1440;
    const scale = Math.min(1, Math.sqrt(maxPixels / (this.size.x * this.size.y)));
    this.size.set(Math.max(1, Math.floor(this.size.x * scale)), Math.max(1, Math.floor(this.size.y * scale)));
    if (this.target.width !== this.size.x || this.target.height !== this.size.y) {
      this.target.setSize(this.size.x, this.size.y);
    }
    const previousTarget = renderer.getRenderTarget();
    const autoReset = renderer.info.autoReset;
    if (autoReset) renderer.info.reset();
    renderer.info.autoReset = false;
    try {
      renderer.setRenderTarget(this.target);
      renderer.render(scene, camera);
      renderer.setRenderTarget(previousTarget);
      renderer.render(this.outputScene, this.outputCamera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.info.autoReset = autoReset;
    }
  }

  dispose(): void {
    this.target.dispose();
    this.quad.geometry.dispose();
    this.quad.material.dispose();
  }
}
