import type {
  Complex,
  FieldClusterSpec,
  FieldSample,
  FieldModeSpec,
  PhotonPoint,
  SceneExcitation,
  Vec3
} from "../types";
import { complex } from "../math/complex";
import { vec3 } from "../math/vec3";

const FIELD_EPSILON = 1e-5;
const GRADIENT_STEP = 0.035;

function rotateEuler(v: Vec3, rotation: Vec3): Vec3 {
  const [rx, ry, rz] = rotation;
  const sx = Math.sin(rx);
  const cx = Math.cos(rx);
  const sy = Math.sin(ry);
  const cy = Math.cos(ry);
  const sz = Math.sin(rz);
  const cz = Math.cos(rz);

  const yx: Vec3 = [v[0], v[1] * cx - v[2] * sx, v[1] * sx + v[2] * cx];
  const yy: Vec3 = [yx[0] * cy + yx[2] * sy, yx[1], -yx[0] * sy + yx[2] * cy];
  return [yy[0] * cz - yy[1] * sz, yy[0] * sz + yy[1] * cz, yy[2]];
}

function inverseRotateEuler(v: Vec3, rotation: Vec3): Vec3 {
  return rotateEuler(v, [-rotation[0], -rotation[1], -rotation[2]]);
}

function gaussianShell(r: number, radialScale: number, radialOffset: number): number {
  const sigma = Math.max(radialScale, 0.08);
  const delta = r - radialOffset;
  return Math.exp(-(delta * delta) / (2 * sigma * sigma));
}

function angularEnvelope(local: Vec3, direction: Vec3, sharpness: number): number {
  const dir = vec3.normalize(direction);
  const radial = vec3.normalize(local);
  const signed = 0.5 + 0.5 * vec3.dot(radial, dir);
  return Math.pow(Math.max(0.01, signed), Math.max(0.15, sharpness));
}

function modeAmplitude(mode: FieldModeSpec, cluster: FieldClusterSpec, local: Vec3, time: number): number {
  const r = vec3.length(local);
  const shell = gaussianShell(
    r,
    mode.radialScale / Math.max(0.55, cluster.structural.formRank),
    mode.radialOffset
  );
  const envelope = angularEnvelope(local, mode.direction, mode.angularSharpness * cluster.structural.formComplexity);
  const excitationBoost = 1 + cluster.dynamic.energyInput * 0.32 + cluster.dynamic.excitationState * 0.45;
  const turbulence = 1 + 0.08 * cluster.dynamic.turbulence * Math.sin(time * 1.7 + r * 2.3);
  return (
    mode.amplitude *
    cluster.structural.kernelDensity *
    cluster.structural.coherence *
    shell *
    envelope *
    excitationBoost *
    turbulence
  );
}

function modePhase(mode: FieldModeSpec, cluster: FieldClusterSpec, local: Vec3, time: number): number {
  const spin = Math.atan2(local[1], local[0]);
  const axial = local[2] * 0.7 + local[0] * 0.35;
  return (
    mode.phaseOffset +
    cluster.visual.phaseMapping +
    mode.phaseVelocity * time * (1 + cluster.dynamic.transitionTension * 0.35) +
    mode.swirl * spin +
    cluster.dynamic.turbulence * 0.12 * axial
  );
}

function sampleClusterMode(cluster: FieldClusterSpec, mode: FieldModeSpec, worldPosition: Vec3, time: number): Complex {
  const centered = vec3.sub(worldPosition, cluster.center);
  const local = inverseRotateEuler(centered, cluster.orientation);
  const radius = modeAmplitude(mode, cluster, local, time);
  const phase = modePhase(mode, cluster, local, time);
  return complex.fromPolar(radius, phase);
}

export function sampleClusterPsi(cluster: FieldClusterSpec, worldPosition: Vec3, time: number): Complex {
  return cluster.modes.reduce<Complex>(
    (sum, mode) => complex.add(sum, sampleClusterMode(cluster, mode, worldPosition, time)),
    [0, 0]
  );
}

export function applyExcitations(clusters: FieldClusterSpec[], excitations: SceneExcitation[], time: number): FieldClusterSpec[] {
  return clusters.map((cluster) => {
    let energyInput = cluster.dynamic.energyInput;
    let excitationState = cluster.dynamic.excitationState;
    let phaseMapping = cluster.visual.phaseMapping;
    for (const excitation of excitations) {
      if (excitation.targetClusterId !== cluster.id) {
        continue;
      }
      if (time < excitation.startTime || time > excitation.startTime + excitation.duration) {
        continue;
      }
      const progress = (time - excitation.startTime) / excitation.duration;
      const window = Math.sin(progress * Math.PI);
      energyInput += excitation.energyDelta * window;
      excitationState += window * 0.75;
      phaseMapping += excitation.phaseDrift * window;
    }

    return {
      ...cluster,
      dynamic: {
        ...cluster.dynamic,
        energyInput,
        excitationState
      },
      visual: {
        ...cluster.visual,
        phaseMapping
      }
    };
  });
}

export function samplePsi(clusters: FieldClusterSpec[], worldPosition: Vec3, time: number): Complex {
  return clusters.reduce<Complex>(
    (sum, cluster) => complex.add(sum, sampleClusterPsi(cluster, worldPosition, time)),
    [0, 0]
  );
}

export function densityFromPsi(psi: Complex): number {
  return complex.abs2(psi);
}

export function phaseFromPsi(psi: Complex): number {
  return complex.phase(psi);
}

function axisOffset(axis: 0 | 1 | 2, delta: number): Vec3 {
  const out: Vec3 = [0, 0, 0];
  out[axis] = delta;
  return out;
}

function differentiate(
  clusters: FieldClusterSpec[],
  position: Vec3,
  time: number,
  axis: 0 | 1 | 2,
  step = GRADIENT_STEP
): Complex {
  const plus = samplePsi(clusters, vec3.add(position, axisOffset(axis, step)), time);
  const minus = samplePsi(clusters, vec3.add(position, axisOffset(axis, -step)), time);
  return [(plus[0] - minus[0]) / (2 * step), (plus[1] - minus[1]) / (2 * step)];
}

function rhoAt(clusters: FieldClusterSpec[], position: Vec3, time: number): number {
  return densityFromPsi(samplePsi(clusters, position, time));
}

export function gradientRho(clusters: FieldClusterSpec[], position: Vec3, time: number): Vec3 {
  return [
    (rhoAt(clusters, vec3.add(position, [GRADIENT_STEP, 0, 0]), time) -
      rhoAt(clusters, vec3.add(position, [-GRADIENT_STEP, 0, 0]), time)) /
      (2 * GRADIENT_STEP),
    (rhoAt(clusters, vec3.add(position, [0, GRADIENT_STEP, 0]), time) -
      rhoAt(clusters, vec3.add(position, [0, -GRADIENT_STEP, 0]), time)) /
      (2 * GRADIENT_STEP),
    (rhoAt(clusters, vec3.add(position, [0, 0, GRADIENT_STEP]), time) -
      rhoAt(clusters, vec3.add(position, [0, 0, -GRADIENT_STEP]), time)) /
      (2 * GRADIENT_STEP)
  ];
}

export function probabilityCurrent(clusters: FieldClusterSpec[], position: Vec3, time: number): Vec3 {
  const psi = samplePsi(clusters, position, time);
  const dPsiDx = differentiate(clusters, position, time, 0);
  const dPsiDy = differentiate(clusters, position, time, 1);
  const dPsiDz = differentiate(clusters, position, time, 2);
  const [a, b] = psi;

  return [
    a * dPsiDx[1] - b * dPsiDx[0],
    a * dPsiDy[1] - b * dPsiDy[0],
    a * dPsiDz[1] - b * dPsiDz[0]
  ];
}

export function flowVelocity(psi: Complex, current: Vec3): Vec3 {
  const rho = densityFromPsi(psi);
  return vec3.scale(current, 1 / (rho + FIELD_EPSILON));
}

export function coherenceMetric(clusters: FieldClusterSpec[], position: Vec3, time: number): number {
  const magnitudes = clusters.map((cluster) => Math.sqrt(densityFromPsi(sampleClusterPsi(cluster, position, time))));
  const sum = magnitudes.reduce((total, value) => total + value, 0);
  if (sum <= FIELD_EPSILON) {
    return 0;
  }
  const totalMagnitude = Math.sqrt(rhoAt(clusters, position, time));
  return Math.max(0, Math.min(1, totalMagnitude / sum));
}

export function sampleField(
  clusters: FieldClusterSpec[],
  position: Vec3,
  time: number,
  surfaceThreshold: number
): FieldSample {
  const psi = samplePsi(clusters, position, time);
  const rho = densityFromPsi(psi);
  const phase = phaseFromPsi(psi);
  const gradRho = gradientRho(clusters, position, time);
  const current = probabilityCurrent(clusters, position, time);
  const flow = flowVelocity(psi, current);
  const coherence = coherenceMetric(clusters, position, time);
  const gradientMagnitude = vec3.length(gradRho);
  const shellDistance = (rho - surfaceThreshold) / (gradientMagnitude + FIELD_EPSILON);

  return {
    psi,
    rho,
    phase,
    gradRho,
    current,
    flow,
    coherence,
    shellDistance
  };
}

export function tangentFlow(flow: Vec3, normal: Vec3): Vec3 {
  return vec3.sub(flow, vec3.scale(normal, vec3.dot(flow, normal)));
}

export function projectToSurface(
  position: Vec3,
  sample: FieldSample,
  surfaceThreshold: number,
  lockStrength: number,
  epsilon: number
): Vec3 {
  const denom = vec3.dot(sample.gradRho, sample.gradRho) + epsilon;
  const correction = ((sample.rho - surfaceThreshold) / denom) * lockStrength;
  return vec3.sub(position, vec3.scale(sample.gradRho, correction));
}

export function estimateShellRadius(point: Pick<PhotonPoint, "density" | "coherence">, thickness: number): number {
  const densityGain = Math.max(0.14, Math.min(1.4, point.density));
  return thickness * (0.22 + densityGain * 0.16 + point.coherence * 0.2);
}

export function averageFieldMetrics(samples: FieldSample[]): Pick<FieldSample, "rho" | "coherence"> & { maxFlow: number } {
  if (samples.length === 0) {
    return { rho: 0, coherence: 0, maxFlow: 0 };
  }
  const totals = samples.reduce(
    (acc, sample) => {
      acc.rho += sample.rho;
      acc.coherence += sample.coherence;
      acc.maxFlow = Math.max(acc.maxFlow, vec3.length(sample.flow));
      return acc;
    },
    { rho: 0, coherence: 0, maxFlow: 0 }
  );

  return {
    rho: totals.rho / samples.length,
    coherence: totals.coherence / samples.length,
    maxFlow: totals.maxFlow
  };
}
