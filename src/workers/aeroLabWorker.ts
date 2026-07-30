import { analyzeAeroLabField, type AeroLabFieldRequest } from '../render/aeroLabAnalysis';

interface RequestMessage {
  requestId: number;
  request: AeroLabFieldRequest;
}

self.onmessage = (event: MessageEvent<RequestMessage>) => {
  const { requestId, request } = event.data;
  try {
    const result = analyzeAeroLabField(request);
    self.postMessage({ requestId, result }, {
      transfer: [
        result.positions.buffer,
        result.normals.buffer,
        result.partKeys.buffer,
        result.streamlinePositions.buffer,
        result.streamlineOffsets.buffer,
        result.shielding.buffer,
      ],
    });
  } catch (error) {
    self.postMessage({
      requestId,
      error: error instanceof Error ? error.name : 'AeroLabAnalysisError',
    });
  }
};
