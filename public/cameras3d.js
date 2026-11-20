// Camera controllers for 3D tiles. Interface: {camera, update(dt, context) -> frame, attach(element, hooks), detach(), configure(config)}.
// Own input handling (DECISION.md E2: no OrbitControls). Smoothing here is presentation-only (E4): it damps the camera,
// never the cars, which stay on interpolated supplied samples.
import * as THREE from '/vendor/three.module.js';
import {damp, dampAngle, headingVector} from './track3d.js';

export const CAMERA_MODES = [
  {id: 'chase', label: 'Chase'},
  {id: 'onboard', label: 'Onboard'},
  {id: 'orbit', label: 'Orbit'},
  {id: 'birdseye', label: "Bird's-eye"},
];
export const SUPPORTED_MODES = new Set(CAMERA_MODES.map(m => m.id));

// context: {track, target:{driverNumber, abbreviation, world:Vector3, heading, pitch, stale}|null, targetLabel,
//           replayDt (presentation seconds advanced since last frame), jumped (seek/epoch/target change), aspect}
// frame:   {ok, message?, overview?, hideLabel?, carYaw?, labelPx?}
class Controller {
  constructor(fov = 55) {
    this.camera = new THREE.PerspectiveCamera(fov, 1, 0.5, 20000);
    this.config = null; this.element = null; this.hooks = null; this.listeners = [];
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

const noTarget = context => ({ok: false, message: context.targetLabel ? `No supplied position for ${context.targetLabel} at this moment.` : 'No car to follow at this moment.'});

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
      if (e.target.closest?.('.tile-bar')) return;
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
    const wheel = e => { e.preventDefault(); this.distance = Math.max(4, Math.min(8000, this.distance * Math.exp(e.deltaY * 0.0012))); clearTimeout(this.wheelTimer); this.wheelTimer = setTimeout(() => this.commit(), 400); };
    const dbl = () => { this.fixed = null; this.hooks?.commit?.({position: null, target: null}); this.appliedKey = JSON.stringify([null, null]); };
    return [['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', up], ['wheel', wheel, {passive: false}], ['dblclick', dbl], ['contextmenu', e => e.preventDefault()]];
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
      message = noTarget(context).message + ' Free orbit.';
    }
    const sp = Math.sin(this.polar);
    this.camera.position.set(this.pivot.x + this.distance * sp * Math.sin(this.azimuth), this.pivot.y + this.distance * Math.cos(this.polar), this.pivot.z + this.distance * sp * Math.cos(this.azimuth));
    this.camera.up.set(0, 1, 0); this.camera.lookAt(this.pivot);
    this.setClip(Math.max(0.1, this.distance * 0.01), Math.max(4000, this.distance * 6));
    // A close follow-orbit hides the target's own label so it does not sit on top of the car.
    return {ok: true, message, labelPx: 16, hideLabel: !this.fixed && target && this.distance < 60 ? target.driverNumber : null};
  }
}

// Top-down view fitted to the track, session +y up like the 2D map. Wheel zoom; when zoomed in it follows the target car.
export class BirdseyeController extends Controller {
  constructor(fov) { super(fov); this.zoom = 1; this.center = null; }
  inputs() {
    const wheel = e => { e.preventDefault(); this.zoom = Math.max(1, Math.min(60, this.zoom * Math.exp(-e.deltaY * 0.0015))); };
    const dbl = () => { this.zoom = 1; };
    return [['wheel', wheel, {passive: false}], ['dblclick', dbl]];
  }
  update(dt, context) {
    const {track, target, aspect} = context, b = track.bounds, tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const fit = Math.max((b.sizeZ / 2 * 1.06 + 25) / tan, (b.sizeX / 2 * 1.06 + 25) / (tan * aspect)), distance = fit / this.zoom;
    const follow = this.zoom > 1.05 && target, desired = follow ? new THREE.Vector3(target.world.x, target.world.y, target.world.z) : new THREE.Vector3(b.cx, 0, b.cz);
    if (!this.center || context.jumped) this.center = desired.clone();
    else { this.center.x = damp(this.center.x, desired.x, 8, dt); this.center.z = damp(this.center.z, desired.z, 8, dt); this.center.y = damp(this.center.y, desired.y, 8, dt); }
    this.camera.position.set(this.center.x, this.center.y + distance, this.center.z);
    this.camera.up.set(0, 0, -1); this.camera.lookAt(this.center.x, this.center.y, this.center.z);
    this.setClip(Math.max(1, distance * 0.05), distance * 2 + 200);
    return {ok: true, overview: this.zoom < 4, labelPx: 16};
  }
}

// Shared damped heading/pitch for driver cameras. Damping runs on presentation (replay) time so 10× playback
// corners look like 1× (plus a small wall-clock term so a paused view still settles). Snaps on seek or target change.
class DriverController extends Controller {
  constructor(fov, {yawRate, pitchRate}) { super(fov); this.yaw = null; this.pitch = 0; this.driver = null; this.yawRate = yawRate; this.pitchRate = pitchRate; }
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
    if (!this.follow(dt, context)) return noTarget(context);
    const w = context.target.world, [fx, , fz] = headingVector(this.yaw);
    this.camera.position.set(w.x - fx * 9, w.y + 3.1, w.z - fz * 9);
    this.camera.up.set(0, 1, 0); this.camera.lookAt(w.x + fx * 7, w.y + 1.0 + Math.tan(this.pitch) * 7, w.z + fz * 7);
    this.setClip(0.3, 6000);
    return {ok: true, labelPx: 15, hideLabel: context.target.driverNumber, carYaw: {driverNumber: context.target.driverNumber, yaw: this.yaw}};
  }
}

// Driver-eye / T-cam height: ~1 m above the track just ahead of the cockpit (behind the car's front), looking along the
// damped heading so the nose, front wheels and cars ahead stay in view.
// The target car itself is drawn with the same damped yaw in this tile so its nose stays aligned with the view.
export class OnboardController extends DriverController {
  constructor(fov) { super(fov, {yawRate: 6, pitchRate: 4}); }
  update(dt, context) {
    if (!this.follow(dt, context)) return noTarget(context);
    const w = context.target.world, [fx, , fz] = headingVector(this.yaw), back = 0.95, up = 1.1;
    this.camera.position.set(w.x + fx * back, w.y + up, w.z + fz * back);
    const ahead = 30, drop = Math.tan(this.pitch) * ahead - 1.5;
    this.camera.up.set(0, 1, 0); this.camera.lookAt(w.x + fx * ahead, w.y + up + drop, w.z + fz * ahead);
    this.setClip(0.08, 6000);
    return {ok: true, labelPx: 14, hideLabel: context.target.driverNumber, carYaw: {driverNumber: context.target.driverNumber, yaw: this.yaw}};
  }
}

// Modes from the server contract that this client does not render yet (M3) report that explicitly.
class UnavailableController extends Controller {
  constructor(fov, mode) { super(fov); this.mode = mode; }
  update() { return {ok: false, message: `The ${this.mode} camera is not available in this client yet.`}; }
}

export function createController(mode, fov) {
  switch (mode) {
    case 'orbit': return new OrbitController(fov);
    case 'birdseye': return new BirdseyeController(fov);
    case 'chase': return new ChaseController(fov);
    case 'onboard': return new OnboardController(fov);
    default: return new UnavailableController(fov, mode);
  }
}
