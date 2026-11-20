// Pure, THREE-free 3D track geometry helpers. Presentation only: the session centerline, turn markers and pit trace are
// supplied by the API; this module only maps them to metres and dresses them (DECISION.md D2/E3). No positions are invented.

// E3: session units are approximately decimetres. World X = x·0.1, Z = −y·0.1, Y = (z − zMin)·0.1 metres (Y up).
export const SESSION_TO_METRES = 0.1;
export const TRACK_WIDTH = 12;
export const PIT_WIDTH = 8;

export function createMapper(zMin = 0) {
  const s = SESSION_TO_METRES;
  return {
    zMin,
    // Missing z (older 3-value samples) stays at the reference ground height instead of an invented elevation.
    toWorld: (x, y, z) => [x * s, Number.isFinite(z) ? (z - zMin) * s : 0, -y * s],
    toSession: (X, Y, Z) => ({x: X / s, y: -Z / s, z: Y / s + zMin}),
  };
}

// Lowest finite z of the reference lap (and pit trace when present).
export function referenceZMin(geometry) {
  let min = Infinity;
  for (const p of geometry?.points || []) if (Number.isFinite(p[3])) min = Math.min(min, p[3]);
  for (const p of pitPoints(geometry)) if (Number.isFinite(p[2])) min = Math.min(min, p[2]);
  return Number.isFinite(min) ? min : 0;
}

// geometry.pitLane.points is [[x,y,z],...]; tolerate [t,x,y,z] rows as well. Returns [[x,y,z|undefined],...].
export function pitPoints(geometry) {
  const rows = geometry?.pitLane?.points;
  if (!Array.isArray(rows)) return [];
  return rows.filter(Array.isArray).map(p => p.length >= 4 ? [p[1], p[2], p[3]] : [p[0], p[1], p[2]])
    .filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function dedupe(points, closed, minDistance) {
  const out = [];
  for (const p of points) if (!out.length || dist(out.at(-1), p) >= minDistance) out.push(p);
  while (closed && out.length > 2 && dist(out.at(-1), out[0]) < minDistance) out.pop();
  return out;
}

// Centripetal Catmull-Rom point between p1 and p2 (Barry-Goldman), u in [0,1]. Centripetal avoids cusps and loops.
function catmull(p0, p1, p2, p3, u) {
  const knot = (a, b) => Math.max(1e-6, Math.sqrt(dist(a, b)));
  const t0 = 0, t1 = t0 + knot(p0, p1), t2 = t1 + knot(p1, p2), t3 = t2 + knot(p2, p3), t = t1 + (t2 - t1) * u;
  const out = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const a1 = (t1 - t) / (t1 - t0) * p0[k] + (t - t0) / (t1 - t0) * p1[k];
    const a2 = (t2 - t) / (t2 - t1) * p1[k] + (t - t1) / (t2 - t1) * p2[k];
    const a3 = (t3 - t) / (t3 - t2) * p2[k] + (t - t2) / (t3 - t2) * p3[k];
    const b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2;
    const b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3;
    out[k] = (t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2;
  }
  return out;
}

// Smooth polyline through world points ([X,Y,Z] metres), resampled at ~uniform arc-length spacing.
// The curve passes through every supplied point; closed loops start exactly at points[0] (the start/finish line).
export function smoothPath(points, {closed = true, spacing = 2} = {}) {
  const p = dedupe(points, closed, 0.25), n = p.length;
  if (n < 2) return p.map(q => [...q]);
  const at = i => closed ? p[(i % n + n) % n] : i < 0 ? mirror(p[0], p[1]) : i >= n ? mirror(p[n - 1], p[n - 2]) : p[i];
  const dense = [], segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const a = at(i - 1), b = at(i), c = at(i + 1), d = at(i + 2), steps = Math.max(2, Math.ceil(dist(b, c) / 0.5));
    for (let s = 0; s < steps; s++) dense.push(catmull(a, b, c, d, s / steps));
  }
  dense.push(closed ? [...p[0]] : [...p[n - 1]]);
  // Uniform arc-length resampling of the dense polyline.
  const lengths = [0];
  for (let i = 1; i < dense.length; i++) lengths.push(lengths[i - 1] + dist(dense[i - 1], dense[i]));
  const total = lengths.at(-1), count = Math.max(closed ? 3 : 2, Math.round(total / spacing)), step = total / count, out = [];
  let j = 0;
  for (let k = 0; k < (closed ? count : count + 1); k++) {
    const s = Math.min(total, k * step);
    while (j < lengths.length - 2 && lengths[j + 1] < s) j++;
    const span = lengths[j + 1] - lengths[j], f = span > 0 ? (s - lengths[j]) / span : 0, a = dense[j], b = dense[j + 1];
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]);
  }
  return out;
}
const mirror = (a, b) => [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];

// Horizontal unit tangents (XZ plane) from averaged incoming/outgoing segment directions.
export function tangents(center, closed = true) {
  const n = center.length, out = [];
  const dir = (a, b) => { const dx = b[0] - a[0], dz = b[2] - a[2], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
  for (let i = 0; i < n; i++) {
    const prev = closed ? center[(i - 1 + n) % n] : center[Math.max(0, i - 1)], next = closed ? center[(i + 1) % n] : center[Math.min(n - 1, i + 1)];
    const a = i > 0 || closed ? dir(prev, center[i]) : null, b = i < n - 1 || closed ? dir(center[i], next) : null;
    let tx = (a?.[0] ?? 0) + (b?.[0] ?? 0), tz = (a?.[1] ?? 0) + (b?.[1] ?? 0), l = Math.hypot(tx, tz);
    if (l < 1e-9) { tx = (b ?? a)[0]; tz = (b ?? a)[1]; l = 1; }
    out.push([tx / l, tz / l]);
  }
  return out;
}

// Left normal of a horizontal tangent: up × forward. Forward +X gives left −Z (session +y), matching a top-down map.
export const leftNormal = t => [t[1], -t[0]];

// Flat-across, elevation-following ribbon. Returns edge polylines plus indexed triangle data
// (two vertices per centerline point: left then right; `distance` is the arc length for each vertex pair).
export function ribbon(center, width, {closed = true, lift = 0} = {}) {
  const t = tangents(center, closed), h = width / 2, n = center.length, left = [], right = [];
  const positions = new Float32Array(n * 6), distance = new Float32Array(n * 2);
  let s = 0;
  for (let i = 0; i < n; i++) {
    if (i) s += dist(center[i - 1], center[i]);
    const [lx, lz] = leftNormal(t[i]), c = center[i], y = c[1] + lift;
    const L = [c[0] + lx * h, y, c[2] + lz * h], R = [c[0] - lx * h, y, c[2] - lz * h];
    left.push(L); right.push(R); positions.set(L, i * 6); positions.set(R, i * 6 + 3); distance[i * 2] = distance[i * 2 + 1] = s;
  }
  const quads = closed ? n : n - 1, indices = new Uint32Array(quads * 6);
  for (let i = 0; i < quads; i++) {
    const a = i * 2, b = ((i + 1) % n) * 2;
    // Counter-clockwise when viewed from above (+Y) so the top face is the front face.
    indices.set([a, a + 1, b, b, a + 1, b + 1], i * 6);
  }
  return {left, right, positions, indices, distance, tangents: t};
}

// Vertical skirt from an edge polyline down to the ground plane, so elevated sections read as raised.
export function skirt(edge, groundY, {closed = true} = {}) {
  const n = edge.length, positions = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) { positions.set(edge[i], i * 6); positions.set([edge[i][0], groundY, edge[i][2]], i * 6 + 3); }
  const quads = closed ? n : n - 1, indices = new Uint32Array(quads * 6);
  for (let i = 0; i < quads; i++) { const a = i * 2, b = ((i + 1) % n) * 2; indices.set([a, b, a + 1, b, b + 1, a + 1], i * 6); }
  return {positions, indices};
}

export function nearestIndex(center, X, Z) {
  let best = -1, bestDistance = Infinity;
  for (let i = 0; i < center.length; i++) {
    const d = (center[i][0] - X) ** 2 + (center[i][2] - Z) ** 2;
    if (d < bestDistance) { bestDistance = d; best = i; }
  }
  return {index: best, distance: Math.sqrt(bestDistance)};
}

// Nearest centerline index searched around a previous index first (closed loop), falling back to a full scan when the
// local match is far away (seek, first frame). Keeps per-frame per-car lookups cheap.
export function nearestIndexAround(center, X, Z, hint, radius = 40, maxLocal = 30) {
  const n = center.length;
  if (!Number.isInteger(hint) || hint < 0 || hint >= n || n <= radius * 2) return nearestIndex(center, X, Z);
  let best = hint, bestDistance = Infinity;
  for (let k = -radius; k <= radius; k++) {
    const i = ((hint + k) % n + n) % n, d = (center[i][0] - X) ** 2 + (center[i][2] - Z) ** 2;
    if (d < bestDistance) { bestDistance = d; best = i; }
  }
  return Math.sqrt(bestDistance) <= maxLocal ? {index: best, distance: Math.sqrt(bestDistance)} : nearestIndex(center, X, Z);
}

// Red/white kerb strips on both sides of the centerline around each turn marker's closest centerline point.
export function kerbs(center, cornerPoints, {width = TRACK_WIDTH, kerbWidth = 1.2, halfLength = 14, closed = true, lift = 0.03, maxDistance = 60} = {}) {
  const t = tangents(center, closed), n = center.length, positions = [], colors = [], indices = [], placed = [];
  if (n < 3) return {positions: new Float32Array(0), colors: new Float32Array(0), indices: new Uint32Array(0), placed};
  const spacing = Math.max(0.1, dist(center[0], center[1])), m = Math.max(1, Math.round(halfLength / spacing));
  const inner = width / 2 - 0.3, outer = inner + kerbWidth, red = [0.78, 0.07, 0.12], white = [0.9, 0.91, 0.9];
  for (const corner of cornerPoints) {
    const {index, distance} = nearestIndex(center, corner[0], corner[2]);
    if (index < 0 || distance > maxDistance) continue;
    placed.push(index);
    for (const side of [1, -1]) for (let k = -m; k < m; k++) {
      let i = index + k, j = i + 1;
      if (closed) { i = (i % n + n) % n; j = (j % n + n) % n; } else if (i < 0 || j >= n) continue;
      const base = positions.length / 3, color = ((k + m) & 1) ? white : red;
      for (const q of [i, j]) {
        const [lx, lz] = leftNormal(t[q]), c = center[q], y = c[1] + lift;
        positions.push(c[0] + side * lx * inner, y, c[2] + side * lz * inner, c[0] + side * lx * outer, y, c[2] + side * lz * outer);
        colors.push(...color, ...color);
      }
      // base: i-inner, i-outer, j-inner, j-outer. Wind counter-clockwise from above for either side.
      indices.push(...(side === -1 ? [base, base + 1, base + 2, base + 2, base + 1, base + 3] : [base, base + 2, base + 1, base + 2, base + 3, base + 1]));
    }
  }
  return {positions: new Float32Array(positions), colors: new Float32Array(colors), indices: new Uint32Array(indices), placed};
}

// Chequered start/finish line across the ribbon at center[0] (geometry.points[0], the reference lap start).
export function startLine(center, {width = TRACK_WIDTH, rows = 2, columns = 12, cell = 0.6, lift = 0.035} = {}) {
  const positions = [], colors = [], indices = [];
  if (center.length < 2) return {positions: new Float32Array(0), colors: new Float32Array(0), indices: new Uint32Array(0)};
  const [tx, tz] = tangents(center, true)[0], [lx, lz] = leftNormal([tx, tz]), c = center[0], y = c[1] + lift;
  for (let r = 0; r < rows; r++) for (let q = 0; q < columns; q++) {
    const a0 = (r - rows / 2) * cell, a1 = a0 + cell, l0 = width / 2 - q * width / columns, l1 = l0 - width / columns, base = positions.length / 3;
    const color = (r + q) & 1 ? [0.08, 0.09, 0.1] : [0.93, 0.94, 0.92];
    for (const [a, l] of [[a0, l0], [a0, l1], [a1, l0], [a1, l1]]) { positions.push(c[0] + tx * a + lx * l, y, c[2] + tz * a + lz * l); colors.push(...color); }
    indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
  }
  return {positions: new Float32Array(positions), colors: new Float32Array(colors), indices: new Uint32Array(indices)};
}

export function bounds(points) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, y, z] of points) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  return {minX, maxX, minY, maxY, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, sizeX: maxX - minX, sizeZ: maxZ - minZ};
}

// Complete approximate 3D dressing of an API geometry object.
export function buildTrack(geometry, {width = TRACK_WIDTH, pitWidth = PIT_WIDTH, spacing = 2} = {}) {
  const raw = (geometry?.points || []).filter(p => Number.isFinite(p[1]) && Number.isFinite(p[2]));
  if (raw.length < 3) return null;
  const mapper = createMapper(referenceZMin(geometry)), control = raw.map(p => mapper.toWorld(p[1], p[2], p[3]));
  const center = smoothPath(control, {closed: true, spacing}), road = ribbon(center, width), box = bounds(center), groundY = Math.min(0, box.minY) - 0.05;
  const corners = (geometry.corners || []).filter(c => Number.isFinite(c.x) && Number.isFinite(c.y)).map(c => mapper.toWorld(c.x, c.y, undefined));
  let pit = null;
  const pitRaw = pitPoints(geometry);
  if (pitRaw.length >= 2) {
    const pitControl = pitRaw.map(([x, y, z]) => {
      const w = mapper.toWorld(x, y, z);
      if (!Number.isFinite(z)) w[1] = center[nearestIndex(center, w[0], w[2]).index][1];
      return w;
    });
    const path = smoothPath(pitControl, {closed: false, spacing});
    if (path.length >= 2) pit = {center: path, ribbon: ribbon(path, pitWidth, {closed: false, lift: -0.02})};
  }
  let length = 0;
  for (let i = 0; i < center.length; i++) length += dist(center[i], center[(i + 1) % center.length]);
  return {mapper, zMin: mapper.zMin, width, center, ribbon: road, skirts: [skirt(road.left, groundY), skirt(road.right, groundY)],
    kerbs: kerbs(center, corners, {width}), start: startLine(center, {width}), pit, bounds: box, groundY, length};
}

// Track surface height near a world XZ point (used only when a sample carries no z).
export function heightAt(track, X, Z) {
  const {index} = nearestIndex(track.center, X, Z);
  return index < 0 ? 0 : track.center[index][1];
}

// Heading helpers. Session heading h is atan2(dy, dx) in the session xy plane; in world space it points along
// (cos h, 0, −sin h), which is exactly three.js rotation.y = h for a model whose forward axis is +X.
export const sessionHeading = (dx, dy) => Math.atan2(dy, dx);
export const headingVector = h => [Math.cos(h), 0, -Math.sin(h)];
export function wrapAngle(a) { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; }
export const angleDelta = (from, to) => wrapAngle(to - from);
// Frame-rate independent exponential damping (presentation only, DECISION.md E4).
export const damp = (current, target, lambda, dt) => target + (current - target) * Math.exp(-lambda * Math.max(0, dt));
export const dampAngle = (current, target, lambda, dt) => wrapAngle(current + angleDelta(current, target) * (1 - Math.exp(-lambda * Math.max(0, dt))));
