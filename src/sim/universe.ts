/**
 * Celestial body registry and hierarchical position evaluation.
 *
 * Positions are evaluated analytically from orbital elements at any absolute
 * simulation time (no per-frame integration), which keeps the whole system
 * exact and time-warp safe. Vessel positions are stored relative to their
 * SOI parent body, never as absolute world floats.
 */
import { Vec3 } from '../core/vec3';
import {
  OrbitalElements,
  elementsAtTime,
  periodOf,
} from '../core/orbit';

export interface AtmosphereDef {
  /** Sea-level static pressure (Pa). */
  seaLevelPressure: number;
  /** Scale height (m) for exponential pressure falloff. */
  scaleHeight: number;
  /** Altitude (m) above which the atmosphere is treated as vacuum. */
  height: number;
  /** Sea-level density (kg/m^3). */
  seaLevelDensity: number;
  /** Sea-level temperature (K), lapse handled simply. */
  seaLevelTemperature: number;
  /** Whether the atmosphere contains oxygen (for jet engines). */
  hasOxygen: boolean;
}

export interface TerrainDef {
  seed: number;
  /** Max mountain amplitude (m). */
  amplitude: number;
  /** Base noise frequency (cycles per radian, roughly). */
  frequency: number;
  octaves: number;
  /** Fraction of surface below "sea level" that renders as ocean (0 = none). */
  oceanLevel: number;
  /** Palette: low, mid, high altitude colors + ocean. */
  colorLow: string;
  colorMid: string;
  colorHigh: string;
  colorOcean?: string;
}

export type SurfaceKind = 'solid' | 'gas' | 'star';

export interface ScienceBiomeDef {
  id: string;
  name: string;
  scienceMultiplier: number;
}

export interface ScienceBiomeThresholds {
  /** Normalized absolute body-fixed latitude component in [0, 1]. */
  iceLatitudeMin?: number;
  /** Meters above terrain datum. */
  highlandAltitudeMin?: number;
  /** Local surface slope in degrees. */
  mountainSlopeMinDeg?: number;
}

export interface BodyDef {
  id: string;
  name: string;
  description: string;
  /** Gravitational parameter (m^3/s^2). */
  mu: number;
  /** Mean radius (m). */
  radius: number;
  /** Sidereal rotation period (s); 0 = tidally locked handled via period of orbit. */
  rotationPeriod: number;
  /** Axial tilt (rad). */
  axialTilt: number;
  /** Physical surface model; never inferred from terrain amplitude. */
  surfaceKind: SurfaceKind;
  /** Immutable terrain-recipe schema version assigned by content. */
  terrainRecipeVersion: number;
  /** Gas-body terminal pressure; absent on solid/star bodies. */
  terminalPressurePa?: number;
  /** Gas-body terminal depth below reference radius. */
  terminalDepthMeters?: number;
  atmosphere?: AtmosphereDef;
  terrain: TerrainDef;
  /** Orbit around parent (absent for the root star). */
  orbit?: Omit<OrbitalElements, 'mu' | 'epoch'>;
  parent?: string;
  isStar?: boolean;
  /** Display/base color for map view and distant rendering. */
  color: string;
  /** Science multiplier for experiments here. */
  scienceValue: number;
  /** Optional authored science biomes; unauthored bodies use a synthetic global biome. */
  biomes?: ScienceBiomeDef[];
  scienceBiomeThresholds?: ScienceBiomeThresholds;
}

export class Body {
  readonly def: BodyDef;
  readonly parent: Body | null;
  readonly children: Body[] = [];
  readonly orbit: OrbitalElements | null;
  readonly soiRadius: number;
  /** Orbital period around parent (s), Infinity for root. */
  readonly orbitalPeriod: number;

  constructor(def: BodyDef, parent: Body | null) {
    this.def = def;
    this.parent = parent;
    if (def.orbit && parent) {
      this.orbit = { ...def.orbit, mu: parent.def.mu, epoch: 0 };
      this.orbitalPeriod = periodOf(this.orbit);
      // Sphere of influence: a * (m/M)^(2/5)
      this.soiRadius = this.orbit.a * Math.pow(def.mu / parent.def.mu, 2 / 5);
    } else {
      this.orbit = null;
      this.orbitalPeriod = Infinity;
      this.soiRadius = Infinity;
    }
  }

  get id(): string {
    return this.def.id;
  }

  get name(): string {
    return this.def.name;
  }

  get mu(): number {
    return this.def.mu;
  }

  get radius(): number {
    return this.def.radius;
  }

  /** Rotation angle at time t (rad). */
  rotationAngle(t: number): number {
    const period = this.def.rotationPeriod;
    if (period === 0) return 0;
    return ((t / period) % 1) * Math.PI * 2;
  }

  /** Surface gravity (m/s^2). */
  get surfaceGravity(): number {
    return this.def.mu / (this.def.radius * this.def.radius);
  }

  hasAtmosphere(): boolean {
    return !!this.def.atmosphere;
  }

  /** Atmospheric pressure (Pa) at altitude above sea level. */
  pressureAt(altitude: number): number {
    const atm = this.def.atmosphere;
    if (!atm || altitude >= atm.height) return 0;
    const modelAltitude = this.def.surfaceKind === 'gas' ? altitude : Math.max(0, altitude);
    return atm.seaLevelPressure * Math.exp(-modelAltitude / atm.scaleHeight);
  }

  /** Atmospheric density (kg/m^3) at altitude. */
  densityAt(altitude: number): number {
    const atm = this.def.atmosphere;
    if (!atm || altitude >= atm.height) return 0;
    const modelAltitude = this.def.surfaceKind === 'gas' ? altitude : Math.max(0, altitude);
    return atm.seaLevelDensity * Math.exp(-modelAltitude / atm.scaleHeight);
  }

  /** Speed of sound (m/s) at altitude — simple model. */
  speedOfSoundAt(altitude: number): number {
    const atm = this.def.atmosphere;
    if (!atm) return 0;
    const frac = Math.max(0.35, 1 - altitude / (atm.height * 1.4));
    return Math.sqrt(1.4 * 287 * atm.seaLevelTemperature * frac);
  }
}

const _pr = new Vec3();
const _pv = new Vec3();

export class Universe {
  readonly bodies = new Map<string, Body>();
  readonly root: Body;
  readonly homeBodyId: string;

  constructor(defs: BodyDef[], homeBodyId = 'veyra') {
    const rootDef = defs.find((d) => !d.parent);
    if (!rootDef) throw new Error('Universe needs a root body');
    this.root = new Body(rootDef, null);
    this.bodies.set(rootDef.id, this.root);
    // Insert children breadth-first so parents exist before children.
    let added = true;
    const remaining = defs.filter((d) => d.parent);
    while (added) {
      added = false;
      for (let i = remaining.length - 1; i >= 0; i--) {
        const def = remaining[i];
        const parent = this.bodies.get(def.parent!);
        if (parent) {
          const body = new Body(def, parent);
          parent.children.push(body);
          this.bodies.set(def.id, body);
          remaining.splice(i, 1);
          added = true;
        }
      }
    }
    if (remaining.length) {
      throw new Error(`Orphan bodies: ${remaining.map((d) => d.id).join(', ')}`);
    }
    if (!this.bodies.has(homeBodyId)) throw new Error(`Unknown home body: ${homeBodyId}`);
    this.homeBodyId = homeBodyId;
  }

  get(id: string): Body {
    const b = this.bodies.get(id);
    if (!b) throw new Error(`Unknown body: ${id}`);
    return b;
  }

  /** Position of body relative to its parent at time t. */
  localPosition(body: Body, t: number, outR: Vec3, outV?: Vec3): void {
    if (!body.orbit) {
      outR.set(0, 0, 0);
      outV?.set(0, 0, 0);
      return;
    }
    elementsAtTime(body.orbit, t, outR, outV ?? _pv);
  }

  /** Absolute (root-frame) position of a body at time t. Only for map-scale math. */
  absolutePosition(body: Body, t: number, outR: Vec3, outV?: Vec3): void {
    outR.set(0, 0, 0);
    outV?.set(0, 0, 0);
    let b: Body | null = body;
    while (b && b.orbit) {
      elementsAtTime(b.orbit, t, _pr, _pv);
      outR.add(_pr);
      outV?.add(_pv);
      b = b.parent;
    }
  }

  /**
   * Position of body `a` relative to body `b` at time t.
   * Walks the tree so precision stays high for nearby bodies.
   */
  relativePosition(a: Body, b: Body, t: number, outR: Vec3, outV?: Vec3): void {
    // Simple and robust: absolute difference. Bodies near each other share
    // most ancestors so the differences of large terms cancel in f64
    // comfortably within our system scale (~1e11 m => 1e-5 m ulp).
    this.absolutePosition(a, t, outR, outV);
    this.absolutePosition(b, t, _pr, _pv);
    outR.sub(_pr);
    outV?.sub(_pv);
  }
}
