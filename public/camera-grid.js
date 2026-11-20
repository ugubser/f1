// Tile grid inside the map panel (DECISION.md D6): the 2D map plus 0–4 camera tiles, auto-laid out, any tile maximizable.
// One shared WebGL canvas sits behind the tiles and renders each camera tile with scissor/viewport (E1).
// Camera configuration is view state on the server (D4: state.settings.cameras, changed with PATCH {cameras:[...]}),
// including placed trackside positions, aims, FOV and the HUD switch. Until the server supplies that field, a local
// default list is used and edits stay local. Maximize, the open settings popover and placement mode are local.
// three.js modules load lazily so the 2D map keeps working if WebGL or the vendor module is unavailable.
// This module also holds the pure, THREE-free placement and TV-director maths (unit-tested in node), so it can be
// served and imported by cameras3d.js without another public file.
import {buildTrack, SESSION_TO_METRES, nearestIndex, leftNormal} from './track3d.js';

// ==== Pure placement / director maths ====================================================================================
// `track` is the buildTrack() model from track3d.js: {mapper, center:[[X,Y,Z] metres], length, ribbon:{tangents}}.
// A trackside camera farther than this from every centerline point is treated as belonging to another circuit
// (cameras are kept across race changes; positions are session units of whichever circuit they were placed on).
export const FAR_LIMIT_M = 2000;
export const PLACE_HEIGHT_RANGE = [1, 300];

const finitePoint = p => Boolean(p) && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
export const roundPoint = p => ({x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z)});

// ---- 2D map projection (the one app.js draw() uses) and its inverse -------------------------------------------------
// points: geometry.points rows [t, x, y, z]. The circuit is fitted into width×height CSS px with `margin` px spare.
export function mapTransform(points, width, height, margin = 145) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) { if (p[1] < minX) minX = p[1]; if (p[1] > maxX) maxX = p[1]; if (p[2] < minY) minY = p[2]; if (p[2] > maxY) maxY = p[2]; }
  const scale = Math.min(Math.max(1, width - margin) / (maxX - minX || 1), Math.max(1, height - margin) / (maxY - minY || 1));
  return {cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, scale, width, height};
}
export function mapProject(t, x, y, out = [0, 0]) { out[0] = (x - t.cx) * t.scale + t.width / 2; out[1] = t.height / 2 - (y - t.cy) * t.scale; return out; }
export function mapUnproject(t, px, py) { return {x: (px - t.width / 2) / t.scale + t.cx, y: t.cy - (py - t.height / 2) / t.scale}; }

// ---- Position checks and heights ------------------------------------------------------------------------------------
// 'missing' (null/invalid), 'far' (> limit from the current centerline) or 'ok'. Returns the distance in metres as well.
export function positionStatus(track, position, limit = FAR_LIMIT_M) {
  if (!track || !finitePoint(position)) return {status: 'missing', distance: null};
  const [X, , Z] = track.mapper.toWorld(position.x, position.y, position.z), {distance} = nearestIndex(track.center, X, Z);
  return {status: distance > limit ? 'far' : 'ok', distance};
}

// Session point `heightM` metres above the local (nearest centerline) track surface at session (x, y).
export function sessionAbove(track, x, y, heightM) {
  const s = SESSION_TO_METRES, X = x * s, Z = -y * s, {index} = nearestIndex(track.center, X, Z);
  return roundPoint(track.mapper.toSession(X, track.center[index][1] + heightM, Z));
}
// Height in metres of a session point above the local track surface.
export function heightAbove(track, position) {
  const [X, Y, Z] = track.mapper.toWorld(position.x, position.y, position.z), {index} = nearestIndex(track.center, X, Z);
  return Y - track.center[index][1];
}
export const clampHeight = h => Math.max(PLACE_HEIGHT_RANGE[0], Math.min(PLACE_HEIGHT_RANGE[1], h));

// ---- Placement next to the track ------------------------------------------------------------------------------------
const wrapIndex = (i, n) => ((i % n) + n) % n;
const spacingOf = track => track.length / track.center.length;

// Signed turn of the centerline around index over ±span metres: < 0 turns left (towards the left normal), > 0 right.
export function turnAt(track, index, span = 20) {
  const t = track.ribbon.tangents, n = t.length, k = Math.max(1, Math.round(span / spacingOf(track)));
  const a = t[wrapIndex(index - k, n)], b = t[wrapIndex(index + k, n)];
  return Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
}

// World point `offset` metres to `side` (+1 left, −1 right) of centerline index, `height` above the track there,
// or null when another part of the circuit is closer than `clearance`·offset (a chicane or a parallel straight).
export function besideTrack(track, index, side, offset, height, clearance = 0.8) {
  const c = track.center[index], [lx, lz] = leftNormal(track.ribbon.tangents[index]);
  const X = c[0] + side * lx * offset, Z = c[2] + side * lz * offset;
  if (nearestIndex(track.center, X, Z).distance < offset * clearance) return null;
  return [X, c[1] + height, Z];
}

// Camera outside a turn marker: the outside of the curve (opposite to the turning direction); for nearly straight
// sections the marker's own angle decides the side. Aims at the apex (the centerline point nearest the marker).
export function cornerPlacement(track, corner, {offset = 32, height = 8} = {}) {
  const [cx, , cz] = track.mapper.toWorld(corner.x, corner.y, undefined), {index} = nearestIndex(track.center, cx, cz);
  if (index < 0) return null;
  const turn = turnAt(track, index), [lx, lz] = leftNormal(track.ribbon.tangents[index]);
  const angle = (corner.angle ?? 0) * Math.PI / 180, markerSide = Math.cos(angle) * lx + -Math.sin(angle) * lz >= 0 ? 1 : -1;
  const outside = Math.abs(turn) > 0.12 ? (turn < 0 ? -1 : 1) : markerSide;
  let world = null, side = outside;
  for (const [s, d] of [[outside, offset], [outside, offset + 8], [-outside, offset], [outside, offset * 0.7], [-outside, offset * 0.7]]) {
    world = besideTrack(track, index, s, d, height); side = s;
    if (world) break;
  }
  if (!world) { world = besideTrack(track, index, outside, offset, height, 0); side = outside; }
  const apex = track.center[index];
  return {position: roundPoint(track.mapper.toSession(...world)), target: roundPoint(track.mapper.toSession(apex[0], apex[1] + 0.5, apex[2])), index, side};
}

// ---- Auto TV director -----------------------------------------------------------------------------------------------
// Generated trackside vantage points every ~`spacing` metres along the smoothed centerline, alternating sides,
// 25–40 m outside and 5–15 m up (deterministic variation). Each: {index, s (arc metres), world:[X,Y,Z], kind, label}.
export function generateVantages(track, {spacing = 320, minOffset = 25, maxOffset = 40, minHeight = 5, maxHeight = 15} = {}) {
  const n = track.center.length, step = spacingOf(track), every = Math.max(1, Math.round(spacing / step)), out = [];
  let side = 1;
  for (let i = Math.round(every / 2), k = 0; i < n; i += every, k++) {
    const offset = minOffset + (k * 7) % (maxOffset - minOffset + 1), height = minHeight + (k * 4) % (maxHeight - minHeight + 1);
    const world = besideTrack(track, i, side, offset, height) || besideTrack(track, i, -side, offset, height);
    side = -side;
    if (world) out.push({index: i, s: i * step, world, kind: 'auto', label: `TRACKSIDE ${out.length + 1}`});
  }
  return out;
}

// A user-placed trackside camera as a director vantage (null when it is not on this circuit).
export function placedVantage(track, camera) {
  if (positionStatus(track, camera.position).status !== 'ok') return null;
  const world = track.mapper.toWorld(camera.position.x, camera.position.y, camera.position.z), {index} = nearestIndex(track.center, world[0], world[2]);
  return {index, s: index * spacingOf(track), world, kind: 'placed', label: `CAM ${camera.id.toUpperCase()}`};
}

// Signed arc distance from a to b on a closed loop of length L, in (−L/2, L/2].
export function arcDelta(a, b, length) { let d = (b - a) % length; if (d > length / 2) d -= length; if (d <= -length / 2) d += length; return d; }

// Vantage the car is approaching: the nearest one at least `minAhead` metres ahead along the track (else the nearest ahead).
export function approachingVantage(vantages, carS, length, {minAhead = 40} = {}) {
  let best = -1, bestAhead = Infinity, fallback = -1, fallbackAhead = Infinity;
  for (let i = 0; i < vantages.length; i++) {
    let ahead = (vantages[i].s - carS) % length; if (ahead < 0) ahead += length;
    if (ahead >= minAhead && ahead < bestAhead) { best = i; bestAhead = ahead; }
    if (ahead < fallbackAhead) { fallback = i; fallbackAhead = ahead; }
  }
  return best >= 0 ? best : fallback;
}

// Metres of nearly straight track ahead of index (heading within `tolerance` rad of the tangent at index).
export function straightAhead(track, index, {max = 900, tolerance = 0.3} = {}) {
  const t = track.ribbon.tangents, n = t.length, step = spacingOf(track), a = t[index];
  for (let k = 1, d = step; d <= max; k++, d += step) {
    const b = t[wrapIndex(index + k, n)];
    if (Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1])) > tolerance) return d;
  }
  return max;
}

export const DIRECTOR = Object.freeze({minShot: 3, maxShot: 12, followShot: 6, recede: 80, longStraight: 350, followEvery: 3});

// One deterministic director step (pure; mutates and returns `shot`). Times are presentation wall-clock seconds.
// shot: {kind:'none'|'trackside'|'chase'|'onboard', vantage:index|-1, started, count, sinceFollow}
// input: {now, carS, length, straight(): metres of straight ahead of the car}
// Cuts only after minShot; a trackside shot cuts once the car has passed its vantage and is `recede` metres beyond it,
// when the car is far from it (seek), or after maxShot when another vantage is the better one. On a long straight, once
// at least `followEvery` trackside shots have passed, the cut is a chase or onboard shot instead (alternating); it ends
// after `followShot` or when a corner is close.
export function directorStep(shot, vantages, {now, carS, length, straight}, rules = DIRECTOR) {
  const best = () => approachingVantage(vantages, carS, length);
  const cut = () => {
    shot.count++; shot.started = now;
    if (vantages.length === 0 || (shot.kind === 'trackside' && shot.sinceFollow >= rules.followEvery && straight() >= rules.longStraight)) {
      shot.follows++; shot.kind = shot.follows % 2 ? 'chase' : 'onboard'; shot.vantage = -1; shot.sinceFollow = 0;
    } else { shot.kind = 'trackside'; shot.vantage = best(); shot.sinceFollow++; }
    return shot;
  };
  if (shot.kind === 'none') return cut();
  const age = now - shot.started;
  if (age < rules.minShot) return shot;
  if (shot.kind === 'trackside') {
    const v = vantages[shot.vantage];
    if (!v) return cut();
    const rel = arcDelta(v.s, carS, length);   // > 0: the car is past the vantage
    if (rel > rules.recede || rel < -length / 3) return cut();
    if (age > rules.maxShot && best() !== shot.vantage) return cut();
    return shot;
  }
  if (age > rules.followShot || (vantages.length && straight() < 120)) return cut();
  return shot;
}
export const newShot = () => ({kind: 'none', vantage: -1, started: 0, count: 0, sinceFollow: 0, follows: 0});

// ==== Camera grid ===================================================================================================
export const MAX_CAMERAS = 4;
export const DEFAULT_CAMERA = Object.freeze({id: 'cam-1', mode: 'chase', driver: null, position: null, target: null, fov: 55, hud: true});
export const MODES = ['chase', 'onboard', 'orbit', 'birdseye', 'trackside', 'director'];
const MODE_LABELS = {chase: 'Chase', onboard: 'Onboard', orbit: 'Orbit', birdseye: "Bird's-eye", trackside: 'Trackside', director: 'TV director'};
export const DEFAULT_PLACE_HEIGHT = 8;

const element = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
const button = (cls, text, title) => { const b = element('button', cls, text); b.type = 'button'; if (title) { b.title = title; b.setAttribute('aria-label', title); } return b; };
const normalise = c => ({id: c.id, mode: c.mode, driver: c.driver ?? null, position: c.position ?? null, target: c.target ?? null, fov: c.fov ?? 55, hud: c.hud ?? true});

// Camera target: explicit driver, else the view's selected driver, else the car in position 1.
export function resolveTarget(camera, state) {
  return camera.driver ?? state?.settings?.selectedDriver ?? state?.cars?.find(c => c.position === 1)?.driverNumber ?? null;
}

// Pure layout rule: number of visible camera tiles -> layout token used by CSS (see style.css .tile-grid).
export function layoutFor(cameraCount, maximized) { return maximized ? 'max' : String(Math.max(0, Math.min(MAX_CAMERAS, cameraCount))); }

// HUD shows in driver-following shots (onboard, chase, or a director chase/onboard shot) when the camera's hud flag is on.
export const hudVisible = (config, frame) => Boolean(config?.hud && frame?.ok && frame.follow);

export class CameraGrid {
  // mapToSession(clientX, clientY) -> {x, y} session units under that point of the 2D map, or null (inverse of draw()).
  constructor({grid, mapTile, addButton, motion, onChange, dots2d = null, mapToSession = () => null}) {
    this.grid = grid; this.mapTile = mapTile; this.addButton = addButton; this.motion = motion; this.onChange = onChange; this.dots2d = dots2d; this.mapToSession = mapToSession;
    this.canvas = element('canvas', 'scene3d'); this.canvas.setAttribute('aria-label', '3D camera views (approximate track)');
    this.canvas.dataset.renderedFrames = '0'; this.canvas.dataset.visibleCars = '0'; this.canvas.dataset.tiles = '0'; this.canvas.dataset.status = 'loading';
    grid.prepend(this.canvas);
    this.tiles = new Map(); this.pending = null; this.local = [{...DEFAULT_CAMERA}]; this.state = null; this.geometry = null; this.maximized = null;
    this.scene = null; this.modules = null; this.Hud = null; this.error = null; this.carIndex = new Map(); this.carKey = ''; this.cornerKey = null;
    this.placing = null; this.placed = []; this.ownTrack = null; this.ownTrackFor = null;
    this.visible = []; this.descriptors = []; this.isHidden = n => this.hidden(n);
    this.lastAt = null; this.lastTime = null; this.fps = {frames: 0, since: null, value: 0}; this.cleared = true;
    this.debug = new URLSearchParams(location.search).has('debug3d') ? {} : null;
    if (this.debug) window.__f1Debug3d = {snapshot: () => structuredClone(this.debug.last ?? null)};
    const mapMax = button('tile-max', '⤢', 'Maximize map'); mapMax.setAttribute('aria-pressed', 'false');
    mapMax.onclick = () => this.toggleMaximize('map'); mapTile.append(mapMax); this.mapMax = mapMax;
    // Placement hint on the 2D map ("click the map to place …", Esc cancels).
    this.hint = element('div', 'place-hint tile-ui'); this.hint.hidden = true; this.hint.setAttribute('role', 'status');
    this.hintText = element('span'); this.hintFollow = button('text-button', 'Follow car'); this.hintCancel = button('text-button', 'Cancel (Esc)');
    this.hint.append(this.hintText, this.hintFollow, this.hintCancel); mapTile.append(this.hint);
    this.hintFollow.onclick = () => { const p = this.placing; this.placing = null; if (p) this.change(p.id, {target: null}); };
    this.hintCancel.onclick = () => this.cancelPlacing();
    mapTile.addEventListener('click', e => this.mapClick(e), true);
    document.addEventListener('keydown', e => { if (e.key !== 'Escape') return; if (this.placing) this.cancelPlacing(); else this.closePopovers(); });
    document.addEventListener('pointerdown', e => { if (!e.target.closest?.('.tile-pop, .tile-settings')) this.closePopovers(); }, true);
    addButton.onclick = () => this.add();
    Promise.all([import('./scene3d.js'), import('./cameras3d.js')]).then(([scene, cameras]) => {
      this.modules = cameras;
      try { this.scene = new scene.Scene3D(this.canvas); this.canvas.dataset.status = 'ready'; }
      catch { this.error = '3D view unavailable: WebGL could not start in this browser.'; this.canvas.dataset.status = 'error'; }
      this.refresh();
    }).catch(() => { this.error = '3D view unavailable: the three.js module could not be loaded.'; this.canvas.dataset.status = 'error'; this.refresh(); });
    // The telemetry HUD is optional: without it the cameras still work.
    import('./hud3d.js').then(m => { this.Hud = m.Hud; this.refresh(); }).catch(() => { this.Hud = null; });
    this.refresh();
  }

  serverBacked() { return Array.isArray(this.state?.settings?.cameras); }
  cameras() { return (this.serverBacked() ? this.pending ?? this.state.settings.cameras : this.local).slice(0, MAX_CAMERAS); }
  // Writes replace the whole list (server contract). Server-backed lists go through REST; until that request settles the
  // written list is shown (so two quick edits build on each other), then the server's snapshot is authoritative again.
  write(list) {
    const next = list.map(normalise);
    if (!this.serverBacked()) { this.local = next; this.refresh(); return; }
    this.pending = next; this.refresh();
    Promise.resolve(this.onChange(next)).catch(() => {}).finally(() => { if (this.pending === next) { this.pending = null; this.refresh(); } });
  }
  change(id, changes) { this.write(this.cameras().map(c => c.id === id ? {...c, ...changes} : c)); }
  add() {
    const list = this.cameras(); if (list.length >= MAX_CAMERAS) return;
    let k = 1; while (list.some(c => c.id === `cam-${k}`)) k++;
    this.write([...list, {...DEFAULT_CAMERA, id: `cam-${k}`, mode: list.length ? 'birdseye' : DEFAULT_CAMERA.mode}]);
  }
  remove(id) { if (this.maximized === id) this.maximized = null; if (this.placing?.id === id) this.placing = null; this.write(this.cameras().filter(c => c.id !== id)); }
  toggleMaximize(id) { this.maximized = this.maximized === id ? null : id; this.refresh(); }

  sync(state, geometry) { this.state = state; this.geometry = geometry; this.refresh(); }
  reset() {
    this.state = null; this.geometry = null; this.maximized = null; this.pending = null; this.local = [{...DEFAULT_CAMERA}]; this.carKey = ''; this.placing = null;
    this.scene?.reset(); this.lastTime = null; this.refresh();
  }

  // Track model for placement maths: the rendered one, else (no WebGL) one built from the same geometry.
  track() {
    if (this.scene?.track) return this.scene.track;
    if (!this.geometry) return null;
    if (this.ownTrackFor !== this.geometry) { this.ownTrackFor = this.geometry; this.ownTrack = buildTrack(this.geometry); }
    return this.ownTrack;
  }

  // ---- Placement (2D map click / turn picker / pinned orbit view); every result is a PATCH of the camera list ----
  startPlacing(id, step = 'position') {
    if (!this.track()) return;
    this.closePopovers(); this.placing = {id, step}; if (this.maximized && this.maximized !== 'map') this.maximized = null; this.refresh();
  }
  cancelPlacing() { this.placing = null; this.refresh(); }
  mapClick(e) {
    if (!this.placing || e.target.closest?.('.tile-ui, .tile-max')) return;
    e.preventDefault(); e.stopPropagation();
    const point = this.mapToSession(e.clientX, e.clientY), track = this.track(), tile = this.tiles.get(this.placing.id);
    if (!point || !track || !tile) return;
    if (this.placing.step === 'position') {
      this.change(tile.id, {mode: 'trackside', position: sessionAbove(track, point.x, point.y, tile.placeHeight), target: null});
      this.placing = {id: tile.id, step: 'aim'};
    } else {
      this.change(tile.id, {target: sessionAbove(track, point.x, point.y, 0.5)});
      this.placing = null;
    }
    this.refresh();
  }
  placeAtCorner(tile, cornerId, apex) {
    const track = this.track(), corner = this.geometry?.corners?.find(c => c.id === cornerId);
    if (!track || !corner) return;
    const p = cornerPlacement(track, corner, {height: tile.placeHeight});
    if (p) this.change(tile.id, {mode: 'trackside', position: p.position, target: apex ? p.target : null});
  }
  pinView(tile) {
    const viewpoint = tile.controller?.viewpoint?.();
    if (viewpoint) this.change(tile.id, {mode: 'trackside', position: viewpoint.position, target: viewpoint.target});
  }
  setHeight(tile, metres) {
    tile.placeHeight = clampHeight(metres);
    const c = tile.config, track = this.track();
    if (c?.mode === 'trackside' && c.position && track && positionStatus(track, c.position).status === 'ok')
      this.change(tile.id, {position: sessionAbove(track, c.position.x, c.position.y, tile.placeHeight)});
  }
  closePopovers() { for (const tile of this.tiles.values()) if (!tile.pop.hidden) { tile.pop.hidden = true; tile.settings.setAttribute('aria-expanded', 'false'); } }

  refresh() {
    const list = this.state ? this.cameras() : [], ids = new Set(list.map(c => c.id));
    for (const [id, tile] of this.tiles) if (!ids.has(id)) { tile.controller?.detach(); tile.hudView?.dispose(); tile.el.remove(); this.tiles.delete(id); }
    if (this.maximized && this.maximized !== 'map' && !ids.has(this.maximized)) this.maximized = null;
    if (this.placing && !ids.has(this.placing.id)) this.placing = null;
    const cars = this.state?.cars || [], carKey = cars.map(c => `${c.driverNumber}:${c.abbreviation}`).sort().join(',');
    const carsChanged = carKey !== this.carKey; this.carKey = carKey; this.carIndex = new Map(cars.map(c => [c.driverNumber, c]));
    const corners = this.geometry?.corners || [], cornerKey = `${this.state?.geometryRevision}|${corners.map(c => c.id).join(',')}`;
    const cornersChanged = cornerKey !== this.cornerKey; this.cornerKey = cornerKey;
    this.placed = list.filter(c => c.mode === 'trackside' && c.position);
    let previous = this.mapTile;
    for (const config of list) {
      let tile = this.tiles.get(config.id);
      if (!tile) { tile = this.createTile(config.id); this.tiles.set(config.id, tile); }
      if (previous.nextElementSibling !== tile.el) previous.after(tile.el);
      previous = tile.el;
      this.configureTile(tile, config, carsChanged, cornersChanged);
    }
    this.grid.dataset.layout = layoutFor(list.length, this.maximized);
    this.grid.dataset.cameras = String(list.length);
    this.mapTile.classList.toggle('maximized', this.maximized === 'map');
    this.mapMax.setAttribute('aria-pressed', String(this.maximized === 'map')); this.mapMax.hidden = !list.length;
    for (const [id, tile] of this.tiles) {
      tile.el.classList.toggle('maximized', this.maximized === id); tile.max.setAttribute('aria-pressed', String(this.maximized === id));
      tile.el.classList.toggle('placing-target', this.placing?.id === id); tile.place.setAttribute('aria-pressed', String(this.placing?.id === id));
    }
    this.grid.classList.toggle('has-maximized', Boolean(this.maximized));
    this.mapTile.classList.toggle('placing', Boolean(this.placing));
    this.hint.hidden = !this.placing; this.hintFollow.hidden = this.placing?.step !== 'aim';
    if (this.placing) this.hintText.textContent = this.placing.step === 'position'
      ? `Click the 2D map to place ${this.placing.id} (${this.tiles.get(this.placing.id)?.placeHeight ?? DEFAULT_PLACE_HEIGHT} m above the track).`
      : `Placed. Click the map to aim ${this.placing.id} at a fixed point, or follow the car.`;
    this.addButton.disabled = !this.state || list.length >= MAX_CAMERAS;
    this.addButton.hidden = !this.state;
    if (this.scene && this.state) {
      this.scene.setTrack(this.geometry, this.geometry ? `${this.state.geometryRevision}|${this.geometry.points.length}|${this.geometry.points[0]?.[0]}` : null);
      this.scene.syncCars(cars, this.state.settings?.selectedDriver ?? null);
      this.scene.setOverlays(this.state.settings?.overlays);
    }
  }

  createTile(id) {
    const el = element('div', 'tile camera-tile'), bar = element('div', 'tile-bar tile-ui'), mode = element('select', 'tile-mode'), driver = element('select', 'tile-driver');
    const place = button('tile-place', '⌖', 'Place this camera on the 2D map'), settings = button('tile-settings', '⚙', 'Camera settings');
    const max = button('tile-max', '⤢', 'Maximize camera'), remove = button('tile-remove', '×', 'Remove camera');
    const message = element('div', 'tile-message'), note = element('div', 'tile-note', 'APPROXIMATE 3D · NOMINAL 12 M TRACK'), shot = element('div', 'tile-shot');
    el.dataset.camera = id; mode.setAttribute('aria-label', 'Camera mode'); driver.setAttribute('aria-label', 'Camera target driver');
    settings.setAttribute('aria-expanded', 'false'); settings.setAttribute('aria-haspopup', 'true'); place.setAttribute('aria-pressed', 'false');
    message.hidden = true; message.setAttribute('role', 'status'); shot.hidden = true;
    bar.append(mode, driver, place, settings, max, remove);
    // Settings popover: height (trackside), FOV, HUD, placement at a turn, aim, pin the orbit view.
    const pop = element('div', 'tile-pop tile-ui'); pop.hidden = true; pop.setAttribute('role', 'group'); pop.setAttribute('aria-label', `Settings for ${id}`);
    const range = (label, min, max, unit) => {
      const row = element('label', 'pop-row'), input = element('input'), out = element('output');
      input.type = 'range'; input.min = String(min); input.max = String(max); input.step = '1';
      row.append(element('span', 'pop-label', label), input, out); input.oninput = () => { out.textContent = input.value + unit; };
      return {row, input, out, unit};
    };
    const height = range('HEIGHT', PLACE_HEIGHT_RANGE[0], PLACE_HEIGHT_RANGE[1], ' m'), fov = range('FOV', 15, 110, '°');
    const hudRow = element('label', 'pop-row pop-check'), hud = element('input'); hud.type = 'checkbox'; hudRow.append(hud, element('span', '', 'Telemetry HUD (onboard / chase shots)'));
    const placeRow = element('div', 'pop-row'), placeMap = button('text-button', 'On 2D map'), corner = element('select', 'pop-corner');
    const apexLabel = element('label', 'pop-check'), apex = element('input'); apex.type = 'checkbox'; apexLabel.append(apex, element('span', '', 'aim at apex'));
    corner.setAttribute('aria-label', 'Place at turn'); placeRow.append(element('span', 'pop-label', 'PLACE'), placeMap, corner, apexLabel);
    const aimRow = element('div', 'pop-row'), follow = button('text-button', 'Follow car'), aimMap = button('text-button', 'Fixed point on map');
    aimRow.append(element('span', 'pop-label', 'AIM'), follow, aimMap);
    const pin = button('text-button pop-pin', 'Pin view here', 'Turn this orbit view into a fixed trackside camera');
    pop.append(height.row, fov.row, hudRow, placeRow, aimRow, pin);
    el.append(bar, pop, message, shot, note);
    const tile = {id, el, bar, mode, driver, place, settings, max, remove, message, note, shot, pop, height, fov, hud, corner, apex, aimRow, follow, aimMap, pin, hudRow,
      controller: null, controllerMode: null, config: null, frame: null, placeHeight: DEFAULT_PLACE_HEIGHT, hudView: null, hudOptions: {visible: false, availability: undefined, time: null},
      rect: {x: 0, y: 0, width: 0, height: 0}, target: {driverNumber: null, abbreviation: '', world: null, heading: 0, pitch: 0, stale: false}, context: {track: null, target: null, targetLabel: '', replayDt: 0, jumped: false, aspect: 1, placed: null},
      descriptor: {rect: null, camera: null, overview: false, hideLabel: null, carYaw: null, labelPx: 16, blank: true, ego: null}};
    // The server requires a position for trackside cameras: without one, placement starts locally and the mode is
    // committed together with the placed position (the select shows Trackside meanwhile; Esc reverts it).
    mode.onchange = () => {
      const next = mode.value, c = tile.config;
      if (next === 'trackside' && !c?.position) { this.startPlacing(id); return; }
      if (this.placing?.id === id) this.placing = null;
      this.change(id, {mode: next});
    };
    driver.onchange = () => this.change(id, {driver: driver.value === '' ? null : +driver.value});
    max.onclick = () => this.toggleMaximize(id); remove.onclick = () => this.remove(id);
    place.onclick = () => this.placing?.id === id ? this.cancelPlacing() : this.startPlacing(id);
    settings.onclick = () => { const open = pop.hidden; this.closePopovers(); pop.hidden = !open; settings.setAttribute('aria-expanded', String(open)); if (open) this.configureTile(tile, tile.config, false, false); };
    // Commit on change end (range `change` fires on release), never per input event.
    height.input.onchange = () => { this.setHeight(tile, +height.input.value); this.refresh(); };
    fov.input.onchange = () => this.change(id, {fov: +fov.input.value});
    hud.onchange = () => this.change(id, {hud: hud.checked});
    placeMap.onclick = () => this.startPlacing(id);
    corner.onchange = () => { if (corner.value) this.placeAtCorner(tile, corner.value, apex.checked); corner.value = ''; };
    follow.onclick = () => this.change(id, {target: null});
    aimMap.onclick = () => this.startPlacing(id, 'aim');
    pin.onclick = () => { this.pinView(tile); this.closePopovers(); };
    return tile;
  }

  configureTile(tile, config, carsChanged, cornersChanged) {
    tile.config = config;
    const modes = MODES.includes(config.mode) ? MODES : [...MODES, config.mode], modeKey = modes.join();
    if (tile.mode.dataset.key !== modeKey) {
      tile.mode.replaceChildren(...modes.map(m => new Option(MODE_LABELS[m] || `${m} (unsupported)`, m)));
      tile.mode.dataset.key = modeKey;
    }
    const shownMode = this.placing?.id === tile.id && this.placing.step === 'position' && config.mode !== 'trackside' ? 'trackside' : config.mode;
    if (tile.mode.value !== shownMode) tile.mode.value = shownMode;
    if (carsChanged || !tile.driver.options.length) {
      tile.driver.replaceChildren(new Option('Selected / P1', ''), ...[...this.carIndex.values()].sort((a, b) => a.driverNumber - b.driverNumber).map(c => new Option(`${c.abbreviation} · ${c.driverNumber}`, String(c.driverNumber))));
    }
    const driverValue = config.driver === null ? '' : String(config.driver);
    if (config.driver !== null && ![...tile.driver.options].some(o => o.value === driverValue)) tile.driver.add(new Option(`#${config.driver}`, driverValue));
    if (tile.driver.value !== driverValue) tile.driver.value = driverValue;
    if (cornersChanged || !tile.corner.options.length) {
      const corners = this.geometry?.corners || [];
      tile.corner.replaceChildren(new Option(corners.length ? 'At turn…' : 'No turn markers', ''), ...corners.map(c => new Option(`T${c.id}${c.name ? ' · ' + c.name : ''}`, c.id)));
      tile.corner.disabled = !corners.length;
    }
    // Popover values follow the configuration unless the user is dragging that control.
    const trackside = config.mode === 'trackside', track = this.track(), p = config.position;
    // Cached: refresh() runs on every state snapshot and the checks scan the centerline.
    const placedKey = trackside && track && p ? `${p.x},${p.y},${p.z}` : null;
    if (placedKey !== tile.placedKey || track !== tile.placedTrack) {
      tile.placedKey = placedKey; tile.placedTrack = track; tile.placed = Boolean(placedKey) && positionStatus(track, p).status === 'ok';
      if (tile.placed) tile.placeHeight = clampHeight(Math.round(heightAbove(track, p)));
    }
    const placed = tile.placed;
    if (document.activeElement !== tile.height.input) { tile.height.input.value = String(tile.placeHeight); tile.height.out.textContent = tile.placeHeight + ' m'; }
    tile.height.row.firstChild.textContent = placed ? 'HEIGHT' : 'PLACE AT';
    if (document.activeElement !== tile.fov.input) { tile.fov.input.value = String(config.fov); tile.fov.out.textContent = config.fov + '°'; }
    tile.fov.row.firstChild.textContent = trackside || config.mode === 'director' ? 'MAX FOV' : 'FOV';
    tile.hud.checked = config.hud;
    tile.aimRow.hidden = !placed;
    tile.follow.setAttribute('aria-pressed', String(placed && !config.target));
    tile.pin.hidden = config.mode !== 'orbit';
    tile.place.disabled = !track;
    if (this.modules && tile.controllerMode !== config.mode) {
      tile.controller?.detach();
      tile.controller = this.modules.createController(config.mode, config.fov);
      tile.controllerMode = config.mode;
      tile.controller.attach(tile.el, {commit: viewpoint => this.change(tile.id, viewpoint)});
    }
    tile.controller?.configure(config);
    if (this.Hud && !tile.hudView) tile.hudView = new this.Hud(tile.el);
  }

  hidden(n) {
    const state = this.state;
    return state.source === 'live' && (!this.carIndex.get(n)?.location || state.status !== 'streaming');
  }

  // Unavailable views get a centred fallback message (never a frozen wrong view); soft notes stay small in a corner.
  showMessage(tile, text, soft = false) {
    if (tile.message.textContent !== (text || '')) tile.message.textContent = text || '';
    if (tile.message.hidden !== !text) tile.message.hidden = !text;
    if (tile.message.classList.contains('soft') !== soft) tile.message.classList.toggle('soft', soft);
  }
  showShot(tile, text) {
    if (tile.shot.textContent !== (text || '')) tile.shot.textContent = text || '';
    if (tile.shot.hidden !== !text) tile.shot.hidden = !text;
  }
  hideHud(tile) { if (tile.hudView && tile.hudOptions.visible !== false) { tile.hudOptions.visible = false; tile.hudView.update(null, null, tile.hudOptions); } }

  // Called from the app's animation frame with the same presentation instant used for the 2D map.
  frame(at) {
    const state = this.state, scene = this.scene, ds = this.canvas.dataset, visible = this.visible;
    visible.length = 0;
    for (const tile of this.tiles.values()) { if (!this.maximized || this.maximized === tile.id) visible.push(tile); else { this.hideHud(tile); this.showShot(tile, null); } }
    if (!state || !visible.length || this.maximized === 'map') {
      for (const tile of this.tiles.values()) { this.showMessage(tile, this.error); this.hideHud(tile); }
      if (scene && !this.cleared) { scene.render([], 0); this.cleared = true; }
      return;
    }
    if (!scene) { for (const tile of visible) this.showMessage(tile, this.error || 'Loading 3D view…'); return; }
    const box = this.grid.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    scene.resize(Math.round(box.width), Math.round(box.height), dpr);
    const sample = this.motion.time(at), time = sample.time, dt = this.lastAt === null ? 0 : Math.min(0.1, Math.max(0, (at - this.lastAt) / 1000));
    // A presentation-time discontinuity (seek, reset, source change) lets driver cameras snap instead of swinging round.
    const rawReplayDt = time === null || this.lastTime === null ? 0 : (time - this.lastTime) / 1000;
    const jumped = this.lastTime === null || rawReplayDt < -0.001 || rawReplayDt > Math.max(3, (state.playback?.speed || 1) * 0.5);
    const replayDt = jumped ? 0 : Math.max(0, rawReplayDt);
    this.lastAt = at; if (time !== null) this.lastTime = time;
    const poses = scene.updateCars(this.motion, at, this.isHidden), track = scene.track, tiles = this.descriptors, availability = state.availability?.car_data;
    tiles.length = 0;
    const debugTiles = this.debug ? [] : null;
    for (const tile of visible) {
      const r = tile.el.getBoundingClientRect(), rect = tile.rect;
      rect.x = Math.round(r.left - box.left); rect.y = Math.round(r.top - box.top); rect.width = Math.round(r.width); rect.height = Math.round(r.height);
      const n = resolveTarget(tile.config, state), car = n === null ? null : this.carIndex.get(n), pose = n === null ? null : poses.get(n);
      let frame;
      if (this.error) frame = {ok: false, message: this.error};
      else if (!track) frame = {ok: false, message: state.status === 'loading' ? 'Loading the race…' : 'Waiting for a complete reference lap to build the 3D track.'};
      else if (!tile.controller) frame = {ok: false, message: 'Loading 3D view…'};
      else {
        const target = pose ? tile.target : null, ctx = tile.context;
        if (target) { target.driverNumber = pose.driverNumber; target.abbreviation = car?.abbreviation; target.world = pose.world; target.heading = pose.heading; target.pitch = pose.pitch; target.stale = pose.stale; }
        ctx.track = track; ctx.target = target; ctx.targetLabel = car?.abbreviation || (n === null ? '' : '#' + n); ctx.replayDt = replayDt; ctx.jumped = jumped; ctx.aspect = rect.width / Math.max(1, rect.height); ctx.placed = this.placed;
        frame = tile.controller.update(dt, ctx);
      }
      tile.frame = frame;
      const status = frame.ok ? 'ok' : 'unavailable', targetKey = n === null ? '' : String(n);
      if (tile.el.dataset.status !== status) tile.el.dataset.status = status;
      if (tile.el.dataset.target !== targetKey) tile.el.dataset.target = targetKey;
      this.showMessage(tile, frame.message, frame.ok); this.showShot(tile, frame.ok ? frame.badge : null);
      if (tile.hudView) {
        const o = tile.hudOptions; o.visible = hudVisible(tile.config, frame); o.availability = availability; o.time = time;
        tile.hudView.update(o.visible && n !== null ? this.motion.telemetry(n, at) : null, car ?? null, o);
      }
      const d = tile.descriptor;
      d.rect = rect; d.camera = tile.controller?.camera; d.overview = Boolean(frame.overview); d.hideLabel = frame.hideLabel ?? null; d.carYaw = frame.carYaw ?? null; d.labelPx = frame.labelPx; d.blank = !frame.ok; d.ego = frame.ok ? frame.ego ?? null : null;
      tiles.push(d);
      if (debugTiles) debugTiles.push({id: tile.id, mode: tile.config.mode, target: n, ok: frame.ok, message: frame.message || null, badge: frame.badge || null, ego: d.ego, hud: hudVisible(tile.config, frame), rect: {...rect}, camera: tile.controller ? {position: d.camera.position.toArray(), direction: d.camera.getWorldDirection(this.scratch || (this.scratch = d.camera.position.clone())).toArray(), fov: d.camera.fov} : null,
        projected: frame.ok ? Object.fromEntries([...poses].map(([k, p]) => [k, scene.project(p.world, d.camera, rect)])) : {}});
    }
    scene.render(tiles, Math.round(box.height)); this.cleared = false;
    // Render diagnostics for automated verification (no credentials or application data beyond counts).
    ds.renderedFrames = String(scene.stats.frames); ds.visibleCars = String(scene.stats.visibleCars); ds.ghostCars = String(scene.stats.ghostCars);
    ds.tiles = String(tiles.length); ds.track = track ? 'ready' : 'none';
    if (this.debug) ds.modes = visible.map(t => t.config.mode).join(',');
    ds.renderMs = scene.stats.lastRenderMs.toFixed(1); if (time !== null) ds.renderTime = String(time); else delete ds.renderTime;
    if (this.fps.since === null) this.fps.since = at;
    if (++this.fps.frames && at - this.fps.since >= 1000) { this.fps.value = this.fps.frames * 1000 / (at - this.fps.since); this.fps.frames = 0; this.fps.since = at; ds.fps = this.fps.value.toFixed(1); }
    if (this.debug) {
      const mapCanvas = this.mapTile.querySelector('canvas'), mr = mapCanvas?.getBoundingClientRect();
      this.debug.last = {at, renderTime: time, buffering: sample.buffering, playback: state.playback, serverCameras: this.serverBacked() ? state.settings.cameras : null, pendingCameras: Boolean(this.pending), placing: this.placing, tiles: debugTiles, corners: (this.geometry?.corners || []).map(c => ({id: c.id, name: c.name, x: c.x, y: c.y})), track: track ? {zMin: track.zMin, bounds: track.bounds, length: track.length, pit: Boolean(track.pit), kerbs: track.kerbs.placed.length} : null,
        cars: [...poses].map(([k, p]) => ({driverNumber: k, session: {x: p.session.x, y: p.session.y, z: p.session.z}, world: p.world.toArray(), trackY: p.trackY, heading: p.heading, stale: p.stale, ghost: scene.cars.get(k)?.ghost})),
        map2d: this.dots2d ? {rect: mr ? {left: mr.left, top: mr.top, width: mr.width, height: mr.height} : null, dots: Object.fromEntries(this.dots2d)} : null};
    }
  }
}
