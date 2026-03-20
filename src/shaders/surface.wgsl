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

struct ClusterRecord {
  center: vec4<f32>,
  orientation: vec4<f32>,
  structural: vec4<f32>,
  dynamic: vec4<f32>,
  mode_range_phase: vec4<f32>,
}

struct ModeRecord {
  values0: vec4<f32>,
  values1: vec4<f32>,
  direction: vec4<f32>,
}

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var<storage, read> clusters: array<ClusterRecord>;
@group(0) @binding(2) var<storage, read> modes: array<ModeRecord>;

fn cluster_count() -> u32 {
  return u32(frame.counts.x);
}

fn surface_threshold() -> f32 {
  return frame.lens.w;
}

/*__FIELD_SHARED__*/

struct VsOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

struct SurfaceOut {
  @location(0) color: vec4<f32>,
  @location(1) depth: f32,
}

fn palette(phase: f32) -> vec3<f32> {
  let a = vec3<f32>(0.52, 0.56, 0.58);
  let b = vec3<f32>(0.46, 0.28, 0.41);
  let c = vec3<f32>(1.0, 1.0, 1.0);
  let d = vec3<f32>(0.15, 0.45, 0.75);
  return a + b * cos(6.28318 * (c * phase + d));
}

fn scene_bounds() -> vec4<f32> {
  let cluster_total = max(1u, cluster_count());
  var center = vec3<f32>(0.0);
  for (var index = 0u; index < cluster_total; index = index + 1u) {
    center = center + clusters[index].center.xyz;
  }
  center = center / f32(cluster_total);

  var radius = 0.0;
  for (var index = 0u; index < cluster_total; index = index + 1u) {
    let cluster = clusters[index];
    let extent = 0.72 + cluster.structural.y * 1.78 + cluster.dynamic.w * 0.18;
    radius = max(radius, distance(center, cluster.center.xyz) + extent);
  }

  return vec4<f32>(center, max(radius, 1.9));
}

fn ray_sphere_interval(origin: vec3<f32>, direction: vec3<f32>, center: vec3<f32>, radius: f32) -> vec2<f32> {
  let oc = origin - center;
  let half_b = dot(oc, direction);
  let c = dot(oc, oc) - radius * radius;
  let discriminant = half_b * half_b - c;
  if (discriminant <= 0.0) {
    return vec2<f32>(1e9, -1e9);
  }
  let root = sqrt(discriminant);
  return vec2<f32>(-half_b - root, -half_b + root);
}

fn refine_surface_hit(
  ray_origin: vec3<f32>,
  ray_dir: vec3<f32>,
  start_t: f32,
  end_t: f32,
  start_value: f32,
  time: f32
) -> f32 {
  var low_t = start_t;
  var high_t = end_t;
  var low_value = start_value;
  for (var iteration = 0; iteration < 4; iteration = iteration + 1) {
    let mid_t = (low_t + high_t) * 0.5;
    let mid_value = sample_field(ray_origin + ray_dir * mid_t, time).rho - surface_threshold();
    let same_sign = (low_value <= 0.0 && mid_value <= 0.0) || (low_value >= 0.0 && mid_value >= 0.0);
    if (same_sign) {
      low_t = mid_t;
      low_value = mid_value;
    } else {
      high_t = mid_t;
    }
  }
  return (low_t + high_t) * 0.5;
}

fn find_surface_hit(ray_origin: vec3<f32>, ray_dir: vec3<f32>, interval: vec2<f32>, time: f32) -> vec4<f32> {
  let steps = max(20.0, frame.surface.x);
  let ray_start = max(0.35, interval.x);
  let step_size = max(0.03, (interval.y - ray_start) / steps);
  var previous_t = ray_start;
  var previous_value = sample_field(ray_origin + ray_dir * previous_t, time).rho - surface_threshold();

  for (var step = 0.0; step < steps; step = step + 1.0) {
    let current_t = min(interval.y, previous_t + step_size);
    let current_value = sample_field(ray_origin + ray_dir * current_t, time).rho - surface_threshold();
    let crossed =
      (previous_value <= 0.0 && current_value >= 0.0) ||
      (previous_value >= 0.0 && current_value <= 0.0);
    if (crossed) {
      let refined_t = refine_surface_hit(ray_origin, ray_dir, previous_t, current_t, previous_value, time);
      return vec4<f32>(ray_origin + ray_dir * refined_t, refined_t);
    }
    previous_t = current_t;
    previous_value = current_value;
  }

  return vec4<f32>(0.0, 0.0, 0.0, -1.0);
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
fn fsMain(input: VsOut) -> SurfaceOut {
  var output: SurfaceOut;
  let centered_uv = input.uv * 2.0 - 1.0;
  let ray_dir = normalize(
    frame.camera_forward.xyz +
      centered_uv.x * frame.lens.y * frame.lens.x * frame.camera_right.xyz +
      centered_uv.y * frame.lens.x * frame.camera_up.xyz
  );
  let bounds = scene_bounds();
  let interval = ray_sphere_interval(frame.camera_pos.xyz, ray_dir, bounds.xyz, bounds.w);
  if (interval.y <= 0.4 || interval.y <= interval.x) {
    output.color = vec4<f32>(0.0);
    output.depth = 0.0;
    return output;
  }

  let hit = find_surface_hit(frame.camera_pos.xyz, ray_dir, interval, frame.lens.z);
  if (hit.w <= 0.0) {
    output.color = vec4<f32>(0.0);
    output.depth = 0.0;
    return output;
  }

  let sample = sample_field(hit.xyz, frame.lens.z);
  let normal = safe_normalize(sample.grad_rho);
  let diagnostics = flow_diagnostics(hit.xyz, frame.lens.z, normal);
  let phase_color = palette(sample.phase * 0.159 + 0.5);
  let vortex_amount = clamp(length(diagnostics.vorticity) * frame.surface.z * 0.55, 0.0, 1.8);
  let burst_amount = clamp(diagnostics.burst * frame.surface.w * 0.7, 0.0, 1.8);
  let vortex_color = mix(vec3<f32>(0.08, 0.82, 0.82), vec3<f32>(0.5, 0.32, 0.92), 0.5 + 0.5 * sin(sample.phase * 1.4));
  let burst_color = vec3<f32>(1.18, 0.92, 0.66);
  let view_alignment = max(0.0, dot(normal, -ray_dir));
  let rim = pow(1.0 - view_alignment, 2.6);
  let coherence_mask = smoothstep(0.08, 0.22, sample.coherence);
  let nodal_void = 1.0 - coherence_mask;
  let lighting = 0.32 + 0.68 * max(0.0, dot(normal, safe_normalize(vec3<f32>(0.28, 0.8, 0.54))));
  let base = phase_color * (0.12 + sample.coherence * 0.34) * (0.42 + lighting * 0.58);
  let vortex = vortex_color * vortex_amount * (0.12 + rim * 0.38) * (0.62 + 0.38 * sin(sample.phase * 1.1));
  let burst = burst_color * burst_amount * (0.05 + rim * 0.62);
  let void_darken = mix(1.0, 0.16, nodal_void);
  let emission = (base + vortex + burst) * coherence_mask * void_darken;
  let color = 1.0 - exp(-emission * frame.composite.x * 0.75);

  output.color = vec4<f32>(color, coherence_mask * (0.48 + min(0.38, vortex_amount * 0.12 + burst_amount * 0.1)));
  output.depth = max(0.001, dot(hit.xyz - frame.camera_pos.xyz, frame.camera_forward.xyz));
  return output;
}
