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
}

struct PointRecord {
  position_radius: vec4<f32>,
  normal_state: vec4<f32>,
  velocity_density: vec4<f32>,
  phase_brightness: vec4<f32>,
}

struct PointMetric {
  size_halo_density_state: vec4<f32>,
}

struct VsOut {
  @builtin(position) position: vec4<f32>,
  @location(0) local_uv: vec2<f32>,
  @location(1) phase: f32,
  @location(2) brightness: f32,
  @location(3) density_lift: f32,
  @location(4) halo: f32,
  @location(5) coherence: f32,
}

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var<storage, read> points: array<PointRecord>;
@group(0) @binding(2) var<storage, read> previous_points: array<PointRecord>;
@group(0) @binding(3) var<storage, read> metrics: array<PointMetric>;

fn palette(phase: f32) -> vec3<f32> {
  let a = vec3<f32>(0.54, 0.48, 0.62);
  let b = vec3<f32>(0.42, 0.32, 0.35);
  let c = vec3<f32>(1.0, 1.0, 1.0);
  let d = vec3<f32>(0.05, 0.24, 0.55);
  return a + b * cos(6.28318 * (c * phase + d));
}

fn quad_corner(vertex_index: u32) -> vec2<f32> {
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(1.0, -1.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, 1.0)
  );
  return corners[vertex_index];
}

@vertex
fn vsMain(@builtin(vertex_index) vertex_index: u32, @builtin(instance_index) instance_index: u32) -> VsOut {
  let point = points[instance_index];
  let previous_point = previous_points[instance_index];
  let metric = metrics[instance_index].size_halo_density_state;
  let point_id = point.phase_brightness.w;
  let previous_point_id = previous_point.phase_brightness.w;
  let corner = quad_corner(vertex_index);

  var output: VsOut;
  if (point_id <= 0.0 || metric.x <= 0.0) {
    output.position = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    output.local_uv = vec2<f32>(0.0);
    output.phase = 0.0;
    output.brightness = 0.0;
    output.density_lift = 0.0;
    output.halo = 0.0;
    output.coherence = 0.0;
    return output;
  }

  let blend_alpha = select(1.0, frame.motion.z, previous_point_id > 0.0 && previous_point_id == point_id);
  let blended_center = mix(previous_point.position_radius.xyz, point.position_radius.xyz, blend_alpha);
  let world_position =
    blended_center +
    frame.camera_right.xyz * corner.x * metric.x +
    frame.camera_up.xyz * corner.y * metric.x;
  let relative = world_position - frame.camera_pos.xyz;
  let view_x = dot(relative, frame.camera_right.xyz);
  let view_y = dot(relative, frame.camera_up.xyz);
  let view_z = max(0.001, dot(relative, frame.camera_forward.xyz));
  let ndc_x = view_x / (view_z * frame.lens.y * frame.lens.x);
  let ndc_y = view_y / (view_z * frame.lens.x);

  output.position = vec4<f32>(ndc_x, ndc_y, clamp(view_z / 32.0, 0.0, 1.0), 1.0);
  output.local_uv = corner;
  output.phase = point.phase_brightness.x;
  output.brightness = point.phase_brightness.y;
  output.density_lift = metric.z;
  output.halo = metric.y;
  output.coherence = point.phase_brightness.z;
  return output;
}

@fragment
fn fsMain(input: VsOut) -> @location(0) vec4<f32> {
  let radial = length(input.local_uv);
  let core = smoothstep(1.0, 0.0, radial);
  let halo = smoothstep(1.8, 0.15, radial * (1.0 + input.halo * 0.35));
  let state_glow = 0.3 + input.coherence * 0.9;
  let alpha = (core * 0.82 + halo * 0.28) * frame.presentation.z;
  let phase_color = palette(input.phase * 0.159 + 0.5);
  let color = phase_color * (input.brightness * 0.55 + input.density_lift * 0.85) * state_glow * frame.composite.y;
  return vec4<f32>(color, alpha);
}
