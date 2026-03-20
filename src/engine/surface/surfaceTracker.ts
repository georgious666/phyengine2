import { DEFAULT_ENGINE_CONFIG } from "../defaults";
import { sampleField, tangentFlow, projectToSurface, estimateShellRadius } from "../field/fieldMath";
import { vec3 } from "../math/vec3";
import type { EngineConfig, FieldClusterSpec, PhotonPoint, Vec3 } from "../types";
import { mulberry32 } from "../util/random";

interface TrackerStats {
  coverage: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function sphericalDirection(index: number, total: number): Vec3 {
  const t = (index + 0.5) / total;
  const y = 1 - 2 * t;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = GOLDEN_ANGLE * index;
  return [Math.cos(theta) * radius, y, Math.sin(theta) * radius];
}

function projectCandidate(
  clusters: FieldClusterSpec[],
  position: Vec3,
  time: number,
  config: EngineConfig
): { position: Vec3; sampleRho: number } {
  let currentPosition = vec3.clone(position);
  let sample = sampleField(clusters, currentPosition, time, config.surfaceThreshold);
  for (let iteration = 0; iteration < 3; iteration += 1) {
    currentPosition = projectToSurface(
      currentPosition,
      sample,
      config.surfaceThreshold,
      1,
      config.surfaceProjectionEpsilon
    );
    sample = sampleField(clusters, currentPosition, time, config.surfaceThreshold);
  }
  return { position: currentPosition, sampleRho: sample.rho };
}

function nearestDistance(candidate: Vec3, points: PhotonPoint[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const point of points) {
    best = Math.min(best, vec3.distance(candidate, point.position));
  }
  return best;
}

function tangentialRepulsion(current: PhotonPoint, points: PhotonPoint[], strength: number): Vec3 {
  let force: Vec3 = [0, 0, 0];
  for (const other of points) {
    if (other.id === current.id) {
      continue;
    }
    const offset = vec3.sub(current.position, other.position);
    const distance = vec3.length(offset);
    if (distance < 1e-5 || distance > strength) {
      continue;
    }
    const away = vec3.scale(vec3.normalize(offset), (strength - distance) / strength);
    force = vec3.add(force, away);
  }
  return force;
}

export class SurfaceTracker {
  private points: PhotonPoint[] = [];
  private nextId = 1;
  private random = mulberry32(1337);
  private stats: TrackerStats = { coverage: 0 };

  constructor(private config: EngineConfig = DEFAULT_ENGINE_CONFIG) {}

  configure(config: EngineConfig): void {
    this.config = config;
  }

  getPoints(): PhotonPoint[] {
    return this.points;
  }

  getCoverage(): number {
    return this.stats.coverage;
  }

  seed(clusters: FieldClusterSpec[], time: number): void {
    this.points = [];
    this.nextId = 1;
    const targetPoints = Math.max(240, Math.floor(this.config.pointBudget * this.config.quality.shellDensity));
    const perCluster = Math.max(64, Math.floor(targetPoints / Math.max(1, clusters.length)));
    for (const cluster of clusters) {
      for (let index = 0; index < perCluster; index += 1) {
        const direction = sphericalDirection(index, perCluster);
        const radius = 0.7 + cluster.structural.formRank * 0.62;
        const candidate = vec3.add(cluster.center, vec3.scale(direction, radius));
        const projection = projectCandidate(clusters, candidate, time, this.config);
        if (Math.abs(projection.sampleRho - this.config.surfaceThreshold) > 0.25) {
          continue;
        }
        if (nearestDistance(projection.position, this.points) < this.config.spawn.minSpacing * 0.66) {
          continue;
        }
        this.points.push(this.createPoint(clusters, projection.position, cluster.id, time, "birthing"));
        if (this.points.length >= targetPoints) {
          break;
        }
      }
    }
    this.rebuildPointSdf();
    this.stats.coverage = this.computeCoverage();
  }

  step(clusters: FieldClusterSpec[], time: number, dt: number): void {
    const updatedPoints: PhotonPoint[] = [];
    for (const point of this.points) {
      const initialSample = sampleField(clusters, point.position, time, this.config.surfaceThreshold);
      const normal = vec3.normalize(initialSample.gradRho);
      const tangentialVelocity = tangentFlow(initialSample.flow, normal);
      const relax = tangentialRepulsion(point, this.points, this.config.spawn.maxSpacing);
      const tangentialRelax = tangentFlow(relax, normal);
      const predicted = vec3.add(
        point.position,
        vec3.scale(
          vec3.add(
            vec3.scale(vec3.clampLength(tangentialVelocity, this.config.lodFlowLimit), this.config.velocityScale),
            vec3.scale(tangentialRelax, this.config.shellRelaxation)
          ),
          dt
        )
      );

      let projected = predicted;
      let projectedSample = sampleField(clusters, projected, time, this.config.surfaceThreshold);
      projected = projectToSurface(
        projected,
        projectedSample,
        this.config.surfaceThreshold,
        point.surfaceLock,
        this.config.surfaceProjectionEpsilon
      );
      projectedSample = sampleField(clusters, projected, time, this.config.surfaceThreshold);
      const projectedNormal = vec3.normalize(projectedSample.gradRho);

      if (projectedSample.rho < this.config.spawn.nodalCullThreshold) {
        continue;
      }

      updatedPoints.push({
        ...point,
        position: projected,
        velocity: tangentialVelocity,
        normal: projectedNormal,
        density: projectedSample.rho,
        phase: projectedSample.phase,
        coherence: projectedSample.coherence,
        brightness: projectedSample.coherence * (0.55 + projectedSample.rho * 0.7),
        age: point.age + dt,
        state:
          projectedSample.coherence < 0.22
            ? "nodal"
            : point.state === "birthing" && point.age > 0.12
              ? "active"
              : "active"
      });
    }

    this.points = updatedPoints;
    this.spawn(clusters, time);
    this.cull(clusters, time);
    this.rebuildPointSdf();
    this.stats.coverage = this.computeCoverage();
  }

  private spawn(clusters: FieldClusterSpec[], time: number): void {
    const targetCount = Math.max(240, Math.floor(this.config.pointBudget * this.config.quality.shellDensity));
    if (this.points.length >= targetCount) {
      return;
    }

    let births = 0;
    while (
      births < this.config.spawn.maxBirthsPerStep &&
      this.points.length < targetCount
    ) {
      const cluster = clusters[Math.floor(this.random() * clusters.length)];
      const direction = sphericalDirection(
        Math.floor(this.random() * Math.max(64, targetCount)),
        Math.max(64, targetCount)
      );
      const jitter = 0.82 + this.random() * 0.72;
      const candidate = vec3.add(cluster.center, vec3.scale(direction, cluster.structural.formRank * jitter));
      const projection = projectCandidate(clusters, candidate, time, this.config);
      const distance = nearestDistance(projection.position, this.points);
      if (
        projection.sampleRho < this.config.surfaceThreshold * 0.55 ||
        distance < this.config.spawn.minSpacing ||
        distance > this.config.spawn.maxSpacing * 1.8
      ) {
        births += 1;
        continue;
      }
      this.points.push(this.createPoint(clusters, projection.position, cluster.id, time, "birthing"));
      births += 1;
    }
  }

  private cull(clusters: FieldClusterSpec[], time: number): void {
    if (this.points.length === 0) {
      return;
    }

    const kept: PhotonPoint[] = [];
    let removed = 0;
    const sortedByDensity = [...this.points].sort((a, b) => b.density - a.density);
    for (const point of sortedByDensity) {
      if (removed >= this.config.spawn.maxCullPerStep && kept.length > 0) {
        kept.push(point);
        continue;
      }
      const sample = sampleField(clusters, point.position, time, this.config.surfaceThreshold);
      const nearest = nearestDistance(point.position, kept);
      const tooClose = nearest < this.config.spawn.minSpacing * 0.72;
      const tooFar = Math.abs(sample.rho - this.config.surfaceThreshold) > 0.28;
      const agedOut = point.age > point.lifetime;
      if (tooClose || tooFar || agedOut) {
        removed += 1;
        continue;
      }
      kept.push({ ...point, density: sample.rho, coherence: sample.coherence });
    }
    this.points = kept.slice(0, this.config.pointBudget);
  }

  private rebuildPointSdf(): void {
    this.points = this.points.map((point) => {
      const spacing = Math.max(
        this.config.spawn.minSpacing,
        Math.min(this.config.spawn.maxSpacing, nearestDistance(point.position, this.points.filter((entry) => entry.id !== point.id)))
      );
      return {
        ...point,
        sdfRadius: estimateShellRadius(point, spacing),
        brightness: point.brightness * (0.75 + Math.min(1, spacing / this.config.spawn.maxSpacing) * 0.35)
      };
    });
  }

  private computeCoverage(): number {
    const targetCount = Math.max(240, Math.floor(this.config.pointBudget * this.config.quality.shellDensity));
    return Math.min(1, this.points.length / targetCount);
  }

  private createPoint(
    clusters: FieldClusterSpec[],
    position: Vec3,
    clusterAffinity: string,
    time: number,
    state: PhotonPoint["state"]
  ): PhotonPoint {
    const initial = sampleField(clusters, position, time, this.config.surfaceThreshold);
    return {
      id: this.nextId++,
      position,
      velocity: [0, 0, 0],
      normal: vec3.normalize(initial.gradRho),
      density: initial.rho,
      phase: initial.phase,
      coherence: initial.coherence,
      sdfRadius: this.config.spawn.minSpacing,
      brightness: initial.coherence * (0.55 + initial.rho * 0.7),
      age: 0,
      lifetime: 24 + this.random() * 16,
      state,
      clusterAffinity,
      surfaceLock: 0.9
    };
  }
}
