export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];
export type Complex = [number, number];
export type RenderMode = "points" | "surface" | "hybrid";

export type PhotonPointState =
  | "active"
  | "drifting"
  | "birthing"
  | "dying"
  | "nodal";

export interface PhotonPoint {
  id: number;
  position: Vec3;
  velocity: Vec3;
  normal: Vec3;
  density: number;
  phase: number;
  coherence: number;
  sdfRadius: number;
  brightness: number;
  age: number;
  lifetime: number;
  state: PhotonPointState;
  clusterAffinity: string;
  surfaceLock: number;
}

export interface PhotonSpawnRule {
  minSpacing: number;
  maxSpacing: number;
  maxBirthsPerStep: number;
  maxCullPerStep: number;
  targetCoverage: number;
  nodalCullThreshold: number;
}

export interface FieldModeSpec {
  id: string;
  amplitude: number;
  radialScale: number;
  radialOffset: number;
  angularSharpness: number;
  phaseOffset: number;
  phaseVelocity: number;
  swirl: number;
  direction: Vec3;
}

export interface FieldClusterSpec {
  id: string;
  label: string;
  center: Vec3;
  orientation: Vec3;
  structural: {
    kernelDensity: number;
    formRank: number;
    formComplexity: number;
    coherence: number;
    shellThreshold: number;
  };
  dynamic: {
    energyInput: number;
    excitationState: number;
    transitionTension: number;
    mergeAffinity: number;
    nodalRepulsion: number;
    turbulence: number;
    decayRate: number;
  };
  visual: {
    phaseMapping: number;
    emissionGain: number;
    bloomResponse: number;
    pointDensity: number;
    surfaceThickness: number;
    spectralSpread: number;
  };
  modes: FieldModeSpec[];
}

export interface SceneCamera {
  target: Vec3;
  yaw: number;
  pitch: number;
  radius: number;
  fovY: number;
  near: number;
  far: number;
  orbitSpeed: number;
}

export interface ScenePostSettings {
  exposure: number;
  bloomGain: number;
  shellComposite: number;
  volumeComposite: number;
  surfaceComposite: number;
}

export interface SceneControl {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  initial: number;
}

export interface SceneExcitation {
  targetClusterId: string;
  startTime: number;
  duration: number;
  energyDelta: number;
  phaseDrift: number;
}

export interface ScenePreset {
  id: string;
  label: string;
  description: string;
  clusters: FieldClusterSpec[];
  camera: SceneCamera;
  post: ScenePostSettings;
  controls: SceneControl[];
  excitations: SceneExcitation[];
}

export interface EngineQuality {
  raymarchSteps: number;
  surfaceSteps: number;
  shellOpacity: number;
  shellDensity: number;
  pointSizeScale: number;
  surfaceResolutionScale: number;
  markerDensity: number;
  vorticityGain: number;
  burstGain: number;
}

export interface EngineConfig {
  fixedTimeStep: number;
  maxSubSteps: number;
  pointBudget: number;
  brickBudget: number;
  brickResolution: number;
  renderScale: number;
  surfaceThreshold: number;
  surfaceProjectionEpsilon: number;
  shellRelaxation: number;
  velocityScale: number;
  lodFlowLimit: number;
  quality: EngineQuality;
  spawn: PhotonSpawnRule;
}

export interface ActiveBrick {
  coord: Vec3;
  energy: number;
  clusterIds: string[];
}

export interface EngineFrameState {
  time: number;
  frame: number;
  fps: number;
  pointCount: number;
  activeBricks: number;
  averageDensity: number;
  averageCoherence: number;
  maxFlow: number;
  peakVorticity: number;
  peakBurst: number;
  shellCoverage: number;
  quality: EngineQuality;
}

export interface FieldSample {
  psi: Complex;
  rho: number;
  phase: number;
  gradRho: Vec3;
  current: Vec3;
  flow: Vec3;
  coherence: number;
  shellDistance: number;
}

export interface FlowDiagnostics {
  vorticity: Vec3;
  divergence: number;
  burst: number;
  speed: number;
}
