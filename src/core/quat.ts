import { Vec3 } from './vec3';

/** Double-precision quaternion for vessel attitude. */
export class Quat {
  x: number;
  y: number;
  z: number;
  w: number;

  constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }

  set(x: number, y: number, z: number, w: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }

  copy(q: Readonly<Quat>): this {
    return this.set(q.x, q.y, q.z, q.w);
  }

  clone(): Quat {
    return new Quat(this.x, this.y, this.z, this.w);
  }

  identity(): this {
    return this.set(0, 0, 0, 1);
  }

  setFromAxisAngle(axis: Readonly<Vec3>, angle: number): this {
    const half = angle / 2;
    const s = Math.sin(half);
    return this.set(axis.x * s, axis.y * s, axis.z * s, Math.cos(half));
  }

  /** this = this * q (apply q first, then this). */
  multiply(q: Readonly<Quat>): this {
    const { x: ax, y: ay, z: az, w: aw } = this;
    const { x: bx, y: by, z: bz, w: bw } = q;
    this.x = aw * bx + ax * bw + ay * bz - az * by;
    this.y = aw * by - ax * bz + ay * bw + az * bx;
    this.z = aw * bz + ax * by - ay * bx + az * bw;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }

  premultiply(q: Readonly<Quat>): this {
    const { x: bx, y: by, z: bz, w: bw } = this;
    const { x: ax, y: ay, z: az, w: aw } = q;
    this.x = aw * bx + ax * bw + ay * bz - az * by;
    this.y = aw * by - ax * bz + ay * bw + az * bx;
    this.z = aw * bz + ax * by - ay * bx + az * bw;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }

  conjugate(): this {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }

  normalize(): this {
    const len = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w);
    if (len > 0) {
      const inv = 1 / len;
      this.x *= inv;
      this.y *= inv;
      this.z *= inv;
      this.w *= inv;
    }
    return this;
  }

  /** Rotate vector v by this quaternion, writing into out (may alias v). */
  rotate(v: Readonly<Vec3>, out: Vec3): Vec3 {
    const { x: qx, y: qy, z: qz, w: qw } = this;
    const { x: vx, y: vy, z: vz } = v;
    // t = 2 * cross(q.xyz, v)
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    // out = v + w*t + cross(q.xyz, t)
    return out.set(
      vx + qw * tx + (qy * tz - qz * ty),
      vy + qw * ty + (qz * tx - qx * tz),
      vz + qw * tz + (qx * ty - qy * tx),
    );
  }

  /** Integrate angular velocity (rad/s, body frame) over dt. */
  integrate(omega: Readonly<Vec3>, dt: number): this {
    const hx = omega.x * dt / 2;
    const hy = omega.y * dt / 2;
    const hz = omega.z * dt / 2;
    const mag = Math.sqrt(hx * hx + hy * hy + hz * hz);
    if (mag < 1e-12) return this;
    const s = Math.sin(mag) / mag;
    const dq = _tmp.set(hx * s, hy * s, hz * s, Math.cos(mag));
    return this.multiply(dq).normalize();
  }

  slerp(q: Readonly<Quat>, t: number): this {
    let cosHalf = this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w;
    let bx = q.x, by = q.y, bz = q.z, bw = q.w;
    if (cosHalf < 0) {
      cosHalf = -cosHalf;
      bx = -bx; by = -by; bz = -bz; bw = -bw;
    }
    if (cosHalf > 0.9995) {
      this.x += (bx - this.x) * t;
      this.y += (by - this.y) * t;
      this.z += (bz - this.z) * t;
      this.w += (bw - this.w) * t;
      return this.normalize();
    }
    const halfAngle = Math.acos(cosHalf);
    const sinHalf = Math.sqrt(1 - cosHalf * cosHalf);
    const ra = Math.sin((1 - t) * halfAngle) / sinHalf;
    const rb = Math.sin(t * halfAngle) / sinHalf;
    return this.set(
      this.x * ra + bx * rb,
      this.y * ra + by * rb,
      this.z * ra + bz * rb,
      this.w * ra + bw * rb,
    );
  }

  /** Orient so that local +Z points along `forward` and +Y roughly along `up`. */
  setLookRotation(forward: Readonly<Vec3>, up: Readonly<Vec3>): this {
    const f = _f.copy(forward).normalize();
    const r = Vec3.cross(up, f, _r);
    if (r.lengthSq() < 1e-12) {
      // forward parallel to up; pick any perpendicular
      r.set(1, 0, 0);
      if (Math.abs(f.x) > 0.9) r.set(0, 1, 0);
      Vec3.cross(r, f, r);
    }
    r.normalize();
    const u = Vec3.cross(f, r, _u);
    // Rotation matrix columns: r, u, f → quaternion
    const m00 = r.x, m01 = u.x, m02 = f.x;
    const m10 = r.y, m11 = u.y, m12 = f.y;
    const m20 = r.z, m21 = u.z, m22 = f.z;
    const trace = m00 + m11 + m22;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1);
      this.set((m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s);
    } else if (m00 > m11 && m00 > m22) {
      const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
      this.set(0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s);
    } else if (m11 > m22) {
      const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
      this.set((m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s);
    } else {
      const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
      this.set((m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s);
    }
    return this.normalize();
  }
}

const _tmp = new Quat();
const _f = new Vec3();
const _r = new Vec3();
const _u = new Vec3();

export interface QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;
}
