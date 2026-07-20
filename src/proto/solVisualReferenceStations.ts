export type SolReferenceBody = 'sun' | 'earth' | 'moon';
export type SolReferencePresentation = 'solar-disk' | 'full-disk' | 'limb' | 'orbit' | 'surface' | 'alignment';

export interface SolVisualReferenceStation {
  readonly id: string;
  readonly bodyId: SolReferenceBody;
  readonly latitudeDegrees: number;
  readonly longitudeDegrees: number;
  readonly altitudeMeters: number;
  readonly fovDegrees: number;
  /** Downward pitch for surface stations; zero is the local horizon. */
  readonly pitchDegrees?: number;
  /** Unit body-fixed direction from the body toward the Sun. */
  readonly sunDirection: readonly [number, number, number];
  readonly timeSeconds: number;
  readonly presentation: SolReferencePresentation;
  readonly note: string;
}

const station = (
  value: SolVisualReferenceStation,
): SolVisualReferenceStation => Object.freeze(value);

export const SOL_VISUAL_REFERENCE_STATIONS: readonly SolVisualReferenceStation[] = Object.freeze([
  station({ id: 'sun-from-earth', bodyId: 'sun', latitudeDegrees: 0, longitudeDegrees: 0, altitudeMeters: 149_597_870_700, fovDegrees: 24, sunDirection: [1, 0, 0], timeSeconds: 0, presentation: 'solar-disk', note: 'Photosphere, limb darkening, bounded glare, and corona.' }),
  station({ id: 'sun-partial-occultation', bodyId: 'sun', latitudeDegrees: 0, longitudeDegrees: 0, altitudeMeters: 149_597_870_700, fovDegrees: 6, sunDirection: [1, 0, 0], timeSeconds: 0, presentation: 'alignment', note: 'Numeric finite-disk occultation alignment station.' }),
  station({ id: 'earth-moon-true-scale', bodyId: 'earth', latitudeDegrees: 0, longitudeDegrees: 0, altitudeMeters: 400_000_000, fovDegrees: 58, sunDirection: [0.92, -0.2, 0.34], timeSeconds: 0, presentation: 'alignment', note: 'Earth and Moon at their physical mean separation in one wide frame.' }),
  station({ id: 'earth-day-full', bodyId: 'earth', latitudeDegrees: 18, longitudeDegrees: -20, altitudeMeters: 22_000_000, fovDegrees: 34, sunDirection: [0.92, -0.2, 0.34], timeSeconds: 0, presentation: 'full-disk', note: 'Africa and Atlantic identity in daylight.' }),
  station({ id: 'earth-terminator-full', bodyId: 'earth', latitudeDegrees: 8, longitudeDegrees: -30, altitudeMeters: 22_000_000, fovDegrees: 34, sunDirection: [0, 1, 0.15], timeSeconds: 0, presentation: 'full-disk', note: 'Terminator, cloud relief, and city-light transition.' }),
  station({ id: 'earth-night-full', bodyId: 'earth', latitudeDegrees: 25, longitudeDegrees: -90, altitudeMeters: 22_000_000, fovDegrees: 34, sunDirection: [-0.96, 0.12, -0.2], timeSeconds: 0, presentation: 'full-disk', note: 'Night emission remains cloud-attenuated and geographically bounded.' }),
  station({ id: 'earth-limb-2000km', bodyId: 'earth', latitudeDegrees: 0, longitudeDegrees: -30, altitudeMeters: 2_000_000, fovDegrees: 62, sunDirection: [0.5, 0.84, 0.2], timeSeconds: 0, presentation: 'limb', note: 'Atmosphere/ocean limb continuity.' }),
  station({ id: 'earth-low-orbit', bodyId: 'earth', latitudeDegrees: 28.5, longitudeDegrees: -80.6, altitudeMeters: 250_000, fovDegrees: 62, sunDirection: [0.55, -0.72, 0.42], timeSeconds: 0, presentation: 'orbit', note: 'Cloud macro structure and source terrain identity.' }),
  station({ id: 'earth-low-orbit-alt-sun', bodyId: 'earth', latitudeDegrees: 28.5, longitudeDegrees: -80.6, altitudeMeters: 250_000, fovDegrees: 62, sunDirection: [-0.48, 0.79, 0.38], timeSeconds: 0, presentation: 'orbit', note: 'Same low-orbit geography under the second locked sun direction.' }),
  station({ id: 'earth-100km', bodyId: 'earth', latitudeDegrees: 28.5, longitudeDegrees: -80.6, altitudeMeters: 100_000, fovDegrees: 62, sunDirection: [0.55, -0.72, 0.42], timeSeconds: 0, presentation: 'orbit', note: 'Atmosphere-top crossing.' }),
  station({ id: 'earth-20km', bodyId: 'earth', latitudeDegrees: 28.5, longitudeDegrees: -80.6, altitudeMeters: 20_000, fovDegrees: 62, pitchDegrees: 14, sunDirection: [0.55, -0.72, 0.42], timeSeconds: 0, presentation: 'surface', note: 'Cloud-layer and aerial-perspective continuity.' }),
  station({ id: 'earth-10km', bodyId: 'earth', latitudeDegrees: 28.5, longitudeDegrees: -80.6, altitudeMeters: 10_000, fovDegrees: 62, pitchDegrees: 16, sunDirection: [0.55, -0.72, 0.42], timeSeconds: 0, presentation: 'surface', note: 'Source macro relief and transition coverage.' }),
  station({ id: 'earth-ksc-1km', bodyId: 'earth', latitudeDegrees: 28.6272, longitudeDegrees: -80.6209, altitudeMeters: 1_000, fovDegrees: 68, pitchDegrees: 20, sunDirection: [0.62, -0.58, 0.53], timeSeconds: 0, presentation: 'surface', note: 'Locked NAIP coverage, categorical shoreline, and cube-page reprojection.' }),
  station({ id: 'earth-ksc-ground', bodyId: 'earth', latitudeDegrees: 28.6272, longitudeDegrees: -80.6209, altitudeMeters: 12, fovDegrees: 72, pitchDegrees: 28, sunDirection: [0.62, -0.58, 0.53], timeSeconds: 0, presentation: 'surface', note: 'KSC contact authority, surface class, and bounded source-detail fallback.' }),
  station({ id: 'earth-ksc-coast-transect', bodyId: 'earth', latitudeDegrees: 28.6272, longitudeDegrees: -80.60, altitudeMeters: 25_000, fovDegrees: 52, sunDirection: [0.62, -0.58, 0.53], timeSeconds: 0, presentation: 'orbit', note: 'KSC west-to-east class and albedo boundary across inland, lagoon, barrier island, and Atlantic.' }),
  station({ id: 'earth-1km', bodyId: 'earth', latitudeDegrees: 35, longitudeDegrees: -105, altitudeMeters: 1_000, fovDegrees: 68, pitchDegrees: 20, sunDirection: [0.62, -0.58, 0.53], timeSeconds: 0, presentation: 'surface', note: 'Inland sourced local material response.' }),
  station({ id: 'earth-ground', bodyId: 'earth', latitudeDegrees: 35, longitudeDegrees: -105, altitudeMeters: 12, fovDegrees: 72, pitchDegrees: 28, sunDirection: [0.62, -0.58, 0.53], timeSeconds: 0, presentation: 'surface', note: 'Meter-scale shading and contact agreement.' }),
  station({ id: 'earth-ocean-horizon', bodyId: 'earth', latitudeDegrees: 18, longitudeDegrees: -155, altitudeMeters: 25, fovDegrees: 68, pitchDegrees: 10, sunDirection: [0.25, 0.85, 0.46], timeSeconds: 0, presentation: 'surface', note: 'Fresnel ocean, wave filtering, and horizon continuity.' }),
  station({ id: 'moon-from-earth', bodyId: 'moon', latitudeDegrees: 0, longitudeDegrees: 0, altitudeMeters: 382_662_000, fovDegrees: 5, sunDirection: [0.7, -0.62, 0.35], timeSeconds: 0, presentation: 'full-disk', note: 'Correct Earth-view angular size and phase.' }),
  station({ id: 'moon-near-full', bodyId: 'moon', latitudeDegrees: 0, longitudeDegrees: 0, altitudeMeters: 6_000_000, fovDegrees: 34, sunDirection: [0.88, -0.18, 0.44], timeSeconds: 0, presentation: 'full-disk', note: 'Near-side maria landmark station.' }),
  station({ id: 'moon-far-full', bodyId: 'moon', latitudeDegrees: 0, longitudeDegrees: 180, altitudeMeters: 6_000_000, fovDegrees: 34, sunDirection: [-0.82, 0.25, 0.51], timeSeconds: 0, presentation: 'full-disk', note: 'Far-side highlands and basin station.' }),
  station({ id: 'moon-polar', bodyId: 'moon', latitudeDegrees: -82, longitudeDegrees: 45, altitudeMeters: 2_500_000, fovDegrees: 38, sunDirection: [0.1, 0.96, 0.08], timeSeconds: 0, presentation: 'full-disk', note: 'Grazing-angle polar relief.' }),
  station({ id: 'moon-low-orbit', bodyId: 'moon', latitudeDegrees: -20, longitudeDegrees: 25, altitudeMeters: 100_000, fovDegrees: 62, sunDirection: [-0.25, 0.966, -0.068], timeSeconds: 0, presentation: 'orbit', note: 'LOLA silhouette and compact/terrain handoff.' }),
  station({ id: 'moon-surface', bodyId: 'moon', latitudeDegrees: -20, longitudeDegrees: 25, altitudeMeters: 15, fovDegrees: 72, pitchDegrees: 18, sunDirection: [-0.25, 0.966, -0.068], timeSeconds: 0, presentation: 'surface', note: 'Dark regolith, grazing relief, and near-black fill.' }),
]);

export function solVisualReferenceStation(id: string): SolVisualReferenceStation {
  const result = SOL_VISUAL_REFERENCE_STATIONS.find((candidate) => candidate.id === id);
  if (!result) throw new Error(`Unknown Sol visual reference station: ${id}`);
  return result;
}
