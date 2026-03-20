import type { Vec3 } from "../types";

export const vec3 = {
  create(x = 0, y = 0, z = 0): Vec3 {
    return [x, y, z];
  },
  clone(v: Vec3): Vec3 {
    return [v[0], v[1], v[2]];
  },
  add(a: Vec3, b: Vec3): Vec3 {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  },
  sub(a: Vec3, b: Vec3): Vec3 {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  },
  scale(v: Vec3, s: number): Vec3 {
    return [v[0] * s, v[1] * s, v[2] * s];
  },
  dot(a: Vec3, b: Vec3): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  },
  cross(a: Vec3, b: Vec3): Vec3 {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  },
  length(v: Vec3): number {
    return Math.hypot(v[0], v[1], v[2]);
  },
  distance(a: Vec3, b: Vec3): number {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  },
  normalize(v: Vec3): Vec3 {
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
  },
  lerp(a: Vec3, b: Vec3, t: number): Vec3 {
    return [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t
    ];
  },
  clampLength(v: Vec3, maxLength: number): Vec3 {
    const len = vec3.length(v);
    if (len <= maxLength || len === 0) {
      return vec3.clone(v);
    }
    return vec3.scale(v, maxLength / len);
  }
};
