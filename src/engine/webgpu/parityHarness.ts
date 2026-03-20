import { cloneDefaultConfig, mergeConfig } from "../config";
import { applyExcitations } from "../field/fieldMath";
import { SCENE_PRESETS } from "../presets";
import { SurfaceTracker } from "../surface/surfaceTracker";
import type { EngineConfig, PhotonPoint, ScenePreset } from "../types";
import { createWebGpuContext } from "./context";
import { GpuSurfaceTracker } from "./gpuSurfaceTracker";
import type { GpuTrackerMetricsSnapshot } from "./trackerTypes";

const DEFAULT_STEPS = 60;

export interface ParityMetric {
  cpu: number;
  gpu: number;
  delta: number;
  tolerance: number;
  passed: boolean;
}

export interface ParityScenarioResult {
  presetId: string;
  pointCount: ParityMetric;
  shellCoverage: ParityMetric;
  averageDeviation: ParityMetric;
  averageDensity: ParityMetric;
  averageCoherence: ParityMetric;
  maxFlow: ParityMetric;
  passed: boolean;
}

export interface ParityHarnessResult {
  scenarios: ParityScenarioResult[];
  bridgeDominanceMaintained: boolean;
  allPassed: boolean;
}

function averageDeviation(points: Array<Pick<PhotonPoint, "density">>, surfaceThreshold: number): number {
  if (points.length === 0) {
    return 0;
  }
  return points.reduce((sum, point) => sum + Math.abs(point.density - surfaceThreshold), 0) / points.length;
}

function averageDensity(points: Array<Pick<PhotonPoint, "density">>): number {
  if (points.length === 0) {
    return 0;
  }
  return points.reduce((sum, point) => sum + point.density, 0) / points.length;
}

function averageCoherence(points: Array<Pick<PhotonPoint, "coherence">>): number {
  if (points.length === 0) {
    return 0;
  }
  return points.reduce((sum, point) => sum + point.coherence, 0) / points.length;
}

function maxFlow(points: Array<Pick<PhotonPoint, "velocity">>): number {
  return points.reduce(
    (max, point) => Math.max(max, Math.hypot(point.velocity[0], point.velocity[1], point.velocity[2])),
    0
  );
}

function targetCount(config: EngineConfig): number {
  return Math.max(240, Math.floor(config.pointBudget * config.quality.shellDensity));
}

function createMetric(cpu: number, gpu: number, tolerance: number): ParityMetric {
  const delta = Math.abs(cpu - gpu);
  return {
    cpu,
    gpu,
    delta,
    tolerance,
    passed: delta <= tolerance
  };
}

function gpuSnapshotAsPoints(snapshot: GpuTrackerMetricsSnapshot): PhotonPoint[] {
  return snapshot.points.map((point) => ({
    id: point.slot + 1,
    position: point.position,
    velocity: point.velocity,
    normal: [0, 1, 0],
    density: point.density,
    phase: 0,
    coherence: point.coherence,
    sdfRadius: 0,
    brightness: point.brightness,
    age: 0,
    lifetime: 0,
    state: "active",
    clusterAffinity: String(point.clusterIndex),
    surfaceLock: 0.9
  }));
}

async function waitForSnapshot(tracker: GpuSurfaceTracker, frame: number): Promise<GpuTrackerMetricsSnapshot> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await Promise.resolve();
    const snapshot = tracker.consumeLatestSnapshot();
    if (snapshot && snapshot.frame === frame) {
      return snapshot;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for GPU tracker snapshot for frame ${frame}.`);
}

async function runScenario(
  canvas: HTMLCanvasElement,
  preset: ScenePreset,
  config: EngineConfig,
  steps: number
): Promise<ParityScenarioResult> {
  const gpu = await createWebGpuContext(canvas);
  const tracker = new GpuSurfaceTracker(gpu, config);
  const cpuTracker = new SurfaceTracker(config);

  let clusters = applyExcitations(preset.clusters, preset.excitations, 0);
  cpuTracker.seed(clusters, 0);
  tracker.uploadSeed(cpuTracker.getPoints(), clusters);
  tracker.consumeLatestSnapshot();

  let gpuSnapshot: GpuTrackerMetricsSnapshot | null = null;
  for (let frame = 1; frame <= steps; frame += 1) {
    const time = frame * config.fixedTimeStep;
    clusters = applyExcitations(preset.clusters, preset.excitations, time);
    cpuTracker.step(clusters, time, config.fixedTimeStep);
    tracker.step(clusters, time, config.fixedTimeStep, frame);
    await gpu.queue.onSubmittedWorkDone();
    gpuSnapshot = await waitForSnapshot(tracker, frame);
  }

  if (!gpuSnapshot) {
    throw new Error(`No GPU snapshot collected for preset ${preset.id}.`);
  }

  const cpuPoints = cpuTracker.getPoints();
  const gpuPoints = gpuSnapshotAsPoints(gpuSnapshot);
  tracker.dispose();

  const pointCountMetric = createMetric(cpuPoints.length, gpuSnapshot.pointCount, Math.max(1, cpuPoints.length * 0.01));
  const shellCoverageMetric = createMetric(cpuTracker.getCoverage(), gpuSnapshot.shellCoverage, 0.02);
  const averageDeviationMetric = createMetric(
    averageDeviation(cpuPoints, config.surfaceThreshold),
    averageDeviation(gpuPoints, config.surfaceThreshold),
    0.02
  );
  const averageDensityMetric = createMetric(averageDensity(cpuPoints), averageDensity(gpuPoints), 0.015);
  const averageCoherenceMetric = createMetric(averageCoherence(cpuPoints), averageCoherence(gpuPoints), 0.03);
  const maxFlowMetric = createMetric(maxFlow(cpuPoints), maxFlow(gpuPoints), 0.05);

  const passed =
    pointCountMetric.passed &&
    shellCoverageMetric.passed &&
    averageDeviationMetric.passed &&
    averageDensityMetric.passed &&
    averageCoherenceMetric.passed &&
    maxFlowMetric.passed;

  return {
    presetId: preset.id,
    pointCount: pointCountMetric,
    shellCoverage: shellCoverageMetric,
    averageDeviation: averageDeviationMetric,
    averageDensity: averageDensityMetric,
    averageCoherence: averageCoherenceMetric,
    maxFlow: maxFlowMetric,
    passed
  };
}

export async function runSurfaceTrackerParityHarness(options: {
  canvas: HTMLCanvasElement;
  config?: Partial<EngineConfig>;
  presets?: ScenePreset[];
  steps?: number;
}): Promise<ParityHarnessResult> {
  const config = mergeConfig(cloneDefaultConfig(), options.config);
  const presets = options.presets ?? SCENE_PRESETS;
  const steps = options.steps ?? DEFAULT_STEPS;
  const scenarios: ParityScenarioResult[] = [];

  for (const preset of presets) {
    scenarios.push(await runScenario(options.canvas, preset, config, steps));
  }

  const bridge = scenarios.find((scenario) => scenario.presetId === "coherent-bridge");
  const nodal = scenarios.find((scenario) => scenario.presetId === "nodal-gap");
  const bridgeDominanceMaintained =
    bridge !== undefined &&
    nodal !== undefined &&
    bridge.averageCoherence.gpu > nodal.averageCoherence.gpu;

  return {
    scenarios,
    bridgeDominanceMaintained,
    allPassed: bridgeDominanceMaintained && scenarios.every((scenario) => scenario.passed)
  };
}
