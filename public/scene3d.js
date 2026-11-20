// One shared three.js scene and WebGL renderer for every camera tile (DECISION.md E1). Presentation only:
// car transforms come from MotionBuffer.pose() (interpolated supplied samples); the track is the approximate
// dressing from track3d.js (D2). Overlapping cars stay on their recorded line and become ghosts (D1).
import * as THREE from '/vendor/three.module.js';
import {buildTrack, ribbon, nearestIndexAround, SESSION_TO_METRES} from './track3d.js';

export const CAR_LENGTH = 5.6, CAR_WIDTH = 2.0;
const SKY = new THREE.Color(0x0d1315), LABEL_W = 176, LABEL_H = 52, LABEL_DOT_X = 22;

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
  for (const {geometry, at = [0, 0, 0], rotate = [0, 0, 0]} of parts) {
    m.compose(new THREE.Vector3(...at), q.setFromEuler(e.set(...rotate)), new THREE.Vector3(1, 1, 1));
    const g = geometry.toNonIndexed().applyMatrix4(m);
    positions.push(...g.getAttribute('position').array); normals.push(...g.getAttribute('normal').array);
    g.dispose(); geometry.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return out;
}

// E5: low-poly procedural car, forward +X, up +Y, origin at ground contact under the car centre, ~5.6 m × 2.0 m.
function carGeometries() {
  const box = (x, y, z) => new THREE.BoxGeometry(x, y, z);
  const body = merged([
    {geometry: box(3.3, 0.42, 0.86), at: [0.05, 0.42, 0]},          // monocoque
    {geometry: box(1.5, 0.26, 0.36), at: [2.05, 0.33, 0]},          // nose
    {geometry: box(1.9, 0.38, 1.42), at: [-0.25, 0.4, 0]},          // sidepods
    {geometry: box(1.4, 0.36, 0.48), at: [-0.65, 0.8, 0]},          // engine cover / airbox
    {geometry: box(0.36, 0.06, 1.95), at: [2.6, 0.14, 0]},          // front wing
    {geometry: box(0.34, 0.06, 1.0), at: [-2.55, 1.02, 0]},         // rear wing main plane
  ]);
  const wheel = () => new THREE.CylinderGeometry(0.36, 0.36, 0.38, 14);
  const dark = merged([
    {geometry: wheel(), at: [1.72, 0.36, 0.82], rotate: [Math.PI / 2, 0, 0]},
    {geometry: wheel(), at: [1.72, 0.36, -0.82], rotate: [Math.PI / 2, 0, 0]},
    {geometry: wheel(), at: [-1.62, 0.36, 0.8], rotate: [Math.PI / 2, 0, 0]},
    {geometry: wheel(), at: [-1.62, 0.36, -0.8], rotate: [Math.PI / 2, 0, 0]},
    {geometry: box(0.3, 0.42, 0.06), at: [-2.55, 0.82, 0.5]},       // rear wing endplates
    {geometry: box(0.3, 0.42, 0.06), at: [-2.55, 0.82, -0.5]},
    {geometry: box(0.36, 0.16, 0.06), at: [2.6, 0.2, 0.98]},        // front wing endplates
    {geometry: box(0.36, 0.16, 0.06), at: [2.6, 0.2, -0.98]},
    {geometry: box(0.55, 0.08, 0.6), at: [0.45, 0.88, 0]},          // halo
    {geometry: box(0.36, 0.22, 0.3), at: [0.15, 0.75, 0]},          // helmet
    {geometry: box(4.9, 0.05, 1.1), at: [0, 0.07, 0]},              // floor
  ]);
  return {body, dark};
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

function groundTexture() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
  const c = canvas.getContext('2d'); c.fillStyle = '#151d1b'; c.fillRect(0, 0, 128, 128);
  c.strokeStyle = '#22302c'; c.lineWidth = 2; c.strokeRect(1, 1, 126, 126);
  const texture = new THREE.CanvasTexture(canvas); texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8;
  return texture;
}

export class Scene3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true, powerPreference: 'high-performance'});
    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1b2420, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.9); sun.position.set(0.4, 1, 0.25); this.scene.add(sun);
    this.trackGroup = new THREE.Group(); this.carGroup = new THREE.Group(); this.scene.add(this.trackGroup, this.carGroup);
    this.overviewObjects = [];
    this.geometries = carGeometries();
    this.cars = new Map();
    this.track = null; this.trackKey = undefined;
    this.stats = {frames: 0, visibleCars: 0, ghostCars: 0, tiles: 0, lastRenderMs: 0};
    this._v = new THREE.Vector3();
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
    const b = track.bounds, margin = 900, w = b.sizeX + margin * 2, d = b.sizeZ + margin * 2, tex = groundTexture();
    tex.repeat.set(w / 50, d / 50);
    const ground = add(new THREE.Mesh(new THREE.PlaneGeometry(w, d), lambert(0xffffff, {map: tex})));
    ground.rotation.x = -Math.PI / 2; ground.position.set(b.cx, track.groundY - 0.05, b.cz);
    add(new THREE.Mesh(indexedGeometry(track.ribbon), lambert(0x3a4245)));
    for (const s of track.skirts) add(new THREE.Mesh(indexedGeometry(s), lambert(0x263033, {side: THREE.DoubleSide})));
    // Thin white edge lines on the nominal ribbon.
    for (const edge of [track.ribbon.left, track.ribbon.right]) add(new THREE.Mesh(indexedGeometry(ribbon(edge, 0.3, {lift: 0.015})), lambert(0xc9d0cc)));
    const coloured = {vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2};
    if (track.kerbs.indices.length) add(new THREE.Mesh(indexedGeometry(track.kerbs), lambert(0xffffff, coloured)));
    if (track.start.indices.length) add(new THREE.Mesh(indexedGeometry(track.start), lambert(0xffffff, coloured)));
    const line = (points, closed, color) => {
      const g = new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(p[0], p[1] + 0.3, p[2])));
      return add(new (closed ? THREE.LineLoop : THREE.Line)(g, new THREE.LineBasicMaterial({color})), true);
    };
    // 1-pixel outline for overview tiles, where a 12 m ribbon is only a pixel or two wide.
    line(track.center, true, 0x93a0a3);
    if (track.pit) {
      add(new THREE.Mesh(indexedGeometry(track.pit.ribbon), lambert(0x2d3437, {polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1})));
      line(track.pit.center, false, 0x5e6b6e);
    }
    return track;
  }

  clearTrack() {
    for (const object of [...this.trackGroup.children]) { disposeObject(object); this.trackGroup.remove(object); }
    this.overviewObjects = []; this.track = null;
  }

  // Create / refresh per-driver car objects from state.cars (team colour, abbreviation, selection).
  syncCars(cars, selectedDriver) {
    const present = new Set();
    for (const car of cars) {
      present.add(car.driverNumber);
      const selected = car.driverNumber === selectedDriver, key = `${car.color}|${car.abbreviation}|${selected}`;
      let entry = this.cars.get(car.driverNumber);
      if (!entry) {
        const body = new THREE.MeshLambertMaterial({color: 0xffffff}), dark = new THREE.MeshLambertMaterial({color: 0x15191b});
        const group = new THREE.Group(); group.rotation.order = 'YZX';
        group.add(new THREE.Mesh(this.geometries.body, body), new THREE.Mesh(this.geometries.dark, dark));
        const label = new THREE.Sprite(new THREE.SpriteMaterial({depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true}));
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
    for (const entry of this.cars.values()) entry.ghost = false;
    const list = [...this.cars.values()].filter(e => e.visible);
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
    const size = this.renderer.getSize(this._size || (this._size = new THREE.Vector2()));
    if (size.x !== width || size.y !== height || this.renderer.getPixelRatio() !== dpr) { this.renderer.setPixelRatio(dpr); this.renderer.setSize(width, height, false); }
  }

  // tiles: [{rect:{x,y,width,height} CSS px from the canvas' top-left, camera, overview, hideLabel, carYaw:{driverNumber,yaw}|null, blank}]
  render(tiles, height) {
    const started = performance.now(), r = this.renderer;
    r.setScissorTest(false); r.setClearColor(0x000000, 0); r.clear();
    r.setScissorTest(true);
    for (const tile of tiles) {
      const {x, y, width: w, height: h} = tile.rect;
      if (w < 2 || h < 2) continue;
      const bottom = height - y - h;
      r.setViewport(x, bottom, w, h); r.setScissor(x, bottom, w, h);
      r.setClearColor(SKY, 1); r.clear();
      if (tile.blank || !this.track) continue;
      const camera = tile.camera;
      if (camera.aspect !== w / h) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
      for (const object of this.overviewObjects) object.visible = Boolean(tile.overview);
      // Constant pixel-size labels: sprite scale = px / tileHeight · 2·tan(fov/2) (sizeAttenuation off).
      const labelPx = tile.labelPx ?? 17, sy = labelPx / h * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
      let restore = null;
      for (const entry of this.cars.values()) {
        entry.label.scale.set(sy * LABEL_W / LABEL_H, sy, 1);
        entry.label.visible = entry.visible && entry.driverNumber !== tile.hideLabel;
        if (tile.carYaw && entry.driverNumber === tile.carYaw.driverNumber && entry.visible) { restore = entry; entry.group.rotation.y = tile.carYaw.yaw; }
      }
      r.render(this.scene, camera);
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
  dispose() { this.reset(); this.geometries.body.dispose(); this.geometries.dark.dispose(); this.renderer.dispose(); }
}

function disposeObject(object) {
  object.traverse(o => {
    o.geometry?.dispose();
    for (const m of [].concat(o.material || [])) { m.map?.dispose(); m.dispose(); }
  });
}
