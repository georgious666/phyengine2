import { DEFAULT_ENGINE_CONFIG } from "./defaults";
import type { EngineConfig } from "./types";

export function mergeConfig(base: EngineConfig, partial?: Partial<EngineConfig>): EngineConfig {
  if (!partial) {
    return structuredClone(base);
  }

  return {
    ...base,
    ...partial,
    quality: {
      ...base.quality,
      ...partial.quality
    },
    spawn: {
      ...base.spawn,
      ...partial.spawn
    }
  };
}

export function cloneDefaultConfig(): EngineConfig {
  return structuredClone(DEFAULT_ENGINE_CONFIG);
}
