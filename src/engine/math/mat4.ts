import type { Vec3 } from "../types";
import { vec3 } from "./vec3";

export type Mat4 = Float32Array;

export function createMat4(): Mat4 {
  return new Float32Array(16);
}

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const out = createMat4();
  const f = 1 / Math.tan(fovY / 2);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = far / (near - far);
  out[11] = -1;
  out[14] = (far * near) / (near - far);
  return out;
}

export function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const zAxis = vec3.normalize(vec3.sub(eye, target));
  const xAxis = vec3.normalize(vec3.cross(up, zAxis));
  const yAxis = vec3.cross(zAxis, xAxis);
  const out = createMat4();

  out[0] = xAxis[0];
  out[1] = yAxis[0];
  out[2] = zAxis[0];
  out[3] = 0;

  out[4] = xAxis[1];
  out[5] = yAxis[1];
  out[6] = zAxis[1];
  out[7] = 0;

  out[8] = xAxis[2];
  out[9] = yAxis[2];
  out[10] = zAxis[2];
  out[11] = 0;

  out[12] = -vec3.dot(xAxis, eye);
  out[13] = -vec3.dot(yAxis, eye);
  out[14] = -vec3.dot(zAxis, eye);
  out[15] = 1;

  return out;
}

export function multiplyMat4(a: Mat4, b: Mat4): Mat4 {
  const out = createMat4();
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      out[row * 4 + col] =
        a[row * 4 + 0] * b[0 * 4 + col] +
        a[row * 4 + 1] * b[1 * 4 + col] +
        a[row * 4 + 2] * b[2 * 4 + col] +
        a[row * 4 + 3] * b[3 * 4 + col];
    }
  }
  return out;
}

export function orbitCamera(target: Vec3, yaw: number, pitch: number, radius: number): Vec3 {
  const clampedPitch = Math.max(-1.45, Math.min(1.45, pitch));
  return [
    target[0] + radius * Math.cos(clampedPitch) * Math.sin(yaw),
    target[1] + radius * Math.sin(clampedPitch),
    target[2] + radius * Math.cos(clampedPitch) * Math.cos(yaw)
  ];
}
