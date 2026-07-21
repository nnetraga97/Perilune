import { Vec3 } from '../core/vec3';
import {
  apoapsisOf,
  periapsisOf,
  periodOf,
  stateToElements,
  timeToTrueAnomaly,
} from '../core/orbit';
import type { GameState } from '../sim/state';
import { inertialToBodyFixed, surfaceVelocity } from '../sim/bodyOrientation';
import { contactSurface, surfaceSlopeDegrees } from '../sim/terrain';
import { G0, analyzeCraft } from '../sim/vessel';
import { el } from './kit';
import type { WindowManager } from './window';

function distance(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)} Mm`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(abs >= 1e4 ? 1 : 2)} km`;
  return `${value.toFixed(0)} m`;
}

function duration(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const seconds = Math.max(0, value);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return hours > 0 ? `${hours}h ${minutes}m` : minutes > 0 ? `${minutes}m ${secs}s` : `${secs}s`;
}

class InstrumentTable {
  private readonly values = new Map<string, HTMLElement>();

  constructor(parent: HTMLElement, labels: readonly string[]) {
    const grid = el('div', 'k-instrument-grid', parent);
    for (const label of labels) {
      el('span', 'k-instrument-key', grid, label);
      this.values.set(label, el('span', 'k-instrument-value', grid, '—'));
    }
  }

  set(label: string, value: string): void {
    const node = this.values.get(label);
    if (node) node.textContent = value;
  }

  clear(): void {
    for (const value of this.values.values()) value.textContent = '—';
  }
}

/** Optional KER-style readout windows backed directly by authoritative state. */
export class FlightInstruments {
  private orbital: InstrumentTable | null = null;
  private surface: InstrumentTable | null = null;
  private vessel: InstrumentTable | null = null;

  constructor(windows: WindowManager, private readonly game: () => GameState) {
    windows.register({
      id: 'flight-orbital',
      title: 'ORBITAL',
      launcherIcon: 'orbit',
      buttonLabel: 'Orbit',
      screen: 'flight',
      defaultPos: { x: 18, y: 120 },
      build: (content) => {
        this.orbital = new InstrumentTable(content, [
          'Apoapsis', 'Periapsis', 'Period', 'Inclination', 'Eccentricity', 'AN ETA', 'DN ETA',
        ]);
      },
      update: () => this.updateOrbital(),
    });
    windows.register({
      id: 'flight-surface',
      title: 'SURFACE',
      launcherIcon: 'surface',
      buttonLabel: 'Surface',
      screen: 'flight',
      defaultPos: { x: 18, y: 330 },
      build: (content) => {
        this.surface = new InstrumentTable(content, [
          'Altitude ASL', 'Altitude AGL', 'Slope', 'Horizontal', 'Vertical', 'Latitude', 'Longitude',
        ]);
      },
      update: () => this.updateSurface(),
    });
    windows.register({
      id: 'flight-vessel',
      title: 'VESSEL',
      launcherIcon: 'vessel',
      buttonLabel: 'Vessel',
      screen: 'flight',
      defaultPos: { x: window.innerWidth - 260, y: 350 },
      build: (content) => {
        this.vessel = new InstrumentTable(content, [
          'Stage Δv', 'Stage TWR', 'Stage burn', 'Total Δv', 'Mass', 'Parts', 'G-force', 'Dynamic Q',
        ]);
      },
      update: () => this.updateVessel(),
    });
  }

  private updateOrbital(): void {
    if (!this.orbital) return;
    const game = this.game();
    const gv = game.active;
    if (!gv) return this.orbital.clear();
    const body = game.bodyOf(gv);
    const elements = stateToElements(body.mu, gv.runtime.pos, gv.runtime.vel, game.time);
    this.orbital.set('Apoapsis', elements.e < 1 ? distance(apoapsisOf(elements) - body.radius) : 'ESCAPE');
    this.orbital.set('Periapsis', distance(periapsisOf(elements) - body.radius));
    this.orbital.set('Period', duration(periodOf(elements)));
    this.orbital.set('Inclination', `${(elements.i * 180 / Math.PI).toFixed(2)}°`);
    this.orbital.set('Eccentricity', elements.e.toFixed(5));
    this.orbital.set('AN ETA', duration(timeToTrueAnomaly(elements, game.time, -elements.argPe)));
    this.orbital.set('DN ETA', duration(timeToTrueAnomaly(elements, game.time, Math.PI - elements.argPe)));
  }

  private updateSurface(): void {
    if (!this.surface) return;
    const game = this.game();
    const gv = game.active;
    if (!gv) return this.surface.clear();
    const v = gv.runtime;
    const body = game.bodyOf(gv);
    const altitude = v.pos.length() - body.radius;
    const directionBF = inertialToBodyFixed(body, game.time, v.pos, new Vec3()).normalize();
    const contact = contactSurface(body, directionBF);
    const groundHeight = contact.kind === 'none' ? 0 : contact.height;
    const groundVelocity = surfaceVelocity(body, v.pos, new Vec3());
    const relativeVelocity = v.vel.clone().sub(groundVelocity);
    const vertical = relativeVelocity.dot(v.pos.clone().normalize());
    const horizontal = Math.sqrt(Math.max(0, relativeVelocity.lengthSq() - vertical * vertical));
    const latitude = Math.asin(Math.max(-1, Math.min(1, directionBF.z))) * 180 / Math.PI;
    const longitude = Math.atan2(directionBF.y, directionBF.x) * 180 / Math.PI;
    this.surface.set('Altitude ASL', distance(altitude));
    this.surface.set('Altitude AGL', distance(altitude - groundHeight));
    this.surface.set('Slope', contact.kind === 'none' ? '—' : `${surfaceSlopeDegrees(body, directionBF).toFixed(1)}°`);
    this.surface.set('Horizontal', `${horizontal.toFixed(1)} m/s`);
    this.surface.set('Vertical', `${vertical >= 0 ? '+' : ''}${vertical.toFixed(1)} m/s`);
    this.surface.set('Latitude', `${Math.abs(latitude).toFixed(3)}° ${latitude >= 0 ? 'N' : 'S'}`);
    this.surface.set('Longitude', `${Math.abs(longitude).toFixed(3)}° ${longitude >= 0 ? 'E' : 'W'}`);
  }

  private updateVessel(): void {
    if (!this.vessel) return;
    const game = this.game();
    const gv = game.active;
    if (!gv) return this.vessel.clear();
    const v = gv.runtime;
    const body = game.bodyOf(gv);
    const altitude = v.pos.length() - body.radius;
    const analysis = analyzeCraft(v.craft, body.surfaceGravity, body.pressureAt(altitude), game.flightTuning, body.def.atmosphere?.seaLevelPressure);
    const stage = analysis.stages[v.currentStage];
    const remainingDeltaV = analysis.stages
      .filter((candidate) => candidate.stageIndex >= v.currentStage)
      .reduce((sum, candidate) => sum + candidate.deltaV, 0);
    this.vessel.set('Stage Δv', stage ? `${stage.deltaV.toFixed(0)} m/s` : '—');
    this.vessel.set('Stage TWR', stage ? stage.twrStart.toFixed(2) : '—');
    this.vessel.set('Stage burn', stage ? duration(stage.burnTime) : '—');
    this.vessel.set('Total Δv', `${remainingDeltaV.toFixed(0)} m/s`);
    this.vessel.set('Mass', `${(v.massProps.mass / 1000).toFixed(2)} t`);
    this.vessel.set('Parts', String(v.craft.parts.length));
    this.vessel.set('G-force', `${(v.properAccel / G0).toFixed(2)} g`);
    this.vessel.set('Dynamic Q', `${(v.aero.dynamicPressure / 1000).toFixed(1)} kPa`);
  }
}
