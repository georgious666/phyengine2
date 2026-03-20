import type { EngineFrameState, ScenePreset } from "../../engine/types";

interface InspectorPanelProps {
  preset: ScenePreset;
  controls: Record<string, number>;
  frameState: EngineFrameState | null;
  onControlChange: (key: string, value: number) => void;
}

function formatNumber(value: number, digits = 2): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(digits);
}

export function InspectorPanel({
  preset,
  controls,
  frameState,
  onControlChange
}: InspectorPanelProps): JSX.Element {
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Inspector</h2>
        <span>Live controls</span>
      </div>

      <div className="control-stack">
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
      </div>
    </section>
  );
}
