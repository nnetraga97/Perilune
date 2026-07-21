/** Renderer bootstrap and the WebGL2 capability contract. */
import * as THREE from 'three';
import { RenderContextLifecycle } from './contextLifecycle';

const ANALYTIC_HIGHP = { precision: 23, rangeMin: 127, rangeMax: 127 } as const;
const LOOKUP_HIGHP = { precision: 16, rangeMin: 31, rangeMax: 31 } as const;

export interface RenderCaps {
  readonly backend: 'webgl2';
  readonly fragmentHighp: {
    readonly precision: number;
    readonly rangeMin: number;
    readonly rangeMax: number;
  };
  readonly atmospherePath: 'analytic' | 'lookup' | 'limb-haze';
  readonly compressedTextures: {
    readonly astc: boolean;
    readonly etc2: boolean;
    readonly etc1: boolean;
    readonly s3tc: boolean;
    readonly bptc: boolean;
    readonly pvrtc: boolean;
  };
  readonly maxTextureSize: number;
  readonly maxAnisotropy: number;
  readonly drawingBufferSamples: number;
}

export interface RenderContext {
  renderer: THREE.WebGLRenderer;
  caps: RenderCaps;
  canvas: HTMLCanvasElement;
  lifecycle: RenderContextLifecycle;
  readonly renderPaused: boolean;
}

export class RenderCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderCapabilityError';
  }
}

function supportsPrecision(
  precision: WebGLShaderPrecisionFormat,
  floor: { readonly precision: number; readonly rangeMin: number; readonly rangeMax: number },
): boolean {
  return precision.precision >= floor.precision
    && precision.rangeMin >= floor.rangeMin
    && precision.rangeMax >= floor.rangeMax;
}

export function probeRenderCaps(
  gl: WebGL2RenderingContext,
  renderer: THREE.WebGLRenderer,
): RenderCaps {
  const highp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  const fragmentHighp = {
    precision: highp?.precision ?? 0,
    rangeMin: highp?.rangeMin ?? 0,
    rangeMax: highp?.rangeMax ?? 0,
  };
  const atmospherePath: RenderCaps['atmospherePath'] = supportsPrecision(fragmentHighp, ANALYTIC_HIGHP)
    ? 'analytic'
    : supportsPrecision(fragmentHighp, LOOKUP_HIGHP) ? 'lookup' : 'limb-haze';

  return {
    backend: 'webgl2',
    fragmentHighp,
    atmospherePath,
    compressedTextures: {
      astc: gl.getExtension('WEBGL_compressed_texture_astc') !== null,
      etc2: gl.getExtension('WEBGL_compressed_texture_etc') !== null,
      etc1: gl.getExtension('WEBGL_compressed_texture_etc1') !== null,
      s3tc: gl.getExtension('WEBGL_compressed_texture_s3tc') !== null,
      bptc: gl.getExtension('EXT_texture_compression_bptc') !== null,
      pvrtc: gl.getExtension('WEBGL_compressed_texture_pvrtc') !== null
        || gl.getExtension('WEBKIT_WEBGL_compressed_texture_pvrtc') !== null,
    },
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
    drawingBufferSamples: gl.getParameter(gl.SAMPLES) as number,
  };
}

export async function createRenderContext(canvas: HTMLCanvasElement): Promise<RenderContext> {
  const gl = canvas.getContext('webgl2', {
    antialias: true,
    powerPreference: 'high-performance',
  });
  if (!gl) {
    throw new RenderCapabilityError('Perilune requires WebGL2');
  }

  const renderer = new THREE.WebGLRenderer({
    canvas,
    context: gl,
    antialias: true,
    logarithmicDepthBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  // WorldScene enables this only for Medium/High after fitting the active-body
  // camera. Keeping it disabled here prevents editor/map passes from paying for
  // a flight shadow map they do not own.
  renderer.shadowMap.enabled = false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const caps = probeRenderCaps(gl, renderer);
  const lifecycle = new RenderContextLifecycle(canvas);

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  });

  return {
    renderer,
    caps,
    canvas,
    lifecycle,
    get renderPaused() { return lifecycle.renderPaused; },
  };
}
