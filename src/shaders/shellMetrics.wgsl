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

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var<storage, read> points: array<PointRecord>;
@group(0) @binding(2) var<storage, read_write> metrics: array<PointMetric>;

@compute @workgroup_size(64)
fn csMain(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let index = global_id.x;
  if (index >= u32(frame.counts.y)) {
    return;
  }

  let point = points[index];
  let point_id = point.phase_brightness.w;
  if (point_id <= 0.0) {
    metrics[index].size_halo_density_state = vec4<f32>(0.0);
    return;
  }
  let radius = point.position_radius.w;
  let density = point.velocity_density.w;
  let phase = point.phase_brightness.x;
  let brightness = point.phase_brightness.y;
  let coherence = point.phase_brightness.z;
  let state = point.normal_state.w;
  let state_gain = select(1.0, 1.2, state == 1.0);
  let nodal_drop = select(1.0, 0.42, state == 3.0);
  let size = radius * frame.counts.w * (0.85 + brightness * 0.35) * nodal_drop;
  let halo = size * (1.2 + coherence * 1.6);
  let density_lift = density * (0.55 + coherence * 0.5) + abs(sin(phase)) * 0.08;
  metrics[index].size_halo_density_state = vec4<f32>(size * state_gain, halo, density_lift, state);
}
