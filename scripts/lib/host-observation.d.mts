export interface SanitizedMacHostObservation {
  readonly modelName: string;
  readonly modelIdentifier: string;
  readonly chip: string;
  readonly gpuCoreCount: number;
  readonly memoryBytes: number;
  readonly firmwareVersion: string;
  readonly osVersion: string;
  readonly osBuild: string;
  readonly powerSource: string;
  readonly powerMode: number;
}

export function observeSanitizedMacHost(
  runCommand?: (command: string, args: readonly string[]) => string,
): Readonly<SanitizedMacHostObservation>;
