// Broadcast-style telemetry HUD for driver camera tiles (DECISION.md D3, M5). Presentation only: it shows the
// sample-and-hold row from MotionBuffer.telemetry() exactly as supplied (no interpolation, no smoothing, no future
// values). A value the source did not supply is shown as "—", never as 0. Loading, unavailable, missing-car, no-sample
// and stale states are explicit.

export const DASH = '—';
// Bar scale only (the number is always the supplied value): the 2014+ regulation rpm limit.
export const RPM_SCALE = 15000;

const clamp01 = v => Math.max(0, Math.min(1, v));
const finite = v => typeof v === 'number' && Number.isFinite(v);

export function formatGear(gear) {
  if (!finite(gear)) return DASH;
  if (gear === 0) return 'N';          // OpenF1 n_gear 0 = neutral
  if (gear < 0) return 'R';
  return String(Math.round(gear));
}
export const formatSpeed = v => finite(v) ? String(Math.round(v)) : DASH;
export const formatRpm = v => finite(v) ? Math.round(v).toLocaleString('en-US') : DASH;
export const formatPct = v => finite(v) ? String(Math.round(v)) : DASH;
export const formatAge = ms => finite(ms) && ms >= 0 ? `${(ms / 1000).toFixed(1)} s` : '';

// Pure display model. sample = motion.telemetry(n, at) | null; car = state.cars entry | null;
// availability = state.availability?.car_data | undefined; time = presentation time (optional, for the sample age).
export function hudModel(sample, car, availability, {time = null} = {}) {
  const n = car?.driverNumber ?? null, label = car?.abbreviation || (n === null ? '' : `#${n}`);
  const model = {
    driver: label, color: car?.color || '#9aa4a7', position: Number.isInteger(car?.position) ? `P${car.position}` : 'P' + DASH,
    speed: DASH, gear: DASH, rpm: DASH, rpmFraction: null, throttle: DASH, throttleFraction: null, brake: DASH, brakeFraction: null,
    drs: 'unknown', state: 'nosample', message: '', age: '',
  };
  if (!car) { model.state = 'nocar'; model.message = 'No car'; return model; }
  if (sample) {
    model.speed = formatSpeed(sample.speed); model.gear = formatGear(sample.gear); model.rpm = formatRpm(sample.rpm);
    model.rpmFraction = finite(sample.rpm) ? clamp01(sample.rpm / RPM_SCALE) : null;
    model.throttle = formatPct(sample.throttle); model.throttleFraction = finite(sample.throttle) ? clamp01(sample.throttle / 100) : null;
    model.brake = formatPct(sample.brake); model.brakeFraction = finite(sample.brake) ? clamp01(sample.brake / 100) : null;
    model.drs = sample.drs === true ? 'open' : sample.drs === false ? 'closed' : 'unknown';
    model.age = finite(time) && finite(sample.time) ? formatAge(time - sample.time) : '';
    model.state = sample.stale ? 'stale' : 'ok';
    model.message = sample.stale ? 'STALE' : '';
    return model;
  }
  const a = availability, missing = Array.isArray(a?.missingDrivers) && a.missingDrivers.includes(n);
  if (!a) { model.state = 'nosample'; model.message = 'No telemetry sample'; }
  else if (a.status === 'unavailable') { model.state = 'unavailable'; model.message = a.message || 'Telemetry not supplied for this source'; }
  else if (missing) { model.state = 'missing'; model.message = `No car_data for ${label}`; }
  else if (a.status === 'loading') { model.state = 'loading'; model.message = `Telemetry loading ${a.completed ?? 0}/${a.total ?? '?'}`; }
  else if (a.status === 'error') { model.state = 'error'; model.message = a.message || 'Telemetry could not be loaded'; }
  else if (a.status === 'empty') { model.state = 'unavailable'; model.message = 'No telemetry for this session'; }
  else { model.state = 'nosample'; model.message = `No telemetry sample for ${label} at this moment`; }
  return model;
}

const CSS = `
.hud3d{position:absolute;left:0;right:0;bottom:26px;z-index:1;pointer-events:none;display:flex;flex-direction:column;align-items:center;gap:3px;
  container-type:inline-size;font:500 11px Barlow,system-ui,sans-serif;color:#eef2ee;text-shadow:0 1px 2px #000a;user-select:none}
.hud3d[hidden]{display:none}
.hud3d-row{width:min(330px,calc(100% - 16px));display:flex;align-items:stretch;background:#0d1214e0;border:1px solid #ffffff1c;border-radius:5px;overflow:hidden;box-shadow:0 2px 10px #0007;height:46px}
.hud3d-id{display:flex;align-items:center;gap:6px;padding:0 9px 0 0;border-right:1px solid #ffffff14;min-width:78px}
.hud3d-stripe{display:block;align-self:stretch;width:5px;background:#9aa4a7}
.hud3d-pos{font:700 11px ui-monospace,monospace;color:#a3adb0}
.hud3d-abbr{font:700 16px 'Barlow Condensed',Barlow,system-ui,sans-serif;letter-spacing:.5px}
.hud3d-speed{display:flex;flex-direction:column;justify-content:center;align-items:flex-end;padding:0 8px;min-width:58px;border-right:1px solid #ffffff14}
.hud3d-speed b{font:700 22px/1 ui-monospace,monospace;font-variant-numeric:tabular-nums}
.hud3d-speed small,.hud3d-gear small{font-size:7px;letter-spacing:1.2px;color:#8f999c;margin-top:2px}
.hud3d-gear{display:flex;flex-direction:column;justify-content:center;align-items:center;min-width:34px;border-right:1px solid #ffffff14}
.hud3d-gear b{font:700 22px/1 ui-monospace,monospace;color:#dbfa58}
.hud3d-bars{flex:1;display:flex;flex-direction:column;justify-content:center;gap:4px;padding:0 8px;min-width:0}
.hud3d-bar{display:grid;grid-template-columns:22px 1fr 34px;align-items:center;gap:5px;font-size:7px;letter-spacing:1px;color:#8f999c}
.hud3d-bar span:last-child{font:9px ui-monospace,monospace;color:#d6dedd;text-align:right;letter-spacing:0;font-variant-numeric:tabular-nums}
.hud3d-track{display:block;height:5px;background:#ffffff14;border-radius:2px;overflow:hidden}
.hud3d-fill{display:block;height:100%;width:100%;transform-origin:0 50%;transform:scaleX(0);background:#c9d0cc}
.hud3d-rpm .hud3d-fill{background:linear-gradient(90deg,#74bdff,#c5a0ff 70%,#ff686d)}
.hud3d-thr .hud3d-fill{background:#5ed58a}
.hud3d-brk .hud3d-fill{background:#ff686d}
.hud3d-fill.none{opacity:0}
.hud3d-drs{display:flex;align-items:center;justify-content:center;width:38px;font:700 10px ui-monospace,monospace;letter-spacing:.5px;color:#7d898c;border-left:1px solid #ffffff14}
.hud3d-drs[data-drs=open]{background:#5ed58a;color:#0d1a10;text-shadow:none}
.hud3d-drs[data-drs=unknown]{color:#59666a}
.hud3d-status{align-self:center;display:flex;gap:8px;align-items:center;background:#0d1214d0;border:1px solid #ffffff14;border-radius:3px;padding:2px 7px;font:9px ui-monospace,monospace;color:#a3adb0}
.hud3d-status:empty{display:none}
.hud3d[data-state=stale] .hud3d-row{opacity:.6}
.hud3d[data-state=stale] .hud3d-status{color:#ffb472;border-color:#ffb47266}
.hud3d[data-state=loading] .hud3d-status{color:#74bdff;border-color:#74bdff55}
.hud3d[data-state=error] .hud3d-status,.hud3d[data-state=missing] .hud3d-status,.hud3d[data-state=unavailable] .hud3d-status{color:#ff9696;border-color:#ff969655}
.hud3d[data-state=loading] .hud3d-row,.hud3d[data-state=error] .hud3d-row,.hud3d[data-state=missing] .hud3d-row,.hud3d[data-state=unavailable] .hud3d-row,.hud3d[data-state=nosample] .hud3d-row{opacity:.55}
@container (max-width:440px){
  .hud3d-row{height:40px}.hud3d-id{min-width:0;gap:4px;padding-right:6px}.hud3d-pos{font-size:9px}.hud3d-abbr{font-size:14px}
  .hud3d-speed{min-width:44px;padding:0 6px}.hud3d-speed b,.hud3d-gear b{font-size:18px}.hud3d-gear{min-width:26px}
  .hud3d-bars{padding:0 6px;gap:3px}.hud3d-bar{grid-template-columns:17px 1fr 26px;gap:4px;font-size:6px}.hud3d-bar span:last-child{font-size:8px}
  .hud3d-drs{width:30px;font-size:8px}.hud3d-status{font-size:8px}}
@container (max-width:300px){.hud3d-pos{display:none}.hud3d-bar{grid-template-columns:17px 1fr}.hud3d-bar span:last-child{display:none}}
`;

let styleInstalled = false;
function installStyle() {
  if (styleInstalled || typeof document === 'undefined') return;
  const style = document.createElement('style'); style.dataset.module = 'hud3d'; style.textContent = CSS;
  document.head.append(style); styleInstalled = true;
}

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

export class Hud {
  constructor(tileElement) {
    installStyle();
    const root = el('div', 'hud3d'); root.hidden = true; root.setAttribute('aria-label', 'Car telemetry'); root.dataset.state = 'nosample';
    const row = el('div', 'hud3d-row');
    const id = el('div', 'hud3d-id'), stripe = el('i', 'hud3d-stripe'), pos = el('span', 'hud3d-pos'), abbr = el('span', 'hud3d-abbr');
    id.append(stripe, pos, abbr);
    const speedBox = el('div', 'hud3d-speed'), speed = el('b', '', DASH); speedBox.append(speed, el('small', '', 'KM/H'));
    const gearBox = el('div', 'hud3d-gear'), gear = el('b', '', DASH); gearBox.append(gear, el('small', '', 'GEAR'));
    const bars = el('div', 'hud3d-bars');
    const bar = (cls, name) => {
      const wrap = el('div', 'hud3d-bar ' + cls), track = el('i', 'hud3d-track'), fill = el('i', 'hud3d-fill none'), value = el('span', '', DASH);
      track.append(fill); wrap.append(el('span', '', name), track, value); bars.append(wrap);
      return {fill, value, fraction: undefined};
    };
    const rpm = bar('hud3d-rpm', 'RPM'), thr = bar('hud3d-thr', 'THR'), brk = bar('hud3d-brk', 'BRK');
    const drs = el('div', 'hud3d-drs', 'DRS'); drs.dataset.drs = 'unknown'; drs.title = 'DRS';
    row.append(id, speedBox, gearBox, bars, drs);
    const status = el('div', 'hud3d-status');
    root.append(row, status);
    tileElement.append(root);
    this.root = root; this.parts = {stripe, pos, abbr, speed, gear, rpm, thr, brk, drs, status};
    this.shown = {}; this.visible = false; this.model = null;
  }

  // Called every frame; touches the DOM only where a displayed value changed.
  update(sample, car, {visible = true, availability, time = null} = {}) {
    if (this.visible !== Boolean(visible)) { this.visible = Boolean(visible); this.root.hidden = !this.visible; }
    if (!this.visible) return;
    const m = hudModel(sample, car, availability, {time}), p = this.parts;
    this.model = m;
    this.set('state', m.state, v => { this.root.dataset.state = v; });
    this.set('color', m.color, v => { p.stripe.style.background = v; });
    this.text(p.pos, 'pos', m.position); this.text(p.abbr, 'abbr', m.driver);
    this.text(p.speed, 'speed', m.speed); this.text(p.gear, 'gear', m.gear);
    this.bar(p.rpm, m.rpmFraction, m.rpm); this.bar(p.thr, m.throttleFraction, m.throttle); this.bar(p.brk, m.brakeFraction, m.brake);
    this.set('drs', m.drs, v => { p.drs.dataset.drs = v; p.drs.title = `DRS ${v}`; p.drs.textContent = v === 'unknown' ? 'DRS ' + DASH : 'DRS'; });
    const status = [m.message, m.state === 'ok' || m.state === 'stale' ? m.age && `sample ${m.age}` : ''].filter(Boolean).join(' · ');
    this.text(p.status, 'status', status);
  }

  set(key, value, apply) { if (this.shown[key] !== value) { this.shown[key] = value; apply(value); } }
  text(node, key, value) { this.set(key, value, v => { node.textContent = v; }); }
  bar(part, fraction, text) {
    if (part.fraction !== fraction) {
      if ((part.fraction === null || part.fraction === undefined) !== (fraction === null)) part.fill.classList.toggle('none', fraction === null);
      part.fraction = fraction; part.fill.style.transform = `scaleX(${fraction ?? 0})`;
    }
    if (part.text !== text) { part.text = text; part.value.textContent = text; }
  }

  dispose() { this.root.remove(); this.parts = null; }
}
