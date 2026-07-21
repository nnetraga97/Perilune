import { describe, expect, it } from 'vitest';
import { PlanetDetailSessionBudget, planetDetailBudget } from '../src/render/planetDetail/detailBudget';

describe('planet visual-detail budgets', () => {
  it('keeps Low offline and pins bounded Medium/High allocations', () => {
    expect(planetDetailBudget('low')).toMatchObject({ enabled: false, activeGpuBytes: 0, gpuBytes: 0, concurrentRequests: 0 });
    expect(planetDetailBudget('medium')).toMatchObject({
      enabled: true, activeGpuBytes: 16 * 1024 * 1024, gpuBytes: 32 * 1024 * 1024, decodedCpuBytes: 24 * 1024 * 1024,
      persistentBytes: 256 * 1024 * 1024, concurrentRequests: 4,
      maximumVisualRequestsPerGeneration: 9, maximumNumericRequestsPerGeneration: 4, maximumRequestsPerGeneration: 13,
    });
    expect(planetDetailBudget('high')).toMatchObject({
      enabled: true, activeGpuBytes: 16 * 1024 * 1024, gpuBytes: 64 * 1024 * 1024, decodedCpuBytes: 48 * 1024 * 1024,
      persistentBytes: 512 * 1024 * 1024, concurrentRequests: 6,
      maximumVisualRequestsPerGeneration: 9, maximumNumericRequestsPerGeneration: 4, maximumRequestsPerGeneration: 13,
    });
  });

  it('enforces proxy request and egress ceilings independently', () => {
    const budget = new PlanetDetailSessionBudget({
      ...planetDetailBudget('medium'), maximumProxyRequestsPerSession: 2, maximumProxyBytesPerSession: 10,
    });
    budget.beginProxyRequest();
    budget.recordProxyBytes(6);
    budget.beginProxyRequest();
    expect(() => budget.beginProxyRequest()).toThrow(/request session budget/);
    expect(() => budget.recordProxyBytes(5)).toThrow(/egress session budget/);
    expect(budget.stats()).toEqual({ proxyRequests: 2, proxyBytes: 6 });
  });

  it('fits one complete 3x3 source atlas within every enabled tier', () => {
    expect(512 * 3 * 512 * 3 * 4).toBeLessThanOrEqual(planetDetailBudget('medium').gpuBytes);
    expect(512 * 3 * 512 * 3 * 4).toBeLessThanOrEqual(planetDetailBudget('high').gpuBytes);
  });
});
