// Camera controllers for 3D tiles. Interface: {camera, update(dt, context) -> frame, attach(element, hooks), detach(), configure(config)}.
// Own input handling (DECISION.md E2: no OrbitControls). Smoothing here is presentation-only (E4): it damps the camera,
// never the cars, which stay on interpolated supplied samples.
import * as THREE from '/vendor/three.module.js';
import {damp, dampAngle, nearestIndex, nearestIndexAround} from './track3d.js';
import {positionStatus, generateVantages, placedVantage, directorStep, newShot, straightAhead, roundPoint} from './camera-grid.js';

export const CAMERA_MODES = [
  {id: 'chase', label: 'Chase'},
  {id: 'onboard', label: 'Onboard'},
  {id: 'orbit', label: 'Orbit'},
  {id: 'birdseye', label: "Bird's-eye"},
  {id: 'trackside', label: 'Trackside'},
  {id: 'director', label: 'TV director'},
];
export const SUPPORTED_MODES = new Set(CAMERA_MODES.map(m => m.id));

// context: {track, target:{driverNumber, abbreviation, world:Vector3, heading, pitch, stale}|null, targetLabel,
//           replayDt (presentation seconds advanced since last frame), jumped (seek/epoch/target change), aspect,
//           placed: [camera configs of this view's trackside cameras] (director vantages)}
// frame:   {ok, message, overview, hideLabel, carYaw, labelPx, ego, badge, follow}. Each controller reuses one frame
//           object (no per-frame allocation); the caller reads it before the next update().
// ego: driver whose cockpit this tile is (onboard), else null. follow: a driver-following shot (HUD may show).
export const PLACE_MESSAGE = 'Place this camera on the current track: use ⌖ Place (2D map click) or the turn picker in ⚙.';
const newFrame = () => ({ok: false, message: null, overview: false, hideLabel: null, carYaw: null, labelPx: 16, ego: null, badge: null, follow: false});
function setFrame(f, ok, message = null, labelPx = 16) {
  f.ok = ok; f.message = message; f.overview = false; f.hideLabel = null; f.carYaw = null; f.labelPx = labelPx; f.ego = null; f.badge = null; f.follow = false;
  return f;
}
class Controller {
  constructor(fov = 55) {
    this.camera = new THREE.PerspectiveCamera(fov, 1, 0.5, 20000);
    this.config = null; this.element = null; this.hooks = null; this.listeners = []; this.frame = newFrame();
  }
  configure(config) {
    this.config = config;
    if (Number.isFinite(config?.fov) && this.camera.fov !== config.fov) { this.camera.fov = config.fov; this.camera.updateProjectionMatrix(); }
  }
  attach(element, hooks = {}) {
    this.detach(); this.element = element; this.hooks = hooks;
    for (const [type, handler, options] of this.inputs()) { element.addEventListener(type, handler, options); this.listeners.push([type, handler, options]); }
  }
  detach() {
    for (const [type, handler, options] of this.listeners) this.element?.removeEventListener(type, handler, options);
    this.listeners = []; this.element = null;
  }
  inputs() { return []; }
  setClip(near, far) { if (this.camera.near !== near || this.camera.far !== far) { this.camera.near = near; this.camera.far = far; this.camera.updateProjectionMatrix(); } }
}

const noTargetText = context => context.targetLabel ? `No supplied position for ${context.targetLabel} at this moment.` : 'No car to follow at this moment.';
const noTarget = (frame, context) => setFrame(frame, false, noTargetText(context));
// Toolbars and popovers inside a tile are not camera input.
const fromUi = e => Boolean(e.target.closest?.('.tile-ui'));

// Free orbit around a pivot. With config.target null the pivot follows the target car (orbit angles stay local);
// a pan places a fixed pivot, and the resulting viewpoint is committed through hooks.commit on release (D4).
export class OrbitController extends Controller {
  constructor(fov) {
    super(fov); this.azimuth = 0.9; this.polar = 1.05; this.distance = 32; this.pivot = new THREE.Vector3(); this.fixed = null;
    this.drag = null; this.initialised = false; this.appliedKey = null;
  }
  configure(config) {
    super.configure(config);
    const key = JSON.stringify([config?.position, config?.target]);
    if (this.drag || key === this.appliedKey) return;
    this.appliedKey = key; this.pendingViewpoint = config?.position && config?.target ? {position: config.position, target: config.target} : null;
    if (!config?.target) this.fixed = null;
  }
  applyViewpoint(track) {
    const {position, target} = this.pendingViewpoint; this.pendingViewpoint = null;
    const p = new THREE.Vector3(...track.mapper.toWorld(position.x, position.y, position.z));
    const t = new THREE.Vector3(...track.mapper.toWorld(target.x, target.y, target.z)), d = p.clone().sub(t);
    this.fixed = t; this.pivot.copy(t); this.distance = Math.max(3, d.length());
    this.polar = Math.acos(Math.max(-1, Math.min(1, d.y / this.distance))); this.azimuth = Math.atan2(d.x, d.z); this.initialised = true;
  }
  inputs() {
    const down = e => {
      if (e.button !== 0 && e.button !== 2) return;
      if (fromUi(e)) return;
      e.preventDefault(); this.element.setPointerCapture?.(e.pointerId);
      this.drag = {x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey, moved: false};
    };
    const move = e => {
      if (!this.drag) return;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y; this.drag.x = e.clientX; this.drag.y = e.clientY;
      if (dx || dy) this.drag.moved = true;
      if (this.drag.pan) {
        if (!this.fixed) this.fixed = this.pivot.clone();
        const scale = this.distance * 0.0016, right = new THREE.Vector3(Math.cos(this.azimuth), 0, -Math.sin(this.azimuth)), forward = new THREE.Vector3(-Math.sin(this.azimuth), 0, -Math.cos(this.azimuth));
        this.fixed.addScaledVector(right, -dx * scale).addScaledVector(forward, dy * scale);
      } else {
        this.azimuth -= dx * 0.006; this.polar = Math.max(0.08, Math.min(1.5, this.polar - dy * 0.006));
      }
    };
    const up = () => { if (!this.drag) return; const moved = this.drag.moved; this.drag = null; if (moved) this.commit(); };
    const wheel = e => { if (fromUi(e)) return; e.preventDefault(); this.distance = Math.max(4, Math.min(8000, this.distance * Math.exp(e.deltaY * 0.0012))); clearTimeout(this.wheelTimer); this.wheelTimer = setTimeout(() => this.commit(), 400); };
    const dbl = e => { if (fromUi(e)) return; this.fixed = null; this.hooks?.commit?.({position: null, target: null}); this.appliedKey = JSON.stringify([null, null]); };
    return [['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', up], ['wheel', wheel, {passive: false}], ['dblclick', dbl], ['contextmenu', e => e.preventDefault()]];
  }
  // Current eye and look-at in session units ("Pin view here" turns them into a fixed trackside camera).
  viewpoint() {
    if (!this.track || !this.initialised) return null;
    const p = this.camera.position, t = this.fixed || this.pivot;
    return {position: roundPoint(this.track.mapper.toSession(p.x, p.y, p.z)), target: roundPoint(this.track.mapper.toSession(t.x, t.y, t.z))};
  }
  commit() {
    // Only placed (fixed-pivot) viewpoints are persisted; a car-following orbit keeps its angles local.
    if (!this.fixed || !this.track) return;
    const p = this.track.mapper.toSession(this.camera.position.x, this.camera.position.y, this.camera.position.z), t = this.track.mapper.toSession(this.fixed.x, this.fixed.y, this.fixed.z);
    const round = v => ({x: Math.round(v.x), y: Math.round(v.y), z: Math.round(v.z)}), viewpoint = {position: round(p), target: round(t)};
    this.appliedKey = JSON.stringify([viewpoint.position, viewpoint.target]);
    this.hooks?.commit?.(viewpoint);
  }
  update(dt, context) {
    const {track, target} = context; this.track = track;
    if (this.pendingViewpoint) this.applyViewpoint(track);
    let message;
    if (this.fixed) this.pivot.lerp(this.fixed, 1 - Math.exp(-12 * dt));
    else if (target) {
      if (!this.initialised || context.jumped) { this.pivot.copy(target.world); this.initialised = true; }
      else this.pivot.copy(target.world);
      this.pivot.y += 0.6;
    } else {
      if (!this.initialised) { this.pivot.set(track.bounds.cx, 0, track.bounds.cz); this.distance = Math.max(track.bounds.sizeX, track.bounds.sizeZ); this.initialised = true; }
      message = noTargetText(context) + ' Free orbit.';
    }
    const sp = Math.sin(this.polar);
    this.camera.position.set(this.pivot.x + this.distance * sp * Math.sin(this.azimuth), this.pivot.y + this.distance * Math.cos(this.polar), this.pivot.z + this.distance * sp * Math.cos(this.azimuth));
    this.camera.up.set(0, 1, 0); this.camera.lookAt(this.pivot);
    this.setClip(Math.max(0.1, this.distance * 0.01), Math.max(4000, this.distance * 6));
    // A close follow-orbit hides the target's own label so it does not sit on top of the car.
    const f = setFrame(this.frame, true, message, 16);
    f.hideLabel = !this.fixed && target && this.distance < 60 ? target.driverNumber : null;
    return f;
  }
}

// Top-down view fitted to the track, session +y up like the 2D map. Wheel zoom; when zoomed in it follows the target car.
export class BirdseyeController extends Controller {
  constructor(fov) { super(fov); this.zoom = 1; this.center = null; }
  inputs() {
    const wheel = e => { if (fromUi(e)) return; e.preventDefault(); this.zoom = Math.max(1, Math.min(60, this.zoom * Math.exp(-e.deltaY * 0.0015))); };
    const dbl = e => { if (!fromUi(e)) this.zoom = 1; };
    return [['wheel', wheel, {passive: false}], ['dblclick', dbl]];
  }
  update(dt, context) {
    const {track, target, aspect} = context, b = track.bounds, tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const fit = Math.max((b.sizeZ / 2 * 1.06 + 25) / tan, (b.sizeX / 2 * 1.06 + 25) / (tan * aspect)), distance = fit / this.zoom;
    const follow = this.zoom > 1.05 && target, desired = this.desired || (this.desired = new THREE.Vector3());
    if (follow) desired.copy(target.world); else desired.set(b.cx, 0, b.cz);
    if (!this.center || context.jumped) this.center = desired.clone();
    else { this.center.x = damp(this.center.x, desired.x, 8, dt); this.center.z = damp(this.center.z, desired.z, 8, dt); this.center.y = damp(this.center.y, desired.y, 8, dt); }
    this.camera.position.set(this.center.x, this.center.y + distance, this.center.z);
    this.camera.up.set(0, 0, -1); this.camera.lookAt(this.center.x, this.center.y, this.center.z);
    this.setClip(Math.max(1, distance * 0.05), distance * 2 + 200);
    const f = setFrame(this.frame, true, null, 16); f.overview = this.zoom < 4;
    return f;
  }
}

// Shared damped heading/pitch for driver cameras. Damping runs on presentation (replay) time so 10× playback
// corners look like 1× (plus a small wall-clock term so a paused view still settles). Snaps on seek or target change.
class DriverController extends Controller {
  constructor(fov, {yawRate, pitchRate}) { super(fov); this.yaw = null; this.pitch = 0; this.driver = null; this.yawRate = yawRate; this.pitchRate = pitchRate; this.carYaw = {driverNumber: null, yaw: 0}; }
  followFrame(labelPx, ego) {
    const f = setFrame(this.frame, true, null, labelPx), n = this.driver;
    f.hideLabel = n; this.carYaw.driverNumber = n; this.carYaw.yaw = this.yaw; f.carYaw = this.carYaw; f.follow = true; f.ego = ego ? n : null;
    return f;
  }
  follow(dt, context) {
    const {target} = context;
    if (!target) { this.yaw = null; return false; }
    const snap = this.yaw === null || context.jumped || target.driverNumber !== this.driver;
    this.driver = target.driverNumber;
    // Per-frame step is capped so one slow frame at high playback speed cannot swing the camera round in a single frame.
    const step = Math.min(0.12, context.replayDt) + 0.15 * dt;
    if (snap) { this.yaw = target.heading; this.pitch = target.pitch || 0; }
    else { this.yaw = dampAngle(this.yaw, target.heading, this.yawRate, step); this.pitch = damp(this.pitch, target.pitch || 0, this.pitchRate, step); }
    return true;
  }
}

// Behind and above the target car (~9 m back, ~3 m up), damped heading follow.
export class ChaseController extends DriverController {
  constructor(fov) { super(fov, {yawRate: 4.5, pitchRate: 3}); }
  update(dt, context) {
    if (!this.follow(dt, context)) return noTarget(this.frame, context);
    const w = context.target.world, fx = Math.cos(this.yaw), fz = -Math.sin(this.yaw);
    this.camera.position.set(w.x - fx * 9, w.y + 3.1, w.z - fz * 9);
    this.camera.up.set(0, 1, 0); this.camera.lookAt(w.x + fx * 7, w.y + 1.0 + Math.tan(this.pitch) * 7, w.z + fz * 7);
    this.setClip(0.3, 6000);
    return this.followFrame(15, false);
  }
}

// Driver-eye / T-cam height: ~1 m above the track just ahead of the cockpit (behind the car's front), looking along the
// damped heading so the nose, front wheels and cars ahead stay in view.
// The target car itself is drawn with the same damped yaw in this tile so its nose stays aligned with the view.
export class OnboardController extends DriverController {
  constructor(fov) { super(fov, {yawRate: 6, pitchRate: 4}); }
  update(dt, context) {
    if (!this.follow(dt, context)) return noTarget(this.frame, context);
    const w = context.target.world, fx = Math.cos(this.yaw), fz = -Math.sin(this.yaw), back = 0.95, up = 1.1;
    this.camera.position.set(w.x + fx * back, w.y + up, w.z + fz * back);
    const ahead = 30, drop = Math.tan(this.pitch) * ahead - 1.5;
    this.camera.up.set(0, 1, 0); this.camera.lookAt(w.x + fx * ahead, w.y + up + drop, w.z + fz * ahead);
    this.setClip(0.08, 6000);
    return this.followFrame(14, true);
  }
}

// Fixed eye with a damped pan towards the target car and a gentle, bounded auto-zoom (presentation only, E4).
// Shared by the trackside camera and the director's trackside shots. Holds the last aim when the car is not visible.
export const ZOOM_HALF_HEIGHT = 12, MIN_FOV = 15, AIM_RATE = 14;
export function autoZoomFov(distance, maxFov) { return Math.max(MIN_FOV, Math.min(maxFov, 2 * Math.atan(ZOOM_HALF_HEIGHT / Math.max(1, distance)) * 180 / Math.PI)); }
class TracksideRig {
  constructor(camera) { this.camera = camera; this.eye = new THREE.Vector3(); this.aim = new THREE.Vector3(); this.hasAim = false; this.fov = null; }
  // Aim at a world point. snap: jump instead of panning (cut, seek, new placement).
  look(point, dt, replayDt, snap, maxFov, zoom = true) {
    const step = Math.min(0.12, replayDt) + 0.15 * dt;
    if (snap || !this.hasAim) { this.aim.copy(point); this.hasAim = true; }
    else { this.aim.x = damp(this.aim.x, point.x, AIM_RATE, step); this.aim.y = damp(this.aim.y, point.y, AIM_RATE, step); this.aim.z = damp(this.aim.z, point.z, AIM_RATE, step); }
    const fov = zoom ? autoZoomFov(this.eye.distanceTo(this.aim), maxFov) : maxFov;
    this.fov = snap || this.fov === null ? fov : damp(this.fov, fov, 3, step + 0.5 * dt);
  }
  apply() {
    const c = this.camera;
    c.position.copy(this.eye); c.up.set(0, 1, 0); c.lookAt(this.aim);
    if (Math.abs(c.fov - this.fov) > 1e-3) { c.fov = this.fov; c.updateProjectionMatrix(); }
    const d = this.eye.distanceTo(this.aim);
    if (c.near !== 0.5 || c.far !== Math.max(6000, d * 4)) { c.near = 0.5; c.far = Math.max(6000, d * 4); c.updateProjectionMatrix(); }
  }
}

// Trackside camera at config.position (session units). config.target null: follows the target car; else fixed aim.
// A missing position, or one > 2 km from the current centerline (placed on another circuit), blanks the tile.
export class TracksideController extends Controller {
  constructor(fov) { super(fov); this.rig = new TracksideRig(this.camera); this.validKey = null; this.valid = null; this.fixedAim = new THREE.Vector3(); this.snap = true; }
  configure(config) {
    const key = JSON.stringify([config?.position, config?.target]);
    if (key !== this.configKey) { this.configKey = key; this.snap = true; }
    this.config = config; // FOV is applied by the rig (auto-zoom never exceeds config.fov)
  }
  update(dt, context) {
    const {track, target} = context, cfg = this.config || {};
    const key = this.configKey;
    if (this.validKey !== key || this.validTrack !== track) {
      this.validKey = key; this.validTrack = track; this.valid = positionStatus(track, cfg.position).status === 'ok';
      if (this.valid) { const [X, Y, Z] = track.mapper.toWorld(cfg.position.x, cfg.position.y, cfg.position.z); this.rig.eye.set(X, Y, Z); }
      if (this.valid && cfg.target) { const [X, Y, Z] = track.mapper.toWorld(cfg.target.x, cfg.target.y, cfg.target.z); this.fixedAim.set(X, Y, Z); }
      if (this.valid && !this.rig.hasAim) { const c = track.center[nearestIndex(track.center, this.rig.eye.x, this.rig.eye.z).index]; this.rig.aim.set(c[0], c[1], c[2]); }
      this.snap = true;
    }
    if (!this.valid) return setFrame(this.frame, false, PLACE_MESSAGE);
    const maxFov = cfg.fov ?? 55, snap = this.snap || context.jumped;
    let message = null;
    if (cfg.target) this.rig.look(this.fixedAim, dt, context.replayDt, true, maxFov, false);
    else if (target) this.rig.look(target.world, dt, context.replayDt, snap, maxFov);
    else { message = noTargetText(context) + ' Holding the last aim.'; if (this.rig.fov === null) this.rig.fov = maxFov; }
    this.snap = false; this.rig.apply();
    return setFrame(this.frame, true, message, 15);
  }
}

// Auto TV director: follows the target car, cutting between generated trackside vantage points (and this view's
// placed trackside cameras) with the vantage the car is approaching, plus occasional chase/onboard shots on long
// straights. Deterministic and presentation-only (see camera-math.js directorStep); no race rules.
export class DirectorController extends Controller {
  constructor(fov) {
    super(fov);
    this.rig = new TracksideRig(new THREE.PerspectiveCamera(fov, 1, 0.5, 20000));
    this.chase = new ChaseController(fov); this.onboard = new OnboardController(fov);
    this.shot = newShot(); this.clock = 0; this.vantages = []; this.vantageKey = null; this.carIndex = undefined; this.lastKind = null; this.lastVantage = -1;
    this.camera = this.rig.camera;
    this.straight = () => straightAhead(this.track, this.carIndex ?? 0);
  }
  configure(config) { this.config = config; this.chase.configure(config); this.onboard.configure(config); }
  vantagesFor(track, placed) {
    const key = placed.map(c => `${c.id}:${c.position?.x},${c.position?.y},${c.position?.z}`).join('|');
    if (track !== this.track || key !== this.vantageKey) {
      if (track !== this.track) this.generated = generateVantages(track);
      this.track = track; this.vantageKey = key;
      this.vantages = [...this.generated, ...placed.map(c => placedVantage(track, c)).filter(Boolean)].sort((a, b) => a.s - b.s);
      this.shot = newShot();
    }
    return this.vantages;
  }
  update(dt, context) {
    const {track, target} = context, vantages = this.vantagesFor(track, context.placed || []);
    this.clock += dt;
    if (!target) { const f = setFrame(this.frame, this.shot.kind === 'trackside' && this.rig.hasAim, noTargetText(context)); if (f.ok) { this.rig.apply(); f.message += ' Holding the shot.'; } return f; }
    if (context.jumped || target.driverNumber !== this.driver) { this.shot = newShot(); this.driver = target.driverNumber; this.carIndex = undefined; }
    const near = nearestIndexAround(track.center, target.world.x, target.world.z, this.carIndex);
    this.carIndex = near.index;
    const spacing = track.length / track.center.length;
    directorStep(this.shot, vantages, {now: this.clock, carS: near.index * spacing, length: track.length, straight: this.straight});
    const kind = this.shot.kind, cut = kind !== this.lastKind || this.shot.vantage !== this.lastVantage;
    this.lastKind = kind; this.lastVantage = this.shot.vantage;
    let sub;
    if (kind === 'trackside') {
      const v = vantages[this.shot.vantage];
      if (cut) this.rig.eye.set(v.world[0], v.world[1], v.world[2]);
      this.rig.look(target.world, dt, context.replayDt, cut || context.jumped, this.config?.fov ?? 55);
      this.rig.apply(); this.camera = this.rig.camera;
      sub = setFrame(this.frame, true, null, 15); sub.badge = `TV · ${v.label}`;
      return sub;
    }
    const controller = kind === 'chase' ? this.chase : this.onboard;
    if (cut) context.jumped = true;            // snap the driver camera's damped heading on a cut
    sub = controller.update(dt, context); this.camera = controller.camera;
    const f = this.frame;
    f.ok = sub.ok; f.message = sub.message; f.overview = false; f.hideLabel = sub.hideLabel; f.carYaw = sub.carYaw; f.labelPx = sub.labelPx; f.ego = sub.ego; f.follow = sub.follow;
    f.badge = kind === 'chase' ? 'TV · CHASE' : 'TV · ONBOARD';
    return f;
  }
}

export function createController(mode, fov) {
  switch (mode) {
    case 'orbit': return new OrbitController(fov);
    case 'birdseye': return new BirdseyeController(fov);
    case 'chase': return new ChaseController(fov);
    case 'onboard': return new OnboardController(fov);
    case 'trackside': return new TracksideController(fov);
    case 'director': return new DirectorController(fov);
    default: return new UnknownController(fov, mode);
  }
}

// Modes this client does not know (a newer server) report that explicitly instead of drawing a wrong view.
class UnknownController extends Controller {
  constructor(fov, mode) { super(fov); this.mode = mode; }
  update() { return setFrame(this.frame, false, `The ${this.mode} camera is not supported by this client.`); }
}
