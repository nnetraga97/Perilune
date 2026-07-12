export const PART_ASSET_BUDGET_CEILINGS: Readonly<{
  totalTriangleLimit: number;
  totalTransferBytes: number;
  totalGpuBytes: number;
}>;
export const REFERENCE_CRAFT_TRIANGLE_LIMIT: number;

export function canonicalJson(value: unknown): string;

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface PartAssetInputs {
  sources: { schemaVersion: number; sources: any[] };
  recipes: {
    schemaVersion: number;
    budgets: Record<string, number>;
    models: any[];
  };
}

export function loadPartAssetInputs(root: string): PartAssetInputs;
export function validatePartAssetDocuments(sources: unknown, recipes: unknown): string[];
export function validatePartAssetInputs(root: string): string[];
export function validateCheckedPartManifest(root: string): string[];
