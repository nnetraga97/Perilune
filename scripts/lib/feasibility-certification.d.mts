export type FeasibilityTier = 'low' | 'medium';

export interface CertificationGate {
  readonly name: string;
  readonly actual: number | null;
  readonly limit: number;
  readonly comparison: '>=' | '<' | '<=' | '===';
  readonly pass: boolean;
  readonly reason: string | null;
}

export const FEASIBILITY_METADATA_KEYS: readonly string[];
export const STABLE_CHROME_PATH: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export function browserExecutableForMode(
  mode: string,
  requestedPath: string | undefined,
  pathExists: (path: string) => boolean,
): string | undefined;
export function expectedReferenceForTier(tier: FeasibilityTier): 'm3-max-30c';
export function effectiveStageFor(tier: FeasibilityTier, requestedStage: number): number;
export function assessCertificationEligibility(input: {
  mode: string;
  tier: FeasibilityTier;
  reference: string | null;
  metadata: Readonly<Record<string, string>>;
  disabled: string;
  requestedStage: number;
  runNonce: string;
  host: Readonly<Record<string, unknown>> | null;
  browser: Readonly<Record<string, unknown>>;
  state: Readonly<Record<string, any>>;
  runtimeErrors: readonly string[];
}): Readonly<{ eligible: boolean; reasons: readonly string[] }>;
export function buildCertificationGates(
  state: Readonly<Record<string, any>>,
  tier: FeasibilityTier,
): readonly CertificationGate[];
