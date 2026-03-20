import { shaderModules } from "./shaderModules";
import type {
  EngineConfig,
  EngineFrameState,
  FieldClusterSpec,
  SceneCamera,
  ScenePostSettings,
  Vec3
} from "../types";
import { FLOATS_PER_POINT } from "../renderPacking";
import { createWebGpuContext, type WebGpuContextResources } from "./context";
import { orbitCamera } from "../math/mat4";
import { vec3 } from "../math/vec3";

const MAX_CLUSTERS = 8;
const FLOATS_PER_CLUSTER = 16;
const FLOATS_PER_METRIC = 4;
const FRAME_UNIFORM_FLOATS = 32;
const QUAD_VERTEX_COUNT = 6;

interface RendererScene {
  clusters: FieldClusterSpec[];
  packedPoints: ArrayBuffer;
  pointCount: number;
  camera: SceneCamera;
  post: ScenePostSettings;
  frameState: EngineFrameState;
}

interface GpuPipelines {
  volume: GPURenderPipeline;
  shell: GPURenderPipeline;
  composite: GPURenderPipeline;
  shellMetrics: GPUComputePipeline;
}

interface GpuBuffers {
  frame: GPUBuffer;
  clusters: GPUBuffer;
  points: GPUBuffer;
  pointMetrics: GPUBuffer;
}

interface OffscreenTargets {
  volume: GPUTexture;
  shell: GPUTexture;
}

function createBuffer(device: GPUDevice, label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer {
  return device.createBuffer({
    label,
    size,
    usage
  });
}

function createOffscreenTexture(device: GPUDevice, size: GPUExtent3DStrict, label: string): GPUTexture {
  return device.createTexture({
    label,
    size,
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
  });
}

function packCluster(cluster: FieldClusterSpec): number[] {
  return [
    cluster.center[0],
    cluster.center[1],
    cluster.center[2],
    cluster.structural.shellThreshold,
    cluster.orientation[0],
    cluster.orientation[1],
    cluster.orientation[2],
    cluster.visual.phaseMapping,
    cluster.structural.kernelDensity,
    cluster.structural.formRank,
    cluster.structural.formComplexity,
    cluster.structural.coherence,
    cluster.dynamic.excitationState,
    cluster.visual.emissionGain,
    cluster.visual.surfaceThickness,
    cluster.visual.spectralSpread
  ];
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
  private pipelines?: GpuPipelines;
  private buffers?: GpuBuffers;
  private bindGroups?: {
    volume: GPUBindGroup;
    shell: GPUBindGroup;
    shellMetrics: GPUBindGroup;
    composite: GPUBindGroup;
  };
  private sampler?: GPUSampler;
  private offscreen?: OffscreenTargets;
  private presentationSize = { width: 1, height: 1 };
  private pointCapacity: number;

  constructor(private readonly canvas: HTMLCanvasElement, private config: EngineConfig) {
    this.pointCapacity = config.pointBudget;
  }

  async init(): Promise<void> {
    this.gpu = await createWebGpuContext(this.canvas);
    this.createResources();
    this.resize(this.canvas.clientWidth || 1, this.canvas.clientHeight || 1);
  }

  updateConfig(config: EngineConfig): void {
    const pointBudgetChanged = config.pointBudget !== this.pointCapacity;
    this.config = config;
    if (pointBudgetChanged) {
      this.pointCapacity = config.pointBudget;
      this.recreatePointBuffers();
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
    this.offscreen.shell.destroy();
    this.offscreen = {
      volume: createOffscreenTexture(this.gpu.device, [scaledWidth, scaledHeight], "volume-target"),
      shell: createOffscreenTexture(this.gpu.device, [scaledWidth, scaledHeight], "shell-target")
    };
    this.createBindGroups();
  }

  render(scene: RendererScene): void {
    if (!this.gpu || !this.pipelines || !this.buffers || !this.bindGroups || !this.offscreen) {
      return;
    }

    this.writeFrameUniforms(scene);
    this.writeClusterBuffer(scene.clusters);
    this.writePointBuffer(scene.packedPoints, scene.pointCount);

    const commandEncoder = this.gpu.device.createCommandEncoder({
      label: "hmr-command-encoder"
    });

    const computePass = commandEncoder.beginComputePass({
      label: "shell-metrics-pass"
    });
    computePass.setPipeline(this.pipelines.shellMetrics);
    computePass.setBindGroup(0, this.bindGroups.shellMetrics);
    computePass.dispatchWorkgroups(Math.ceil(Math.max(1, scene.pointCount) / 64));
    computePass.end();

    const volumePass = commandEncoder.beginRenderPass({
      label: "volume-pass",
      colorAttachments: [
        {
          view: this.offscreen.volume.createView(),
          clearValue: { r: 0.02, g: 0.03, b: 0.05, a: 1 },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });
    volumePass.setPipeline(this.pipelines.volume);
    volumePass.setBindGroup(0, this.bindGroups.volume);
    volumePass.draw(3, 1, 0, 0);
    volumePass.end();

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
    shellPass.draw(QUAD_VERTEX_COUNT, scene.pointCount, 0, 0);
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
    this.offscreen?.shell.destroy();
    this.buffers?.frame.destroy();
    this.buffers?.clusters.destroy();
    this.buffers?.points.destroy();
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
        MAX_CLUSTERS * FLOATS_PER_CLUSTER * Float32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      ),
      points: createBuffer(
        device,
        "point-storage-buffer",
        this.pointCapacity * FLOATS_PER_POINT * Float32Array.BYTES_PER_ELEMENT,
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
      volume: createOffscreenTexture(device, [1, 1], "volume-target"),
      shell: createOffscreenTexture(device, [1, 1], "shell-target")
    };
    this.createBindGroups();
  }

  private createBindGroups(): void {
    if (!this.gpu || !this.pipelines || !this.buffers || !this.offscreen || !this.sampler) {
      return;
    }
    const { device } = this.gpu;

    this.bindGroups = {
      volume: device.createBindGroup({
        layout: this.pipelines.volume.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.buffers.frame } },
          { binding: 1, resource: { buffer: this.buffers.clusters } }
        ]
      }),
      shellMetrics: device.createBindGroup({
        layout: this.pipelines.shellMetrics.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.buffers.frame } },
          { binding: 1, resource: { buffer: this.buffers.points } },
          { binding: 2, resource: { buffer: this.buffers.pointMetrics } }
        ]
      }),
      shell: device.createBindGroup({
        layout: this.pipelines.shell.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.buffers.frame } },
          { binding: 1, resource: { buffer: this.buffers.points } },
          { binding: 2, resource: { buffer: this.buffers.pointMetrics } }
        ]
      }),
      composite: device.createBindGroup({
        layout: this.pipelines.composite.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.buffers.frame } },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: this.offscreen.volume.createView() },
          { binding: 3, resource: this.offscreen.shell.createView() }
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
        scene.pointCount,
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

    this.gpu.queue.writeBuffer(this.buffers.frame, 0, frame);
  }

  private writeClusterBuffer(clusters: FieldClusterSpec[]): void {
    if (!this.gpu || !this.buffers) {
      return;
    }
    const data = new Float32Array(MAX_CLUSTERS * FLOATS_PER_CLUSTER);
    clusters.slice(0, MAX_CLUSTERS).forEach((cluster, index) => {
      data.set(packCluster(cluster), index * FLOATS_PER_CLUSTER);
    });
    this.gpu.queue.writeBuffer(this.buffers.clusters, 0, data);
  }

  private writePointBuffer(packedPoints: ArrayBuffer, pointCount: number): void {
    if (!this.gpu || !this.buffers) {
      return;
    }
    this.gpu.queue.writeBuffer(
      this.buffers.points,
      0,
      packedPoints,
      0,
      Math.min(pointCount, this.pointCapacity) * FLOATS_PER_POINT * Float32Array.BYTES_PER_ELEMENT
    );
  }

  private recreatePointBuffers(): void {
    if (!this.gpu || !this.buffers) {
      return;
    }
    this.buffers.points.destroy();
    this.buffers.pointMetrics.destroy();
    this.buffers.points = createBuffer(
      this.gpu.device,
      "point-storage-buffer",
      this.pointCapacity * FLOATS_PER_POINT * Float32Array.BYTES_PER_ELEMENT,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    );
    this.buffers.pointMetrics = createBuffer(
      this.gpu.device,
      "point-metrics-storage-buffer",
      this.pointCapacity * FLOATS_PER_METRIC * Float32Array.BYTES_PER_ELEMENT,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    );
    this.createBindGroups();
  }
}
