import { DEFAULT_ENGINE_CONFIG } from "./defaults";
import { SCENE_PRESETS } from "./presets";

function nextPowerOfTwo(value: number): number {
  let current = 1;
  while (current < value) {
    current <<= 1;
  }
  return current;
}

export const GPU_RUNTIME_POINT_CAPACITY = SCENE_PRESETS.reduce((maxBudget, preset) => {
  const pointBudgetControl = preset.controls.find((control) => control.key === "pointBudget");
  return Math.max(maxBudget, Math.round(pointBudgetControl?.max ?? DEFAULT_ENGINE_CONFIG.pointBudget));
}, DEFAULT_ENGINE_CONFIG.pointBudget);

export const GPU_RUNTIME_SORT_CAPACITY = nextPowerOfTwo(GPU_RUNTIME_POINT_CAPACITY);

export const GPU_RUNTIME_CLUSTER_CAPACITY = SCENE_PRESETS.reduce(
  (maxClusters, preset) => Math.max(maxClusters, preset.clusters.length),
  1
);

export const GPU_RUNTIME_MODE_CAPACITY = SCENE_PRESETS.reduce((maxModes, preset) => {
  const presetModeCount = preset.clusters.reduce((sum, cluster) => sum + cluster.modes.length, 0);
  return Math.max(maxModes, presetModeCount);
}, 1);
