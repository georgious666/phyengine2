export interface GpuTrackerRenderBuffers {
  currentPoints: GPUBuffer;
  previousPoints: GPUBuffer;
  pointCapacity: number;
}

export interface GpuTrackerMetricPoint {
  slot: number;
  position: [number, number, number];
  velocity: [number, number, number];
  density: number;
  coherence: number;
  brightness: number;
  clusterIndex: number;
}

export interface GpuTrackerMetricsSnapshot {
  frame: number;
  pointCount: number;
  shellCoverage: number;
  points: GpuTrackerMetricPoint[];
}
