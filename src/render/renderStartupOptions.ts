import type { DiagnosticQualityTier } from './renderDiagnostics';

export interface RenderStartupOptions {
  readonly quality: DiagnosticQualityTier;
  readonly renderDebug: boolean;
}

export function parseRenderStartupOptions(search: string): RenderStartupOptions {
  const params = new URLSearchParams(search);
  const quality = params.get('quality');
  return Object.freeze({
    quality: quality === 'high' ? 'high' : 'medium',
    renderDebug: params.get('renderDebug') === '1',
  });
}
