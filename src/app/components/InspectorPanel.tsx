import type { EngineFrameState, RenderMode, ScenePreset } from "../../engine/types";

interface InspectorPanelProps {
  preset: ScenePreset;
  controls: Record<string, number>;
  frameState: EngineFrameState | null;
  renderMode: RenderMode;
  onRenderModeChange: (renderMode: RenderMode) => void;
  onControlChange: (key: string, value: number) => void;
}

function formatNumber(value: number, digits = 2): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(digits);
}

export function InspectorPanel({
  preset,
  controls,
  frameState,
  renderMode,
  onRenderModeChange,
  onControlChange
}: InspectorPanelProps): JSX.Element {
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Inspector</h2>
        <span>Live controls</span>
      </div>

      <div className="control-stack">
        <div className="mode-toggle" role="tablist" aria-label="Render mode">
          {(["points", "surface", "hybrid"] as const).map((mode) => (
            <button
              type="button"
              key={mode}
              className={`mode-chip ${renderMode === mode ? "active" : ""}`}
              onClick={() => onRenderModeChange(mode)}
            >
              {mode}
            </button>
          ))}
        </div>

        {preset.controls.map((control) => (
          <label className="control-row" key={control.key}>
            <div className="control-meta">
              <span>{control.label}</span>
              <strong>{formatNumber(controls[control.key] ?? control.initial)}</strong>
            </div>
            <input
              type="range"
              min={control.min}
              max={control.max}
              step={control.step}
              value={controls[control.key] ?? control.initial}
              onChange={(event) => onControlChange(control.key, Number(event.target.value))}
            />
          </label>
        ))}

        {!preset.controls.some((control) => control.key === "shellDensity") ? (
          <label className="control-row" key="shellDensity">
            <div className="control-meta">
              <span>Shell Density</span>
              <strong>{formatNumber(controls.shellDensity ?? 1)}</strong>
            </div>
            <input
              type="range"
              min={0.5}
              max={1.5}
              step={0.01}
              value={controls.shellDensity ?? 1}
              onChange={(event) => onControlChange("shellDensity", Number(event.target.value))}
            />
          </label>
        ) : null}

        {!preset.controls.some((control) => control.key === "raymarchSteps") ? (
          <label className="control-row" key="raymarchSteps">
            <div className="control-meta">
              <span>Raymarch Steps</span>
              <strong>{Math.round(controls.raymarchSteps ?? 54)}</strong>
            </div>
            <input
              type="range"
              min={24}
              max={96}
              step={1}
              value={controls.raymarchSteps ?? 54}
              onChange={(event) => onControlChange("raymarchSteps", Number(event.target.value))}
            />
          </label>
        ) : null}

        <label className="control-row" key="surfaceSteps">
          <div className="control-meta">
            <span>Surface Steps</span>
            <strong>{Math.round(controls.surfaceSteps ?? 72)}</strong>
          </div>
          <input
            type="range"
            min={44}
            max={96}
            step={1}
            value={controls.surfaceSteps ?? 72}
            onChange={(event) => onControlChange("surfaceSteps", Number(event.target.value))}
          />
        </label>

        <label className="control-row" key="markerDensity">
          <div className="control-meta">
            <span>Marker Density</span>
            <strong>{formatNumber(controls.markerDensity ?? 0.18)}</strong>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={controls.markerDensity ?? 0.18}
            onChange={(event) => onControlChange("markerDensity", Number(event.target.value))}
          />
        </label>

        <label className="control-row" key="vorticityGain">
          <div className="control-meta">
            <span>Vortex Gain</span>
            <strong>{formatNumber(controls.vorticityGain ?? 1.3)}</strong>
          </div>
          <input
            type="range"
            min={0.4}
            max={2.4}
            step={0.01}
            value={controls.vorticityGain ?? 1.3}
            onChange={(event) => onControlChange("vorticityGain", Number(event.target.value))}
          />
        </label>

        <label className="control-row" key="burstGain">
          <div className="control-meta">
            <span>Burst Gain</span>
            <strong>{formatNumber(controls.burstGain ?? 1.6)}</strong>
          </div>
          <input
            type="range"
            min={0.4}
            max={2.6}
            step={0.01}
            value={controls.burstGain ?? 1.6}
            onChange={(event) => onControlChange("burstGain", Number(event.target.value))}
          />
        </label>
      </div>

      <div className="metrics-card">
        <div className="metric">
          <span>FPS</span>
          <strong>{frameState ? Math.round(frameState.fps) : "..."}</strong>
        </div>
        <div className="metric">
          <span>Points</span>
          <strong>{frameState?.pointCount ?? "..."}</strong>
        </div>
        <div className="metric">
          <span>Avg Density</span>
          <strong>{frameState ? frameState.averageDensity.toFixed(3) : "..."}</strong>
        </div>
        <div className="metric">
          <span>Max Flow</span>
          <strong>{frameState ? frameState.maxFlow.toFixed(3) : "..."}</strong>
        </div>
        <div className="metric">
          <span>Peak Vorticity</span>
          <strong>{frameState ? frameState.peakVorticity.toFixed(3) : "..."}</strong>
        </div>
        <div className="metric">
          <span>Peak Burst</span>
          <strong>{frameState ? frameState.peakBurst.toFixed(3) : "..."}</strong>
        </div>
      </div>
    </section>
  );
}
