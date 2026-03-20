import type { PhotonPoint } from "./types";

export const FLOATS_PER_POINT = 16;

function pointStateIndex(state: PhotonPoint["state"]): number {
  switch (state) {
    case "birthing":
      return 1;
    case "dying":
      return 2;
    case "nodal":
      return 3;
    case "drifting":
      return 4;
    default:
      return 0;
  }
}

export function packPhotonPoints(points: PhotonPoint[], pointCapacity: number): Float32Array {
  const data = new Float32Array(pointCapacity * FLOATS_PER_POINT);
  points.slice(0, pointCapacity).forEach((point, index) => {
    const base = index * FLOATS_PER_POINT;
    data.set(
      [
        point.position[0],
        point.position[1],
        point.position[2],
        point.sdfRadius,
        point.normal[0],
        point.normal[1],
        point.normal[2],
        pointStateIndex(point.state),
        point.velocity[0],
        point.velocity[1],
        point.velocity[2],
        point.density,
        point.phase,
        point.brightness,
        point.coherence,
        point.age
      ],
      base
    );
  });
  return data;
}
