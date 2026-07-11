export interface PlanetPackRecord {
  readonly bodyId: string;
  readonly tier: string;
  readonly compressedBytes: number;
  readonly transientBytes: number;
  readonly bootCritical: boolean;
}

export function derivePlanetTransfer(
  manifest: { readonly packs: readonly PlanetPackRecord[] },
  bodyId: string,
  tier: string,
) {
  const selected = manifest.packs.filter((pack) => pack.bodyId === bodyId && pack.tier === tier);
  const sum = (packs: readonly PlanetPackRecord[], field: 'compressedBytes' | 'transientBytes') =>
    packs.reduce((total, pack) => total + pack[field], 0);
  return Object.freeze({
    bodyPackCompressedBytes: sum(selected, 'compressedBytes'),
    bootCriticalBytes: sum(manifest.packs.filter((pack) => pack.tier === tier && pack.bootCritical), 'compressedBytes'),
    transientBytes: sum(selected, 'transientBytes'),
    manifestPackCount: manifest.packs.length,
    selectedPackCount: selected.length,
  });
}

export function applicationResourceTransfer(entries: readonly PerformanceEntry[]) {
  let transferBytes = 0;
  let encodedBytes = 0;
  for (const entry of entries) {
    if (!(entry instanceof PerformanceResourceTiming) && !(entry instanceof PerformanceNavigationTiming)) continue;
    const url = new URL(entry.name, location.href);
    if (url.origin !== location.origin) continue;
    transferBytes += entry.transferSize;
    encodedBytes += entry.encodedBodySize;
  }
  return Object.freeze({ transferBytes, encodedBytes });
}
