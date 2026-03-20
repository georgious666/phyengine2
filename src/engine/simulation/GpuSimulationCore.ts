import { buildActiveBricks } from "../field/brickPool";
import { cloneDefaultConfig, mergeConfig } from "../config";
import { DEFAULT_ENGINE_CONFIG } from "../defaults";
import { applyExcitations, flowDiagnostics } from "../field/fieldMath";
import { getPresetById, SCENE_PRESETS } from "../presets";
import { SurfaceTracker } from "../surface/surfaceTracker";
import type {
  EngineConfig,
  EngineFrameState,
  FieldClusterSpec,
  PhotonPoint,
  ScenePreset
} from "../types";
import type { WebGpuContextResources } from "../webgpu/context";
import { GpuSurfaceTracker } from "../webgpu/gpuSurfaceTracker";
import type { GpuTrackerMetricPoint, GpuTrackerRenderBuffers } from "../webgpu/trackerTypes";

const DEFAULT_QUALITY = cloneDefaultConfig().quality;
const GPU_RUNTIME_FIXED_STEP = 1 / 30;

export interface GpuSimulationSnapshot {
  clusters: FieldClusterSpec[];
  pointBuffers: GpuTrackerRenderBuffers;
  pointCount: number;
  frameState: EngineFrameState;
}

function toPhotonMetric(point: GpuTrackerMetricPoint, clusters: FieldClusterSpec[]): PhotonPoint {
  return {
    id: point.slot + 1,
    position: point.position,
    velocity: point.velocity,
    normal: [0, 1, 0],
    density: point.density,
    phase: 0,
    coherence: point.coherence,
    sdfRadius: DEFAULT_ENGINE_CONFIG.spawn.minSpacing,
    brightness: point.brightness,
    age: 0,
    lifetime: 0,
    state: "active",
    clusterAffinity: clusters[point.clusterIndex]?.id ?? clusters[0]?.id ?? "cluster",
    surfaceLock: 0.9
  };
}

function averageMetricSamples(points: GpuTrackerMetricPoint[], frame: number): { rho: number; coherence: number; maxFlow: number } {
  const selected = points.filter((_, index) => index % 4 === frame % 4).slice(0, 24);
  if (selected.length === 0) {
    return { rho: 0, coherence: 0, maxFlow: 0 };
  }

  let rho = 0;
  let coherence = 0;
  let maxFlow = 0;
  for (const point of selected) {
    rho += point.density;
    coherence += point.coherence;
    maxFlow = Math.max(maxFlow, Math.hypot(point.velocity[0], point.velocity[1], point.velocity[2]));
  }
  return {
    rho: rho / selected.length,
    coherence: coherence / selected.length,
    maxFlow
  };
}

function diagnosticMetricSamples(
  points: GpuTrackerMetricPoint[],
  clusters: FieldClusterSpec[],
  time: number,
  surfaceThreshold: number,
  frame: number
): { peakVorticity: number; peakBurst: number } {
  const selected = points.filter((_, index) => index % 4 === frame % 4).slice(0, 12);
  let peakVorticity = 0;
  let peakBurst = 0;
  for (const point of selected) {
    const diagnostics = flowDiagnostics(clusters, point.position, time, surfaceThreshold);
    peakVorticity = Math.max(peakVorticity, Math.hypot(...diagnostics.vorticity));
    peakBurst = Math.max(peakBurst, diagnostics.burst);
  }
  return { peakVorticity, peakBurst };
}

export class GpuSimulationCore {
  private readonly tracker: GpuSurfaceTracker;
  private config: EngineConfig;
  private targetQuality: EngineConfig["quality"];
  private preset: ScenePreset = getPresetById(SCENE_PRESETS[0].id);
  private animatedClusters: FieldClusterSpec[] = this.preset.clusters;
  private frameState: EngineFrameState;
  private accumulator = 0;
  private frame = 0;
  private time = 0;
  private fpsSmoother = 60;

  constructor(gpu: WebGpuContextResources, config?: Partial<EngineConfig>, preset?: ScenePreset) {
    this.config = mergeConfig(cloneDefaultConfig(), config);
    this.targetQuality = structuredClone(this.config.quality);
    if (preset) {
      this.preset = structuredClone(preset);
    }
    this.animatedClusters = this.preset.clusters;
    this.tracker = new GpuSurfaceTracker(gpu, this.config);
    this.frameState = {
      time: 0,
      frame: 0,
      fps: 60,
      pointCount: 0,
      activeBricks: 0,
      averageDensity: 0,
      averageCoherence: 0,
      maxFlow: 0,
      peakVorticity: 0,
      peakBurst: 0,
      shellCoverage: 0,
      quality: structuredClone(this.config.quality)
    };
    this.resetSimulation();
  }

  loadPreset(presetOrId: ScenePreset | string): void {
    this.preset = typeof presetOrId === "string" ? getPresetById(presetOrId) : structuredClone(presetOrId);
    this.resetSimulation();
  }

  updateConfig(partial?: Partial<EngineConfig>): void {
    if (!partial) {
      return;
    }
    this.config = mergeConfig(this.config, partial);
    this.targetQuality = structuredClone(this.config.quality);
    this.tracker.configure(this.config);
    this.frameState = {
      ...this.frameState,
      pointCount: Math.min(this.tracker.getCurrentPointCount(), this.config.pointBudget),
      quality: structuredClone(this.config.quality)
    };
  }

  step(dt: number): void {
    this.fpsSmoother = this.fpsSmoother * 0.92 + (1 / Math.max(dt, 1e-4)) * 0.08;
    this.accumulator += dt;
    const runtimeFixedStep = Math.max(this.config.fixedTimeStep, GPU_RUNTIME_FIXED_STEP);
    const maxSubSteps =
      dt > runtimeFixedStep * 1.5
        ? 1
        : this.config.maxSubSteps;
    let subSteps = 0;
    while (this.accumulator >= runtimeFixedStep && subSteps < maxSubSteps) {
      this.advanceFixedStep(runtimeFixedStep);
      this.accumulator -= runtimeFixedStep;
      subSteps += 1;
    }
    if (this.accumulator > runtimeFixedStep) {
      // Avoid a GPU-driven catch-up spiral when a frame overruns badly.
      this.accumulator = runtimeFixedStep;
    }
    this.consumeTrackerSnapshot();
  }

  getSnapshot(): GpuSimulationSnapshot {
    return {
      clusters: this.animatedClusters,
      pointBuffers: this.tracker.getRenderBuffers(),
      pointCount: Math.min(this.tracker.getCurrentPointCount(), this.config.pointBudget),
      frameState: {
        ...this.frameState,
        quality: structuredClone(this.config.quality)
      }
    };
  }

  dispose(): void {
    this.tracker.dispose();
  }

  private resetSimulation(): void {
    this.time = 0;
    this.frame = 0;
    this.accumulator = 0;
    this.animatedClusters = applyExcitations(this.preset.clusters, this.preset.excitations, this.time);
    const seedTracker = new SurfaceTracker(this.config);
    seedTracker.seed(this.animatedClusters, this.time);
    this.tracker.configure(this.config);
    this.tracker.uploadSeed(seedTracker.getPoints(), this.animatedClusters);
    this.frameState = {
      ...this.frameState,
      time: 0,
      frame: 0,
      pointCount: seedTracker.getPoints().length,
      activeBricks: 0,
      averageDensity: 0,
      averageCoherence: 0,
      maxFlow: 0,
      peakVorticity: 0,
      peakBurst: 0,
      shellCoverage: seedTracker.getCoverage(),
      quality: structuredClone(this.config.quality)
    };
  }

  private advanceFixedStep(dt: number): void {
    this.time += dt;
    this.frame += 1;
    this.animatedClusters = applyExcitations(this.preset.clusters, this.preset.excitations, this.time);
    this.tracker.step(this.animatedClusters, this.time, dt, this.frame);
    this.frameState = {
      ...this.frameState,
      time: this.time,
      frame: this.frame,
      fps: this.fpsSmoother,
      quality: structuredClone(this.config.quality)
    };
  }

  private consumeTrackerSnapshot(): void {
    const snapshot = this.tracker.consumeLatestSnapshot();
    if (!snapshot) {
      return;
    }

    const metrics = averageMetricSamples(snapshot.points, snapshot.frame);
    const diagnostics = diagnosticMetricSamples(
      snapshot.points,
      this.animatedClusters,
      this.time,
      this.config.surfaceThreshold,
      snapshot.frame
    );
    const activeBricks = buildActiveBricks(
      snapshot.points.map((point) => toPhotonMetric(point, this.animatedClusters)),
      this.animatedClusters,
      this.config.brickBudget,
      this.config.brickResolution
    );

    this.applyLod(metrics.maxFlow, activeBricks.length);
    this.frameState = {
      time: this.time,
      frame: snapshot.frame,
      fps: this.fpsSmoother,
      pointCount: snapshot.pointCount,
      activeBricks: activeBricks.length,
      averageDensity: metrics.rho,
      averageCoherence: metrics.coherence,
      maxFlow: metrics.maxFlow,
      peakVorticity: diagnostics.peakVorticity,
      peakBurst: diagnostics.peakBurst,
      shellCoverage: snapshot.shellCoverage,
      quality: structuredClone(this.config.quality)
    };
  }

  private applyLod(maxFlow: number, activeBricks: number): void {
    const overload = Math.max(
      maxFlow / Math.max(0.1, this.config.lodFlowLimit),
      activeBricks / Math.max(1, this.config.brickBudget)
    );

    if (overload > 1.05) {
      if (this.config.quality.surfaceResolutionScale > 0.72) {
        this.config.quality.surfaceResolutionScale = Math.max(
          0.72,
          this.config.quality.surfaceResolutionScale * 0.988
        );
      } else if (this.config.quality.surfaceSteps > 44) {
        this.config.quality.surfaceSteps = Math.max(44, Math.floor(this.config.quality.surfaceSteps * 0.985));
      } else if (this.config.quality.markerDensity > 0.04) {
        this.config.quality.markerDensity = Math.max(0.04, this.config.quality.markerDensity * 0.985);
      } else {
        this.config.quality.raymarchSteps = Math.max(24, Math.floor(this.config.quality.raymarchSteps * 0.97));
        this.config.quality.shellDensity = Math.max(0.58, this.config.quality.shellDensity * 0.992);
        this.config.quality.pointSizeScale = Math.max(0.85, this.config.quality.pointSizeScale * 0.997);
      }
    } else {
      this.config.quality.surfaceResolutionScale = Math.min(
        this.targetQuality.surfaceResolutionScale,
        this.config.quality.surfaceResolutionScale + 0.006
      );
      this.config.quality.surfaceSteps = Math.min(
        this.targetQuality.surfaceSteps,
        this.config.quality.surfaceSteps + 1
      );
      this.config.quality.markerDensity = Math.min(
        this.targetQuality.markerDensity,
        this.config.quality.markerDensity + 0.01
      );
      this.config.quality.raymarchSteps = Math.min(
        this.targetQuality.raymarchSteps,
        this.config.quality.raymarchSteps + 1
      );
      this.config.quality.shellDensity = Math.min(
        this.targetQuality.shellDensity,
        this.config.quality.shellDensity + 0.005
      );
      this.config.quality.pointSizeScale = Math.min(
        this.targetQuality.pointSizeScale,
        this.config.quality.pointSizeScale + 0.003
      );
    }
    this.tracker.configure(this.config);
  }
}
