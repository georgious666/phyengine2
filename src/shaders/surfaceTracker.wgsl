const FIELD_EPSILON = 1e-5;
const GRADIENT_STEP = 0.035;
const GOLDEN_ANGLE = 2.3999631;
const INVALID_SLOT = 0xffffffffu;

struct PointRecord {
  position_radius: vec4<f32>,
  normal_state: vec4<f32>,
  velocity_density: vec4<f32>,
  phase_brightness: vec4<f32>,
}

struct SimPointState {
  lifecycle: vec4<f32>,
  tags: vec4<u32>,
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

struct SimUniforms {
  time_dt_threshold_epsilon: vec4<f32>,
  motion_target: vec4<f32>,
  spawn_budget: vec4<f32>,
  grid_min_cell: vec4<f32>,
  grid_dims_meta: vec4<f32>,
  counts: vec4<f32>,
}

struct GlobalState {
  values: vec4<u32>,
}

struct CompactMetricRecord {
  position_density: vec4<f32>,
  velocity_coherence: vec4<f32>,
  brightness_cluster_alive: vec4<f32>,
}

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

@group(0) @binding(0) var<uniform> sim: SimUniforms;
@group(0) @binding(1) var<storage, read_write> points: array<PointRecord>;
@group(0) @binding(2) var<storage, read_write> point_state: array<SimPointState>;
@group(0) @binding(3) var<storage, read_write> previous_points: array<PointRecord>;
@group(0) @binding(4) var<storage, read_write> scratch_points: array<PointRecord>;
@group(0) @binding(5) var<storage, read_write> scratch_state: array<SimPointState>;
@group(0) @binding(6) var<storage, read_write> clusters: array<ClusterRecord>;
@group(0) @binding(7) var<storage, read_write> modes: array<ModeRecord>;
@group(0) @binding(8) var<storage, read_write> global_state: GlobalState;
@group(0) @binding(9) var<storage, read_write> free_slots: array<u32>;
@group(0) @binding(10) var<storage, read_write> grid_cells: array<vec4<u32>>;
@group(0) @binding(11) var<storage, read_write> grid_indices: array<u32>;
@group(0) @binding(12) var<storage, read_write> sort_indices: array<u32>;
@group(0) @binding(13) var<storage, read_write> compact_metrics: array<CompactMetricRecord>;

fn point_capacity() -> u32 {
  return u32(sim.counts.y);
}

fn cluster_count() -> u32 {
  return u32(sim.counts.z);
}

fn grid_cell_count() -> u32 {
  let dims = vec3<u32>(
    u32(sim.grid_dims_meta.x),
    u32(sim.grid_dims_meta.y),
    u32(sim.grid_dims_meta.z)
  );
  return max(1u, dims.x * dims.y * dims.z);
}

fn clear_point(slot: u32) {
  points[slot].position_radius = vec4<f32>(0.0);
  points[slot].normal_state = vec4<f32>(0.0);
  points[slot].velocity_density = vec4<f32>(0.0);
  points[slot].phase_brightness = vec4<f32>(0.0);
}

fn clear_scratch(slot: u32) {
  scratch_points[slot].position_radius = vec4<f32>(0.0);
  scratch_points[slot].normal_state = vec4<f32>(0.0);
  scratch_points[slot].velocity_density = vec4<f32>(0.0);
  scratch_points[slot].phase_brightness = vec4<f32>(0.0);
  scratch_state[slot].lifecycle = vec4<f32>(0.0);
  scratch_state[slot].tags = vec4<u32>(0u);
}

fn safe_normalize(v: vec3<f32>) -> vec3<f32> {
  let len = length(v);
  if (len <= 0.0) {
    return vec3<f32>(0.0);
  }
  return v / len;
}

fn clamp_length(v: vec3<f32>, max_length: f32) -> vec3<f32> {
  let len = length(v);
  if (len <= max_length || len <= 0.0) {
    return v;
  }
  return v * (max_length / len);
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
  let shell = gaussian_shell(
    r,
    mode.values0.y / max(0.55, cluster.structural.y),
    mode.values0.z
  );
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
  let shell_distance = (rho - sim.time_dt_threshold_epsilon.z) / (gradient_magnitude + FIELD_EPSILON);
  return FieldSample(psi, rho, phase, grad_rho, current, flow, coherence, shell_distance);
}

fn tangent_flow(flow: vec3<f32>, normal: vec3<f32>) -> vec3<f32> {
  return flow - normal * dot(flow, normal);
}

fn project_to_surface(
  position: vec3<f32>,
  sample: FieldSample,
  surface_threshold: f32,
  lock_strength: f32,
  epsilon: f32
) -> vec3<f32> {
  let denom = dot(sample.grad_rho, sample.grad_rho) + epsilon;
  let correction = ((sample.rho - surface_threshold) / denom) * lock_strength;
  return position - sample.grad_rho * correction;
}

fn estimate_shell_radius(density: f32, coherence: f32, thickness: f32) -> f32 {
  let density_gain = clamp(density, 0.14, 1.4);
  return thickness * (0.22 + density_gain * 0.16 + coherence * 0.2);
}

fn cell_index(position: vec3<f32>) -> u32 {
  let dims = vec3<i32>(
    i32(sim.grid_dims_meta.x),
    i32(sim.grid_dims_meta.y),
    i32(sim.grid_dims_meta.z)
  );
  let coord = vec3<i32>(floor((position - sim.grid_min_cell.xyz) / sim.grid_min_cell.www));
  if (
    coord.x < 0 ||
    coord.y < 0 ||
    coord.z < 0 ||
    coord.x >= dims.x ||
    coord.y >= dims.y ||
    coord.z >= dims.z
  ) {
    return INVALID_SLOT;
  }
  let dims_u = vec3<u32>(u32(dims.x), u32(dims.y), u32(dims.z));
  return u32(coord.x) + u32(coord.y) * dims_u.x + u32(coord.z) * dims_u.x * dims_u.y;
}

fn nearest_distance_grid(candidate: vec3<f32>, ignore_slot: u32) -> f32 {
  let dims = vec3<i32>(
    i32(sim.grid_dims_meta.x),
    i32(sim.grid_dims_meta.y),
    i32(sim.grid_dims_meta.z)
  );
  let base_coord = vec3<i32>(floor((candidate - sim.grid_min_cell.xyz) / sim.grid_min_cell.www));
  var best = 1e20;
  for (var dz = -1; dz <= 1; dz = dz + 1) {
    for (var dy = -1; dy <= 1; dy = dy + 1) {
      for (var dx = -1; dx <= 1; dx = dx + 1) {
        let coord = base_coord + vec3<i32>(dx, dy, dz);
        if (
          coord.x < 0 ||
          coord.y < 0 ||
          coord.z < 0 ||
          coord.x >= dims.x ||
          coord.y >= dims.y ||
          coord.z >= dims.z
        ) {
          continue;
        }
        let cell =
          u32(coord.x) + u32(coord.y) * u32(dims.x) + u32(coord.z) * u32(dims.x) * u32(dims.y);
        let start = grid_cells[cell].y;
        let count = grid_cells[cell].x;
        for (var offset = 0u; offset < count; offset = offset + 1u) {
          let slot = grid_indices[start + offset];
          if (slot == ignore_slot || point_state[slot].tags.y == 0u) {
            continue;
          }
          best = min(best, distance(candidate, points[slot].position_radius.xyz));
        }
      }
    }
  }
  return best;
}

fn tangential_repulsion(current_slot: u32, strength: f32) -> vec3<f32> {
  let position = points[current_slot].position_radius.xyz;
  let dims = vec3<i32>(
    i32(sim.grid_dims_meta.x),
    i32(sim.grid_dims_meta.y),
    i32(sim.grid_dims_meta.z)
  );
  let base_coord = vec3<i32>(floor((position - sim.grid_min_cell.xyz) / sim.grid_min_cell.www));
  var force = vec3<f32>(0.0);
  for (var dz = -1; dz <= 1; dz = dz + 1) {
    for (var dy = -1; dy <= 1; dy = dy + 1) {
      for (var dx = -1; dx <= 1; dx = dx + 1) {
        let coord = base_coord + vec3<i32>(dx, dy, dz);
        if (
          coord.x < 0 ||
          coord.y < 0 ||
          coord.z < 0 ||
          coord.x >= dims.x ||
          coord.y >= dims.y ||
          coord.z >= dims.z
        ) {
          continue;
        }
        let cell =
          u32(coord.x) + u32(coord.y) * u32(dims.x) + u32(coord.z) * u32(dims.x) * u32(dims.y);
        let start = grid_cells[cell].y;
        let count = grid_cells[cell].x;
        for (var offset = 0u; offset < count; offset = offset + 1u) {
          let other_slot = grid_indices[start + offset];
          if (other_slot == current_slot || point_state[other_slot].tags.y == 0u) {
            continue;
          }
          let offset_vector = position - points[other_slot].position_radius.xyz;
          let distance_to_other = length(offset_vector);
          if (distance_to_other < 1e-5 || distance_to_other > strength) {
            continue;
          }
          let away = safe_normalize(offset_vector) * ((strength - distance_to_other) / strength);
          force = force + away;
        }
      }
    }
  }
  return force;
}

fn random_next() -> f32 {
  global_state.values.y = global_state.values.y + 0x6d2b79f5u;
  var t = global_state.values.y;
  t = (t ^ (t >> 15u)) * (t | 1u);
  t = t ^ (t + ((t ^ (t >> 7u)) * (t | 61u)));
  return f32(t ^ (t >> 14u)) / 4294967296.0;
}

fn spherical_direction(index: u32, total: u32) -> vec3<f32> {
  let t = (f32(index) + 0.5) / f32(total);
  let y = 1.0 - 2.0 * t;
  let radius = sqrt(max(0.0, 1.0 - y * y));
  let theta = GOLDEN_ANGLE * f32(index);
  return vec3<f32>(cos(theta) * radius, y, sin(theta) * radius);
}

fn write_point(
  slot: u32,
  position: vec3<f32>,
  velocity: vec3<f32>,
  normal: vec3<f32>,
  density: f32,
  phase: f32,
  coherence: f32,
  brightness: f32,
  radius: f32,
  state_index: f32,
  point_id: f32
) {
  points[slot].position_radius = vec4<f32>(position, radius);
  points[slot].normal_state = vec4<f32>(normal, state_index);
  points[slot].velocity_density = vec4<f32>(velocity, density);
  points[slot].phase_brightness = vec4<f32>(phase, brightness, coherence, point_id);
}

fn project_candidate(position: vec3<f32>, time: f32) -> vec4<f32> {
  var current_position = position;
  var sample = sample_field(current_position, time);
  for (var iteration = 0; iteration < 3; iteration = iteration + 1) {
    current_position = project_to_surface(
      current_position,
      sample,
      sim.time_dt_threshold_epsilon.z,
      1.0,
      sim.time_dt_threshold_epsilon.w
    );
    sample = sample_field(current_position, time);
  }
  return vec4<f32>(current_position, sample.rho);
}

fn nearest_distance_all(candidate: vec3<f32>, ignore_slot: u32) -> f32 {
  var best = 1e20;
  for (var slot = 0u; slot < point_capacity(); slot = slot + 1u) {
    if (point_state[slot].tags.y == 0u || slot == ignore_slot) {
      continue;
    }
    best = min(best, distance(candidate, points[slot].position_radius.xyz));
  }
  return best;
}

@compute @workgroup_size(1)
fn rebuildStateAndGrid(@builtin(global_invocation_id) global_id: vec3<u32>) {
  if (global_id.x > 0u) {
    return;
  }

  let cell_count = grid_cell_count();
  for (var cell = 0u; cell < cell_count; cell = cell + 1u) {
    grid_cells[cell] = vec4<u32>(0u);
  }

  var live_count = 0u;
  var free_count = 0u;

  for (var slot = 0u; slot < point_capacity(); slot = slot + 1u) {
    if (point_state[slot].tags.y == 0u || points[slot].phase_brightness.w <= 0.0) {
      point_state[slot].tags.y = 0u;
      clear_point(slot);
      free_slots[free_count] = slot;
      free_count = free_count + 1u;
      continue;
    }
    live_count = live_count + 1u;
    let cell = cell_index(points[slot].position_radius.xyz);
    if (cell != INVALID_SLOT) {
      grid_cells[cell].x = grid_cells[cell].x + 1u;
    }
  }

  var running = 0u;
  for (var cell = 0u; cell < cell_count; cell = cell + 1u) {
    grid_cells[cell].y = running;
    running = running + grid_cells[cell].x;
    grid_cells[cell].z = 0u;
  }

  for (var slot = 0u; slot < point_capacity(); slot = slot + 1u) {
    if (point_state[slot].tags.y == 0u) {
      continue;
    }
    let cell = cell_index(points[slot].position_radius.xyz);
    if (cell == INVALID_SLOT) {
      continue;
    }
    let dest = grid_cells[cell].y + grid_cells[cell].z;
    grid_indices[dest] = slot;
    grid_cells[cell].z = grid_cells[cell].z + 1u;
  }

  global_state.values.z = live_count;
  global_state.values.w = free_count;
}

@compute @workgroup_size(64)
fn updatePoints(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let slot = global_id.x;
  if (slot >= point_capacity()) {
    return;
  }
  if (point_state[slot].tags.y == 0u || points[slot].phase_brightness.w <= 0.0) {
    clear_scratch(slot);
    return;
  }

  let initial_sample = sample_field(points[slot].position_radius.xyz, sim.time_dt_threshold_epsilon.x);
  let normal = safe_normalize(initial_sample.grad_rho);
  let tangential_velocity = tangent_flow(initial_sample.flow, normal);
  let relax = tangential_repulsion(slot, sim.spawn_budget.y);
  let tangential_relax = tangent_flow(relax, normal);
  let advect_velocity =
    clamp_length(tangential_velocity, sim.motion_target.z) * sim.motion_target.y +
    tangential_relax * sim.motion_target.x;
  let predicted = points[slot].position_radius.xyz + advect_velocity * sim.time_dt_threshold_epsilon.y;
  var projected_sample = sample_field(predicted, sim.time_dt_threshold_epsilon.x);
  var projected = project_to_surface(
    predicted,
    projected_sample,
    sim.time_dt_threshold_epsilon.z,
    point_state[slot].lifecycle.z,
    sim.time_dt_threshold_epsilon.w
  );
  projected_sample = sample_field(projected, sim.time_dt_threshold_epsilon.x);
  let projected_normal = safe_normalize(projected_sample.grad_rho);

  if (projected_sample.rho < sim.grid_dims_meta.w) {
    clear_scratch(slot);
    return;
  }

  scratch_points[slot].position_radius = vec4<f32>(projected, points[slot].position_radius.w);
  scratch_points[slot].normal_state = vec4<f32>(
    projected_normal,
    select(0.0, 3.0, projected_sample.coherence < 0.22)
  );
  scratch_points[slot].velocity_density = vec4<f32>(advect_velocity, projected_sample.rho);
  scratch_points[slot].phase_brightness = vec4<f32>(
    projected_sample.phase,
    projected_sample.coherence * (0.55 + projected_sample.rho * 0.7),
    projected_sample.coherence,
    points[slot].phase_brightness.w
  );
  scratch_state[slot].lifecycle = vec4<f32>(
    point_state[slot].lifecycle.x + sim.time_dt_threshold_epsilon.y,
    point_state[slot].lifecycle.y,
    point_state[slot].lifecycle.z,
    0.0
  );
  scratch_state[slot].tags = vec4<u32>(point_state[slot].tags.x, 1u, 0u, 0u);
}

@compute @workgroup_size(1)
fn spawnPoints(@builtin(global_invocation_id) global_id: vec3<u32>) {
  if (global_id.x > 0u) {
    return;
  }

  let target_count = u32(sim.motion_target.w);
  if (global_state.values.z >= target_count || global_state.values.w == 0u) {
    return;
  }

  var births = 0u;
  var live_count = global_state.values.z;
  var free_count = global_state.values.w;
  let cluster_total = max(1u, cluster_count());
  let direction_total = max(64u, target_count);

  loop {
    if (births >= u32(sim.spawn_budget.z) || live_count >= target_count || free_count == 0u) {
      break;
    }
    let cluster_index = min(cluster_total - 1u, u32(floor(random_next() * f32(cluster_total))));
    let direction_index = min(direction_total - 1u, u32(floor(random_next() * f32(direction_total))));
    let direction = spherical_direction(direction_index, direction_total);
    let jitter = 0.82 + random_next() * 0.72;
    let candidate =
      clusters[cluster_index].center.xyz + direction * (clusters[cluster_index].structural.y * jitter);
    let projection = project_candidate(candidate, sim.time_dt_threshold_epsilon.x);
    let distance_to_other = nearest_distance_all(projection.xyz, INVALID_SLOT);
    if (
      projection.w < sim.time_dt_threshold_epsilon.z * 0.55 ||
      distance_to_other < sim.spawn_budget.x ||
      distance_to_other > sim.spawn_budget.y * 1.8
    ) {
      births = births + 1u;
      continue;
    }

    let slot = free_slots[free_count - 1u];
    free_count = free_count - 1u;
    let initial = sample_field(projection.xyz, sim.time_dt_threshold_epsilon.x);
    let lifetime = 24.0 + random_next() * 16.0;
    write_point(
      slot,
      projection.xyz,
      vec3<f32>(0.0),
      safe_normalize(initial.grad_rho),
      initial.rho,
      initial.phase,
      initial.coherence,
      initial.coherence * (0.55 + initial.rho * 0.7),
      sim.spawn_budget.x,
      1.0,
      f32(global_state.values.x)
    );
    point_state[slot].lifecycle = vec4<f32>(0.0, lifetime, 0.9, 0.0);
    point_state[slot].tags = vec4<u32>(cluster_index, 1u, 0u, 0u);
    global_state.values.x = global_state.values.x + 1u;
    live_count = live_count + 1u;
    births = births + 1u;
  }

  global_state.values.z = live_count;
  global_state.values.w = free_count;
}

@compute @workgroup_size(1)
fn sortByDensity(@builtin(global_invocation_id) global_id: vec3<u32>) {
  if (global_id.x > 0u) {
    return;
  }

  var count = 0u;
  for (var slot = 0u; slot < point_capacity(); slot = slot + 1u) {
    if (point_state[slot].tags.y == 0u || points[slot].phase_brightness.w <= 0.0) {
      continue;
    }
    sort_indices[count] = slot;
    count = count + 1u;
  }
  for (var slot = count; slot < point_capacity(); slot = slot + 1u) {
    sort_indices[slot] = INVALID_SLOT;
  }

  for (var index = 1u; index < count; index = index + 1u) {
    let current_slot = sort_indices[index];
    let current_density = points[current_slot].velocity_density.w;
    var cursor = index;
    loop {
      if (cursor == 0u) {
        break;
      }
      let previous_slot = sort_indices[cursor - 1u];
      if (points[previous_slot].velocity_density.w >= current_density) {
        break;
      }
      sort_indices[cursor] = previous_slot;
      cursor = cursor - 1u;
    }
    sort_indices[cursor] = current_slot;
  }
}

@compute @workgroup_size(1)
fn cullPoints(@builtin(global_invocation_id) global_id: vec3<u32>) {
  if (global_id.x > 0u) {
    return;
  }

  var kept_count = 0u;
  var removed = 0u;
  let point_budget = u32(sim.counts.x);

  for (var index = 0u; index < point_capacity(); index = index + 1u) {
    let slot = sort_indices[index];
    if (slot == INVALID_SLOT) {
      break;
    }
    if (removed >= u32(sim.spawn_budget.w) && kept_count > 0u) {
      free_slots[kept_count] = slot;
      kept_count = kept_count + 1u;
      continue;
    }

    var nearest = 1e20;
    for (var kept_index = 0u; kept_index < kept_count; kept_index = kept_index + 1u) {
      let other_slot = free_slots[kept_index];
      nearest = min(nearest, distance(points[slot].position_radius.xyz, points[other_slot].position_radius.xyz));
    }

    let too_close = nearest < sim.spawn_budget.x * 0.72;
    let too_far = abs(points[slot].velocity_density.w - sim.time_dt_threshold_epsilon.z) > 0.28;
    let aged_out = point_state[slot].lifecycle.x > point_state[slot].lifecycle.y;
    let unstable = points[slot].normal_state.w == 3.0 && points[slot].phase_brightness.z < 0.12;
    if (too_close || too_far || aged_out || unstable) {
      point_state[slot].tags.y = 0u;
      clear_point(slot);
      removed = removed + 1u;
      continue;
    }

    free_slots[kept_count] = slot;
    kept_count = kept_count + 1u;
  }

  if (kept_count > point_budget) {
    for (var index = point_budget; index < kept_count; index = index + 1u) {
      let slot = free_slots[index];
      point_state[slot].tags.y = 0u;
      clear_point(slot);
    }
  }
}

@compute @workgroup_size(64)
fn rebuildSdfAndMetrics(@builtin(global_invocation_id) global_id: vec3<u32>) {
  let slot = global_id.x;
  if (slot >= point_capacity()) {
    return;
  }

  if (point_state[slot].tags.y == 0u || points[slot].phase_brightness.w <= 0.0) {
    compact_metrics[slot].position_density = vec4<f32>(0.0);
    compact_metrics[slot].velocity_coherence = vec4<f32>(0.0);
    compact_metrics[slot].brightness_cluster_alive = vec4<f32>(0.0);
    return;
  }

  let spacing = clamp(
    nearest_distance_grid(points[slot].position_radius.xyz, slot),
    sim.spawn_budget.x,
    sim.spawn_budget.y
  );
  let brightness =
    points[slot].phase_brightness.y *
    (0.75 + min(1.0, spacing / sim.spawn_budget.y) * 0.35);
  let radius = estimate_shell_radius(
    points[slot].velocity_density.w,
    points[slot].phase_brightness.z,
    spacing
  );

  points[slot].position_radius.w = radius;
  points[slot].phase_brightness.y = brightness;

  compact_metrics[slot].position_density = vec4<f32>(points[slot].position_radius.xyz, points[slot].velocity_density.w);
  compact_metrics[slot].velocity_coherence = vec4<f32>(points[slot].velocity_density.xyz, points[slot].phase_brightness.z);
  compact_metrics[slot].brightness_cluster_alive = vec4<f32>(
    brightness,
    f32(point_state[slot].tags.x),
    1.0,
    0.0
  );
}
