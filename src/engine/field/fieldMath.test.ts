import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_CONFIG } from "../defaults";
import { sampleField, tangentFlow, projectToSurface } from "./fieldMath";
import { getPresetById } from "../presets";
import { vec3 } from "../math/vec3";

describe("fieldMath", () => {
  it("derives stable rho, phase and flow for a single coherent cluster", () => {
    const preset = getPresetById("solo-orbital");
    const sample = sampleField(preset.clusters, [0.85, 0.1, 0.18], 0.6, DEFAULT_ENGINE_CONFIG.surfaceThreshold);

    expect(sample.rho).toBeGreaterThan(0);
    expect(Number.isFinite(sample.phase)).toBe(true);
    expect(sample.coherence).toBeGreaterThan(0);
    expect(vec3.length(sample.flow)).toBeLessThan(6);
  });

  it("removes the normal component from tangent flow", () => {
    const normal = vec3.normalize([0.4, 1, -0.25]);
    const flow: [number, number, number] = [1.8, -0.4, 0.75];
    const tangent = tangentFlow(flow, normal);

    expect(Math.abs(vec3.dot(tangent, normal))).toBeLessThan(1e-6);
  });

  it("projects a point closer to the density level-set", () => {
    const preset = getPresetById("solo-orbital");
    const position: [number, number, number] = [1.7, 0.3, -0.2];
    const before = sampleField(preset.clusters, position, 0.5, DEFAULT_ENGINE_CONFIG.surfaceThreshold);
    const projected = projectToSurface(
      position,
      before,
      DEFAULT_ENGINE_CONFIG.surfaceThreshold,
      1,
      DEFAULT_ENGINE_CONFIG.surfaceProjectionEpsilon
    );
    const after = sampleField(preset.clusters, projected, 0.5, DEFAULT_ENGINE_CONFIG.surfaceThreshold);

    expect(Math.abs(after.rho - DEFAULT_ENGINE_CONFIG.surfaceThreshold)).toBeLessThan(
      Math.abs(before.rho - DEFAULT_ENGINE_CONFIG.surfaceThreshold)
    );
  });
});
