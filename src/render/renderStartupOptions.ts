import type { DiagnosticQualityTier } from './renderDiagnostics';

export interface RenderStartupOptions {
  readonly quality: DiagnosticQualityTier;
  readonly renderDebug: boolean;
  /** Profiling kill switch. Production defaults on; `?reentryVfx=0` disables it. */
  readonly reentryVfx: boolean;
}

export function parseRenderStartupOptions(search: string): RenderStartupOptions {
  const params = new URLSearchParams(search);
  const quality = params.get('quality');
  return Object.freeze({
    quality: quality === 'high' ? 'high' : 'medium',
    renderDebug: params.get('renderDebug') === '1',
    reentryVfx: params.get('reentryVfx') !== '0',
  });
}
