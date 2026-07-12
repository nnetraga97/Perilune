export interface PinnedSource {
  sourceId: string;
  url: string;
  sha256: string;
  [key: string]: unknown;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  body: NodeJS.ReadableStream | null;
}

export function fetchPinnedSource(
  source: PinnedSource,
  destination: string,
  fetchImpl: (url: string) => Promise<FetchResponseLike>,
): Promise<'downloaded' | 'verified'>;
