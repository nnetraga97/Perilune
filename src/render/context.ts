/**
 * Renderer bootstrap: capability detection and graceful fallback.
 * WebGL2 is the baseline (ADR-002); WebGPU adoption lands later behind the
 * same interface. If WebGL2 is unavailable we fall back to WebGL1 with
 * reduced features rather than a blank page.
 */
import * as THREE from 'three';

export interface RenderCaps {
  backend: 'webgl2' | 'webgl1';
  maxTextureSize: number;
  maxAnisotropy: number;
  webgpuAvailable: boolean;
}

export interface RenderContext {
  renderer: THREE.WebGLRenderer;
  caps: RenderCaps;
  canvas: HTMLCanvasElement;
}

export async function createRenderContext(canvas: HTMLCanvasElement): Promise<RenderContext> {
  // Detect (but don't yet use) WebGPU so the capability is surfaced.
  let webgpuAvailable = false;
  try {
    const nav = navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } };
    if (nav.gpu) {
      const adapter = await nav.gpu.requestAdapter();
      webgpuAvailable = adapter !== null && adapter !== undefined;
    }
  } catch {
    webgpuAvailable = false;
  }

  const gl2 = canvas.getContext('webgl2', { antialias: true, powerPreference: 'high-performance' });
  const backend: RenderCaps['backend'] = gl2 ? 'webgl2' : 'webgl1';

  const renderer = new THREE.WebGLRenderer({
    canvas,
    context: gl2 ?? undefined,
    antialias: true,
    logarithmicDepthBuffer: true, // planetary scale needs the depth range
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const gl = renderer.getContext();
  const caps: RenderCaps = {
    backend,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
    webgpuAvailable,
  };

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  });

  return { renderer, caps, canvas };
}
