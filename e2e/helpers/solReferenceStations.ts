import { SOL_VISUAL_REFERENCE_STATIONS } from '../../src/proto/solVisualReferenceStations';

/** Stable station IDs shared by Playwright capture and the runtime harness. */
export const SOL_REFERENCE_STATION_IDS = Object.freeze(
  SOL_VISUAL_REFERENCE_STATIONS.map((station) => station.id),
);
