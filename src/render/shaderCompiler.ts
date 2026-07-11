import * as THREE from 'three';
import { RenderBoundaryError } from './renderFailures';
import type { QualityTier } from './bodyRenderer';

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
  readonly tier: QualityTier;
  readonly channel: string;
}

const compileQueues = new WeakMap<object, Promise<void>>();

async function compileIsolated(options: CompileRendererCandidateOptions): Promise<void> {
  const stagingScene = new THREE.Scene();
  const previousParent = options.root.parent;
  const previousIndex = previousParent?.children.indexOf(options.root) ?? -1;
  const previousVisible = options.root.visible;
  stagingScene.add(options.root);
  options.root.visible = true;
  const previous = options.renderer.debug.onShaderError;
  const shaderFailures: unknown[][] = [];
  options.renderer.debug.onShaderError = (...args: Parameters<ShaderErrorCallback>) => { shaderFailures.push(args); };
  try {
    try {
      await options.renderer.compileAsync(stagingScene, options.camera);
    } catch (error) {
      throw new RenderBoundaryError(
        { body: options.body, tier: options.tier, channel: options.channel, phase: 'compile' },
        `${options.body}/${options.channel} compile failed`,
        { cause: error },
      );
    }
    if (shaderFailures.length > 0) {
      throw new RenderBoundaryError(
        { body: options.body, tier: options.tier, channel: options.channel, phase: 'compile' },
        `${options.body}/${options.channel} shader failed (${shaderFailures.length} error${shaderFailures.length === 1 ? '' : 's'})`,
      );
    }
  } finally {
    options.renderer.debug.onShaderError = previous;
    stagingScene.remove(options.root);
    options.root.visible = previousVisible;
    if (previousParent) {
      previousParent.add(options.root);
      if (previousIndex >= 0 && previousIndex < previousParent.children.length - 1) {
        previousParent.children.splice(previousParent.children.indexOf(options.root), 1);
        previousParent.children.splice(previousIndex, 0, options.root);
      }
    }
  }
}

export async function compileRendererCandidate(options: CompileRendererCandidateOptions): Promise<void> {
  const previous = compileQueues.get(options.renderer) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => compileIsolated(options));
  const tail = run.then(() => undefined, () => undefined);
  compileQueues.set(options.renderer, tail);
  try {
    await run;
  } finally {
    if (compileQueues.get(options.renderer) === tail) compileQueues.delete(options.renderer);
  }
}
