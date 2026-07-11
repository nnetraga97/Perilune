/**
 * Double-precision 3-vector math.
 *
 * JS numbers are IEEE-754 doubles, so plain numeric fields give us the
 * f64 precision the simulation needs. All operations write into an `out`
 * parameter (or mutate `this`) so hot loops allocate nothing.
 */

export class Vec3 {
  x: number;
  y: number;
  z: number;

  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  copy(v: Readonly<Vec3>): this {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z);
  }

  add(v: Readonly<Vec3>): this {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }

  sub(v: Readonly<Vec3>): this {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }

  scale(s: number): this {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }

  addScaled(v: Readonly<Vec3>, s: number): this {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }

  dot(v: Readonly<Vec3>): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  cross(v: Readonly<Vec3>): this {
    const { x, y, z } = this;
    this.x = y * v.z - z * v.y;
    this.y = z * v.x - x * v.z;
    this.z = x * v.y - y * v.x;
    return this;
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  length(): number {
    return Math.sqrt(this.lengthSq());
  }

  distanceTo(v: Readonly<Vec3>): number {
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    const dz = this.z - v.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  normalize(): this {
    const len = this.length();
    if (len > 0) this.scale(1 / len);
    return this;
  }

  negate(): this {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }

  isFinite(): boolean {
    return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z);
  }

  static add(a: Readonly<Vec3>, b: Readonly<Vec3>, out: Vec3): Vec3 {
    return out.set(a.x + b.x, a.y + b.y, a.z + b.z);
  }

  static sub(a: Readonly<Vec3>, b: Readonly<Vec3>, out: Vec3): Vec3 {
    return out.set(a.x - b.x, a.y - b.y, a.z - b.z);
  }

  static scale(a: Readonly<Vec3>, s: number, out: Vec3): Vec3 {
    return out.set(a.x * s, a.y * s, a.z * s);
  }

  static cross(a: Readonly<Vec3>, b: Readonly<Vec3>, out: Vec3): Vec3 {
    return out.set(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  }

  static dot(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  }

  static lerp(a: Readonly<Vec3>, b: Readonly<Vec3>, t: number, out: Vec3): Vec3 {
    return out.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
  }
}

/** Serializable plain form used in saves. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}
