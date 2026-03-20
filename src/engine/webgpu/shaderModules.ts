import volumeShader from "../../shaders/volume.wgsl?raw";
import shellShader from "../../shaders/shell.wgsl?raw";
import compositeShader from "../../shaders/composite.wgsl?raw";
import shellMetricsShader from "../../shaders/shellMetrics.wgsl?raw";
import surfaceTrackerShader from "../../shaders/surfaceTracker.wgsl?raw";

export const shaderModules = {
  volumeShader,
  shellShader,
  compositeShader,
  shellMetricsShader,
  surfaceTrackerShader
};
