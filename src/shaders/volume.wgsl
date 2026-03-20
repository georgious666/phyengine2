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
  let centered_uv = input.uv * 2.0 - 1.0;
  let ray_dir = normalize(
    frame.camera_forward.xyz +
      centered_uv.x * frame.lens.y * frame.lens.x * frame.camera_right.xyz +
      centered_uv.y * frame.lens.x * frame.camera_up.xyz
  );
  let bounds = scene_bounds();
  let interval = ray_sphere_interval(frame.camera_pos.xyz, ray_dir, bounds.xyz, bounds.w);
  if (interval.y <= 0.4 || interval.y <= interval.x) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  let max_steps = i32(frame.counts.z);
  let step_size = max(0.08, (interval.y - max(0.35, interval.x)) / max(12.0, frame.counts.z));
  let ray_end = interval.y;
  var distance_along_ray = max(0.35, interval.x);
  var transmittance = 1.0;
  var color = vec3<f32>(0.0);

  for (var step = 0; step < max_steps && distance_along_ray <= ray_end; step = step + 1) {
    let position = frame.camera_pos.xyz + ray_dir * distance_along_ray;
    let field = sample_field(position, frame.lens.z);
    let shell_band = exp(-abs(field.rho - surface_threshold()) * 8.0);
    let phase_color = palette(field.phase * 0.159 + 0.5);
    let flow_energy = clamp(length(field.flow) * 0.2, 0.0, 1.0);
    let scatter = field.rho * 0.1 + shell_band * 0.22;
    color =
      color +
      phase_color * scatter * transmittance * (0.26 + field.coherence * 0.84 + flow_energy * 0.24);
    transmittance = transmittance * exp(-field.rho * 0.14 - shell_band * 0.035);
    if (transmittance < 0.03) {
      break;
    }
    distance_along_ray = distance_along_ray + step_size;
  }

  let exposed = 1.0 - exp(-color * frame.composite.x * frame.composite.z);
  return vec4<f32>(exposed, 1.0);
}
