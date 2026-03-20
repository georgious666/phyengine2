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

function writePackedPoint(data: Float32Array, slot: number, point: PhotonPoint): void {
  const base = slot * FLOATS_PER_POINT;
  data[base + 0] = point.position[0];
  data[base + 1] = point.position[1];
  data[base + 2] = point.position[2];
  data[base + 3] = point.sdfRadius;
  data[base + 4] = point.normal[0];
  data[base + 5] = point.normal[1];
  data[base + 6] = point.normal[2];
  data[base + 7] = pointStateIndex(point.state);
  data[base + 8] = point.velocity[0];
  data[base + 9] = point.velocity[1];
  data[base + 10] = point.velocity[2];
  data[base + 11] = point.density;
  data[base + 12] = point.phase;
  data[base + 13] = point.brightness;
  data[base + 14] = point.coherence;
  data[base + 15] = point.id;
}

export function packPhotonPointSlots(
  points: PhotonPoint[],
  slotByPointId: ReadonlyMap<number, number>,
  pointCapacity: number
): Float32Array {
  const data = new Float32Array(pointCapacity * FLOATS_PER_POINT);
  for (const point of points) {
    const slot = slotByPointId.get(point.id);
    if (slot === undefined || slot < 0 || slot >= pointCapacity) {
      continue;
    }
    writePackedPoint(data, slot, point);
  }
  return data;
}
