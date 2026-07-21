import type { QualityTier } from '../bodyRenderer';

export interface PlanetDetailBudget {
  readonly enabled: boolean;
  /** Maximum simultaneously resident compact + terrain detail atlases. */
  readonly activeGpuBytes: number;
  readonly gpuBytes: number;
  readonly decodedCpuBytes: number;
  readonly persistentBytes: number;
  readonly concurrentRequests: number;
  readonly maximumVisualRequestsPerGeneration: number;
  readonly maximumNumericRequestsPerGeneration: number;
  readonly maximumRequestsPerGeneration: number;
  readonly maximumProxyRequestsPerSession: number;
  readonly maximumProxyBytesPerSession: number;
}

const budgets: Readonly<Record<QualityTier, PlanetDetailBudget>> = Object.freeze({
  low: Object.freeze({ enabled: false, activeGpuBytes: 0, gpuBytes: 0, decodedCpuBytes: 0, persistentBytes: 0, concurrentRequests: 0, maximumVisualRequestsPerGeneration: 0, maximumNumericRequestsPerGeneration: 0, maximumRequestsPerGeneration: 0, maximumProxyRequestsPerSession: 0, maximumProxyBytesPerSession: 0 }),
  medium: Object.freeze({ enabled: true, activeGpuBytes: 16 * 1024 * 1024, gpuBytes: 32 * 1024 * 1024, decodedCpuBytes: 24 * 1024 * 1024, persistentBytes: 256 * 1024 * 1024, concurrentRequests: 4, maximumVisualRequestsPerGeneration: 9, maximumNumericRequestsPerGeneration: 4, maximumRequestsPerGeneration: 13, maximumProxyRequestsPerSession: 96, maximumProxyBytesPerSession: 48 * 1024 * 1024 }),
  high: Object.freeze({ enabled: true, activeGpuBytes: 16 * 1024 * 1024, gpuBytes: 64 * 1024 * 1024, decodedCpuBytes: 48 * 1024 * 1024, persistentBytes: 512 * 1024 * 1024, concurrentRequests: 6, maximumVisualRequestsPerGeneration: 9, maximumNumericRequestsPerGeneration: 4, maximumRequestsPerGeneration: 13, maximumProxyRequestsPerSession: 192, maximumProxyBytesPerSession: 96 * 1024 * 1024 }),
});

export function planetDetailBudget(tier: QualityTier): PlanetDetailBudget { return budgets[tier]; }

export class PlanetDetailSessionBudget {
  private proxyRequests = 0;
  private proxyBytes = 0;
  constructor(private readonly budget: Readonly<PlanetDetailBudget>) {}
  beginProxyRequest(): void {
    if (this.proxyRequests >= this.budget.maximumProxyRequestsPerSession) throw new Error('Planet proxy request session budget exhausted');
    this.proxyRequests++;
  }
  recordProxyBytes(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0 || this.proxyBytes + bytes > this.budget.maximumProxyBytesPerSession) {
      throw new Error('Planet proxy egress session budget exhausted');
    }
    this.proxyBytes += bytes;
  }
  stats(): Readonly<{ proxyRequests: number; proxyBytes: number }> {
    return Object.freeze({ proxyRequests: this.proxyRequests, proxyBytes: this.proxyBytes });
  }
}
