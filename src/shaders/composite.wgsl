struct FrameUniforms {
  camera_pos: vec4<f32>,
  camera_right: vec4<f32>,
  camera_up: vec4<f32>,
  camera_forward: vec4<f32>,
  lens: vec4<f32>,
  composite: vec4<f32>,
  counts: vec4<f32>,
  presentation: vec4<f32>,
  motion: vec4<f32>,
  surface: vec4<f32>,
}

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var scene_sampler: sampler;
@group(0) @binding(2) var volume_texture: texture_2d<f32>;
@group(0) @binding(3) var surface_texture: texture_2d<f32>;
@group(0) @binding(4) var shell_texture: texture_2d<f32>;

struct VsOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vsMain(@builtin(vertex_index) vertex_index: u32) -> VsOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0),
    vec2<f32>(-1.0, 1.0),
    vec2<f32>(3.0, 1.0)
  );
  var output: VsOut;
  let position = positions[vertex_index];
  output.position = vec4<f32>(position, 0.0, 1.0);
  output.uv = position * 0.5 + 0.5;
  return output;
}

@fragment
fn fsMain(input: VsOut) -> @location(0) vec4<f32> {
  let volume = textureSample(volume_texture, scene_sampler, input.uv).rgb;
  let surface = textureSample(surface_texture, scene_sampler, input.uv);
  let shell = textureSample(shell_texture, scene_sampler, input.uv).rgb;
  let surface_presence = surface.a;
  let shell_presence = smoothstep(0.015, 0.14, max(shell.r, max(shell.g, shell.b)));
  let bloom = pow(shell, vec3<f32>(1.55, 1.55, 1.55)) * frame.composite.w * 0.14;
  let combined =
    volume * frame.composite.z * mix(1.0, 0.34, surface_presence) +
    surface.rgb * frame.motion.w * (0.78 + surface_presence * 0.16) +
    shell * frame.composite.y +
    bloom;
  let graded = pow(combined, vec3<f32>(0.92, 0.92, 0.92));
  return vec4<f32>(graded, 1.0);
}
