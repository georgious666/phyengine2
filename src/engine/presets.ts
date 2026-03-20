import type { FieldClusterSpec, ScenePreset } from "./types";

function createCluster(overrides: Partial<FieldClusterSpec> & Pick<FieldClusterSpec, "id" | "label" | "center">): FieldClusterSpec {
  return {
    id: overrides.id,
    label: overrides.label,
    center: overrides.center,
    orientation: overrides.orientation ?? [0, 0, 0],
    structural: {
      kernelDensity: 1.1,
      formRank: 1.05,
      formComplexity: 1,
      coherence: 0.95,
      shellThreshold: 0.24,
      ...overrides.structural
    },
    dynamic: {
      energyInput: 0.18,
      excitationState: 0,
      transitionTension: 0.12,
      mergeAffinity: 0.35,
      nodalRepulsion: 0.45,
      turbulence: 0.1,
      decayRate: 0.05,
      ...overrides.dynamic
    },
    visual: {
      phaseMapping: 0,
      emissionGain: 1.2,
      bloomResponse: 0.75,
      pointDensity: 1,
      surfaceThickness: 1.2,
      spectralSpread: 1,
      ...overrides.visual
    },
    modes:
      overrides.modes ??
      [
        {
          id: `${overrides.id}-core`,
          amplitude: 1,
          radialScale: 0.82,
          radialOffset: 1.15,
          angularSharpness: 0.8,
          phaseOffset: 0,
          phaseVelocity: 0.65,
          swirl: 0.5,
          direction: [1, 0.4, 0.1]
        },
        {
          id: `${overrides.id}-crest`,
          amplitude: 0.55,
          radialScale: 0.6,
          radialOffset: 0.78,
          angularSharpness: 2.1,
          phaseOffset: 0.9,
          phaseVelocity: -0.24,
          swirl: 1.2,
          direction: [0.2, 1, 0.6]
        }
      ]
  };
}

function coherentBridgeModes(id: string, phaseOffset = 0): FieldClusterSpec["modes"] {
  return [
    {
      id: `${id}-bridge-core`,
      amplitude: 1.08,
      radialScale: 0.86,
      radialOffset: 0.94,
      angularSharpness: 0.6,
      phaseOffset,
      phaseVelocity: 0.5,
      swirl: 0.22,
      direction: [1, 0.1, 0]
    },
    {
      id: `${id}-bridge-band`,
      amplitude: 0.62,
      radialScale: 0.72,
      radialOffset: 1.08,
      angularSharpness: 0.9,
      phaseOffset: phaseOffset + 0.25,
      phaseVelocity: -0.16,
      swirl: 0.35,
      direction: [0.6, 0.2, 0.1]
    }
  ];
}

function nodalModes(id: string, phaseOffset = 0, directionSign = 1): FieldClusterSpec["modes"] {
  return [
    {
      id: `${id}-nodal-core`,
      amplitude: 1.02,
      radialScale: 0.82,
      radialOffset: 0.98,
      angularSharpness: 0.8,
      phaseOffset,
      phaseVelocity: 0.46,
      swirl: 0.25,
      direction: [directionSign, 0.05, 0]
    },
    {
      id: `${id}-nodal-band`,
      amplitude: 0.58,
      radialScale: 0.68,
      radialOffset: 1.06,
      angularSharpness: 1,
      phaseOffset: phaseOffset + 0.22,
      phaseVelocity: -0.14,
      swirl: 0.38,
      direction: [0.4 * directionSign, 0.2, 0.1]
    }
  ];
}

export const SCENE_PRESETS: ScenePreset[] = [
  {
    id: "solo-orbital",
    label: "Solo Orbital",
    description: "Single coherent cluster with a stable point shell around a harmonic density surface.",
    clusters: [
      createCluster({
        id: "solo",
        label: "Solo",
        center: [0, 0, 0],
        structural: {
          kernelDensity: 1.2,
          formRank: 1.12,
          formComplexity: 1.1,
          coherence: 0.98,
          shellThreshold: 0.24
        },
        visual: {
          phaseMapping: 0.15,
          emissionGain: 1.45,
          bloomResponse: 0.92,
          pointDensity: 1.05,
          surfaceThickness: 1.1,
          spectralSpread: 0.9
        }
      })
    ],
    camera: {
      target: [0, 0, 0],
      yaw: 0.35,
      pitch: 0.28,
      radius: 4.4,
      fovY: 0.92,
      near: 0.1,
      far: 24,
      orbitSpeed: 0.06
    },
    post: {
      exposure: 1.1,
      bloomGain: 0.9,
      shellComposite: 1.1,
      volumeComposite: 0.84
    },
    controls: [
      { key: "surfaceThreshold", label: "Shell Threshold", min: 0.12, max: 0.42, step: 0.01, initial: 0.24 },
      { key: "pointBudget", label: "Point Budget", min: 600, max: 3200, step: 50, initial: 1800 },
      { key: "exposure", label: "Exposure", min: 0.7, max: 1.8, step: 0.01, initial: 1.1 }
    ],
    excitations: []
  },
  {
    id: "coherent-bridge",
    label: "Coherent Bridge",
    description: "Two phase-aligned clusters grow a glowing bridge through constructive interference.",
    clusters: [
      createCluster({
        id: "left",
        label: "Left",
        center: [-0.98, 0, 0],
        orientation: [0.08, 0.12, -0.08],
        modes: coherentBridgeModes("left", 0.08),
        visual: {
          phaseMapping: 0.08,
          emissionGain: 1.32,
          bloomResponse: 0.86,
          pointDensity: 1.08,
          surfaceThickness: 1.08,
          spectralSpread: 1.05
        }
      }),
      createCluster({
        id: "right",
        label: "Right",
        center: [0.98, 0, 0],
        orientation: [-0.08, -0.12, 0.08],
        modes: coherentBridgeModes("right", 0.08),
        structural: { coherence: 0.92, kernelDensity: 1.08, formRank: 1.08, formComplexity: 1, shellThreshold: 0.24 },
        visual: { phaseMapping: 0.08, emissionGain: 1.28, bloomResponse: 0.86, pointDensity: 1.1, surfaceThickness: 1.08, spectralSpread: 1.1 },
        dynamic: { mergeAffinity: 0.8, nodalRepulsion: 0.25, turbulence: 0.18, energyInput: 0.22, excitationState: 0, transitionTension: 0.16, decayRate: 0.04 }
      })
    ],
    camera: {
      target: [0, 0, 0],
      yaw: 0.1,
      pitch: 0.24,
      radius: 5.3,
      fovY: 0.85,
      near: 0.1,
      far: 30,
      orbitSpeed: 0.045
    },
    post: {
      exposure: 1.18,
      bloomGain: 1.1,
      shellComposite: 1.18,
      volumeComposite: 0.8
    },
    controls: [
      { key: "surfaceThreshold", label: "Shell Threshold", min: 0.14, max: 0.4, step: 0.01, initial: 0.24 },
      { key: "pointBudget", label: "Point Budget", min: 800, max: 4200, step: 50, initial: 2200 },
      { key: "raymarchSteps", label: "Raymarch Steps", min: 24, max: 96, step: 1, initial: 54 }
    ],
    excitations: []
  },
  {
    id: "nodal-gap",
    label: "Nodal Gap",
    description: "Phase-opposed clusters cancel in the center and open a cold nodal void.",
    clusters: [
      createCluster({
        id: "left-nodal",
        label: "Left Nodal",
        center: [-1.16, 0, 0],
        orientation: [0, 0.08, 0.18],
        modes: nodalModes("left-nodal", 0.12, 1),
        visual: {
          phaseMapping: 0.12,
          emissionGain: 1.25,
          bloomResponse: 0.8,
          pointDensity: 0.96,
          surfaceThickness: 1.05,
          spectralSpread: 1
        }
      }),
      createCluster({
        id: "right-nodal",
        label: "Right Nodal",
        center: [1.16, 0, 0],
        modes: nodalModes("right-nodal", Math.PI + 0.12, -1),
        visual: {
          phaseMapping: Math.PI + 0.12,
          emissionGain: 1.25,
          bloomResponse: 0.8,
          pointDensity: 1.02,
          surfaceThickness: 1.05,
          spectralSpread: 1
        },
        dynamic: { mergeAffinity: 0.18, nodalRepulsion: 0.85, turbulence: 0.22, energyInput: 0.18, excitationState: 0, transitionTension: 0.16, decayRate: 0.05 }
      })
    ],
    camera: {
      target: [0, 0, 0],
      yaw: 0.18,
      pitch: 0.25,
      radius: 5.4,
      fovY: 0.85,
      near: 0.1,
      far: 30,
      orbitSpeed: 0.04
    },
    post: {
      exposure: 1.05,
      bloomGain: 0.8,
      shellComposite: 1.08,
      volumeComposite: 0.88
    },
    controls: [
      { key: "surfaceThreshold", label: "Shell Threshold", min: 0.14, max: 0.38, step: 0.01, initial: 0.24 },
      { key: "pointBudget", label: "Point Budget", min: 800, max: 4200, step: 50, initial: 2200 },
      { key: "shellDensity", label: "Shell Density", min: 0.5, max: 1.5, step: 0.01, initial: 1 }
    ],
    excitations: []
  },
  {
    id: "excited-transition",
    label: "Excited Transition",
    description: "A single cluster is pushed through an excitation pulse and rebuilds its shell topology.",
    clusters: [
      createCluster({
        id: "excited",
        label: "Excited",
        center: [0, 0, 0],
        orientation: [0.2, -0.1, 0.28],
        structural: {
          kernelDensity: 1.08,
          formRank: 1.02,
          formComplexity: 1.35,
          coherence: 0.92,
          shellThreshold: 0.23
        },
        dynamic: {
          energyInput: 0.22,
          excitationState: 0.1,
          transitionTension: 0.4,
          mergeAffinity: 0.3,
          nodalRepulsion: 0.46,
          turbulence: 0.28,
          decayRate: 0.05
        },
        visual: {
          phaseMapping: 0.22,
          emissionGain: 1.4,
          bloomResponse: 1,
          pointDensity: 1.1,
          surfaceThickness: 1.18,
          spectralSpread: 1.15
        }
      })
    ],
    camera: {
      target: [0, 0, 0],
      yaw: 0.56,
      pitch: 0.3,
      radius: 4.8,
      fovY: 0.9,
      near: 0.1,
      far: 24,
      orbitSpeed: 0.08
    },
    post: {
      exposure: 1.12,
      bloomGain: 1.12,
      shellComposite: 1.14,
      volumeComposite: 0.78
    },
    controls: [
      { key: "surfaceThreshold", label: "Shell Threshold", min: 0.14, max: 0.38, step: 0.01, initial: 0.23 },
      { key: "pointBudget", label: "Point Budget", min: 600, max: 3200, step: 50, initial: 2000 },
      { key: "exposure", label: "Exposure", min: 0.7, max: 1.8, step: 0.01, initial: 1.12 }
    ],
    excitations: [
      {
        targetClusterId: "excited",
        startTime: 1.4,
        duration: 3.1,
        energyDelta: 0.5,
        phaseDrift: 1.2
      }
    ]
  }
];

export function getPresetById(id: string): ScenePreset {
  const preset = SCENE_PRESETS.find((entry) => entry.id === id);
  if (!preset) {
    return SCENE_PRESETS[0];
  }
  return structuredClone(preset);
}
