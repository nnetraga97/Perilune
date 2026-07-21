export type ArtemisFidelityLabel =
  | 'verified-source'
  | 'reference-trajectory'
  | 'representative'
  | 'proxy-visual';

export interface ArtemisKernelArtifact {
  readonly filename: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface ArtemisSourceRecord {
  readonly id: string;
  readonly kind: 'web-page' | 'technical-report' | 'metadata' | 'kernel';
  readonly fidelity: ArtemisFidelityLabel;
  readonly publisher: string;
  readonly title: string;
  readonly url: string;
  readonly retrievedOn: string;
  readonly supportedClaims: readonly string[];
  readonly artifact?: ArtemisKernelArtifact;
}

export interface ArtemisReferenceTrajectoryLock {
  readonly id: string;
  readonly fidelity: 'reference-trajectory';
  readonly coordinateFrame: 'MOON_J2000';
  readonly positionUnits: 'm';
  readonly velocityUnits: 'm/s';
  readonly timeUnits: 's';
  readonly sourceIds: readonly string[];
  readonly kernelSourceIds: readonly string[];
  readonly selection: {
    readonly startEtSeconds: number;
    readonly stopEtSeconds: number;
    readonly sampleStepSeconds: number;
    readonly method: string;
  };
  readonly generatedArtifact: {
    readonly path: string;
    readonly byteLength: number;
    readonly sha256: string;
    readonly script: string;
    readonly scriptByteLength: number;
    readonly scriptSha256: string;
    readonly requirements: string;
    readonly requirementsByteLength: number;
    readonly requirementsSha256: string;
    readonly command: string;
  };
  readonly disclaimer: string;
}

export interface ArtemisSourceLock {
  readonly schemaVersion: 1;
  readonly missionId: 'artemis-iv';
  readonly retrievedOn: string;
  readonly allowedHosts: readonly string[];
  readonly sources: readonly ArtemisSourceRecord[];
  readonly referenceTrajectory: ArtemisReferenceTrajectoryLock;
}

export interface ArtemisReferenceSample {
  readonly tSeconds: number;
  readonly positionM: readonly [number, number, number];
  readonly velocityMps: readonly [number, number, number];
}

export const ARTEMIS_FIDELITY_LABELS: readonly ArtemisFidelityLabel[];
export function sha256ArtemisBytes(bytes: Uint8Array): string;
export function artemisSamplesSha256(samples: readonly ArtemisReferenceSample[]): string;
export function validateArtemisSourceLock(lock: unknown): string[];
export function assertArtemisSourceLock(lock: unknown): ArtemisSourceLock;
export function sourceByArtemisId(lock: ArtemisSourceLock, sourceId: string): ArtemisSourceRecord;
export function validateArtemisReferenceArtifact(
  lock: unknown,
  artifact: unknown,
  artifactBytes?: Uint8Array,
): string[];
export function assertArtemisReferenceArtifact<T>(
  lock: unknown,
  artifact: T,
  artifactBytes?: Uint8Array,
): T;
