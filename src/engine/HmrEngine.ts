import { cloneDefaultConfig, mergeConfig } from "./config";
import { getPresetById, SCENE_PRESETS } from "./presets";
import type { EngineConfig, EngineFrameState, RenderMode, ScenePreset } from "./types";
import { GpuSimulationCore } from "./simulation/GpuSimulationCore";
import { createWebGpuContext, type WebGpuContextResources } from "./webgpu/context";
import { HmrRenderer } from "./webgpu/renderer";

export class HmrEngine {
  private renderer: HmrRenderer;
  private simulation: GpuSimulationCore | null = null;
  private gpu: WebGpuContextResources | null = null;
  private config: EngineConfig;
  private preset: ScenePreset = getPresetById(SCENE_PRESETS[0].id);
  private frameState: EngineFrameState;
  private latestFrameReceivedAt = 0;
  private previousFrameReceivedAt = 0;
  private lastRenderedSimulationFrame = -1;
  private initialized = false;
  private renderMode: RenderMode = "hybrid";

  constructor(private readonly canvas: HTMLCanvasElement, config?: Partial<EngineConfig>) {
    this.config = mergeConfig(cloneDefaultConfig(), config);
    this.renderer = new HmrRenderer(canvas, this.config);
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
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.gpu = await createWebGpuContext(this.canvas);
    this.simulation = new GpuSimulationCore(this.gpu, this.config, this.preset);
    await this.renderer.init(this.gpu, this.simulation.getSnapshot().pointBuffers);
    this.frameState = this.simulation.getSnapshot().frameState;
    this.initialized = true;
  }

  loadPreset(presetOrId: ScenePreset | string): void {
    if (!this.simulation) {
      return;
    }
    this.preset = typeof presetOrId === "string" ? getPresetById(presetOrId) : structuredClone(presetOrId);
    this.simulation.loadPreset(this.preset);
    this.frameState = this.simulation.getSnapshot().frameState;
    this.lastRenderedSimulationFrame = -1;
  }

  updateParams(params: {
    config?: Partial<EngineConfig>;
    post?: Partial<ScenePreset["post"]>;
    camera?: Partial<ScenePreset["camera"]>;
    renderMode?: RenderMode;
  }): void {
    if (params.config) {
      this.config = mergeConfig(this.config, params.config);
      this.renderer.updateConfig(this.config);
      this.simulation?.updateConfig(params.config);
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
    if (params.renderMode) {
      this.renderMode = params.renderMode;
    }
  }

  step(dt: number): void {
    if (!this.initialized || !this.simulation) {
      return;
    }
    this.simulation.step(dt);
    this.frameState = this.simulation.getSnapshot().frameState;
    const quality = this.frameState.quality;
    const qualityChanged =
      quality.raymarchSteps !== this.config.quality.raymarchSteps ||
      quality.surfaceSteps !== this.config.quality.surfaceSteps ||
      quality.shellDensity !== this.config.quality.shellDensity ||
      quality.pointSizeScale !== this.config.quality.pointSizeScale ||
      quality.surfaceResolutionScale !== this.config.quality.surfaceResolutionScale ||
      quality.markerDensity !== this.config.quality.markerDensity ||
      quality.vorticityGain !== this.config.quality.vorticityGain ||
      quality.burstGain !== this.config.quality.burstGain;
    if (qualityChanged) {
      this.config = {
        ...this.config,
        quality: structuredClone(quality)
      };
      this.renderer.updateConfig(this.config);
    }
  }

  render(): void {
    if (!this.initialized || !this.simulation) {
      return;
    }

    const snapshot = this.simulation.getSnapshot();
    if (snapshot.frameState.frame !== this.lastRenderedSimulationFrame) {
      this.previousFrameReceivedAt = this.latestFrameReceivedAt || performance.now();
      this.latestFrameReceivedAt = performance.now();
      this.lastRenderedSimulationFrame = snapshot.frameState.frame;
    }

    this.renderer.render({
      clusters: snapshot.clusters,
      pointCount: snapshot.pointCount,
      simulationAge: 0,
      snapshotBlendAlpha: (() => {
        const now = performance.now();
        const intervalSeconds = Math.max(
          1 / 120,
          Math.min(0.08, (this.latestFrameReceivedAt - this.previousFrameReceivedAt) / 1000 || 1 / 60)
        );
        const blendDuration = Math.max(0.012, Math.min(0.04, intervalSeconds * 0.7));
        return Math.min(1, Math.max(0, (now - this.latestFrameReceivedAt) / 1000 / blendDuration));
      })(),
      camera: this.preset.camera,
      post: this.preset.post,
      frameState: snapshot.frameState,
      renderMode: this.renderMode
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

  dispose(): void {
    this.simulation?.dispose();
    this.simulation = null;
    this.renderer.dispose();
  }
}
