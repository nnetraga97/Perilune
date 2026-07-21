export interface PlanetSourceOperation {
  readonly id: string;
  readonly url: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly expectedMime: string;
  readonly expectedCors?: '*';
  readonly maximumBytes: number;
  readonly sha256?: string;
  readonly image?: { readonly width: number; readonly height: number };
  readonly numeric?: { readonly minimum: number; readonly maximum: number; readonly tolerance: number };
  readonly json?: Readonly<Record<string, unknown>>;
}

export interface PlanetSourceRecord {
  readonly id: string;
  readonly body: 'earth' | 'moon';
  readonly role: 'height' | 'surface-class' | 'albedo' | 'material' | 'shading-normal';
  readonly coverage: readonly [number, number, number, number];
  readonly version: string;
  readonly projection: string;
  readonly verticalDatum: string;
  readonly license: string;
  readonly licenseUrl: string;
  readonly delivery: 'direct-cors' | 'same-origin-proxy' | 'offline-build';
  readonly operations: readonly PlanetSourceOperation[];
}

export interface PlanetSourceLock {
  readonly schemaVersion: 1;
  readonly observedAt: string;
  readonly allowedHosts: readonly string[];
  readonly sources: readonly PlanetSourceRecord[];
}

export const PLANET_SOURCE_ROLES: readonly string[];
export function buildProbeUrl(operation: PlanetSourceOperation): URL;
export function validatePlanetSourceLock(lock: unknown): string[];
export function assertPlanetSourceLock(lock: unknown): PlanetSourceLock;
export function sourceById(lock: PlanetSourceLock, sourceId: string): PlanetSourceRecord;
export function sha256Bytes(bytes: Uint8Array): string;
export function assertJsonFingerprint(actual: unknown, expected: Readonly<Record<string, unknown>>, label?: string): void;
