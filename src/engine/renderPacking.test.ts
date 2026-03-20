import { describe, expect, it } from "vitest";
import { FLOATS_PER_POINT, packPhotonPointSlots } from "./renderPacking";
import type { PhotonPoint } from "./types";

function createPoint(id: number, x: number): PhotonPoint {
  return {
    id,
    position: [x, x + 1, x + 2],
    velocity: [0.1, 0.2, 0.3],
    normal: [0, 1, 0],
    density: 0.5,
    phase: 0.25,
    coherence: 0.8,
    sdfRadius: 0.4,
    brightness: 0.9,
    age: 1.2,
    lifetime: 10,
    state: "active",
    clusterAffinity: "cluster-a",
    surfaceLock: 1
  };
}

describe("packPhotonPointSlots", () => {
  it("packs points into stable slots and leaves inactive slots empty", () => {
    const points = [createPoint(11, 1), createPoint(29, 4)];
    const slotByPointId = new Map<number, number>([
      [11, 1],
      [29, 3]
    ]);

    const packed = packPhotonPointSlots(points, slotByPointId, 5);

    expect(packed[15]).toBe(0);
    expect(packed[FLOATS_PER_POINT + 0]).toBe(1);
    expect(packed[FLOATS_PER_POINT + 1]).toBe(2);
    expect(packed[FLOATS_PER_POINT + 15]).toBe(11);
    expect(packed[FLOATS_PER_POINT * 2 + 15]).toBe(0);
    expect(packed[FLOATS_PER_POINT * 3 + 0]).toBe(4);
    expect(packed[FLOATS_PER_POINT * 3 + 15]).toBe(29);
  });
});
