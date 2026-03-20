import { GPU_RUNTIME_CLUSTER_CAPACITY, GPU_RUNTIME_MODE_CAPACITY } from "../runtimeLimits";
import type { FieldClusterSpec } from "../types";

export const GPU_FIELD_CLUSTER_FLOATS = 20;
export const GPU_FIELD_MODE_FLOATS = 12;

export interface PackedFieldData {
  clusterData: Float32Array;
  modeData: Float32Array;
  modeCount: number;
}

export function packFieldClustersAndModes(clusters: FieldClusterSpec[]): PackedFieldData {
  const clusterData = new Float32Array(GPU_RUNTIME_CLUSTER_CAPACITY * GPU_FIELD_CLUSTER_FLOATS);
  const modeData = new Float32Array(GPU_RUNTIME_MODE_CAPACITY * GPU_FIELD_MODE_FLOATS);
  let modeOffset = 0;

  clusters.slice(0, GPU_RUNTIME_CLUSTER_CAPACITY).forEach((cluster, clusterIndex) => {
    const base = clusterIndex * GPU_FIELD_CLUSTER_FLOATS;
    clusterData[base + 0] = cluster.center[0];
    clusterData[base + 1] = cluster.center[1];
    clusterData[base + 2] = cluster.center[2];
    clusterData[base + 4] = cluster.orientation[0];
    clusterData[base + 5] = cluster.orientation[1];
    clusterData[base + 6] = cluster.orientation[2];
    clusterData[base + 8] = cluster.structural.kernelDensity;
    clusterData[base + 9] = cluster.structural.formRank;
    clusterData[base + 10] = cluster.structural.formComplexity;
    clusterData[base + 11] = cluster.structural.coherence;
    clusterData[base + 12] = cluster.dynamic.energyInput;
    clusterData[base + 13] = cluster.dynamic.excitationState;
    clusterData[base + 14] = cluster.dynamic.transitionTension;
    clusterData[base + 15] = cluster.dynamic.turbulence;
    clusterData[base + 16] = modeOffset;
    clusterData[base + 17] = cluster.modes.length;
    clusterData[base + 18] = cluster.visual.phaseMapping;

    cluster.modes.forEach((mode) => {
      if (modeOffset >= GPU_RUNTIME_MODE_CAPACITY) {
        return;
      }
      const modeBase = modeOffset * GPU_FIELD_MODE_FLOATS;
      modeData[modeBase + 0] = mode.amplitude;
      modeData[modeBase + 1] = mode.radialScale;
      modeData[modeBase + 2] = mode.radialOffset;
      modeData[modeBase + 3] = mode.angularSharpness;
      modeData[modeBase + 4] = mode.phaseOffset;
      modeData[modeBase + 5] = mode.phaseVelocity;
      modeData[modeBase + 6] = mode.swirl;
      modeData[modeBase + 8] = mode.direction[0];
      modeData[modeBase + 9] = mode.direction[1];
      modeData[modeBase + 10] = mode.direction[2];
      modeOffset += 1;
    });
  });

  return {
    clusterData,
    modeData,
    modeCount: modeOffset
  };
}
