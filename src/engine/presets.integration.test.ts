import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_CONFIG } from "./defaults";
import { applyExcitations, flowDiagnostics, sampleField } from "./field/fieldMath";
import { getPresetById } from "./presets";
import { SurfaceTracker } from "./surface/surfaceTracker";

function peakBurstForPreset(presetId: string, untilTime: number): number {
  const preset = getPresetById(presetId);
  const tracker = new SurfaceTracker({
    ...DEFAULT_ENGINE_CONFIG,
    pointBudget: 280
  });

  tracker.seed(applyExcitations(preset.clusters, preset.excitations, 0), 0);
  for (let step = 0; step < Math.floor(untilTime / DEFAULT_ENGINE_CONFIG.fixedTimeStep); step += 1) {
    const time = step * DEFAULT_ENGINE_CONFIG.fixedTimeStep;
    tracker.step(
      applyExcitations(preset.clusters, preset.excitations, time),
      time,
      DEFAULT_ENGINE_CONFIG.fixedTimeStep
    );
  }

  return tracker
    .getPoints()
    .slice(0, 24)
    .reduce(
      (maxBurst, point) =>
        Math.max(
          maxBurst,
          flowDiagnostics(
            applyExcitations(preset.clusters, preset.excitations, untilTime),
            point.position,
            untilTime,
            DEFAULT_ENGINE_CONFIG.surfaceThreshold
          ).burst
        ),
      0
    );
}

describe("scene presets", () => {
  it("creates a denser midpoint bridge in the coherent preset than in the nodal gap preset", () => {
    const bridge = getPresetById("coherent-bridge");
    const nodal = getPresetById("nodal-gap");

    const bridgeMid = sampleField(bridge.clusters, [0, 0, 0], 0.8, DEFAULT_ENGINE_CONFIG.surfaceThreshold);
    const nodalMid = sampleField(nodal.clusters, [0, 0, 0], 0.8, DEFAULT_ENGINE_CONFIG.surfaceThreshold);

    expect(Math.abs(bridgeMid.rho - nodalMid.rho)).toBeGreaterThan(1);
    expect(Math.abs(bridgeMid.phase - nodalMid.phase)).toBeGreaterThan(0.3);
  });

  it("maintains higher shell coherence for the coherent bridge than for nodal cancellation", () => {
    const bridge = getPresetById("coherent-bridge");
    const nodal = getPresetById("nodal-gap");
    const bridgeTracker = new SurfaceTracker({
      ...DEFAULT_ENGINE_CONFIG,
      pointBudget: 520
    });
    const nodalTracker = new SurfaceTracker({
      ...DEFAULT_ENGINE_CONFIG,
      pointBudget: 520
    });

    bridgeTracker.seed(bridge.clusters, 0);
    nodalTracker.seed(nodal.clusters, 0);

    for (let step = 0; step < 20; step += 1) {
      const time = step * DEFAULT_ENGINE_CONFIG.fixedTimeStep;
      bridgeTracker.step(bridge.clusters, time, DEFAULT_ENGINE_CONFIG.fixedTimeStep);
      nodalTracker.step(nodal.clusters, time, DEFAULT_ENGINE_CONFIG.fixedTimeStep);
    }

    const bridgeMeanCoherence =
      bridgeTracker.getPoints().reduce((sum, point) => sum + point.coherence, 0) /
      bridgeTracker.getPoints().length;
    const nodalMeanCoherence =
      nodalTracker.getPoints().reduce((sum, point) => sum + point.coherence, 0) /
      nodalTracker.getPoints().length;

    expect(bridgeMeanCoherence).toBeGreaterThan(nodalMeanCoherence);
  });

  it("keeps a deterministic regression signature for the excited transition shell", () => {
    const preset = getPresetById("excited-transition");
    const tracker = new SurfaceTracker({
      ...DEFAULT_ENGINE_CONFIG,
      pointBudget: 360
    });

    tracker.seed(preset.clusters, 0);
    for (let step = 0; step < 18; step += 1) {
      tracker.step(preset.clusters, step * DEFAULT_ENGINE_CONFIG.fixedTimeStep, DEFAULT_ENGINE_CONFIG.fixedTimeStep);
    }

    const signature = tracker
      .getPoints()
      .slice(0, 6)
      .map((point) =>
        [
          point.position[0].toFixed(2),
          point.position[1].toFixed(2),
          point.position[2].toFixed(2),
          point.phase.toFixed(2),
          point.density.toFixed(2)
        ].join(":")
      )
      .join("|");

    expect(signature).toMatchInlineSnapshot(
      `"0.32:0.22:-0.25:0.61:0.46|-0.18:-0.26:1.12:-1.38:0.36|0.33:-0.87:0.53:-0.25:0.26|-0.38:0.87:-0.71:1.56:0.24|-0.46:0.29:0.61:2.50:0.24|-0.45:0.34:0.47:2.55:0.24"`
    );
  });

  it("amplifies excited-transition burst during the excitation window", () => {
    const preBurst = peakBurstForPreset("excited-transition", 0.9);
    const excitedBurst = peakBurstForPreset("excited-transition", 2.2);

    expect(excitedBurst).toBeGreaterThan(preBurst * 1.15);
  });
});
