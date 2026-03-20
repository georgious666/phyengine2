import type { EngineConfig } from "./types";

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  fixedTimeStep: 1 / 60,
  maxSubSteps: 4,
  pointBudget: 1800,
  brickBudget: 128,
  brickResolution: 10,
  renderScale: 1,
  surfaceThreshold: 0.24,
  surfaceProjectionEpsilon: 1e-3,
  shellRelaxation: 0.35,
  velocityScale: 1.25,
  lodFlowLimit: 1.8,
  quality: {
    raymarchSteps: 54,
    shellOpacity: 1,
    shellDensity: 1,
    pointSizeScale: 1
  },
  spawn: {
    minSpacing: 0.18,
    maxSpacing: 0.54,
    maxBirthsPerStep: 24,
    maxCullPerStep: 20,
    targetCoverage: 0.86,
    nodalCullThreshold: 0.06
  }
};
