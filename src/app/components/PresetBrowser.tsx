import { memo } from "react";
import type { ScenePreset } from "../../engine/types";

interface PresetBrowserProps {
  presets: ScenePreset[];
  activePresetId: string;
  onSelect: (presetId: string) => void;
}

export const PresetBrowser = memo(function PresetBrowser({
  presets,
  activePresetId,
  onSelect
}: PresetBrowserProps): JSX.Element {
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Presets</h2>
        <span>{presets.length} scenes</span>
      </div>
      <div className="preset-grid">
        {presets.map((preset) => (
          <button
            type="button"
            key={preset.id}
            className={`preset-card ${preset.id === activePresetId ? "active" : ""}`}
            onClick={() => onSelect(preset.id)}
          >
            <strong>{preset.label}</strong>
            <p>{preset.description}</p>
          </button>
        ))}
      </div>
    </section>
  );
});
