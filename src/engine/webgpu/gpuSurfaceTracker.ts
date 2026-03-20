import { FLOATS_PER_POINT } from "../renderPacking";
import { GPU_RUNTIME_CLUSTER_CAPACITY, GPU_RUNTIME_MODE_CAPACITY, GPU_RUNTIME_POINT_CAPACITY } from "../runtimeLimits";
import type { EngineConfig, FieldClusterSpec, PhotonPoint, Vec3 } from "../types";
import { advanceMulberry32State } from "../util/random";
import type { WebGpuContextResources } from "./context";
import type { GpuTrackerMetricsSnapshot, GpuTrackerRenderBuffers } from "./trackerTypes";
import { shaderModules } from "./shaderModules";

const FLOATS_PER_STATE = 8;
const FLOATS_PER_COMPACT_METRIC = 12;
const GLOBAL_STATE_UINTS = 4;
const FRAME_UNIFORM_FLOATS = 24;
const GRID_MARGIN_MULTIPLIER = 4;
const GRID_CELL_UINTS = 4;
const CULL_CADENCE = 4;
const READBACK_CADENCE = 6;

interface GridBounds {
  min: Vec3;
  dims: [number, number, number];
  cellCount: number;
}

interface TrackerBuffers extends GpuTrackerRenderBuffers {
  pointState: GPUBuffer;
  scratchPoints: GPUBuffer;
  scratchState: GPUBuffer;
  clusters: GPUBuffer;
  modes: GPUBuffer;
  uniforms: GPUBuffer;
  globalState: GPUBuffer;
  freeSlots: GPUBuffer;
  gridCells: GPUBuffer;
  gridIndices: GPUBuffer;
  sortIndices: GPUBuffer;
  compactMetrics: GPUBuffer;
}

interface ReadbackSlot {
  buffer: GPUBuffer;
  busy: boolean;
}

function createBuffer(device: GPUDevice, label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer {
  return device.createBuffer({ label, size, usage });
}

function createZeroFloatArray(length: number): Float32Array {
  return new Float32Array(length);
}

function pointStateIndex(state: PhotonPoint["state"]): number {
  switch (state) {
    case "birthing":
      return 1;
    case "dying":
      return 2;
    case "nodal":
      return 3;
    case "drifting":
      return 4;
    default:
      return 0;
  }
}

function createPointRecordArray(points: PhotonPoint[], clusterIndexById: ReadonlyMap<string, number>) {
  const pointData = new Float32Array(GPU_RUNTIME_POINT_CAPACITY * FLOATS_PER_POINT);
  const stateBuffer = new ArrayBuffer(GPU_RUNTIME_POINT_CAPACITY * FLOATS_PER_STATE * Float32Array.BYTES_PER_ELEMENT);
  const stateFloats = new Float32Array(stateBuffer);
  const stateUints = new Uint32Array(stateBuffer);

  points.slice(0, GPU_RUNTIME_POINT_CAPACITY).forEach((point, slot) => {
    const pointBase = slot * FLOATS_PER_POINT;
    pointData[pointBase + 0] = point.position[0];
    pointData[pointBase + 1] = point.position[1];
    pointData[pointBase + 2] = point.position[2];
    pointData[pointBase + 3] = point.sdfRadius;
    pointData[pointBase + 4] = point.normal[0];
    pointData[pointBase + 5] = point.normal[1];
    pointData[pointBase + 6] = point.normal[2];
    pointData[pointBase + 7] = pointStateIndex(point.state);
    pointData[pointBase + 8] = point.velocity[0];
    pointData[pointBase + 9] = point.velocity[1];
    pointData[pointBase + 10] = point.velocity[2];
    pointData[pointBase + 11] = point.density;
    pointData[pointBase + 12] = point.phase;
    pointData[pointBase + 13] = point.brightness;
    pointData[pointBase + 14] = point.coherence;
    pointData[pointBase + 15] = point.id;

    const stateBase = slot * FLOATS_PER_STATE;
    stateFloats[stateBase + 0] = point.age;
    stateFloats[stateBase + 1] = point.lifetime;
    stateFloats[stateBase + 2] = point.surfaceLock;
    stateFloats[stateBase + 3] = 0;
    stateUints[stateBase + 4] = clusterIndexById.get(point.clusterAffinity) ?? 0;
    stateUints[stateBase + 5] = 1;
    stateUints[stateBase + 6] = 0;
    stateUints[stateBase + 7] = 0;
  });

  return {
    pointData,
    stateBuffer
  };
}

function computeGridBounds(points: PhotonPoint[], config: EngineConfig): GridBounds {
  const margin = config.spawn.maxSpacing * GRID_MARGIN_MULTIPLIER;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const point of points) {
    minX = Math.min(minX, point.position[0]);
    minY = Math.min(minY, point.position[1]);
    minZ = Math.min(minZ, point.position[2]);
    maxX = Math.max(maxX, point.position[0]);
    maxY = Math.max(maxY, point.position[1]);
    maxZ = Math.max(maxZ, point.position[2]);
  }

  const min: Vec3 = [minX - margin, minY - margin, minZ - margin];
  const max: Vec3 = [maxX + margin, maxY + margin, maxZ + margin];
  const cellSize = config.spawn.maxSpacing;
  const dims: [number, number, number] = [
    Math.max(1, Math.ceil((max[0] - min[0]) / cellSize) + 1),
    Math.max(1, Math.ceil((max[1] - min[1]) / cellSize) + 1),
    Math.max(1, Math.ceil((max[2] - min[2]) / cellSize) + 1)
  ];

  return {
    min,
    dims,
    cellCount: dims[0] * dims[1] * dims[2]
  };
}

function targetPointCount(config: EngineConfig): number {
  return Math.max(240, Math.floor(config.pointBudget * config.quality.shellDensity));
}

export class GpuSurfaceTracker {
  private readonly device: GPUDevice;
  private readonly queue: GPUQueue;
  private config: EngineConfig;
  private buffers: TrackerBuffers;
  private pipelines: {
    rebuild: GPUComputePipeline;
    update: GPUComputePipeline;
    spawn: GPUComputePipeline;
    sort: GPUComputePipeline;
    cull: GPUComputePipeline;
    sdf: GPUComputePipeline;
  };
  private bindGroups: {
    rebuild: GPUBindGroup;
    update: GPUBindGroup;
    spawn: GPUBindGroup;
    sort: GPUBindGroup;
    cull: GPUBindGroup;
    sdf: GPUBindGroup;
  };
  private gridBounds: GridBounds = {
    min: [-1, -1, -1],
    dims: [1, 1, 1],
    cellCount: 1
  };
  private latestSnapshot: GpuTrackerMetricsSnapshot | null = null;
  private readbackSlots: ReadbackSlot[];
  private currentPointCount = 0;
  private allocatedGridCellCount = 1;

  constructor(gpu: WebGpuContextResources, config: EngineConfig) {
    this.device = gpu.device;
    this.queue = gpu.queue;
    this.config = config;
    this.buffers = this.createBuffers(1);
    this.pipelines = this.createPipelines();
    this.bindGroups = this.createBindGroups();
    this.readbackSlots = [
      {
        buffer: createBuffer(
          this.device,
          "tracker-readback-0",
          GPU_RUNTIME_POINT_CAPACITY * FLOATS_PER_COMPACT_METRIC * Float32Array.BYTES_PER_ELEMENT +
            GLOBAL_STATE_UINTS * Uint32Array.BYTES_PER_ELEMENT,
          GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        ),
        busy: false
      },
      {
        buffer: createBuffer(
          this.device,
          "tracker-readback-1",
          GPU_RUNTIME_POINT_CAPACITY * FLOATS_PER_COMPACT_METRIC * Float32Array.BYTES_PER_ELEMENT +
            GLOBAL_STATE_UINTS * Uint32Array.BYTES_PER_ELEMENT,
          GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        ),
        busy: false
      }
    ];
  }

  getRenderBuffers(): GpuTrackerRenderBuffers {
    return {
      currentPoints: this.buffers.currentPoints,
      previousPoints: this.buffers.previousPoints,
      pointCapacity: GPU_RUNTIME_POINT_CAPACITY
    };
  }

  configure(config: EngineConfig): void {
    this.config = config;
  }

  uploadSeed(points: PhotonPoint[], clusters: FieldClusterSpec[]): void {
    const boundedPoints = points.slice(0, GPU_RUNTIME_POINT_CAPACITY);
    this.currentPointCount = boundedPoints.length;
    this.gridBounds = computeGridBounds(boundedPoints, this.config);
    this.recreateGridBuffers(this.gridBounds.cellCount);

    const clusterIndexById = new Map(clusters.map((cluster, index) => [cluster.id, index]));
    const { pointData, stateBuffer } = createPointRecordArray(boundedPoints, clusterIndexById);
    const freeSlots = new Uint32Array(GPU_RUNTIME_POINT_CAPACITY);
    for (let slot = boundedPoints.length; slot < GPU_RUNTIME_POINT_CAPACITY; slot += 1) {
      freeSlots[slot - boundedPoints.length] = slot;
    }
    const globalState = new Uint32Array(GLOBAL_STATE_UINTS);
    const lastPointId = boundedPoints.reduce((maxId, point) => Math.max(maxId, point.id), 0);
    globalState[0] = lastPointId + 1;
    globalState[1] = advanceMulberry32State(1337, boundedPoints.length);
    globalState[2] = boundedPoints.length;
    globalState[3] = GPU_RUNTIME_POINT_CAPACITY - boundedPoints.length;

    this.queue.writeBuffer(this.buffers.currentPoints, 0, pointData.buffer as ArrayBuffer, pointData.byteOffset, pointData.byteLength);
    this.queue.writeBuffer(this.buffers.previousPoints, 0, pointData.buffer as ArrayBuffer, pointData.byteOffset, pointData.byteLength);
    const zeroScratchPoints = createZeroFloatArray(pointData.length);
    this.queue.writeBuffer(
      this.buffers.scratchPoints,
      0,
      zeroScratchPoints.buffer as ArrayBuffer,
      zeroScratchPoints.byteOffset,
      zeroScratchPoints.byteLength
    );
    this.queue.writeBuffer(this.buffers.pointState, 0, stateBuffer);
    this.queue.writeBuffer(this.buffers.scratchState, 0, new Uint8Array(stateBuffer.byteLength));
    this.queue.writeBuffer(
      this.buffers.globalState,
      0,
      globalState.buffer as ArrayBuffer,
      globalState.byteOffset,
      globalState.byteLength
    );
    this.queue.writeBuffer(this.buffers.freeSlots, 0, freeSlots.buffer as ArrayBuffer, freeSlots.byteOffset, freeSlots.byteLength);
    const zeroSortIndices = new Uint32Array(GPU_RUNTIME_POINT_CAPACITY);
    this.queue.writeBuffer(
      this.buffers.sortIndices,
      0,
      zeroSortIndices.buffer as ArrayBuffer,
      zeroSortIndices.byteOffset,
      zeroSortIndices.byteLength
    );
    this.queue.writeBuffer(
      this.buffers.compactMetrics,
      0,
      createZeroFloatArray(GPU_RUNTIME_POINT_CAPACITY * FLOATS_PER_COMPACT_METRIC).buffer as ArrayBuffer
    );
    this.writeClusterAndModeBuffers(clusters);
    this.writeUniforms(clusters.length, clusters.reduce((sum, cluster) => sum + cluster.modes.length, 0), 0, 0);
    this.latestSnapshot = {
      frame: 0,
      pointCount: boundedPoints.length,
      shellCoverage: Math.min(1, boundedPoints.length / targetPointCount(this.config)),
      points: boundedPoints.map((point, slot) => ({
        slot,
        position: [...point.position] as [number, number, number],
        velocity: [...point.velocity] as [number, number, number],
        density: point.density,
        coherence: point.coherence,
        brightness: point.brightness,
        clusterIndex: clusterIndexById.get(point.clusterAffinity) ?? 0
      }))
    };
  }

  step(clusters: FieldClusterSpec[], time: number, dt: number, frame: number): void {
    const modeCount = clusters.reduce((sum, cluster) => sum + cluster.modes.length, 0);
    this.writeClusterAndModeBuffers(clusters);
    this.writeUniforms(clusters.length, modeCount, time, dt);
    const shouldCull = frame % CULL_CADENCE === 0;
    const shouldReadback = frame === 1 || frame % READBACK_CADENCE === 0;

    const encoder = this.device.createCommandEncoder({
      label: `surface-tracker-step-${frame}`
    });

    encoder.copyBufferToBuffer(
      this.buffers.currentPoints,
      0,
      this.buffers.previousPoints,
      0,
      GPU_RUNTIME_POINT_CAPACITY * FLOATS_PER_POINT * Float32Array.BYTES_PER_ELEMENT
    );

    this.dispatchSingle(encoder, this.pipelines.rebuild, this.bindGroups.rebuild, "tracker-rebuild-source");
    this.dispatchPoints(encoder, this.pipelines.update, this.bindGroups.update, "tracker-update");
    encoder.copyBufferToBuffer(
      this.buffers.scratchPoints,
      0,
      this.buffers.currentPoints,
      0,
      GPU_RUNTIME_POINT_CAPACITY * FLOATS_PER_POINT * Float32Array.BYTES_PER_ELEMENT
    );
    encoder.copyBufferToBuffer(
      this.buffers.scratchState,
      0,
      this.buffers.pointState,
      0,
      GPU_RUNTIME_POINT_CAPACITY * FLOATS_PER_STATE * Float32Array.BYTES_PER_ELEMENT
    );
    this.dispatchSingle(encoder, this.pipelines.rebuild, this.bindGroups.rebuild, "tracker-rebuild-updated");
    this.dispatchSingle(encoder, this.pipelines.spawn, this.bindGroups.spawn, "tracker-spawn");
    if (shouldCull) {
      this.dispatchSingle(encoder, this.pipelines.sort, this.bindGroups.sort, "tracker-sort");
      this.dispatchSingle(encoder, this.pipelines.cull, this.bindGroups.cull, "tracker-cull");
    }
    this.dispatchSingle(encoder, this.pipelines.rebuild, this.bindGroups.rebuild, "tracker-rebuild-final");
    this.dispatchPoints(encoder, this.pipelines.sdf, this.bindGroups.sdf, "tracker-sdf");

    const readbackSlot = shouldReadback ? this.readbackSlots.find((slot) => !slot.busy) : undefined;
    if (readbackSlot) {
      readbackSlot.busy = true;
      encoder.copyBufferToBuffer(
        this.buffers.compactMetrics,
        0,
        readbackSlot.buffer,
        0,
        GPU_RUNTIME_POINT_CAPACITY * FLOATS_PER_COMPACT_METRIC * Float32Array.BYTES_PER_ELEMENT
      );
      encoder.copyBufferToBuffer(
        this.buffers.globalState,
        0,
        readbackSlot.buffer,
        GPU_RUNTIME_POINT_CAPACITY * FLOATS_PER_COMPACT_METRIC * Float32Array.BYTES_PER_ELEMENT,
        GLOBAL_STATE_UINTS * Uint32Array.BYTES_PER_ELEMENT
      );
    }

    this.queue.submit([encoder.finish()]);

    if (readbackSlot) {
      void this.captureReadback(readbackSlot, frame, targetPointCount(this.config));
    }
  }

  consumeLatestSnapshot(): GpuTrackerMetricsSnapshot | null {
    const snapshot = this.latestSnapshot;
    this.latestSnapshot = null;
    return snapshot;
  }

  getCurrentPointCount(): number {
    return this.currentPointCount;
  }

  dispose(): void {
    this.buffers.currentPoints.destroy();
    this.buffers.previousPoints.destroy();
    this.buffers.pointState.destroy();
    this.buffers.scratchPoints.destroy();
    this.buffers.scratchState.destroy();
    this.buffers.clusters.destroy();
    this.buffers.modes.destroy();
    this.buffers.uniforms.destroy();
    this.buffers.globalState.destroy();
    this.buffers.freeSlots.destroy();
    this.buffers.gridCells.destroy();
    this.buffers.gridIndices.destroy();
    this.buffers.sortIndices.destroy();
    this.buffers.compactMetrics.destroy();
    this.readbackSlots.forEach((slot) => slot.buffer.destroy());
  }

  private createBuffers(cellCount: number): TrackerBuffers {
    const pointBytes = GPU_RUNTIME_POINT_CAPACITY * FLOATS_PER_POINT * Float32Array.BYTES_PER_ELEMENT;
    const stateBytes = GPU_RUNTIME_POINT_CAPACITY * FLOATS_PER_STATE * Float32Array.BYTES_PER_ELEMENT;
    const uintBytes = GPU_RUNTIME_POINT_CAPACITY * Uint32Array.BYTES_PER_ELEMENT;
    const gridCellBytes = cellCount * GRID_CELL_UINTS * Uint32Array.BYTES_PER_ELEMENT;

    return {
      pointCapacity: GPU_RUNTIME_POINT_CAPACITY,
      currentPoints: createBuffer(
        this.device,
        "tracker-current-points",
        pointBytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
      ),
      previousPoints: createBuffer(
        this.device,
        "tracker-previous-points",
        pointBytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
      ),
      pointState: createBuffer(
        this.device,
        "tracker-point-state",
        stateBytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
      ),
      scratchPoints: createBuffer(
        this.device,
        "tracker-scratch-points",
        pointBytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
      ),
      scratchState: createBuffer(
        this.device,
        "tracker-scratch-state",
        stateBytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
      ),
      clusters: createBuffer(
        this.device,
        "tracker-clusters",
        GPU_RUNTIME_CLUSTER_CAPACITY * 20 * Float32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      ),
      modes: createBuffer(
        this.device,
        "tracker-modes",
        GPU_RUNTIME_MODE_CAPACITY * 12 * Float32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      ),
      uniforms: createBuffer(
        this.device,
        "tracker-uniforms",
        FRAME_UNIFORM_FLOATS * Float32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      ),
      globalState: createBuffer(
        this.device,
        "tracker-global-state",
        GLOBAL_STATE_UINTS * Uint32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
      ),
      freeSlots: createBuffer(
        this.device,
        "tracker-free-slots",
        uintBytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      ),
      gridCells: createBuffer(
        this.device,
        "tracker-grid-cells",
        gridCellBytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      ),
      gridIndices: createBuffer(
        this.device,
        "tracker-grid-indices",
        uintBytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      ),
      sortIndices: createBuffer(
        this.device,
        "tracker-sort-indices",
        uintBytes,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      ),
      compactMetrics: createBuffer(
        this.device,
        "tracker-compact-metrics",
        GPU_RUNTIME_POINT_CAPACITY * FLOATS_PER_COMPACT_METRIC * Float32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
      )
    };
  }

  private recreateGridBuffers(cellCount: number): void {
    if (cellCount === this.allocatedGridCellCount) {
      return;
    }
    this.buffers.gridCells.destroy();
    this.buffers.gridIndices.destroy();
    this.buffers = {
      ...this.buffers,
      gridCells: createBuffer(
        this.device,
        "tracker-grid-cells",
        cellCount * GRID_CELL_UINTS * Uint32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      ),
      gridIndices: createBuffer(
        this.device,
        "tracker-grid-indices",
        GPU_RUNTIME_POINT_CAPACITY * Uint32Array.BYTES_PER_ELEMENT,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      )
    };
    this.allocatedGridCellCount = cellCount;
    this.bindGroups = this.createBindGroups();
  }

  private createBindGroups() {
    return {
      rebuild: this.device.createBindGroup({
        layout: this.pipelines.rebuild.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.buffers.uniforms } },
          { binding: 1, resource: { buffer: this.buffers.currentPoints } },
          { binding: 2, resource: { buffer: this.buffers.pointState } },
          { binding: 8, resource: { buffer: this.buffers.globalState } },
          { binding: 9, resource: { buffer: this.buffers.freeSlots } },
          { binding: 10, resource: { buffer: this.buffers.gridCells } },
          { binding: 11, resource: { buffer: this.buffers.gridIndices } }
        ]
      }),
      update: this.device.createBindGroup({
        layout: this.pipelines.update.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.buffers.uniforms } },
          { binding: 1, resource: { buffer: this.buffers.currentPoints } },
          { binding: 2, resource: { buffer: this.buffers.pointState } },
          { binding: 4, resource: { buffer: this.buffers.scratchPoints } },
          { binding: 5, resource: { buffer: this.buffers.scratchState } },
          { binding: 6, resource: { buffer: this.buffers.clusters } },
          { binding: 7, resource: { buffer: this.buffers.modes } },
          { binding: 10, resource: { buffer: this.buffers.gridCells } },
          { binding: 11, resource: { buffer: this.buffers.gridIndices } }
        ]
      }),
      spawn: this.device.createBindGroup({
        layout: this.pipelines.spawn.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.buffers.uniforms } },
          { binding: 1, resource: { buffer: this.buffers.currentPoints } },
          { binding: 2, resource: { buffer: this.buffers.pointState } },
          { binding: 6, resource: { buffer: this.buffers.clusters } },
          { binding: 7, resource: { buffer: this.buffers.modes } },
          { binding: 8, resource: { buffer: this.buffers.globalState } },
          { binding: 9, resource: { buffer: this.buffers.freeSlots } }
        ]
      }),
      sort: this.device.createBindGroup({
        layout: this.pipelines.sort.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.buffers.uniforms } },
          { binding: 1, resource: { buffer: this.buffers.currentPoints } },
          { binding: 2, resource: { buffer: this.buffers.pointState } },
          { binding: 12, resource: { buffer: this.buffers.sortIndices } }
        ]
      }),
      cull: this.device.createBindGroup({
        layout: this.pipelines.cull.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.buffers.uniforms } },
          { binding: 1, resource: { buffer: this.buffers.currentPoints } },
          { binding: 2, resource: { buffer: this.buffers.pointState } },
          { binding: 9, resource: { buffer: this.buffers.freeSlots } },
          { binding: 12, resource: { buffer: this.buffers.sortIndices } }
        ]
      }),
      sdf: this.device.createBindGroup({
        layout: this.pipelines.sdf.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.buffers.uniforms } },
          { binding: 1, resource: { buffer: this.buffers.currentPoints } },
          { binding: 2, resource: { buffer: this.buffers.pointState } },
          { binding: 10, resource: { buffer: this.buffers.gridCells } },
          { binding: 11, resource: { buffer: this.buffers.gridIndices } },
          { binding: 13, resource: { buffer: this.buffers.compactMetrics } }
        ]
      })
    };
  }

  private createPipelines() {
    const module = this.device.createShaderModule({
      code: shaderModules.surfaceTrackerShader
    });
    return {
      rebuild: this.device.createComputePipeline({
        label: "tracker-rebuild-pipeline",
        layout: "auto",
        compute: {
          module,
          entryPoint: "rebuildStateAndGrid"
        }
      }),
      update: this.device.createComputePipeline({
        label: "tracker-update-pipeline",
        layout: "auto",
        compute: {
          module,
          entryPoint: "updatePoints"
        }
      }),
      spawn: this.device.createComputePipeline({
        label: "tracker-spawn-pipeline",
        layout: "auto",
        compute: {
          module,
          entryPoint: "spawnPoints"
        }
      }),
      sort: this.device.createComputePipeline({
        label: "tracker-sort-pipeline",
        layout: "auto",
        compute: {
          module,
          entryPoint: "sortByDensity"
        }
      }),
      cull: this.device.createComputePipeline({
        label: "tracker-cull-pipeline",
        layout: "auto",
        compute: {
          module,
          entryPoint: "cullPoints"
        }
      }),
      sdf: this.device.createComputePipeline({
        label: "tracker-sdf-pipeline",
        layout: "auto",
        compute: {
          module,
          entryPoint: "rebuildSdfAndMetrics"
        }
      })
    };
  }

  private writeClusterAndModeBuffers(clusters: FieldClusterSpec[]): void {
    const clusterData = new Float32Array(GPU_RUNTIME_CLUSTER_CAPACITY * 20);
    const modeData = new Float32Array(GPU_RUNTIME_MODE_CAPACITY * 12);
    let modeOffset = 0;

    clusters.slice(0, GPU_RUNTIME_CLUSTER_CAPACITY).forEach((cluster, clusterIndex) => {
      const base = clusterIndex * 20;
      clusterData[base + 0] = cluster.center[0];
      clusterData[base + 1] = cluster.center[1];
      clusterData[base + 2] = cluster.center[2];
      clusterData[base + 4] = cluster.orientation[0];
      clusterData[base + 5] = cluster.orientation[1];
      clusterData[base + 6] = cluster.orientation[2];
      clusterData[base + 8] = cluster.structural.kernelDensity;
      clusterData[base + 9] = cluster.structural.formRank;
      clusterData[base + 10] = cluster.structural.formComplexity;
      clusterData[base + 11] = cluster.structural.coherence;
      clusterData[base + 12] = cluster.dynamic.energyInput;
      clusterData[base + 13] = cluster.dynamic.excitationState;
      clusterData[base + 14] = cluster.dynamic.transitionTension;
      clusterData[base + 15] = cluster.dynamic.turbulence;
      clusterData[base + 16] = modeOffset;
      clusterData[base + 17] = cluster.modes.length;
      clusterData[base + 18] = cluster.visual.phaseMapping;

      cluster.modes.forEach((mode) => {
        if (modeOffset >= GPU_RUNTIME_MODE_CAPACITY) {
          return;
        }
        const modeBase = modeOffset * 12;
        modeData[modeBase + 0] = mode.amplitude;
        modeData[modeBase + 1] = mode.radialScale;
        modeData[modeBase + 2] = mode.radialOffset;
        modeData[modeBase + 3] = mode.angularSharpness;
        modeData[modeBase + 4] = mode.phaseOffset;
        modeData[modeBase + 5] = mode.phaseVelocity;
        modeData[modeBase + 6] = mode.swirl;
        modeData[modeBase + 8] = mode.direction[0];
        modeData[modeBase + 9] = mode.direction[1];
        modeData[modeBase + 10] = mode.direction[2];
        modeOffset += 1;
      });
    });

    this.queue.writeBuffer(this.buffers.clusters, 0, clusterData.buffer as ArrayBuffer, clusterData.byteOffset, clusterData.byteLength);
    this.queue.writeBuffer(this.buffers.modes, 0, modeData.buffer as ArrayBuffer, modeData.byteOffset, modeData.byteLength);
  }

  private writeUniforms(clusterCount: number, modeCount: number, time: number, dt: number): void {
    const uniform = new Float32Array(FRAME_UNIFORM_FLOATS);
    uniform.set([time, dt, this.config.surfaceThreshold, this.config.surfaceProjectionEpsilon], 0);
    uniform.set(
      [
        this.config.shellRelaxation,
        this.config.velocityScale,
        this.config.lodFlowLimit,
        targetPointCount(this.config)
      ],
      4
    );
    uniform.set(
      [
        this.config.spawn.minSpacing,
        this.config.spawn.maxSpacing,
        this.config.spawn.maxBirthsPerStep,
        this.config.spawn.maxCullPerStep
      ],
      8
    );
    uniform.set(
      [
        this.gridBounds.min[0],
        this.gridBounds.min[1],
        this.gridBounds.min[2],
        this.config.spawn.maxSpacing
      ],
      12
    );
    uniform.set(
      [
        this.gridBounds.dims[0],
        this.gridBounds.dims[1],
        this.gridBounds.dims[2],
        this.config.spawn.nodalCullThreshold
      ],
      16
    );
    uniform.set([this.config.pointBudget, GPU_RUNTIME_POINT_CAPACITY, clusterCount, modeCount], 20);
    this.queue.writeBuffer(this.buffers.uniforms, 0, uniform.buffer as ArrayBuffer, uniform.byteOffset, uniform.byteLength);
  }

  private dispatchSingle(
    encoder: GPUCommandEncoder,
    pipeline: GPUComputePipeline,
    bindGroup: GPUBindGroup,
    label: string
  ): void {
    const pass = encoder.beginComputePass({ label });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  private dispatchPoints(
    encoder: GPUCommandEncoder,
    pipeline: GPUComputePipeline,
    bindGroup: GPUBindGroup,
    label: string
  ): void {
    const pass = encoder.beginComputePass({ label });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(GPU_RUNTIME_POINT_CAPACITY / 64));
    pass.end();
  }

  private async captureReadback(slot: ReadbackSlot, frame: number, targetCount: number): Promise<void> {
    try {
      await this.queue.onSubmittedWorkDone();
      await slot.buffer.mapAsync(GPUMapMode.READ);
      const copy = slot.buffer.getMappedRange().slice(0);
      slot.buffer.unmap();

      const metricBytes = GPU_RUNTIME_POINT_CAPACITY * FLOATS_PER_COMPACT_METRIC * Float32Array.BYTES_PER_ELEMENT;
      const metrics = new Float32Array(copy, 0, GPU_RUNTIME_POINT_CAPACITY * FLOATS_PER_COMPACT_METRIC);
      const state = new Uint32Array(copy, metricBytes, GLOBAL_STATE_UINTS);
      const points = [];

      for (let slotIndex = 0; slotIndex < GPU_RUNTIME_POINT_CAPACITY; slotIndex += 1) {
        const base = slotIndex * FLOATS_PER_COMPACT_METRIC;
        const alive = metrics[base + 10] > 0.5;
        if (!alive) {
          continue;
        }
        points.push({
          slot: slotIndex,
          position: [metrics[base + 0], metrics[base + 1], metrics[base + 2]] as [number, number, number],
          density: metrics[base + 3],
          velocity: [metrics[base + 4], metrics[base + 5], metrics[base + 6]] as [number, number, number],
          coherence: metrics[base + 7],
          brightness: metrics[base + 8],
          clusterIndex: Math.round(metrics[base + 9])
        });
      }

      this.currentPointCount = state[2];
      this.latestSnapshot = {
        frame,
        pointCount: state[2],
        shellCoverage: Math.min(1, state[2] / Math.max(1, targetCount)),
        points
      };
    } finally {
      slot.busy = false;
    }
  }
}
