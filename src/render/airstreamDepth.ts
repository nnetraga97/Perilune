import * as THREE from 'three';

const BIAS_MATRIX = new THREE.Matrix4().set(
  0.5, 0, 0, 0.5,
  0, 0.5, 0, 0.5,
  0, 0, 0.5, 0.5,
  0, 0, 0, 1,
);

/**
 * Conventional (non-logarithmic) vessel-local depth map. The main flight
 * renderer uses logarithmic depth, but this isolated shader intentionally
 * writes ordinary orthographic gl_FragCoord.z so receivers can compare the
 * projected light-camera depth directly.
 */
export class AirstreamDepthPass {
  readonly target: THREE.WebGLRenderTarget;
  readonly matrix = new THREE.Matrix4();
  readonly texelSize: THREE.Vector2;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera();
  private readonly mesh: THREE.Mesh;
  private readonly center = new THREE.Vector3();
  private readonly radius: number;

  constructor(geometry: THREE.BufferGeometry, size: number) {
    geometry.computeBoundingSphere();
    const bounds = geometry.boundingSphere ?? new THREE.Sphere(new THREE.Vector3(), 1);
    this.center.copy(bounds.center);
    this.radius = Math.max(0.5, bounds.radius + 0.1);
    const depthTexture = new THREE.DepthTexture(size, size, THREE.UnsignedIntType);
    depthTexture.format = THREE.DepthFormat;
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;
    this.target = new THREE.WebGLRenderTarget(size, size, {
      depthTexture,
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
    });
    this.target.texture.name = 'reentry-occlusion-debug-depth';
    depthTexture.name = 'reentry-occlusion-depth';
    this.texelSize = new THREE.Vector2(1 / size, 1 / size);
    const material = new THREE.ShaderMaterial({
      vertexShader: `
        varying float vDepth;
        void main() {
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          vDepth = gl_Position.z / gl_Position.w * 0.5 + 0.5;
        }
      `,
      fragmentShader: `
        varying float vDepth;
        void main() {
          // The color attachment is a deterministic debug mask. Production
          // sampling uses the depth attachment; tests/tools may read this one.
          gl_FragColor = vec4(vDepth, vDepth, vDepth, 1.0);
        }
      `,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: true,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  update(velocityOS: THREE.Vector3): void {
    const direction = velocityOS.lengthSq() > 1e-8
      ? velocityOS.clone().normalize()
      : new THREE.Vector3(0, 1, 0);
    const up = Math.abs(direction.y) < 0.92
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(1, 0, 0);
    this.camera.left = -this.radius;
    this.camera.right = this.radius;
    this.camera.top = this.radius;
    this.camera.bottom = -this.radius;
    this.camera.near = Math.max(0.01, this.radius * 0.05);
    this.camera.far = this.radius * 5;
    // velocityOS points in the direction of travel. Upstream is +velocityOS;
    // the camera therefore looks back along -velocityOS toward the craft.
    this.camera.position.copy(this.center).addScaledVector(direction, this.radius * 2.25);
    this.camera.up.copy(up);
    this.camera.lookAt(this.center);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    this.matrix.copy(BIAS_MATRIX)
      .multiply(this.camera.projectionMatrix)
      .multiply(this.camera.matrixWorldInverse);
  }

  render(renderer: THREE.WebGLRenderer): void {
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    try {
      renderer.autoClear = false;
      renderer.setRenderTarget(this.target);
      renderer.clear(true, true, false);
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = previousAutoClear;
    }
  }

  /** Readable only in explicit diagnostics; never called in the frame loop. */
  readDebugPixel(renderer: THREE.WebGLRenderer, x: number, y: number): Uint8Array {
    const pixel = new Uint8Array(4);
    renderer.readRenderTargetPixels(this.target, x, y, 1, 1, pixel);
    return pixel;
  }

  /** Detached proxy used by the renderer's isolated shader compiler. */
  compileCandidateObject(): THREE.Object3D {
    const candidate = this.mesh.clone();
    candidate.visible = true;
    return candidate;
  }

  dispose(): void {
    (this.mesh.material as THREE.Material).dispose();
    this.target.dispose();
    this.scene.clear();
  }
}
