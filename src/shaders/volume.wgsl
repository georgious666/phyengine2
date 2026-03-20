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

struct ClusterRecord {
  center_threshold: vec4<f32>,
  orientation_phase: vec4<f32>,
  structural: vec4<f32>,
  visual: vec4<f32>,
}

@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(0) @binding(1) var<storage, read> clusters: array<ClusterRecord>;

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

fn sample_cluster(index: i32, position: vec3<f32>, time: f32) -> vec2<f32> {
  let cluster = clusters[index];
  let center = cluster.center_threshold.xyz;
  let threshold = cluster.center_threshold.w;
  let orientation = normalize(cluster.orientation_phase.xyz + vec3<f32>(0.001, 0.0, 0.0));
  let phase_bias = cluster.orientation_phase.w;
  let kernel_density = cluster.structural.x;
  let form_rank = cluster.structural.y;
  let form_complexity = cluster.structural.z;
  let coherence = cluster.structural.w;
  let excitation = cluster.visual.x;
  let surface_thickness = cluster.visual.z;
  let spectral_spread = cluster.visual.w;
  let offset = position - center;
  let radius = length(offset);
  let shell = exp(-pow(radius - form_rank, 2.0) / max(0.18, 2.0 * pow(0.22 + surface_thickness * 0.18, 2.0)));
  let lobe = pow(max(0.05, 0.5 + 0.5 * dot(normalize(offset + vec3<f32>(0.0001, 0.0, 0.0)), orientation)), max(0.35, form_complexity));
  let amplitude = kernel_density * coherence * shell * lobe * (1.0 + excitation * 0.4);
  let phase = phase_bias + time * (0.55 + excitation * 0.35) + dot(offset, orientation) * spectral_spread * 1.25 + threshold * 0.5;
  return vec2<f32>(cos(phase), sin(phase)) * amplitude;
}

fn sample_field(position: vec3<f32>, time: f32) -> vec4<f32> {
  var psi = vec2<f32>(0.0, 0.0);
  var amplitude_sum = 0.0;
  for (var i = 0; i < i32(frame.counts.x); i = i + 1) {
    let contribution = sample_cluster(i, position, time);
    amplitude_sum = amplitude_sum + length(contribution);
    psi = psi + contribution;
  }
  let density = dot(psi, psi);
  let coherence = select(0.0, clamp(length(psi) / max(amplitude_sum, 0.0001), 0.0, 1.0), amplitude_sum > 0.0);
  return vec4<f32>(psi, density, coherence);
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

  let max_steps = i32(frame.counts.z);
  let step_size = 0.14;
  var distance_along_ray = 0.4;
  var transmittance = 1.0;
  var color = vec3<f32>(0.0, 0.0, 0.0);

  for (var step = 0; step < max_steps; step = step + 1) {
    let position = frame.camera_pos.xyz + ray_dir * distance_along_ray;
    let field = sample_field(position, frame.lens.z);
    let psi = field.xy;
    let density = field.z;
    let coherence = field.w;
    let shell_band = exp(-abs(density - frame.lens.w) * 8.0);
    let phase = atan2(psi.y, psi.x);
    let phase_color = palette(phase * 0.159 + 0.5);
    let scatter = density * 0.12 + shell_band * 0.18;
    color = color + phase_color * scatter * transmittance * (0.3 + coherence * 0.8);
    transmittance = transmittance * exp(-density * 0.16 - shell_band * 0.02);
    distance_along_ray = distance_along_ray + step_size;
  }

  let exposed = 1.0 - exp(-color * frame.composite.x * frame.composite.z);
  return vec4<f32>(exposed, 1.0);
}
