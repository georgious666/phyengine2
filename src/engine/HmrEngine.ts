import { cloneDefaultConfig, mergeConfig } from "./config";
import { getPresetById, SCENE_PRESETS } from "./presets";
import type {
  EngineConfig,
  EngineFrameState,
  FieldClusterSpec,
  ScenePreset
} from "./types";
import type {
  SimulationWorkerRequest,
  SimulationWorkerResponse
} from "./simulation/workerProtocol";
import { HmrRenderer } from "./webgpu/renderer";

interface LatestFrame {
  clusters: FieldClusterSpec[];
  packedPoints: ArrayBuffer;
  pointCount: number;
  frameState: EngineFrameState;
}

export class HmrEngine {
  private readonly renderer: HmrRenderer;
  private worker: Worker | null = null;
  private config: EngineConfig;
  private preset: ScenePreset = getPresetById(SCENE_PRESETS[0].id);
  private frameState: EngineFrameState;
  private latestFrame: LatestFrame | null = null;
  private initialized = false;
  private workerBusy = false;
  private pendingDt = 0;
  private initResolver: (() => void) | null = null;
  private initRejecter: ((error: Error) => void) | null = null;

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
      shellCoverage: 0,
      quality: structuredClone(this.config.quality)
    };
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.renderer.init();
    await this.initSimulationWorker();
    this.initialized = true;
  }

  loadPreset(presetOrId: ScenePreset | string): void {
    this.preset = typeof presetOrId === "string" ? getPresetById(presetOrId) : structuredClone(presetOrId);
    this.pendingDt = 0;
    this.postWorkerMessage({
      type: "loadPreset",
      preset: this.preset
    });
  }

  updateParams(params: {
    config?: Partial<EngineConfig>;
    post?: Partial<ScenePreset["post"]>;
    camera?: Partial<ScenePreset["camera"]>;
  }): void {
    if (params.config) {
      this.config = mergeConfig(this.config, params.config);
      this.renderer.updateConfig(this.config);
      this.postWorkerMessage({
        type: "updateConfig",
        config: params.config
      });
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
    this.pendingDt += dt;
    this.flushWorkerStep();
  }

  render(): void {
    if (!this.initialized || !this.latestFrame) {
      return;
    }

    this.renderer.render({
      clusters: this.latestFrame.clusters,
      packedPoints: this.latestFrame.packedPoints,
      pointCount: this.latestFrame.pointCount,
      camera: this.preset.camera,
      post: this.preset.post,
      frameState: this.latestFrame.frameState
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
    return this.latestFrame?.frameState ?? this.frameState;
  }

  dispose(): void {
    this.postWorkerMessage({ type: "dispose" });
    this.worker?.terminate();
    this.worker = null;
    this.renderer.dispose();
  }

  private async initSimulationWorker(): Promise<void> {
    this.worker = new Worker(new URL("./simulation/simulation.worker.ts", import.meta.url), {
      type: "module"
    });

    this.worker.onmessage = (event: MessageEvent<SimulationWorkerResponse>) => {
      const message = event.data;
      if (message.type === "error") {
        const error = new Error(message.message);
        if (this.initRejecter) {
          this.initRejecter(error);
          this.initRejecter = null;
          this.initResolver = null;
        }
        throw error;
      }

      this.latestFrame = {
        clusters: message.clusters,
        packedPoints: (() => {
          const copy = new ArrayBuffer(message.packedPoints.byteLength);
          new Uint8Array(copy).set(message.packedPoints);
          return copy;
        })(),
        pointCount: message.pointCount,
        frameState: message.frameState
      };
      this.frameState = message.frameState;
      this.workerBusy = false;

      if (this.initResolver) {
        this.initResolver();
        this.initResolver = null;
        this.initRejecter = null;
      }

      this.flushWorkerStep();
    };

    this.worker.onerror = (event) => {
      const error = new Error(event.message || "Simulation worker crashed.");
      if (this.initRejecter) {
        this.initRejecter(error);
        this.initRejecter = null;
        this.initResolver = null;
      } else {
        throw error;
      }
    };

    const readyPromise = new Promise<void>((resolve, reject) => {
      this.initResolver = resolve;
      this.initRejecter = reject;
    });

    this.workerBusy = true;
    this.worker.postMessage({
      type: "init",
      config: this.config,
      preset: this.preset
    } satisfies SimulationWorkerRequest);

    await readyPromise;
  }

  private flushWorkerStep(): void {
    if (!this.worker || this.workerBusy || this.pendingDt <= 0) {
      return;
    }

    const dt = Math.min(0.05, this.pendingDt);
    this.pendingDt = Math.max(0, this.pendingDt - dt);
    this.workerBusy = true;
    this.worker.postMessage({
      type: "step",
      dt
    } satisfies SimulationWorkerRequest);
  }

  private postWorkerMessage(message: SimulationWorkerRequest): void {
    if (!this.worker) {
      return;
    }
    if (message.type === "step") {
      this.workerBusy = true;
    }
    this.worker.postMessage(message);
  }
}
