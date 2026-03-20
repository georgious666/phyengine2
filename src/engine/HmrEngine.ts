import { DEFAULT_ENGINE_CONFIG } from "./defaults";
import { buildActiveBricks } from "./field/brickPool";
import { applyExcitations, averageFieldMetrics, sampleField } from "./field/fieldMath";
import { getPresetById, SCENE_PRESETS } from "./presets";
import { SurfaceTracker } from "./surface/surfaceTracker";
import type { EngineConfig, EngineFrameState, FieldClusterSpec, ScenePreset } from "./types";
import { HmrRenderer } from "./webgpu/renderer";

function mergeConfig(base: EngineConfig, partial?: Partial<EngineConfig>): EngineConfig {
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

export class HmrEngine {
  private readonly tracker = new SurfaceTracker();
  private readonly renderer: HmrRenderer;
  private config: EngineConfig;
  private preset: ScenePreset = getPresetById(SCENE_PRESETS[0].id);
  private animatedClusters: FieldClusterSpec[] = this.preset.clusters;
  private frameState: EngineFrameState;
  private accumulator = 0;
  private frame = 0;
  private time = 0;
  private fpsSmoother = 60;
  private initialized = false;
  private activeBricks = 0;

  constructor(private readonly canvas: HTMLCanvasElement, config?: Partial<EngineConfig>) {
    this.config = mergeConfig(DEFAULT_ENGINE_CONFIG, config);
    this.renderer = new HmrRenderer(canvas, this.config);
    this.tracker.configure(this.config);
    this.frameState = {
      time: 0,
      frame: 0,
      fps: 60,
      pointCount: 0,
      activeBricks: 0,
      averageDensity: 0,
      averageCoherence: 0,
      maxFlow: 0,
      shellCoverage: 0,
      quality: structuredClone(this.config.quality)
    };
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.renderer.init();
    this.resetSimulation();
    this.initialized = true;
  }

  loadPreset(presetOrId: ScenePreset | string): void {
    this.preset = typeof presetOrId === "string" ? getPresetById(presetOrId) : structuredClone(presetOrId);
    this.resetSimulation();
  }

  updateParams(params: {
    config?: Partial<EngineConfig>;
    post?: Partial<ScenePreset["post"]>;
    camera?: Partial<ScenePreset["camera"]>;
  }): void {
    if (params.config) {
      this.config = mergeConfig(this.config, params.config);
      this.tracker.configure(this.config);
      this.renderer.updateConfig(this.config);
    }
    if (params.post) {
      this.preset.post = {
        ...this.preset.post,
        ...params.post
      };
    }
    if (params.camera) {
      this.preset.camera = {
        ...this.preset.camera,
        ...params.camera
      };
    }
  }

  step(dt: number): void {
    if (!this.initialized) {
      return;
    }

    this.fpsSmoother = this.fpsSmoother * 0.92 + (1 / Math.max(dt, 1e-4)) * 0.08;
    this.accumulator += dt;
    let subSteps = 0;
    while (this.accumulator >= this.config.fixedTimeStep && subSteps < this.config.maxSubSteps) {
      this.advanceFixedStep(this.config.fixedTimeStep);
      this.accumulator -= this.config.fixedTimeStep;
      subSteps += 1;
    }
  }

  render(): void {
    if (!this.initialized) {
      return;
    }
    this.renderer.render({
      clusters: this.animatedClusters,
      points: this.tracker.getPoints(),
      camera: this.preset.camera,
      post: this.preset.post,
      frameState: this.frameState
    });
  }

  resize(width: number, height: number): void {
    this.renderer.resize(width, height);
  }

  orbit(deltaYaw: number, deltaPitch: number): void {
    this.preset.camera.yaw += deltaYaw;
    this.preset.camera.pitch += deltaPitch;
  }

  zoom(deltaRadius: number): void {
    this.preset.camera.radius = Math.max(2.4, Math.min(12, this.preset.camera.radius + deltaRadius));
  }

  getFrameState(): EngineFrameState {
    return this.frameState;
  }

  getPreset(): ScenePreset {
    return this.preset;
  }

  dispose(): void {
    this.renderer.dispose();
  }

  private resetSimulation(): void {
    this.time = 0;
    this.frame = 0;
    this.accumulator = 0;
    this.animatedClusters = applyExcitations(this.preset.clusters, this.preset.excitations, this.time);
    this.tracker.seed(this.animatedClusters, this.time);
    this.activeBricks = 0;
    this.frameState = {
      ...this.frameState,
      time: 0,
      frame: 0,
      pointCount: this.tracker.getPoints().length,
      activeBricks: 0,
      averageDensity: 0,
      averageCoherence: 0,
      maxFlow: 0,
      shellCoverage: this.tracker.getCoverage(),
      quality: structuredClone(this.config.quality)
    };
  }

  private advanceFixedStep(dt: number): void {
    this.time += dt;
    this.frame += 1;
    this.preset.camera.yaw += this.preset.camera.orbitSpeed * dt;
    this.animatedClusters = applyExcitations(this.preset.clusters, this.preset.excitations, this.time);
    this.tracker.step(this.animatedClusters, this.time, dt);

    const pointSamples = this.tracker
      .getPoints()
      .slice(0, 96)
      .map((point) => sampleField(this.animatedClusters, point.position, this.time, this.config.surfaceThreshold));
    const metrics = averageFieldMetrics(pointSamples);
    const activeBricks = buildActiveBricks(
      this.animatedClusters,
      this.time,
      this.config.brickBudget,
      this.config.brickResolution,
      this.config.surfaceThreshold
    );

    this.activeBricks = activeBricks.length;
    this.applyLod(metrics.maxFlow, activeBricks.length);

    this.frameState = {
      time: this.time,
      frame: this.frame,
      fps: this.fpsSmoother,
      pointCount: this.tracker.getPoints().length,
      activeBricks: activeBricks.length,
      averageDensity: metrics.rho,
      averageCoherence: metrics.coherence,
      maxFlow: metrics.maxFlow,
      shellCoverage: this.tracker.getCoverage(),
      quality: structuredClone(this.config.quality)
    };
  }

  private applyLod(maxFlow: number, activeBricks: number): void {
    const overload = Math.max(
      maxFlow / Math.max(0.1, this.config.lodFlowLimit),
      activeBricks / Math.max(1, this.config.brickBudget)
    );

    if (overload > 1.05) {
      this.config.quality.raymarchSteps = Math.max(24, Math.floor(this.config.quality.raymarchSteps * 0.97));
      this.config.quality.shellDensity = Math.max(0.58, this.config.quality.shellDensity * 0.992);
      this.config.quality.pointSizeScale = Math.max(0.85, this.config.quality.pointSizeScale * 0.997);
    } else {
      this.config.quality.raymarchSteps = Math.min(
        DEFAULT_ENGINE_CONFIG.quality.raymarchSteps,
        this.config.quality.raymarchSteps + 1
      );
      this.config.quality.shellDensity = Math.min(
        DEFAULT_ENGINE_CONFIG.quality.shellDensity,
        this.config.quality.shellDensity + 0.005
      );
      this.config.quality.pointSizeScale = Math.min(
        DEFAULT_ENGINE_CONFIG.quality.pointSizeScale,
        this.config.quality.pointSizeScale + 0.003
      );
    }
    this.tracker.configure(this.config);
    this.renderer.updateConfig(this.config);
  }
}
