// Tile grid inside the map panel (DECISION.md D6): the 2D map plus 0–4 camera tiles, auto-laid out, any tile maximizable.
// One shared WebGL canvas sits behind the tiles and renders each camera tile with scissor/viewport (E1).
// Camera configuration is view state on the server (D4: state.settings.cameras, changed with PATCH {cameras:[...]}).
// Until the server supplies that field, a local default list is used and edits stay local. Maximize is local layout.
// three.js modules load lazily so the 2D map keeps working if WebGL or the vendor module is unavailable.

export const MAX_CAMERAS = 4;
export const DEFAULT_CAMERA = Object.freeze({id: 'cam-1', mode: 'chase', driver: null, position: null, target: null, fov: 55, hud: true});
const MODE_LABELS = {chase: 'Chase', onboard: 'Onboard', orbit: 'Orbit', birdseye: "Bird's-eye", trackside: 'Trackside', director: 'TV director'};
const RENDERED_MODES = ['orbit', 'birdseye'];

const element = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
const normalise = c => ({id: c.id, mode: c.mode, driver: c.driver ?? null, position: c.position ?? null, target: c.target ?? null, fov: c.fov ?? 55, hud: c.hud ?? true});

// Camera target: explicit driver, else the view's selected driver, else the car in position 1.
export function resolveTarget(camera, state) {
  return camera.driver ?? state?.settings?.selectedDriver ?? state?.cars?.find(c => c.position === 1)?.driverNumber ?? null;
}

// Pure layout rule: number of visible camera tiles -> layout token used by CSS (see style.css .tile-grid).
export function layoutFor(cameraCount, maximized) { return maximized ? 'max' : String(Math.max(0, Math.min(MAX_CAMERAS, cameraCount))); }

export class CameraGrid {
  constructor({grid, mapTile, addButton, motion, onChange, dots2d = null}) {
    this.grid = grid; this.mapTile = mapTile; this.addButton = addButton; this.motion = motion; this.onChange = onChange; this.dots2d = dots2d;
    this.canvas = element('canvas', 'scene3d'); this.canvas.setAttribute('aria-label', '3D camera views (approximate track)');
    this.canvas.dataset.renderedFrames = '0'; this.canvas.dataset.visibleCars = '0'; this.canvas.dataset.tiles = '0'; this.canvas.dataset.status = 'loading';
    grid.prepend(this.canvas);
    this.tiles = new Map(); this.pending = null; this.local = [{...DEFAULT_CAMERA}]; this.state = null; this.geometry = null; this.maximized = null;
    this.scene = null; this.modules = null; this.error = null; this.carIndex = new Map(); this.carKey = '';
    this.lastAt = null; this.lastTime = null; this.fps = {frames: 0, since: null, value: 0}; this.cleared = true;
    this.debug = new URLSearchParams(location.search).has('debug3d') ? {} : null;
    if (this.debug) window.__f1Debug3d = {snapshot: () => structuredClone(this.debug.last ?? null)};
    const mapMax = element('button', 'tile-max', '⤢'); mapMax.type = 'button'; mapMax.title = 'Maximize map'; mapMax.setAttribute('aria-label', 'Maximize map'); mapMax.setAttribute('aria-pressed', 'false');
    mapMax.onclick = () => this.toggleMaximize('map'); mapTile.append(mapMax); this.mapMax = mapMax;
    addButton.onclick = () => this.add();
    Promise.all([import('./scene3d.js'), import('./cameras3d.js')]).then(([scene, cameras]) => {
      this.modules = cameras;
      try { this.scene = new scene.Scene3D(this.canvas); this.canvas.dataset.status = 'ready'; }
      catch { this.error = '3D view unavailable: WebGL could not start in this browser.'; this.canvas.dataset.status = 'error'; }
      this.refresh();
    }).catch(() => { this.error = '3D view unavailable: the three.js module could not be loaded.'; this.canvas.dataset.status = 'error'; this.refresh(); });
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
  remove(id) { if (this.maximized === id) this.maximized = null; this.write(this.cameras().filter(c => c.id !== id)); }
  toggleMaximize(id) { this.maximized = this.maximized === id ? null : id; this.refresh(); }

  sync(state, geometry) { this.state = state; this.geometry = geometry; this.refresh(); }
  reset() {
    this.state = null; this.geometry = null; this.maximized = null; this.pending = null; this.local = [{...DEFAULT_CAMERA}]; this.carKey = '';
    this.scene?.reset(); this.lastTime = null; this.refresh();
  }

  refresh() {
    const list = this.state ? this.cameras() : [], ids = new Set(list.map(c => c.id));
    for (const [id, tile] of this.tiles) if (!ids.has(id)) { tile.controller?.detach(); tile.el.remove(); this.tiles.delete(id); }
    if (this.maximized && this.maximized !== 'map' && !ids.has(this.maximized)) this.maximized = null;
    const cars = this.state?.cars || [], carKey = cars.map(c => `${c.driverNumber}:${c.abbreviation}`).sort().join(',');
    const carsChanged = carKey !== this.carKey; this.carKey = carKey; this.carIndex = new Map(cars.map(c => [c.driverNumber, c]));
    let previous = this.mapTile;
    for (const config of list) {
      let tile = this.tiles.get(config.id);
      if (!tile) { tile = this.createTile(config.id); this.tiles.set(config.id, tile); }
      if (previous.nextElementSibling !== tile.el) previous.after(tile.el);
      previous = tile.el;
      this.configureTile(tile, config, carsChanged);
    }
    this.grid.dataset.layout = layoutFor(list.length, this.maximized);
    this.grid.dataset.cameras = String(list.length);
    this.mapTile.classList.toggle('maximized', this.maximized === 'map');
    this.mapMax.setAttribute('aria-pressed', String(this.maximized === 'map')); this.mapMax.hidden = !list.length;
    for (const [id, tile] of this.tiles) { tile.el.classList.toggle('maximized', this.maximized === id); tile.max.setAttribute('aria-pressed', String(this.maximized === id)); }
    this.grid.classList.toggle('has-maximized', Boolean(this.maximized));
    this.addButton.disabled = !this.state || list.length >= MAX_CAMERAS;
    this.addButton.hidden = !this.state;
    if (this.scene && this.state) {
      this.scene.setTrack(this.geometry, this.geometry ? `${this.state.geometryRevision}|${this.geometry.points.length}|${this.geometry.points[0]?.[0]}` : null);
      this.scene.syncCars(cars, this.state.settings?.selectedDriver ?? null);
    }
  }

  createTile(id) {
    const el = element('div', 'tile camera-tile'), bar = element('div', 'tile-bar'), mode = element('select', 'tile-mode'), driver = element('select', 'tile-driver');
    const max = element('button', 'tile-max', '⤢'), remove = element('button', 'tile-remove', '×'), message = element('div', 'tile-message'), note = element('div', 'tile-note', 'APPROXIMATE 3D · NOMINAL 12 M TRACK');
    el.dataset.camera = id; mode.setAttribute('aria-label', 'Camera mode'); driver.setAttribute('aria-label', 'Camera target driver');
    max.type = remove.type = 'button'; max.title = 'Maximize camera'; max.setAttribute('aria-label', 'Maximize camera'); remove.title = 'Remove camera'; remove.setAttribute('aria-label', 'Remove camera');
    message.hidden = true; message.setAttribute('role', 'status');
    bar.append(mode, driver, max, remove); el.append(bar, message, note);
    mode.onchange = () => this.change(id, {mode: mode.value, position: null, target: null});
    driver.onchange = () => this.change(id, {driver: driver.value === '' ? null : +driver.value});
    max.onclick = () => this.toggleMaximize(id); remove.onclick = () => this.remove(id);
    return {id, el, bar, mode, driver, max, remove, message, note, controller: null, controllerMode: null, config: null, frame: null};
  }

  configureTile(tile, config, carsChanged) {
    tile.config = config;
    const modes = [...RENDERED_MODES, ...(RENDERED_MODES.includes(config.mode) ? [] : [config.mode])];
    const modeKey = modes.join();
    if (tile.mode.dataset.key !== modeKey) {
      tile.mode.replaceChildren(...modes.map(m => new Option(MODE_LABELS[m] ? MODE_LABELS[m] + (RENDERED_MODES.includes(m) ? '' : ' (not available yet)') : m, m)));
      tile.mode.dataset.key = modeKey;
    }
    if (tile.mode.value !== config.mode) tile.mode.value = config.mode;
    if (carsChanged || !tile.driver.options.length) {
      tile.driver.replaceChildren(new Option('Selected / P1', ''), ...[...this.carIndex.values()].sort((a, b) => a.driverNumber - b.driverNumber).map(c => new Option(`${c.abbreviation} · ${c.driverNumber}`, String(c.driverNumber))));
    }
    const driverValue = config.driver === null ? '' : String(config.driver);
    if (config.driver !== null && ![...tile.driver.options].some(o => o.value === driverValue)) tile.driver.add(new Option(`#${config.driver}`, driverValue));
    if (tile.driver.value !== driverValue) tile.driver.value = driverValue;
    if (this.modules && tile.controllerMode !== config.mode) {
      tile.controller?.detach();
      tile.controller = this.modules.createController(config.mode, config.fov);
      tile.controllerMode = config.mode;
      tile.controller.attach(tile.el, {commit: viewpoint => this.change(tile.id, viewpoint)});
    }
    tile.controller?.configure(config);
  }

  hidden(n) {
    const state = this.state;
    return state.source === 'live' && (!this.carIndex.get(n)?.location || state.status !== 'streaming');
  }

  // Unavailable views get a centred fallback message (never a frozen wrong view); soft notes stay small in a corner.
  showMessage(tile, text, soft = false) {
    if (tile.message.textContent !== (text || '')) tile.message.textContent = text || '';
    if (tile.message.hidden !== !text) tile.message.hidden = !text;
    tile.message.classList.toggle('soft', soft);
  }

  // Called from the app's animation frame with the same presentation instant used for the 2D map.
  frame(at) {
    const state = this.state, scene = this.scene, ds = this.canvas.dataset;
    const visible = [...this.tiles.values()].filter(t => !this.maximized || this.maximized === t.id);
    if (!state || !visible.length || this.maximized === 'map') {
      for (const tile of this.tiles.values()) this.showMessage(tile, this.error);
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
    const poses = scene.updateCars(this.motion, at, n => this.hidden(n)), track = scene.track, tiles = [];
    const debugTiles = this.debug ? [] : null;
    for (const tile of visible) {
      const r = tile.el.getBoundingClientRect(), rect = {x: Math.round(r.left - box.left), y: Math.round(r.top - box.top), width: Math.round(r.width), height: Math.round(r.height)};
      const n = resolveTarget(tile.config, state), car = n === null ? null : this.carIndex.get(n), pose = n === null ? null : poses.get(n);
      let frame;
      if (this.error) frame = {ok: false, message: this.error};
      else if (!track) frame = {ok: false, message: state.status === 'loading' ? 'Loading the race…' : 'Waiting for a complete reference lap to build the 3D track.'};
      else if (!tile.controller) frame = {ok: false, message: 'Loading 3D view…'};
      else frame = tile.controller.update(dt, {track, target: pose ? {...pose, abbreviation: car?.abbreviation} : null, targetLabel: car?.abbreviation || (n === null ? '' : '#' + n), replayDt, jumped, aspect: rect.width / Math.max(1, rect.height)});
      tile.frame = frame; tile.el.dataset.status = frame.ok ? 'ok' : 'unavailable'; tile.el.dataset.target = n === null ? '' : String(n);
      this.showMessage(tile, frame.message, frame.ok);
      tiles.push({rect, camera: tile.controller?.camera, overview: frame.overview, hideLabel: frame.hideLabel, carYaw: frame.carYaw, labelPx: frame.labelPx, blank: !frame.ok});
      if (debugTiles) debugTiles.push({id: tile.id, mode: tile.config.mode, target: n, ok: frame.ok, message: frame.message || null, rect, camera: tile.controller ? {position: tile.controller.camera.position.toArray(), direction: tile.controller.camera.getWorldDirection(this.scratch || (this.scratch = tile.controller.camera.position.clone())).toArray(), fov: tile.controller.camera.fov} : null,
        projected: frame.ok ? Object.fromEntries([...poses].map(([k, p]) => [k, scene.project(p.world, tile.controller.camera, rect)])) : {}});
    }
    scene.render(tiles, Math.round(box.height)); this.cleared = false;
    // Render diagnostics for automated verification (no credentials or application data beyond counts).
    ds.renderedFrames = String(scene.stats.frames); ds.visibleCars = String(scene.stats.visibleCars); ds.ghostCars = String(scene.stats.ghostCars);
    ds.tiles = String(tiles.length); ds.modes = visible.map(t => t.config.mode).join(','); ds.track = track ? 'ready' : 'none';
    ds.renderMs = scene.stats.lastRenderMs.toFixed(1); if (time !== null) ds.renderTime = String(time); else delete ds.renderTime;
    if (this.fps.since === null) this.fps.since = at;
    if (++this.fps.frames && at - this.fps.since >= 1000) { this.fps.value = this.fps.frames * 1000 / (at - this.fps.since); this.fps.frames = 0; this.fps.since = at; ds.fps = this.fps.value.toFixed(1); }
    if (this.debug) {
      const mapCanvas = this.mapTile.querySelector('canvas'), mr = mapCanvas?.getBoundingClientRect();
      this.debug.last = {at, renderTime: time, buffering: sample.buffering, playback: state.playback, serverCameras: this.serverBacked() ? state.settings.cameras : null, pendingCameras: Boolean(this.pending), tiles: debugTiles, corners: (this.geometry?.corners || []).map(c => ({id: c.id, name: c.name, x: c.x, y: c.y})), track: track ? {zMin: track.zMin, bounds: track.bounds, length: track.length, pit: Boolean(track.pit), kerbs: track.kerbs.placed.length} : null,
        cars: [...poses].map(([k, p]) => ({driverNumber: k, session: {x: p.session.x, y: p.session.y, z: p.session.z}, world: p.world.toArray(), trackY: p.trackY, heading: p.heading, stale: p.stale, ghost: scene.cars.get(k)?.ghost})),
        map2d: this.dots2d ? {rect: mr ? {width: mr.width, height: mr.height} : null, dots: Object.fromEntries(this.dots2d)} : null};
    }
  }
}
