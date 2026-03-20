const FIELD_EPSILON = 1e-5;
const GRADIENT_STEP = 0.035;

struct FieldSample {
  psi: vec2<f32>,
  rho: f32,
  phase: f32,
  grad_rho: vec3<f32>,
  current: vec3<f32>,
  flow: vec3<f32>,
  coherence: f32,
  shell_distance: f32,
}

struct FlowDiagnostics {
  vorticity: vec3<f32>,
  divergence: f32,
  burst: f32,
  speed: f32,
}

fn safe_normalize(v: vec3<f32>) -> vec3<f32> {
  let len = length(v);
  if (len <= 0.0) {
    return vec3<f32>(0.0);
  }
  return v / len;
}

fn rotate_euler(v: vec3<f32>, rotation: vec3<f32>) -> vec3<f32> {
  let sx = sin(rotation.x);
  let cx = cos(rotation.x);
  let sy = sin(rotation.y);
  let cy = cos(rotation.y);
  let sz = sin(rotation.z);
  let cz = cos(rotation.z);
  let yx = vec3<f32>(v.x, v.y * cx - v.z * sx, v.y * sx + v.z * cx);
  let yy = vec3<f32>(yx.x * cy + yx.z * sy, yx.y, -yx.x * sy + yx.z * cy);
  return vec3<f32>(yy.x * cz - yy.y * sz, yy.x * sz + yy.y * cz, yy.z);
}

fn inverse_rotate_euler(v: vec3<f32>, rotation: vec3<f32>) -> vec3<f32> {
  return rotate_euler(v, -rotation);
}

fn gaussian_shell(r: f32, radial_scale: f32, radial_offset: f32) -> f32 {
  let sigma = max(radial_scale, 0.08);
  let delta = r - radial_offset;
  return exp(-(delta * delta) / (2.0 * sigma * sigma));
}

fn angular_envelope(local: vec3<f32>, direction: vec3<f32>, sharpness: f32) -> f32 {
  let dir = safe_normalize(direction);
  let radial = safe_normalize(local);
  let signed = 0.5 + 0.5 * dot(radial, dir);
  return pow(max(0.01, signed), max(0.15, sharpness));
}

fn sample_cluster_mode(cluster_index: u32, mode_index: u32, world_position: vec3<f32>, time: f32) -> vec2<f32> {
  let cluster = clusters[cluster_index];
  let mode = modes[mode_index];
  let centered = world_position - cluster.center.xyz;
  let local = inverse_rotate_euler(centered, cluster.orientation.xyz);
  let r = length(local);
  let shell = gaussian_shell(r, mode.values0.y / max(0.55, cluster.structural.y), mode.values0.z);
  let envelope = angular_envelope(local, mode.direction.xyz, mode.values0.w * cluster.structural.z);
  let excitation_boost = 1.0 + cluster.dynamic.x * 0.32 + cluster.dynamic.y * 0.45;
  let turbulence = 1.0 + 0.08 * cluster.dynamic.w * sin(time * 1.7 + r * 2.3);
  let amplitude =
    mode.values0.x *
    cluster.structural.x *
    cluster.structural.w *
    shell *
    envelope *
    excitation_boost *
    turbulence;
  let spin = atan2(local.y, local.x);
  let axial = local.z * 0.7 + local.x * 0.35;
  let phase =
    mode.values1.x +
    cluster.mode_range_phase.z +
    mode.values1.y * time * (1.0 + cluster.dynamic.z * 0.35) +
    mode.values1.z * spin +
    cluster.dynamic.w * 0.12 * axial;
  return vec2<f32>(cos(phase), sin(phase)) * amplitude;
}

fn sample_cluster_psi(cluster_index: u32, world_position: vec3<f32>, time: f32) -> vec2<f32> {
  let cluster = clusters[cluster_index];
  let mode_offset = u32(cluster.mode_range_phase.x);
  let mode_count = u32(cluster.mode_range_phase.y);
  var sum = vec2<f32>(0.0);
  for (var mode_offset_index = 0u; mode_offset_index < mode_count; mode_offset_index = mode_offset_index + 1u) {
    sum = sum + sample_cluster_mode(cluster_index, mode_offset + mode_offset_index, world_position, time);
  }
  return sum;
}

fn sample_psi(world_position: vec3<f32>, time: f32) -> vec2<f32> {
  var sum = vec2<f32>(0.0);
  for (var cluster_index = 0u; cluster_index < cluster_count(); cluster_index = cluster_index + 1u) {
    sum = sum + sample_cluster_psi(cluster_index, world_position, time);
  }
  return sum;
}

fn density_from_psi(psi: vec2<f32>) -> f32 {
  return dot(psi, psi);
}

fn phase_from_psi(psi: vec2<f32>) -> f32 {
  return atan2(psi.y, psi.x);
}

fn rho_at(position: vec3<f32>, time: f32) -> f32 {
  return density_from_psi(sample_psi(position, time));
}

fn gradient_rho(position: vec3<f32>, time: f32) -> vec3<f32> {
  return vec3<f32>(
    (rho_at(position + vec3<f32>(GRADIENT_STEP, 0.0, 0.0), time) -
      rho_at(position - vec3<f32>(GRADIENT_STEP, 0.0, 0.0), time)) /
      (2.0 * GRADIENT_STEP),
    (rho_at(position + vec3<f32>(0.0, GRADIENT_STEP, 0.0), time) -
      rho_at(position - vec3<f32>(0.0, GRADIENT_STEP, 0.0), time)) /
      (2.0 * GRADIENT_STEP),
    (rho_at(position + vec3<f32>(0.0, 0.0, GRADIENT_STEP), time) -
      rho_at(position - vec3<f32>(0.0, 0.0, GRADIENT_STEP), time)) /
      (2.0 * GRADIENT_STEP)
  );
}

fn probability_current(position: vec3<f32>, time: f32) -> vec3<f32> {
  let psi = sample_psi(position, time);
  let d_psi_dx =
    (sample_psi(position + vec3<f32>(GRADIENT_STEP, 0.0, 0.0), time) -
      sample_psi(position - vec3<f32>(GRADIENT_STEP, 0.0, 0.0), time)) /
    (2.0 * GRADIENT_STEP);
  let d_psi_dy =
    (sample_psi(position + vec3<f32>(0.0, GRADIENT_STEP, 0.0), time) -
      sample_psi(position - vec3<f32>(0.0, GRADIENT_STEP, 0.0), time)) /
    (2.0 * GRADIENT_STEP);
  let d_psi_dz =
    (sample_psi(position + vec3<f32>(0.0, 0.0, GRADIENT_STEP), time) -
      sample_psi(position - vec3<f32>(0.0, 0.0, GRADIENT_STEP), time)) /
    (2.0 * GRADIENT_STEP);
  return vec3<f32>(
    psi.x * d_psi_dx.y - psi.y * d_psi_dx.x,
    psi.x * d_psi_dy.y - psi.y * d_psi_dy.x,
    psi.x * d_psi_dz.y - psi.y * d_psi_dz.x
  );
}

fn flow_velocity(psi: vec2<f32>, current: vec3<f32>) -> vec3<f32> {
  let rho = density_from_psi(psi);
  return current / (rho + FIELD_EPSILON);
}

fn coherence_metric(position: vec3<f32>, time: f32) -> f32 {
  var sum = 0.0;
  for (var cluster_index = 0u; cluster_index < cluster_count(); cluster_index = cluster_index + 1u) {
    sum = sum + length(sample_cluster_psi(cluster_index, position, time));
  }
  if (sum <= FIELD_EPSILON) {
    return 0.0;
  }
  let total_magnitude = sqrt(rho_at(position, time));
  return clamp(total_magnitude / sum, 0.0, 1.0);
}

fn sample_field(position: vec3<f32>, time: f32) -> FieldSample {
  let psi = sample_psi(position, time);
  let rho = density_from_psi(psi);
  let phase = phase_from_psi(psi);
  let grad_rho = gradient_rho(position, time);
  let current = probability_current(position, time);
  let flow = flow_velocity(psi, current);
  let coherence = coherence_metric(position, time);
  let gradient_magnitude = length(grad_rho);
  let shell_distance = (rho - surface_threshold()) / (gradient_magnitude + FIELD_EPSILON);
  return FieldSample(psi, rho, phase, grad_rho, current, flow, coherence, shell_distance);
}

fn tangent_flow(flow: vec3<f32>, normal: vec3<f32>) -> vec3<f32> {
  return flow - normal * dot(flow, normal);
}

fn project_to_surface(
  position: vec3<f32>,
  sample: FieldSample,
  surface_threshold_value: f32,
  lock_strength: f32,
  epsilon: f32
) -> vec3<f32> {
  let denom = dot(sample.grad_rho, sample.grad_rho) + epsilon;
  let correction = ((sample.rho - surface_threshold_value) / denom) * lock_strength;
  return position - sample.grad_rho * correction;
}

fn estimate_shell_radius(density: f32, coherence: f32, thickness: f32) -> f32 {
  let density_gain = clamp(density, 0.14, 1.4);
  return thickness * (0.22 + density_gain * 0.16 + coherence * 0.2);
}

fn flow_at(position: vec3<f32>, time: f32) -> vec3<f32> {
  let psi = sample_psi(position, time);
  let current = probability_current(position, time);
  return flow_velocity(psi, current);
}

fn divergence_at(position: vec3<f32>, time: f32) -> f32 {
  let flow_xp = flow_at(position + vec3<f32>(GRADIENT_STEP, 0.0, 0.0), time);
  let flow_xm = flow_at(position - vec3<f32>(GRADIENT_STEP, 0.0, 0.0), time);
  let flow_yp = flow_at(position + vec3<f32>(0.0, GRADIENT_STEP, 0.0), time);
  let flow_ym = flow_at(position - vec3<f32>(0.0, GRADIENT_STEP, 0.0), time);
  let flow_zp = flow_at(position + vec3<f32>(0.0, 0.0, GRADIENT_STEP), time);
  let flow_zm = flow_at(position - vec3<f32>(0.0, 0.0, GRADIENT_STEP), time);
  return
    (flow_xp.x - flow_xm.x + flow_yp.y - flow_ym.y + flow_zp.z - flow_zm.z) /
    (2.0 * GRADIENT_STEP);
}

fn curl_at(position: vec3<f32>, time: f32) -> vec3<f32> {
  let flow_xp = flow_at(position + vec3<f32>(GRADIENT_STEP, 0.0, 0.0), time);
  let flow_xm = flow_at(position - vec3<f32>(GRADIENT_STEP, 0.0, 0.0), time);
  let flow_yp = flow_at(position + vec3<f32>(0.0, GRADIENT_STEP, 0.0), time);
  let flow_ym = flow_at(position - vec3<f32>(0.0, GRADIENT_STEP, 0.0), time);
  let flow_zp = flow_at(position + vec3<f32>(0.0, 0.0, GRADIENT_STEP), time);
  let flow_zm = flow_at(position - vec3<f32>(0.0, 0.0, GRADIENT_STEP), time);
  return vec3<f32>(
    (flow_zp.y - flow_zm.y - flow_yp.z + flow_ym.z) / (2.0 * GRADIENT_STEP),
    (flow_xp.z - flow_xm.z - flow_zp.x + flow_zm.x) / (2.0 * GRADIENT_STEP),
    (flow_yp.x - flow_ym.x - flow_xp.y + flow_xm.y) / (2.0 * GRADIENT_STEP)
  );
}

fn flow_diagnostics(position: vec3<f32>, time: f32, normal: vec3<f32>) -> FlowDiagnostics {
  let sample = sample_field(position, time);
  let divergence = divergence_at(position, time);
  let vorticity = curl_at(position, time);
  let burst =
    (max(0.0, dot(sample.flow, normal)) + max(0.0, divergence) * 0.5) *
    smoothstep(0.08, 0.26, sample.coherence);
  return FlowDiagnostics(vorticity, divergence, burst, length(sample.flow));
}
