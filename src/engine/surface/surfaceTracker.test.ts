import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_CONFIG } from "../defaults";
import { getPresetById } from "../presets";
import { SurfaceTracker } from "./surfaceTracker";

describe("SurfaceTracker", () => {
  it("keeps point shell coverage stable without point explosion", () => {
    const preset = getPresetById("solo-orbital");
    const tracker = new SurfaceTracker({
      ...DEFAULT_ENGINE_CONFIG,
      pointBudget: 420,
      quality: {
        ...DEFAULT_ENGINE_CONFIG.quality,
        shellDensity: 0.7
      }
    });

    tracker.seed(preset.clusters, 0);
    for (let step = 0; step < 16; step += 1) {
      tracker.step(preset.clusters, step * DEFAULT_ENGINE_CONFIG.fixedTimeStep, DEFAULT_ENGINE_CONFIG.fixedTimeStep);
    }

    const points = tracker.getPoints();
    const averageDeviation =
      points.reduce((sum, point) => sum + Math.abs(point.density - DEFAULT_ENGINE_CONFIG.surfaceThreshold), 0) /
      points.length;

    expect(points.length).toBeGreaterThan(120);
    expect(points.length).toBeLessThanOrEqual(420);
    expect(averageDeviation).toBeLessThan(0.18);
    expect(tracker.getCoverage()).toBeGreaterThan(0.6);
  });
});
