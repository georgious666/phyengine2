import { useEffect, useState } from "react";
import { DEFAULT_ENGINE_CONFIG } from "../engine/defaults";
import { SCENE_PRESETS, getPresetById } from "../engine/presets";
import type { EngineFrameState } from "../engine/types";
import { InspectorPanel } from "./components/InspectorPanel";
import { PresetBrowser } from "./components/PresetBrowser";
import { ViewportCanvas } from "./components/ViewportCanvas";

type ControlValues = Record<string, number>;

function controlMapForPreset(presetId: string): ControlValues {
  const preset = getPresetById(presetId);
  return preset.controls.reduce<ControlValues>((accumulator, control) => {
    accumulator[control.key] = control.initial;
    return accumulator;
  }, {});
}

export function App(): JSX.Element {
  const [presetId, setPresetId] = useState(SCENE_PRESETS[0].id);
  const [controls, setControls] = useState<ControlValues>(() => controlMapForPreset(SCENE_PRESETS[0].id));
  const [frameState, setFrameState] = useState<EngineFrameState | null>(null);
  const [status, setStatus] = useState("Initializing WebGPU scene...");

  useEffect(() => {
    setControls(controlMapForPreset(presetId));
  }, [presetId]);

  const activePreset = getPresetById(presetId);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="hero-block">
          <p className="eyebrow">Field-native WebGPU renderer</p>
          <h1>Harmonic Manifold</h1>
          <p className="hero-copy">
            Continuous complex field, density level-set, photon shell markers and hybrid
            volume-plus-surface rendering in one real-time browser app.
          </p>
        </div>

        <PresetBrowser presets={SCENE_PRESETS} activePresetId={presetId} onSelect={setPresetId} />

        <InspectorPanel
          preset={activePreset}
          controls={controls}
          frameState={frameState}
          onControlChange={(key, value) =>
            setControls((previous) => ({
              ...previous,
              [key]: value
            }))
          }
        />

        <div className="legend-card">
          <div className="legend-row">
            <span>Canonical field</span>
            <strong>psi to rho, phi, j, v</strong>
          </div>
          <div className="legend-row">
            <span>Surface truth</span>
            <strong>rho = rho0</strong>
          </div>
          <div className="legend-row">
            <span>Shell markers</span>
            <strong>{Math.round(controls.pointBudget ?? DEFAULT_ENGINE_CONFIG.pointBudget)}</strong>
          </div>
        </div>
      </aside>

      <main className="viewport-panel">
        <ViewportCanvas
          presetId={presetId}
          controls={controls}
          onFrameState={setFrameState}
          onStatus={setStatus}
        />

        <div className="viewport-hud">
          <div>
            <span className="hud-label">Status</span>
            <strong>{status}</strong>
          </div>
          <div>
            <span className="hud-label">Shell Coverage</span>
            <strong>{frameState ? `${Math.round(frameState.shellCoverage * 100)}%` : "..."}</strong>
          </div>
          <div>
            <span className="hud-label">Active Bricks</span>
            <strong>{frameState?.activeBricks ?? 0}</strong>
          </div>
        </div>
      </main>
    </div>
  );
}
