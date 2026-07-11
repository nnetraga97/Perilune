import * as THREE from 'three';

type ShaderErrorCallback = NonNullable<THREE.WebGLRenderer['debug']['onShaderError']>;

interface CompileRenderer {
  readonly debug: { onShaderError: ShaderErrorCallback | null };
  compileAsync(scene: THREE.Scene, camera: THREE.Camera): Promise<unknown>;
}

export interface CompileRendererCandidateOptions {
  readonly renderer: CompileRenderer;
  readonly camera: THREE.Camera;
  readonly root: THREE.Object3D;
  readonly body: string;
  readonly channel: string;
}

export async function compileRendererCandidate(options: CompileRendererCandidateOptions): Promise<void> {
  const stagingScene = new THREE.Scene();
  stagingScene.add(options.root);
  const previous = options.renderer.debug.onShaderError;
  const shaderFailures: unknown[][] = [];
  options.renderer.debug.onShaderError = (...args: Parameters<ShaderErrorCallback>) => { shaderFailures.push(args); };
  try {
    try {
      await options.renderer.compileAsync(stagingScene, options.camera);
    } catch (error) {
      throw new Error(`${options.body}/${options.channel} compile failed`, { cause: error });
    }
    if (shaderFailures.length > 0) {
      throw new Error(`${options.body}/${options.channel} shader failed (${shaderFailures.length} error${shaderFailures.length === 1 ? '' : 's'})`);
    }
  } finally {
    options.renderer.debug.onShaderError = previous;
    stagingScene.remove(options.root);
  }
}
