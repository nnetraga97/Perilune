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

  constructor(samples = 4) {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: true,
      stencilBuffer: false,
      samples,
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

  /** Renders `scene` linearly, then writes the tone-mapped image to the canvas. */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    renderer.getDrawingBufferSize(this.size);
    if (this.target.width !== this.size.x || this.target.height !== this.size.y) {
      this.target.setSize(this.size.x, this.size.y);
    }
    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(previousTarget);
    renderer.render(this.outputScene, this.outputCamera);
  }

  dispose(): void {
    this.target.dispose();
    this.quad.geometry.dispose();
    this.quad.material.dispose();
  }
}
