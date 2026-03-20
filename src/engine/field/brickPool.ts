import type { ActiveBrick, FieldClusterSpec, Vec3 } from "../types";
import { vec3 } from "../math/vec3";
import { sampleField } from "./fieldMath";

function bucketCoord(position: Vec3, brickSize: number): Vec3 {
  return [
    Math.round(position[0] / brickSize),
    Math.round(position[1] / brickSize),
    Math.round(position[2] / brickSize)
  ];
}

export function buildActiveBricks(
  clusters: FieldClusterSpec[],
  time: number,
  brickBudget: number,
  brickResolution: number,
  surfaceThreshold: number
): ActiveBrick[] {
  const brickSize = 2 / brickResolution;
  const bucketMap = new Map<string, ActiveBrick>();

  for (const cluster of clusters) {
    const extent = Math.max(1.3, cluster.structural.formRank + cluster.visual.surfaceThickness * 2.5);
    for (let x = -extent; x <= extent; x += brickSize) {
      for (let y = -extent; y <= extent; y += brickSize) {
        for (let z = -extent; z <= extent; z += brickSize) {
          const position = vec3.add(cluster.center, [x, y, z]);
          const sample = sampleField(clusters, position, time, surfaceThreshold);
          const interest = sample.rho + Math.abs(sample.shellDistance) * 0.08 + sample.coherence * 0.3;
          if (interest < surfaceThreshold * 0.35) {
            continue;
          }
          const coord = bucketCoord(position, brickSize);
          const key = coord.join(":");
          const existing = bucketMap.get(key);
          if (existing) {
            existing.energy = Math.max(existing.energy, interest);
            if (!existing.clusterIds.includes(cluster.id)) {
              existing.clusterIds.push(cluster.id);
            }
            continue;
          }
          bucketMap.set(key, {
            coord,
            energy: interest,
            clusterIds: [cluster.id]
          });
        }
      }
    }
  }

  return [...bucketMap.values()]
    .sort((a, b) => b.energy - a.energy)
    .slice(0, brickBudget);
}
