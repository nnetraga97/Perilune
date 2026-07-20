export interface SolarPresentationBlend {
  readonly physicalOpacity: number;
  readonly proxyOpacity: number;
  readonly mode: 'physical' | 'transition' | 'proxy';
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function solarPresentationBlend(distanceInSolarRadii: number): SolarPresentationBlend {
  const proxyOpacity = smoothstep(30, 45, distanceInSolarRadii);
  return Object.freeze({
    physicalOpacity: 1 - proxyOpacity,
    proxyOpacity,
    mode: proxyOpacity <= 0 ? 'physical' : proxyOpacity >= 1 ? 'proxy' : 'transition',
  });
}
