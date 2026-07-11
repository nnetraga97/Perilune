import { describe, expect, it, vi } from 'vitest';

const { rendererConstructor } = vi.hoisted(() => ({ rendererConstructor: vi.fn() }));

vi.mock('three', () => ({
  WebGLRenderer: rendererConstructor,
  SRGBColorSpace: 'srgb',
  ACESFilmicToneMapping: 'aces',
}));

import {
  RenderCapabilityError,
  createRenderContext,
  probeRenderCaps,
} from '../src/render/context';

type Precision = { precision: number; rangeMin: number; rangeMax: number };

function fakeGl(
  highp: Precision,
  extensions: readonly string[] = [],
  maxTextureSize = 16_384,
  samples = 4,
): WebGL2RenderingContext {
  const extensionSet = new Set(extensions);
  return {
    FRAGMENT_SHADER: 0x8b30,
    HIGH_FLOAT: 0x8df2,
    MAX_TEXTURE_SIZE: 0x0d33,
    SAMPLES: 0x80a9,
    getShaderPrecisionFormat: vi.fn(() => highp),
    getExtension: vi.fn((name: string) => extensionSet.has(name) ? {} : null),
    getParameter: vi.fn((name: number) => name === 0x0d33 ? maxTextureSize : samples),
  } as unknown as WebGL2RenderingContext;
}

const renderer = (anisotropy = 8) => ({
  capabilities: { getMaxAnisotropy: () => anisotropy },
}) as unknown as import('three').WebGLRenderer;

describe('renderer capabilities', () => {
  it('rejects a missing WebGL2 context before constructing Three.js', async () => {
    rendererConstructor.mockClear();
    const canvas = { getContext: vi.fn(() => null) } as unknown as HTMLCanvasElement;

    await expect(createRenderContext(canvas)).rejects.toEqual(
      new RenderCapabilityError('Perilune requires WebGL2'),
    );
    expect(rendererConstructor).not.toHaveBeenCalled();
  });

  it('reports full analytic atmosphere capability at the precision floor', () => {
    const caps = probeRenderCaps(fakeGl({ precision: 23, rangeMin: 127, rangeMax: 127 }), renderer());

    expect(caps.backend).toBe('webgl2');
    expect(caps.fragmentHighp).toEqual({ precision: 23, rangeMin: 127, rangeMax: 127 });
    expect(caps.atmospherePath).toBe('analytic');
  });

  it('uses lookup atmosphere for intermediate fragment precision', () => {
    expect(probeRenderCaps(
      fakeGl({ precision: 16, rangeMin: 31, rangeMax: 31 }),
      renderer(),
    ).atmospherePath).toBe('lookup');
  });

  it('uses limb haze when fragment precision or range is insufficient', () => {
    expect(probeRenderCaps(
      fakeGl({ precision: 15, rangeMin: 31, rangeMax: 31 }),
      renderer(),
    ).atmospherePath).toBe('limb-haze');
    expect(probeRenderCaps(
      fakeGl({ precision: 23, rangeMin: 30, rangeMax: 127 }),
      renderer(),
    ).atmospherePath).toBe('limb-haze');
  });

  it('exposes KTX2 transcode formats, texture limits, anisotropy, and samples', () => {
    const gl = fakeGl(
      { precision: 23, rangeMin: 127, rangeMax: 127 },
      [
        'WEBGL_compressed_texture_astc',
        'WEBGL_compressed_texture_etc',
        'WEBGL_compressed_texture_etc1',
        'WEBGL_compressed_texture_s3tc',
        'EXT_texture_compression_bptc',
      ],
      8_192,
      2,
    );

    const caps = probeRenderCaps(gl, renderer(16));

    expect(caps.compressedTextures).toEqual({
      astc: true,
      etc2: true,
      etc1: true,
      s3tc: true,
      bptc: true,
      pvrtc: false,
    });
    expect(caps.maxTextureSize).toBe(8_192);
    expect(caps.maxAnisotropy).toBe(16);
    expect(caps.drawingBufferSamples).toBe(2);
  });

  it('detects WebKit-prefixed PVRTC support used by the KTX2 loader', () => {
    const caps = probeRenderCaps(
      fakeGl(
        { precision: 23, rangeMin: 127, rangeMax: 127 },
        ['WEBKIT_WEBGL_compressed_texture_pvrtc'],
      ),
      renderer(),
    );

    expect(caps.compressedTextures.pvrtc).toBe(true);
  });

  it('provides the exact user-facing WebGL2 requirement message', () => {
    const error = new RenderCapabilityError('Perilune requires WebGL2');

    expect(error.name).toBe('RenderCapabilityError');
    expect(error.message).toBe('Perilune requires WebGL2');
  });
});
