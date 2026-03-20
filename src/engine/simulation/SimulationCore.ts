import { buildActiveBricks } from "../field/brickPool";
import { applyExcitations, averageFieldMetrics, sampleField } from "../field/fieldMath";
import { getPresetById, SCENE_PRESETS } from "../presets";
import { packPhotonPointSlots } from "../renderPacking";
import { SurfaceTracker } from "../surface/surfaceTracker";
import type {
  EngineConfig,
  EngineFrameState,
  FieldClusterSpec,
  ScenePreset
} from "../types";
import { cloneDefaultConfig, mergeConfig } from "../config";

export interface SimulationSnapshot {
  clusters: FieldClusterSpec[];
  packedPoints: Float32Array;
  pointCount: number;
  frameState: EngineFrameState;
}

const DEFAULT_QUALITY = cloneDefaultConfig().quality;

export class SimulationCore {
  private readonly tracker = new SurfaceTracker();
  private config: EngineConfig;
  private preset: ScenePreset = getPresetById(SCENE_PRESETS[0].id);
  private animatedClusters: FieldClusterSpec[] = this.preset.clusters;
  private frameState: EngineFrameState;
  private accumulator = 0;
  private frame = 0;
  private time = 0;
  private fpsSmoother = 60;
  private readonly pointSlotById = new Map<number, number>();
  private freePointSlots: number[] = [];
  private nextPointSlot = 0;

  constructor(config?: Partial<EngineConfig>, preset?: ScenePreset) {
    this.config = mergeConfig(cloneDefaultConfig(), config);
    this.tracker.configure(this.config);
    if (preset) {
      this.preset = structuredClone(preset);
    }
    this.animatedClusters = this.preset.clusters;
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
    this.resetSimulation();
  }

  loadPreset(presetOrId: ScenePreset | string): SimulationSnapshot {
    this.preset = typeof presetOrId === "string" ? getPresetById(presetOrId) : structuredClone(presetOrId);
    this.resetSimulation();
    return this.getSnapshot();
  }

  updateConfig(partial?: Partial<EngineConfig>): SimulationSnapshot {
    if (partial) {
      const pointBudgetChanged =
        partial.pointBudget !== undefined && partial.pointBudget !== this.config.pointBudget;
      this.config = mergeConfig(this.config, partial);
      this.tracker.configure(this.config);
      if (pointBudgetChanged) {
        this.resetPointSlots();
        this.syncPointSlots(this.tracker.getPoints());
      }
      this.frameState = {
        ...this.frameState,
        pointCount: Math.min(this.tracker.getPoints().length, this.config.pointBudget),
        quality: structuredClone(this.config.quality)
      };
    }
    return this.getSnapshot();
  }

  step(dt: number): SimulationSnapshot {
    this.fpsSmoother = this.fpsSmoother * 0.92 + (1 / Math.max(dt, 1e-4)) * 0.08;
    this.accumulator += dt;
    let subSteps = 0;
    while (this.accumulator >= this.config.fixedTimeStep && subSteps < this.config.maxSubSteps) {
      this.advanceFixedStep(this.config.fixedTimeStep);
      this.accumulator -= this.config.fixedTimeStep;
      subSteps += 1;
    }
    return this.getSnapshot();
  }

  getSnapshot(): SimulationSnapshot {
    const points = this.tracker.getPoints();
    this.syncPointSlots(points);
    const pointCount = Math.min(points.length, this.config.pointBudget);
    return {
      clusters: this.animatedClusters,
      packedPoints: packPhotonPointSlots(points, this.pointSlotById, this.config.pointBudget),
      pointCount,
      frameState: {
        ...this.frameState,
        pointCount,
        quality: structuredClone(this.config.quality)
      }
    };
  }

  private resetSimulation(): void {
    this.time = 0;
    this.frame = 0;
    this.accumulator = 0;
    this.animatedClusters = applyExcitations(this.preset.clusters, this.preset.excitations, this.time);
    this.tracker.seed(this.animatedClusters, this.time);
    this.resetPointSlots();
    this.syncPointSlots(this.tracker.getPoints());
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

  private resetPointSlots(): void {
    this.pointSlotById.clear();
    this.freePointSlots = [];
    this.nextPointSlot = 0;
  }

  private syncPointSlots(points: Array<{ id: number }>): void {
    const liveIds = new Set(points.map((point) => point.id));
    for (const [pointId, slot] of this.pointSlotById) {
      if (liveIds.has(pointId)) {
        continue;
      }
      this.pointSlotById.delete(pointId);
      this.freePointSlots.push(slot);
    }

    for (const point of points) {
      if (this.pointSlotById.has(point.id)) {
        continue;
      }
      const slot = this.acquirePointSlot();
      if (slot === -1) {
        break;
      }
      this.pointSlotById.set(point.id, slot);
    }
  }

  private acquirePointSlot(): number {
    const recycledSlot = this.freePointSlots.pop();
    if (recycledSlot !== undefined) {
      return recycledSlot;
    }
    if (this.nextPointSlot >= this.config.pointBudget) {
      return -1;
    }
    const slot = this.nextPointSlot;
    this.nextPointSlot += 1;
    return slot;
  }

  private advanceFixedStep(dt: number): void {
    this.time += dt;
    this.frame += 1;
    this.animatedClusters = applyExcitations(this.preset.clusters, this.preset.excitations, this.time);
    this.tracker.step(this.animatedClusters, this.time, dt);

    const pointSamples = this.tracker
      .getPoints()
      .filter((_, index) => index % 4 === this.frame % 4)
      .slice(0, 24)
      .map((point) => sampleField(this.animatedClusters, point.position, this.time, this.config.surfaceThreshold));
    const metrics = averageFieldMetrics(pointSamples);
    const activeBricks = buildActiveBricks(
      this.tracker.getPoints(),
      this.animatedClusters,
      this.config.brickBudget,
      this.config.brickResolution
    );

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
        DEFAULT_QUALITY.raymarchSteps,
        this.config.quality.raymarchSteps + 1
      );
      this.config.quality.shellDensity = Math.min(
        DEFAULT_QUALITY.shellDensity,
        this.config.quality.shellDensity + 0.005
      );
      this.config.quality.pointSizeScale = Math.min(
        DEFAULT_QUALITY.pointSizeScale,
        this.config.quality.pointSizeScale + 0.003
      );
    }
    this.tracker.configure(this.config);
  }
}
