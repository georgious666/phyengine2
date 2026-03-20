import type { Complex } from "../types";

export const complex = {
  fromPolar(radius: number, phase: number): Complex {
    return [radius * Math.cos(phase), radius * Math.sin(phase)];
  },
  add(a: Complex, b: Complex): Complex {
    return [a[0] + b[0], a[1] + b[1]];
  },
  sub(a: Complex, b: Complex): Complex {
    return [a[0] - b[0], a[1] - b[1]];
  },
  mul(a: Complex, b: Complex): Complex {
    return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
  },
  conj(a: Complex): Complex {
    return [a[0], -a[1]];
  },
  abs2(a: Complex): number {
    return a[0] * a[0] + a[1] * a[1];
  },
  phase(a: Complex): number {
    return Math.atan2(a[1], a[0]);
  }
};
