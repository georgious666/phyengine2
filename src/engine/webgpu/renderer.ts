import { shaderModules } from "./shaderModules";
import type {
  EngineConfig,
  EngineFrameState,
  FieldClusterSpec,
  RenderMode,
  SceneCamera,
  ScenePostSettings,
  Vec3
} from "../types";
import type { WebGpuContextResources } from "./context";
import { GPU_FIELD_CLUSTER_FLOATS, GPU_FIELD_MODE_FLOATS, packFieldClustersAndModes } from "./fieldBufferLayout";
import type { GpuTrackerRenderBuffers } from "./trackerTypes";
import { orbitCamera } from "../math/mat4";
import { vec3 } from "../math/vec3";
import { GPU_RUNTIME_CLUSTER_CAPACITY, GPU_RUNTIME_MODE_CAPACITY } from "../runtimeLimits";

const FLOATS_PER_METRIC = 4;
const FRAME_UNIFORM_FLOATS = 40;
const QUAD_VERTEX_COUNT = 6;
const VOLUME_RESOLUTION_SCALE = 0.67;
const VOLUME_PASS_CADENCE = 2;

interface RendererScene {
  clusters: FieldClusterSpec[];
  pointCount: number;
  simulationAge: number;
  snapshotBlendAlpha: number;
  camera: SceneCamera;
  post: ScenePostSettings;
  frameState: EngineFrameState;
  renderMode: RenderMode;
}

interface GpuPipelines {
  volume: GPURenderPipeline;
  surface: GPURenderPipeline;
  shell: GPURenderPipeline;
  composite: GPURenderPipeline;
  shellMetrics: GPUComputePipeline;
}

interface GpuBuffers {
  frame: GPUBuffer;
  clusters: GPUBuffer;
  modes: GPUBuffer;
  pointMetrics: GPUBuffer;
}

interface OffscreenTargets {
  volume: GPUTexture;
  surfaceColor: GPUTexture;
  surfaceDepth: GPUTexture;
  shell: GPUTexture;
}

function createBuffer(device: GPUDevice, label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer {
  return device.createBuffer({
    label,
    size,
    usage
  });
}

function createOffscreenTexture(
  device: GPUDevice,
  size: GPUExtent3DStrict,
  label: string,
  format: GPUTextureFormat
): GPUTexture {
  return device.createTexture({
    label,
    size,
    format,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
  });
}

function renderModeIndex(renderMode: RenderMode): number {
  switch (renderMode) {
    case "points":
      return 0;
    case "surface":
      return 1;
    default:
      return 2;
  }
}

function cameraBasis(camera: SceneCamera): { eye: Vec3; right: Vec3; up: Vec3; forward: Vec3 } {
  const eye = orbitCamera(camera.target, camera.yaw, camera.pitch, camera.radius);
  const forward = vec3.normalize(vec3.sub(camera.target, eye));
  const right = vec3.normalize(vec3.cross(forward, [0, 1, 0]));
  const up = vec3.normalize(vec3.cross(right, forward));
  return { eye, right, up, forward };
}

export class HmrRenderer {
  private gpu?: WebGpuContextResources;
  private pointBuffers?: GpuTrackerRenderBuffers;
  private pipelines?: GpuPipelines;
  private buffers?: GpuBuffers;
  private bindGroups?: {
    volume: GPUBindGroup;
    surface: GPUBindGroup;
    shell: GPUBindGroup;
    shellMetrics: GPUBindGroup;
    composite: GPUBindGroup;
  };
  private sampler?: GPUSampler;
  private offscreen?: OffscreenTargets;
  private presentationSize = { width: 1, height: 1 };
  private surfaceTargetSize = { width: 1, height: 1 };
  private pointCapacity: number;
  private simulationFrame = -1;
  private shellMetricsDirty = true;
  private volumeDirty = true;
  private renderTick = 0;
  private modeCount = 1;
  private renderMode: RenderMode = "hybrid";

  constructor(private readonly canvas: HTMLCanvasElement, private config: EngineConfig) {
    this.pointCapacity = 0;
  }

  async init(gpu: WebGpuContextResources, pointBuffers: GpuTrackerRenderBuffers): Promise<void> {
    this.gpu = gpu;
    this.pointBuffers = pointBuffers;
    this.pointCapacity = pointBuffers.pointCapacity;
    this.createResources();
    this.resize(this.canvas.clientWidth || 1, this.canvas.clientHeight || 1);
  }

  updateConfig(config: EngineConfig): void {
    const resizeNeeded =
      config.renderScale !== this.config.renderScale ||
      config.quality.surfaceResolutionScale !== this.config.quality.surfaceResolutionScale;
    this.config = config;
    this.shellMetricsDirty = true;
    this.volumeDirty = true;
    if (resizeNeeded) {
      this.resize(this.canvas.clientWidth || 1, this.canvas.clientHeight || 1);
    }
  }

  resize(width: number, height: number): void {
    if (!this.gpu || !this.offscreen) {
      return;
    }

    const devicePixelRatio = window.devicePixelRatio || 1;
    const scaledWidth = Math.max(1, Math.floor(width * devicePixelRatio * this.config.renderScale));
    const scaledHeight = Math.max(1, Math.floor(height * devicePixelRatio * this.config.renderScale));
    this.presentationSize = { width: scaledWidth, height: scaledHeight };
    this.canvas.width = scaledWidth;
    this.canvas.height = scaledHeight;

    this.offscreen.volume.destroy();
    this.offscreen.surfaceColor.destroy();
    this.offscreen.surfaceDepth.destroy();
    this.offscreen.shell.destroy();
    this.surfaceTargetSize = {
      width: Math.max(1, Math.floor(scaledWidth * this.config.quality.surfaceResolutionScale)),
      height: Math.max(1, Math.floor(scaledHeight * this.config.quality.surfaceResolutionScale))
    };
    this.offscreen = {
      volume: createOffscreenTexture(
        this.gpu.device,
        [
          Math.max(1, Math.floor(scaledWidth * VOLUME_RESOLUTION_SCALE)),
          Math.max(1, Math.floor(scaledHeight * VOLUME_RESOLUTION_SCALE))
        ],
        "volume-target",
        "rgba8unorm"
      ),
      surfaceColor: createOffscreenTexture(
        this.gpu.device,
        [this.surfaceTargetSize.width, this.surfaceTargetSize.height],
        "surface-color-target",
        "rgba8unorm"
      ),
      surfaceDepth: createOffscreenTexture(
        this.gpu.device,
        [this.surfaceTargetSize.width, this.surfaceTargetSize.height],
        "surface-depth-target",
        "r16float"
      ),
      shell: createOffscreenTexture(this.gpu.device, [scaledWidth, scaledHeight], "shell-target", "rgba8unorm")
    };
    this.volumeDirty = true;
    this.createBindGroups();
  }

  render(scene: RendererScene): void {
    if (!this.gpu || !this.pointBuffers || !this.pipelines || !this.buffers || !this.bindGroups || !this.offscreen) {
      return;
    }

    this.writeFrameUniforms(scene);
    this.writeClusterBuffers(scene.clusters);
    this.renderTick += 1;
    if (scene.renderMode !== this.renderMode) {
      this.renderMode = scene.renderMode;
      this.shellMetricsDirty = true;
    }
    if (scene.frameState.frame !== this.simulationFrame) {
      this.simulationFrame = scene.frameState.frame;
      this.shellMetricsDirty = true;
      this.volumeDirty = true;
    }

    const commandEncoder = this.gpu.device.createCommandEncoder({
      label: "hmr-command-encoder"
    });

    if (this.shellMetricsDirty) {
      const computePass = commandEncoder.beginComputePass({
        label: "shell-metrics-pass"
      });
      computePass.setPipeline(this.pipelines.shellMetrics);
      computePass.setBindGroup(0, this.bindGroups.shellMetrics);
      computePass.dispatchWorkgroups(Math.ceil(Math.max(1, this.pointCapacity) / 64));
      computePass.end();
      this.shellMetricsDirty = false;
    }

    if (this.volumeDirty || this.renderTick % VOLUME_PASS_CADENCE === 0) {
      const volumePass = commandEncoder.beginRenderPass({
        label: "volume-pass",
        colorAttachments: [
          {
            view: this.offscreen.volume.createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: "clear",
            storeOp: "store"
          }
        ]
      });
      volumePass.setPipeline(this.pipelines.volume);
      volumePass.setBindGroup(0, this.bindGroups.volume);
      volumePass.draw(3, 1, 0, 0);
      volumePass.end();
      this.volumeDirty = false;
    }

    const surfacePass = commandEncoder.beginRenderPass({
      label: "surface-pass",
      colorAttachments: [
        {
          view: this.offscreen.surfaceColor.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store"
        },
        {
          view: this.offscreen.surfaceDepth.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });
    if (scene.renderMode !== "points") {
      surfacePass.setPipeline(this.pipelines.surface);
      surfacePass.setBindGroup(0, this.bindGroups.surface);
      surfacePass.draw(3, 1, 0, 0);
    }
    surfacePass.end();

    const shellPass = commandEncoder.beginRenderPass({
      label: "shell-pass",
      colorAttachments: [
        {
          view: this.offscreen.shell.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });
    shellPass.setPipeline(this.pipelines.shell);
    shellPass.setBindGroup(0, this.bindGroups.shell);
    shellPass.draw(QUAD_VERTEX_COUNT, this.pointCapacity, 0, 0);
    shellPass.end();

    const compositePass = commandEncoder.beginRenderPass({
      label: "composite-pass",
      colorAttachments: [
        {
          view: this.gpu.canvasContext.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });
    compositePass.setPipeline(this.pipelines.composite);
    compositePass.setBindGroup(0, this.bindGroups.composite);
    compositePass.draw(3, 1, 0, 0);
    compositePass.end();

    this.gpu.queue.submit([commandEncoder.finish()]);
  }

  dispose(): void {
    this.offscreen?.volume.destroy();
    this.offscreen?.surfaceColor.destroy();
    this.offscreen?.surfaceDepth.destroy();
    this.offscreen?.shell.destroy();
    this.buffers?.frame.destroy();
    this.buffers?.clusters.destroy();
    this.buffers?.modes.destroy();
    this.buffers?.pointMetrics.destroy();
  }

  private createResources(): void {
    if (!this.gpu) {
      return;
    }
    const { device, format } = this.gpu;

    this.buffers = {
      frame: createBuffer(
        device,
        "frame-uniform-buffer",
        FRAME_UNIFORM_FLOATS * Float32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      ),
      clusters: createBuffer(
        device,
        "cluster-storage-buffer",
        GPU_RUNTIME_CLUSTER_CAPACITY * GPU_FIELD_CLUSTER_FLOATS * Float32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      ),
      modes: createBuffer(
        device,
        "mode-storage-buffer",
        GPU_RUNTIME_MODE_CAPACITY * GPU_FIELD_MODE_FLOATS * Float32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      ),
      pointMetrics: createBuffer(
        device,
        "point-metrics-storage-buffer",
        this.pointCapacity * FLOATS_PER_METRIC * Float32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      )
    };

    this.pipelines = {
      volume: device.createRenderPipeline({
        label: "volume-pipeline",
        layout: "auto",
        vertex: {
          module: device.createShaderModule({ code: shaderModules.volumeShader }),
          entryPoint: "vsMain"
        },
        fragment: {
          module: device.createShaderModule({ code: shaderModules.volumeShader }),
          entryPoint: "fsMain",
          targets: [{ format: "rgba8unorm" }]
        },
        primitive: {
          topology: "triangle-list"
        }
      }),
      surface: device.createRenderPipeline({
        label: "surface-pipeline",
        layout: "auto",
        vertex: {
          module: device.createShaderModule({ code: shaderModules.surfaceShader }),
          entryPoint: "vsMain"
        },
        fragment: {
          module: device.createShaderModule({ code: shaderModules.surfaceShader }),
          entryPoint: "fsMain",
          targets: [{ format: "rgba8unorm" }, { format: "r16float" }]
        },
        primitive: {
          topology: "triangle-list"
        }
      }),
      shell: device.createRenderPipeline({
        label: "shell-pipeline",
        layout: "auto",
        vertex: {
          module: device.createShaderModule({ code: shaderModules.shellShader }),
          entryPoint: "vsMain"
        },
        fragment: {
          module: device.createShaderModule({ code: shaderModules.shellShader }),
          entryPoint: "fsMain",
          targets: [
            {
              format: "rgba8unorm",
              blend: {
                color: {
                  srcFactor: "src-alpha",
                  dstFactor: "one",
                  operation: "add"
                },
                alpha: {
                  srcFactor: "one",
                  dstFactor: "one-minus-src-alpha",
                  operation: "add"
                }
              }
            }
          ]
        },
        primitive: {
          topology: "triangle-list"
        }
      }),
      composite: device.createRenderPipeline({
        label: "composite-pipeline",
        layout: "auto",
        vertex: {
          module: device.createShaderModule({ code: shaderModules.compositeShader }),
          entryPoint: "vsMain"
        },
        fragment: {
          module: device.createShaderModule({ code: shaderModules.compositeShader }),
          entryPoint: "fsMain",
          targets: [{ format }]
        },
        primitive: {
          topology: "triangle-list"
        }
      }),
      shellMetrics: device.createComputePipeline({
        label: "shell-metrics-pipeline",
        layout: "auto",
        compute: {
          module: device.createShaderModule({ code: shaderModules.shellMetricsShader }),
          entryPoint: "csMain"
        }
      })
    };

    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear"
    });
    this.offscreen = {
      volume: createOffscreenTexture(device, [1, 1], "volume-target", "rgba8unorm"),
      surfaceColor: createOffscreenTexture(device, [1, 1], "surface-color-target", "rgba8unorm"),
      surfaceDepth: createOffscreenTexture(device, [1, 1], "surface-depth-target", "r16float"),
      shell: createOffscreenTexture(device, [1, 1], "shell-target", "rgba8unorm")
    };
    this.createBindGroups();
  }

  private createBindGroups(): void {
    if (!this.gpu || !this.pointBuffers || !this.pipelines || !this.buffers || !this.offscreen || !this.sampler) {
      return;
    }
    const { device } = this.gpu;

    this.bindGroups = {
      volume: device.createBindGroup({
        layout: this.pipelines.volume.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.buffers.frame } },
          { binding: 1, resource: { buffer: this.buffers.clusters } },
          { binding: 2, resource: { buffer: this.buffers.modes } }
        ]
      }),
      surface: device.createBindGroup({
        layout: this.pipelines.surface.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.buffers.frame } },
          { binding: 1, resource: { buffer: this.buffers.clusters } },
          { binding: 2, resource: { buffer: this.buffers.modes } }
        ]
      }),
      shellMetrics: device.createBindGroup({
        layout: this.pipelines.shellMetrics.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.buffers.frame } },
          { binding: 1, resource: { buffer: this.pointBuffers.currentPoints } },
          { binding: 2, resource: { buffer: this.buffers.pointMetrics } }
        ]
      }),
      shell: device.createBindGroup({
        layout: this.pipelines.shell.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.buffers.frame } },
          { binding: 1, resource: { buffer: this.pointBuffers.currentPoints } },
          { binding: 2, resource: { buffer: this.pointBuffers.previousPoints } },
          { binding: 3, resource: { buffer: this.buffers.pointMetrics } },
          { binding: 4, resource: this.offscreen.surfaceDepth.createView() }
        ]
      }),
      composite: device.createBindGroup({
        layout: this.pipelines.composite.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.buffers.frame } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: this.offscreen.volume.createView() },
          { binding: 3, resource: this.offscreen.surfaceColor.createView() },
          { binding: 4, resource: this.offscreen.shell.createView() }
        ]
      })
    };
  }

  private writeFrameUniforms(scene: RendererScene): void {
    if (!this.gpu || !this.buffers) {
      return;
    }
    const { eye, right, up, forward } = cameraBasis(scene.camera);
    const frame = new Float32Array(FRAME_UNIFORM_FLOATS);
    frame.set([eye[0], eye[1], eye[2], 0], 0);
    frame.set([right[0], right[1], right[2], 0], 4);
    frame.set([up[0], up[1], up[2], 0], 8);
    frame.set([forward[0], forward[1], forward[2], 0], 12);
    frame.set(
      [
        Math.tan(scene.camera.fovY / 2),
        this.presentationSize.width / this.presentationSize.height,
        scene.frameState.time,
        this.config.surfaceThreshold
      ],
      16
    );
    frame.set(
      [
        scene.post.exposure,
        scene.post.shellComposite,
        scene.post.volumeComposite,
        scene.post.bloomGain
      ],
      20
    );
    frame.set(
      [
        scene.clusters.length,
        this.pointCapacity,
        scene.frameState.quality.raymarchSteps,
        scene.frameState.quality.pointSizeScale
      ],
      24
    );
    frame.set(
      [
        this.presentationSize.width,
        this.presentationSize.height,
        scene.frameState.quality.shellOpacity,
        scene.frameState.quality.shellDensity
      ],
      28
    );
    frame.set(
      [scene.simulationAge, scene.snapshotBlendAlpha, renderModeIndex(scene.renderMode), scene.post.surfaceComposite],
      32
    );
    frame.set(
      [
        scene.frameState.quality.surfaceSteps,
        scene.frameState.quality.markerDensity,
        scene.frameState.quality.vorticityGain,
        scene.frameState.quality.burstGain
      ],
      36
    );

    this.gpu.queue.writeBuffer(this.buffers.frame, 0, frame);
  }

  private writeClusterBuffers(clusters: FieldClusterSpec[]): void {
    if (!this.gpu || !this.buffers) {
      return;
    }
    const { clusterData, modeData, modeCount } = packFieldClustersAndModes(clusters);
    this.modeCount = modeCount;
    this.gpu.queue.writeBuffer(
      this.buffers.clusters,
      0,
      clusterData.buffer as ArrayBuffer,
      clusterData.byteOffset,
      clusterData.byteLength
    );
    this.gpu.queue.writeBuffer(
      this.buffers.modes,
      0,
      modeData.buffer as ArrayBuffer,
      modeData.byteOffset,
      modeData.byteLength
    );
  }
}
