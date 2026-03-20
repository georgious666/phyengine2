import type { ActiveBrick, FieldClusterSpec, PhotonPoint, Vec3 } from "../types";

function bucketCoord(position: Vec3, brickSize: number): Vec3 {
  return [
    Math.round(position[0] / brickSize),
    Math.round(position[1] / brickSize),
    Math.round(position[2] / brickSize)
  ];
}

export function buildActiveBricks(
  points: PhotonPoint[],
  clusters: FieldClusterSpec[],
  brickBudget: number,
  brickResolution: number
): ActiveBrick[] {
  const brickSize = 2 / brickResolution;
  const bucketMap = new Map<string, ActiveBrick>();

  for (const point of points) {
    const coord = bucketCoord(point.position, brickSize);
    const key = coord.join(":");
    const energy = point.brightness * (0.7 + point.coherence * 0.8) + point.density * 0.18;
    const existing = bucketMap.get(key);
    if (existing) {
      existing.energy = Math.max(existing.energy, energy);
      if (!existing.clusterIds.includes(point.clusterAffinity)) {
        existing.clusterIds.push(point.clusterAffinity);
      }
      continue;
    }
    bucketMap.set(key, {
      coord,
      energy,
      clusterIds: [point.clusterAffinity]
    });
  }

  for (const cluster of clusters) {
    const coord = bucketCoord(cluster.center, brickSize);
    const key = coord.join(":");
    const energy = cluster.structural.kernelDensity * cluster.structural.coherence + cluster.visual.emissionGain * 0.35;
    const existing = bucketMap.get(key);
    if (existing) {
      existing.energy = Math.max(existing.energy, energy);
      if (!existing.clusterIds.includes(cluster.id)) {
        existing.clusterIds.push(cluster.id);
      }
      continue;
    }
    bucketMap.set(key, {
      coord,
      energy,
      clusterIds: [cluster.id]
    });
  }

  return [...bucketMap.values()]
    .sort((a, b) => b.energy - a.energy)
    .slice(0, brickBudget);
}
