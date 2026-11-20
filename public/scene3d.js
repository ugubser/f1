// One shared three.js scene and WebGL renderer for every camera tile (DECISION.md E1). Presentation only:
// car transforms come from MotionBuffer.pose() (interpolated supplied samples); the track is the approximate
// dressing from track3d.js (D2: ribbon, kerbs, pit lane, start line, ground). Overlapping cars stay on their recorded
// line and become ghosts (D1). Cars are low-poly procedural team-coloured models (E5).
import * as THREE from '/vendor/three.module.js';
import {buildTrack, ribbon, nearestIndexAround, SESSION_TO_METRES} from './track3d.js';

export const CAR_LENGTH = 5.6, CAR_WIDTH = 2.0;
export const SECTOR_COLORS = {1: '#74bdff', 2: '#c5a0ff', 3: '#ffb472'};
const LABEL_W = 176, LABEL_H = 52, LABEL_DOT_X = 22;
// Muted dark palette matching the app: deep blue-green zenith, grey-teal horizon (also the fog colour), dark grass.
const SKY_TOP = new THREE.Color(0x0a1115), SKY_HORIZON = new THREE.Color(0x2b383a), SKY_BELOW = new THREE.Color(0x1c2621);
const CLEAR = new THREE.Color(0x0d1315), ASPHALT = new THREE.Color(0x3b4246), PIT_ASPHALT = new THREE.Color(0x33393c);
// Rendering budget: never more than ~4.5 million drawing-buffer pixels whatever the device pixel ratio.
const MAX_BUFFER_PIXELS = 4.5e6;

function indexedGeometry({positions, indices, colors}) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (colors) g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  g.computeVertexNormals();
  return g;
}

// Merge transformed primitives into one non-indexed geometry (BufferGeometryUtils is an addon with a bare 'three' import).
function merged(parts) {
  const positions = [], normals = [], m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  for (const {geometry, at = [0, 0, 0], rotate = [0, 0, 0], scale = [1, 1, 1]} of parts) {
    m.compose(new THREE.Vector3(...at), q.setFromEuler(e.set(...rotate)), new THREE.Vector3(...scale));
    const g = (geometry.index ? geometry.toNonIndexed() : geometry.clone()).applyMatrix4(m);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    positions.push(...g.getAttribute('position').array); normals.push(...g.getAttribute('normal').array);
    g.dispose(); geometry.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return out;
}

// Lofted low-poly body along +X through hexagonal cross-sections {x, hw (half width), bottom, top}. Flat-shaded,
// faces wound outward (checked against the section centre), both ends capped.
function loft(sections) {
  const ring = s => {
    const mid = s.bottom + (s.top - s.bottom) * 0.45;
    return [[s.x, s.bottom, -s.hw * 0.78], [s.x, s.bottom, s.hw * 0.78], [s.x, mid, s.hw], [s.x, s.top, s.hw * 0.5], [s.x, s.top, -s.hw * 0.5], [s.x, mid, -s.hw]];
  };
  const rings = sections.map(ring), out = [];
  const push = (a, b, c, inside) => {
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const centroid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    const outward = n[0] * (centroid[0] - inside[0]) + n[1] * (centroid[1] - inside[1]) + n[2] * (centroid[2] - inside[2]);
    out.push(...a, ...(outward >= 0 ? [...b, ...c] : [...c, ...b]));
  };
  const centre = s => [s.x, (s.top + s.bottom) / 2, 0];
  for (let i = 0; i + 1 < rings.length; i++) {
    const A = rings[i], B = rings[i + 1], c = centre({x: (sections[i].x + sections[i + 1].x) / 2, top: (sections[i].top + sections[i + 1].top) / 2, bottom: (sections[i].bottom + sections[i + 1].bottom) / 2});
    for (let k = 0; k < 6; k++) { const k2 = (k + 1) % 6; push(A[k], B[k], B[k2], c); push(A[k], B[k2], A[k2], c); }
  }
  for (const [r, s, dir] of [[rings[0], sections[0], 1], [rings.at(-1), sections.at(-1), -1]]) {
    const inside = [s.x + dir, (s.top + s.bottom) / 2, 0];
    for (let k = 1; k < 5; k++) push(r[0], r[k], r[k + 1], inside);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3)); g.computeVertexNormals();
  return g;
}

// Thin bar between two points (local +X box oriented a→b), for halo arcs, pillars and suspension arms.
function bar(a, b, thickness = 0.05, depth = thickness) {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), length = d.length();
  const g = new THREE.BoxGeometry(length, thickness, depth);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), d.normalize());
  g.applyQuaternion(q); g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return {geometry: g};
}
// Halo hoop: elliptical arc in the horizontal plane around `centre`, front at +X (car space).
function hoop(centre, rx, rz, from, to, thickness, segments = 9) {
  const parts = [];
  for (let k = 0; k < segments; k++) {
    const a0 = from + (to - from) * k / segments, a1 = from + (to - from) * (k + 1) / segments;
    parts.push(bar([centre[0] + rx * Math.cos(a0), centre[1], centre[2] + rz * Math.sin(a0)], [centre[0] + rx * Math.cos(a1), centre[1], centre[2] + rz * Math.sin(a1)], thickness));
  }
  return parts;
}
const wheel = (radius, width, at) => ({geometry: new THREE.CylinderGeometry(radius, radius, width, 14), at, rotate: [Math.PI / 2, 0, 0]});
const box = (x, y, z, at, rotate) => ({geometry: new THREE.BoxGeometry(x, y, z), at, rotate});

// E5: low-poly procedural car, forward +X, up +Y, origin at ground contact under the car centre, 5.6 m × 2.0 m.
// `body` takes the team colour, `dark` the shared carbon/tyre colour. One geometry set is shared by every car.
function carGeometries() {
  const body = merged([
    {geometry: loft([
      {x: 2.78, hw: 0.07, bottom: 0.17, top: 0.26}, {x: 2.1, hw: 0.15, bottom: 0.17, top: 0.38}, {x: 1.25, hw: 0.27, bottom: 0.12, top: 0.56},
      {x: 0.6, hw: 0.36, bottom: 0.1, top: 0.62}, {x: -0.25, hw: 0.38, bottom: 0.1, top: 0.64}, {x: -0.55, hw: 0.3, bottom: 0.1, top: 0.98},
      {x: -1.5, hw: 0.24, bottom: 0.12, top: 0.72}, {x: -2.35, hw: 0.13, bottom: 0.18, top: 0.42}])},                        // nose, monocoque, airbox, engine cover
    {geometry: loft([{x: 0.55, hw: 0.74, bottom: 0.12, top: 0.44}, {x: 0.2, hw: 0.8, bottom: 0.1, top: 0.56}, {x: -0.8, hw: 0.64, bottom: 0.1, top: 0.5}, {x: -1.75, hw: 0.3, bottom: 0.12, top: 0.32}])}, // sidepods
    box(0.42, 0.05, 1.0, [-2.5, 0.9, 0]), box(0.24, 0.04, 1.0, [-2.36, 1.0, 0], [0, 0, 0.5]),                 // rear wing main plane + flap
    box(0.28, 0.035, 1.78, [2.42, 0.19, 0], [0, 0, 0.35]),                                                     // front wing flap
    box(1.1, 0.2, 0.03, [-1.55, 0.84, 0]),                                                                     // engine cover fin
    {geometry: new THREE.SphereGeometry(0.15, 8, 6), at: [-0.08, 0.76, 0]},                                    // helmet
  ]);
  const dark = merged([
    box(4.5, 0.04, 1.42, [-0.15, 0.05, 0]),                                                                    // floor
    box(0.5, 0.035, 1.96, [2.55, 0.1, 0]),                                                                     // front wing main plane
    box(0.52, 0.2, 0.03, [2.52, 0.17, 0.97]), box(0.52, 0.2, 0.03, [2.52, 0.17, -0.97]),                       // front endplates
    box(0.62, 0.56, 0.03, [-2.46, 0.78, 0.5]), box(0.62, 0.56, 0.03, [-2.46, 0.78, -0.5]),                     // rear endplates
    box(0.16, 0.42, 0.05, [-2.38, 0.62, 0]),                                                                   // rear wing pylon
    wheel(0.34, 0.36, [1.75, 0.34, 0.82]), wheel(0.34, 0.36, [1.75, 0.34, -0.82]),
    wheel(0.36, 0.44, [-1.62, 0.36, 0.8]), wheel(0.36, 0.44, [-1.62, 0.36, -0.8]),
    bar([1.72, 0.4, 0.62], [1.45, 0.42, 0.2], 0.04), bar([1.72, 0.32, 0.62], [1.95, 0.3, 0.15], 0.04),          // front suspension
    bar([1.72, 0.4, -0.62], [1.45, 0.42, -0.2], 0.04), bar([1.72, 0.32, -0.62], [1.95, 0.3, -0.15], 0.04),
    bar([-1.62, 0.42, 0.56], [-1.9, 0.4, 0.15], 0.04), bar([-1.62, 0.42, -0.56], [-1.9, 0.4, -0.15], 0.04),    // rear suspension
    ...hoop([0.08, 0.86, 0], 0.42, 0.33, -Math.PI * 0.62, Math.PI * 0.62, 0.05), bar([0.62, 0.6, 0], [0.5, 0.86, 0], 0.05), // halo
    box(0.12, 0.07, 0.15, [0.78, 0.68, 0.46]), box(0.12, 0.07, 0.15, [0.78, 0.68, -0.46]),                     // mirrors
  ]);
  return {body, dark};
}

// Ego cockpit (onboard tiles) in camera space: x right, y up, −z forward, origin at the eye. It stays within the bottom
// ~20 % of a 55° view (nose, wheel tops, mirrors, wing tip) plus the halo's central pillar and a thin hoop at the top.
function cockpitGeometries() {
  const forward = [0, Math.PI / 2, 0];            // car-space +X loft → camera −Z
  const body = merged([
    {geometry: loft([{x: 0.6, hw: 0.3, bottom: -1.05, top: -0.5}, {x: 1.3, hw: 0.24, bottom: -1.05, top: -0.6}, {x: 2.3, hw: 0.14, bottom: -1.05, top: -0.76}, {x: 3.2, hw: 0.06, bottom: -1.05, top: -0.9}]), rotate: forward}, // nose
    box(0.13, 0.05, 0.04, [0.7, -0.52, -1.45]), box(0.13, 0.05, 0.04, [-0.7, -0.52, -1.45]),                 // mirror housings
  ]);
  const dark = merged([
    {geometry: new THREE.CylinderGeometry(0.34, 0.34, 0.38, 18), at: [1.0, -0.97, -1.9], rotate: [0, 0, Math.PI / 2]},  // front tyre tops
    {geometry: new THREE.CylinderGeometry(0.34, 0.34, 0.38, 18), at: [-1.0, -0.97, -1.9], rotate: [0, 0, Math.PI / 2]},
    box(2.0, 0.04, 0.45, [0, -1.02, -3.4]),                                                                   // front wing edge
    bar([0, -0.64, -1.05], [0, 0.44, -1.0], 0.028),                                                            // halo central pillar
    ...cockpitHoop(),                                                                                         // halo hoop (top)
    bar([0.68, -0.54, -1.45], [0.6, -0.8, -1.45], 0.02), bar([-0.68, -0.54, -1.45], [-0.6, -0.8, -1.45], 0.02), // mirror stalks
  ]);
  return {body, dark};
}
// Halo hoop over the driver's head in camera space: front at −Z just above the view centre line, sides out of view.
function cockpitHoop() {
  const parts = [], segments = 10, from = -Math.PI * 0.5, to = Math.PI * 0.5, cy = 0.44, rx = 0.55, rz = 0.95, cz = -1.0 + rz;
  for (let k = 0; k < segments; k++) {
    const a0 = from + (to - from) * k / segments, a1 = from + (to - from) * (k + 1) / segments;
    parts.push(bar([rx * Math.sin(a0), cy, cz - rz * Math.cos(a0)], [rx * Math.sin(a1), cy, cz - rz * Math.cos(a1)], 0.03));
  }
  return parts;
}

function labelTexture(abbreviation, color, selected) {
  const canvas = document.createElement('canvas'); canvas.width = LABEL_W; canvas.height = LABEL_H;
  const c = canvas.getContext('2d'), r = 14;
  c.font = '700 26px Barlow, system-ui, sans-serif';
  const boxWidth = Math.min(LABEL_W - LABEL_DOT_X - 8, c.measureText(abbreviation).width + 26);
  c.fillStyle = selected ? 'rgba(219,250,88,.95)' : 'rgba(16,20,22,.82)';
  c.beginPath(); c.roundRect(LABEL_DOT_X + 6, 9, boxWidth, LABEL_H - 18, 8); c.fill();
  c.textBaseline = 'middle'; c.fillStyle = selected ? '#161b0d' : '#f1f5ee';
  c.fillText(abbreviation, LABEL_DOT_X + 20, LABEL_H / 2 + 1);
  c.beginPath(); c.arc(LABEL_DOT_X, LABEL_H / 2, r - 3, 0, Math.PI * 2); c.fillStyle = color; c.fill();
  c.lineWidth = 4; c.strokeStyle = '#0d1214'; c.stroke();
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
  return texture;
}

// Deterministic value noise for procedural textures (no randomness between page loads).
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
function noiseTexture(size, paint, repeat = true) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  paint(canvas.getContext('2d'), size);
  const texture = new THREE.CanvasTexture(canvas);
  if (repeat) texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8;
  return texture;
}
// Grass: dark green with soft speckle and faint mowing bands. Asphalt: fine grain, mean ~white so vertex colours set the tone.
const grassTexture = () => noiseTexture(256, (c, n) => {
  const r = rng(7); c.fillStyle = '#243328'; c.fillRect(0, 0, n, n);
  for (let y = 0; y < n; y += 64) { c.fillStyle = 'rgba(255,255,255,.025)'; c.fillRect(0, y, n, 32); }
  for (let k = 0; k < 5000; k++) { const v = r(); c.fillStyle = v < 0.5 ? 'rgba(12,20,14,.28)' : 'rgba(80,104,74,.16)'; c.fillRect(r() * n, r() * n, 1 + r() * 2, 1 + r() * 2); }
});
const asphaltTexture = () => noiseTexture(256, (c, n) => {
  const r = rng(11); c.fillStyle = '#d4d4d4'; c.fillRect(0, 0, n, n);
  for (let k = 0; k < 14000; k++) { const v = 185 + r() * 70 | 0; c.fillStyle = `rgb(${v},${v},${v})`; c.fillRect(r() * n, r() * n, 1, 1); }
  for (let k = 0; k < 6; k++) { c.fillStyle = 'rgba(110,110,110,.07)'; c.fillRect(0, r() * n, n, 2 + r() * 4); }
});
function skyMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {top: {value: SKY_TOP}, horizon: {value: SKY_HORIZON}, below: {value: SKY_BELOW}},
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 below; varying vec3 vDir;
      void main(){ float h = normalize(vDir).y; vec3 c = h > 0.0 ? mix(horizon, top, pow(min(1.0, h * 2.2), 0.6)) : mix(horizon, below, min(1.0, -h * 6.0));
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
  });
}

export class Scene3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true, powerPreference: 'high-performance'});
    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(SKY_HORIZON, 300, 3000);
    // Shadowless lighting: hemisphere fill plus one sun.
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1b2420, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.9); sun.position.set(0.4, 1, 0.25); this.scene.add(sun);
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), skyMaterial()); this.sky.renderOrder = -1000; this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this.trackGroup = new THREE.Group(); this.carGroup = new THREE.Group(); this.scene.add(this.trackGroup, this.carGroup);
    this.overviewObjects = []; this.sectorSwaps = [];
    this.overlays = {sectors: true};
    this.geometries = carGeometries();
    this.textures = {grass: grassTexture(), asphalt: asphaltTexture()};
    this.cockpit = this.createCockpit();
    this.cars = new Map();
    this.track = null; this.trackKey = undefined;
    this.stats = {frames: 0, visibleCars: 0, ghostCars: 0, tiles: 0, lastRenderMs: 0};
    this._v = new THREE.Vector3();
  }

  createCockpit() {
    const g = cockpitGeometries(), group = new THREE.Group();
    const body = new THREE.MeshLambertMaterial({color: 0x9aa4a7, fog: false}), dark = new THREE.MeshLambertMaterial({color: 0x24282b, fog: false});
    group.add(new THREE.Mesh(g.body, body), new THREE.Mesh(g.dark, dark));
    group.matrixAutoUpdate = false; group.visible = false; group.renderOrder = 5;
    for (const mesh of group.children) mesh.frustumCulled = false;
    this.scene.add(group);
    return {group, body, dark, geometries: g};
  }

  // Overlay settings from the view (state.settings.overlays). Only `sectors` affects the 3D dressing.
  setOverlays(overlays) {
    const sectors = overlays?.sectors !== false;
    if (sectors === this.overlays.sectors) return;
    this.overlays = {sectors}; this.applySectors();
  }
  applySectors() {
    const on = this.overlays.sectors;
    for (const {geometry, plain, tinted} of this.sectorSwaps) { geometry.setAttribute('color', on ? tinted : plain); }
  }

  // Rebuild the approximate track when the API geometry (revision) changes. Returns the track3d model or null.
  setTrack(geometry, key) {
    if (key === this.trackKey) return this.track;
    this.trackKey = key; this.clearTrack();
    const track = geometry ? buildTrack(geometry) : null;
    this.track = track;
    if (!track) return null;
    const add = (object, overview = false) => { this.trackGroup.add(object); if (overview) this.overviewObjects.push(object); return object; };
    const lambert = (color, extra = {}) => new THREE.MeshLambertMaterial({color, ...extra});
    const b = track.bounds, margin = 2500, w = b.sizeX + margin * 2, d = b.sizeZ + margin * 2, grass = this.textures.grass.clone();
    grass.repeat.set(w / 40, d / 40); grass.needsUpdate = true;
    const ground = add(new THREE.Mesh(new THREE.PlaneGeometry(w, d), lambert(0xffffff, {map: grass})));
    ground.rotation.x = -Math.PI / 2; ground.position.set(b.cx, track.groundY - 0.05, b.cz);
    // Grass embankments from the ribbon edges down to the ground (raised sections read as built up, not floating).
    const bankMaterial = lambert(0xffffff, {vertexColors: true, side: THREE.DoubleSide});
    for (const e of [...track.embankments, ...(track.pit?.embankments || [])]) add(new THREE.Mesh(indexedGeometry(e), bankMaterial));
    // Asphalt ribbon: fine-grain texture along the arc length (speed cue), vertex colours carry the optional sector tint.
    const sectorOf = track.sectors, colorFor = i => sectorOf ? new THREE.Color(SECTOR_COLORS[sectorOf[i]] || '#ffffff') : null;
    const road = this.surface(track.ribbon, ASPHALT, (i, base, out) => { const c = colorFor(i); if (c) out.copy(base).lerp(c, 0.045); else out.copy(base); });
    add(new THREE.Mesh(road, lambert(0xffffff, {map: this.textures.asphalt, vertexColors: true})));
    // Edge lines: white, or the sector colour when the sector overlay is on.
    const white = new THREE.Color(0xd5dbd7);
    for (const edge of [track.ribbon.left, track.ribbon.right]) {
      const line = ribbon(edge, 0.32, {lift: 0.015}), geometryLine = indexedGeometry(line);
      this.colorize(geometryLine, edge.length, white, (i, base, out) => { const c = colorFor(i); if (c) out.copy(c); else out.copy(base); });
      add(new THREE.Mesh(geometryLine, lambert(0xffffff, {vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1})));
    }
    const coloured = {vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2};
    if (track.kerbs.indices.length) add(new THREE.Mesh(indexedGeometry(track.kerbs), lambert(0xffffff, coloured)));
    if (track.start.indices.length) add(new THREE.Mesh(indexedGeometry(track.start), lambert(0xffffff, coloured)));
    // 1-pixel outline for overview tiles, where a 12 m ribbon is only a few pixels wide (sector-coloured when on).
    const outline = new THREE.BufferGeometry().setFromPoints(track.center.map(p => new THREE.Vector3(p[0], p[1] + 0.3, p[2])));
    this.colorize(outline, track.center.length, new THREE.Color(0x93a0a3), (i, base, out) => { const c = colorFor(i); if (c) out.copy(c); else out.copy(base); }, 1);
    add(new THREE.LineLoop(outline, new THREE.LineBasicMaterial({vertexColors: true, fog: false})), true);
    if (track.pit) {
      const pit = this.surface(track.pit.ribbon, PIT_ASPHALT, (i, base, out) => out.copy(base));
      add(new THREE.Mesh(pit, lambert(0xffffff, {map: this.textures.asphalt, vertexColors: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1})));
      // Pit edge lines only where the lane is off the main ribbon (the trace starts and ends on the racing line).
      const pitLine = lambert(0xc4cac6);
      for (const [from, to] of track.pit.edgeRuns) for (const edge of [track.pit.ribbon.left, track.pit.ribbon.right]) add(new THREE.Mesh(indexedGeometry(ribbon(edge.slice(from, to + 1), 0.22, {closed: false, lift: 0.01})), pitLine));
      const pitOutline = new THREE.BufferGeometry().setFromPoints(track.pit.center.map(p => new THREE.Vector3(p[0], p[1] + 0.3, p[2])));
      add(new THREE.Line(pitOutline, new THREE.LineBasicMaterial({color: 0x6f7c7f, fog: false})), true);
    }
    this.applySectors();
    return track;
  }

  // Ribbon mesh with arc-length UVs (texture every 6 m along, once across) and swappable plain/sector vertex colours.
  surface(strip, base, tint) {
    const g = indexedGeometry(strip), n = strip.distance.length, uv = new Float32Array(n * 2);
    for (let k = 0; k < n; k++) { uv[k * 2] = strip.distance[k] / 6; uv[k * 2 + 1] = k & 1; }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.colorize(g, n / 2, base, tint);
    return g;
  }
  // Two colour attributes per geometry (plain / sector-tinted), `per` vertices per centerline index.
  colorize(geometry, count, base, tint, per = 2) {
    const plain = new Float32Array(count * per * 3), tinted = new Float32Array(count * per * 3), c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      tint(i, base, c);
      for (let k = 0; k < per; k++) { plain.set([base.r, base.g, base.b], (i * per + k) * 3); tinted.set([c.r, c.g, c.b], (i * per + k) * 3); }
    }
    const entry = {geometry, plain: new THREE.BufferAttribute(plain, 3), tinted: new THREE.BufferAttribute(tinted, 3)};
    geometry.setAttribute('color', entry.plain); this.sectorSwaps.push(entry);
  }

  clearTrack() {
    for (const object of [...this.trackGroup.children]) { disposeObject(object, [this.textures.asphalt]); this.trackGroup.remove(object); }
    this.overviewObjects = []; this.sectorSwaps = []; this.track = null;
  }

  // Create / refresh per-driver car objects from state.cars (team colour, abbreviation, selection).
  syncCars(cars, selectedDriver) {
    const present = new Set();
    for (const car of cars) {
      present.add(car.driverNumber);
      const selected = car.driverNumber === selectedDriver, key = `${car.color}|${car.abbreviation}|${selected}`;
      let entry = this.cars.get(car.driverNumber);
      if (!entry) {
        const body = new THREE.MeshLambertMaterial({color: 0xffffff}), dark = new THREE.MeshLambertMaterial({color: 0x16191b});
        const group = new THREE.Group(); group.rotation.order = 'YZX';
        group.add(new THREE.Mesh(this.geometries.body, body), new THREE.Mesh(this.geometries.dark, dark));
        const label = new THREE.Sprite(new THREE.SpriteMaterial({depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true, fog: false}));
        label.center.set(LABEL_DOT_X / LABEL_W, 0.5); label.renderOrder = 10;
        group.visible = false; label.visible = false;
        this.carGroup.add(group, label);
        entry = {driverNumber: car.driverNumber, trackIndex: undefined, group, label, body, dark, key: '', heading: null, opacity: 1, world: new THREE.Vector3(), visible: false, stale: false, ghost: false};
        this.cars.set(car.driverNumber, entry);
      }
      if (entry.key !== key) {
        entry.key = key; entry.body.color.set(car.color || '#9aa4a7');
        entry.label.material.map?.dispose(); entry.label.material.map = labelTexture(car.abbreviation || String(car.driverNumber), car.color || '#9aa4a7', selected); entry.label.material.needsUpdate = true;
      }
      entry.abbreviation = car.abbreviation;
    }
    for (const [n, entry] of this.cars) if (!present.has(n)) this.removeCar(n, entry);
  }

  removeCar(n, entry) {
    this.carGroup.remove(entry.group, entry.label);
    entry.body.dispose(); entry.dark.dispose(); entry.label.material.map?.dispose(); entry.label.material.dispose();
    this.cars.delete(n);
  }

  // Per frame: place every car from motion.pose(n, at). Hidden when there is no supplied position; dimmed when stale.
  // `hidden(n)` lets the caller mirror the 2D map's visibility rules (live status). Returns the visible poses.
  updateCars(motion, at, hidden = () => false) {
    const track = this.track, poses = new Map();
    let visible = 0;
    for (const [n, entry] of this.cars) {
      const pose = track && !hidden(n) ? motion.pose(n, at) : null;
      entry.visible = Boolean(pose);
      entry.group.visible = entry.label.visible = entry.visible;
      if (!pose) continue;
      const s = SESSION_TO_METRES, X = pose.x * s, Z = -pose.y * s;
      // Height: the sample's own z. Samples without z, or with a z far from the nearby recorded track height
      // (e.g. a source default of 0), sit on the reference centerline height instead of floating or sinking.
      const near = nearestIndexAround(track.center, X, Z, entry.trackIndex), trackY = track.center[near.index][1];
      entry.trackIndex = near.index;
      const sampleY = Number.isFinite(pose.z) ? (pose.z - track.zMin) * s : null;
      const Y = sampleY !== null && Math.abs(sampleY - trackY) <= 15 ? sampleY : trackY;
      entry.trackY = trackY;
      if (pose.heading !== null) entry.heading = pose.heading;
      else if (entry.heading === null) { const t = track.ribbon.tangents[near.index]; entry.heading = Math.atan2(-t[1], t[0]); }
      entry.world.set(X, Y, Z); entry.stale = pose.stale; entry.pitch = Math.max(-0.15, Math.min(0.15, pose.pitch ?? 0));
      entry.group.position.copy(entry.world); entry.group.rotation.set(0, entry.heading, entry.pitch);
      entry.label.position.set(X, Y + 1.9, Z);
      poses.set(n, {driverNumber: n, world: entry.world, heading: entry.heading, pitch: entry.pitch, stale: pose.stale, session: pose, trackY});
      visible++;
    }
    // D1 ghosting: overlapping bodies (same recorded line) are both drawn semi-transparent; no lateral offset is invented.
    const list = this.visibleList || (this.visibleList = []); list.length = 0;
    for (const entry of this.cars.values()) { entry.ghost = false; if (entry.visible) list.push(entry); }
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j], dx = b.world.x - a.world.x, dz = b.world.z - a.world.z;
      if (Math.abs(dx) > CAR_LENGTH || Math.abs(dz) > CAR_LENGTH || Math.abs(b.world.y - a.world.y) > 2) continue;
      const c = Math.cos(a.heading), sn = Math.sin(a.heading), along = dx * c - dz * sn, across = dx * sn + dz * c;
      if (Math.abs(along) < CAR_LENGTH && Math.abs(across) < CAR_WIDTH) a.ghost = b.ghost = true;
    }
    let ghosts = 0;
    for (const entry of list) {
      if (entry.ghost) ghosts++;
      this.setOpacity(entry, entry.ghost ? 0.38 : entry.stale ? 0.5 : 1);
      entry.label.material.opacity = entry.stale ? 0.55 : 1;
    }
    this.stats.visibleCars = visible; this.stats.ghostCars = ghosts;
    return poses;
  }

  setOpacity(entry, opacity) {
    if (entry.opacity === opacity) return;
    const transparent = opacity < 1;
    for (const m of [entry.body, entry.dark]) {
      m.opacity = opacity;
      if (m.transparent !== transparent) { m.transparent = transparent; m.depthWrite = !transparent; m.needsUpdate = true; }
    }
    entry.opacity = opacity;
  }

  resize(width, height, dpr) {
    // Cap the drawing buffer (large / high-DPI screens with four tiles) — the scene is low-poly, fill rate dominates.
    const ratio = Math.max(0.5, Math.min(dpr, Math.sqrt(MAX_BUFFER_PIXELS / Math.max(1, width * height))));
    const size = this.renderer.getSize(this._size || (this._size = new THREE.Vector2()));
    if (size.x !== width || size.y !== height || this.renderer.getPixelRatio() !== ratio) { this.renderer.setPixelRatio(ratio); this.renderer.setSize(width, height, false); }
  }

  // tiles: [{rect:{x,y,width,height} CSS px from the canvas' top-left, camera, overview, hideLabel, carYaw:{driverNumber,yaw}|null,
  //          labelPx, blank, ego: driverNumber|null}]
  // ego: an onboard tile's own car. Its body and label are hidden in that tile and a cockpit (nose, halo, mirrors, wheel tops)
  // is drawn fixed to the tile camera instead. Undefined/null draws no cockpit.
  render(tiles, height) {
    const started = performance.now(), r = this.renderer, fog = this.scene.fog;
    r.setScissorTest(false); r.setClearColor(0x000000, 0); r.clear();
    r.setScissorTest(true);
    for (const tile of tiles) {
      const {x, y, width: w, height: h} = tile.rect;
      if (w < 2 || h < 2) continue;
      const bottom = height - y - h;
      r.setViewport(x, bottom, w, h); r.setScissor(x, bottom, w, h);
      r.setClearColor(CLEAR, 1); r.clear();
      if (tile.blank || !this.track) continue;
      const camera = tile.camera;
      if (camera.aspect !== w / h) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
      camera.updateMatrixWorld();
      for (const object of this.overviewObjects) object.visible = Boolean(tile.overview);
      // Distance fog scaled by camera height: driver views fade the far side of the circuit into the horizon,
      // high overview cameras see no fog at all.
      const above = Math.max(0, camera.position.y - this.track.groundY);
      fog.near = 260 + above * 3; fog.far = fog.near + 2300 + above * 8;
      this.sky.position.copy(camera.position); this.sky.scale.setScalar(camera.far * 0.9);
      // Constant pixel-size labels: sprite scale = px / tileHeight · 2·tan(fov/2) (sizeAttenuation off). Low cameras
      // only label cars within ~700 m (fog-faded cars far away do not clutter the view).
      const labelPx = tile.labelPx ?? 17, sy = labelPx / h * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
      const labelRange = above < 60 ? 700 : Infinity, ego = tile.ego ?? null;
      let restore = null, egoEntry = null;
      for (const entry of this.cars.values()) {
        entry.label.scale.set(sy * LABEL_W / LABEL_H, sy, 1);
        entry.label.visible = entry.visible && entry.driverNumber !== tile.hideLabel && entry.driverNumber !== ego && (labelRange === Infinity || entry.world.distanceTo(camera.position) < labelRange);
        if (tile.carYaw && entry.driverNumber === tile.carYaw.driverNumber && entry.visible) { restore = entry; entry.group.rotation.y = tile.carYaw.yaw; }
        if (ego !== null && entry.driverNumber === ego && entry.visible) { egoEntry = entry; entry.group.visible = false; }
      }
      const cockpit = this.cockpit.group;
      if (egoEntry) {
        cockpit.matrix.copy(camera.matrixWorld); cockpit.matrixWorldNeedsUpdate = true; cockpit.visible = true;
        this.cockpit.body.color.copy(egoEntry.body.color);
      }
      r.render(this.scene, camera);
      cockpit.visible = false;
      if (egoEntry) egoEntry.group.visible = true;
      if (restore) restore.group.rotation.y = restore.heading;
    }
    r.setScissorTest(false);
    this.stats.frames++; this.stats.tiles = tiles.length; this.stats.lastRenderMs = performance.now() - started;
  }

  // Project a world point through a tile camera to CSS px inside that tile (debug/verification only).
  project(world, camera, rect) {
    const v = this._v.copy(world).project(camera);
    return {x: (v.x + 1) / 2 * rect.width, y: (1 - v.y) / 2 * rect.height, visible: v.z > -1 && v.z < 1};
  }

  clearCars() { for (const [n, entry] of [...this.cars]) this.removeCar(n, entry); }
  reset() { this.clearCars(); this.clearTrack(); this.trackKey = undefined; }
  dispose() {
    this.reset();
    for (const g of [this.geometries.body, this.geometries.dark, this.cockpit.geometries.body, this.cockpit.geometries.dark, this.sky.geometry]) g.dispose();
    for (const m of [this.cockpit.body, this.cockpit.dark, this.sky.material]) m.dispose();
    for (const t of Object.values(this.textures)) t.dispose();
    this.renderer.dispose();
  }
}

function disposeObject(object, keep = []) {
  object.traverse(o => {
    o.geometry?.dispose();
    for (const m of [].concat(o.material || [])) { if (m.map && !keep.includes(m.map)) m.map.dispose(); m.dispose(); }
  });
}
