import { describe, expect, it } from "vitest";
import { cloneDefaultConfig, mergeConfig } from "./config";
import { getPresetById } from "./presets";

describe("config", () => {
  it("merges and preserves extended quality controls", () => {
    const defaults = cloneDefaultConfig();
    const merged = mergeConfig(cloneDefaultConfig(), {
      quality: {
        ...defaults.quality,
        surfaceSteps: 64,
        markerDensity: 0.42
      }
    });

    expect(merged.quality.surfaceSteps).toBe(64);
    expect(merged.quality.markerDensity).toBe(0.42);
    expect(merged.quality.surfaceResolutionScale).toBeGreaterThan(0);
    expect(merged.quality.vorticityGain).toBeGreaterThan(0);
    expect(merged.quality.burstGain).toBeGreaterThan(0);
  });

  it("keeps surface composite when cloning presets", () => {
    const preset = getPresetById("solo-orbital");

    expect(preset.post.surfaceComposite).toBeGreaterThan(1);
  });
});
