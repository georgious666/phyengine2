import fieldShared from "../../shaders/fieldShared.wgsl?raw";
import surfaceShaderTemplate from "../../shaders/surface.wgsl?raw";
import volumeShader from "../../shaders/volume.wgsl?raw";
import shellShader from "../../shaders/shell.wgsl?raw";
import compositeShader from "../../shaders/composite.wgsl?raw";
import shellMetricsShader from "../../shaders/shellMetrics.wgsl?raw";
import surfaceTrackerShader from "../../shaders/surfaceTracker.wgsl?raw";

const FIELD_PLACEHOLDER = "/*__FIELD_SHARED__*/";

export const shaderModules = {
  volumeShader: volumeShader.replace(FIELD_PLACEHOLDER, fieldShared),
  surfaceShader: surfaceShaderTemplate.replace(FIELD_PLACEHOLDER, fieldShared),
  shellShader,
  compositeShader,
  shellMetricsShader,
  surfaceTrackerShader
};
