// OpenF1 car_data rules for the onboard HUD. No dependency on UI or transport.
import {upperBound} from './replay.mjs';

// OpenF1 DRS codes: 10, 12 and 14 mean the flap is open; 0, 1 (off) and 8
// (detected/eligible, not yet open) and any other code are closed.
const OPEN = new Set([10,12,14]);
export const drsOpen = code => code === null || code === undefined ? null : OPEN.has(code);

const FIELDS = ['speed','n_gear','rpm','throttle','brake','drs'];
// Disk cache rows: [t, speedKph, gear, rpm, throttlePct, brakePct, drsCode].
// Sorted, invalid timestamps and duplicate timestamps dropped; a missing value stays null.
export function compactCarData(rows) {
  const out = rows.map(r => [Date.parse(r.date), ...FIELDS.map(f => Number.isFinite(r[f]) ? r[f] : null)])
    .filter(r => Number.isFinite(r[0])).sort((a,b) => a[0]-b[0]);
  return out.filter((r,i) => !i || r[0] !== out[i-1][0]);
}

// Columnar in-memory store: 8 bytes time + 6 x Int16 values = 20 bytes per row
// (a full Monza race is ~30k rows per car, ~0.6 MB; ~12 MB for 20 cars).
const MISSING = -32768;
export function telemetryStore(rows) {
  const time = new Float64Array(rows.length), values = new Int16Array(rows.length * 6);
  rows.forEach((r,i) => { time[i] = r[0]; for (let k = 0; k < 6; k++) { const v = r[k+1]; values[i*6+k] = Number.isInteger(v) && Math.abs(v) <= 32767 ? v : MISSING; } });
  return {time, values, length: rows.length};
}
const value = v => v === MISSING ? null : v;
export function telemetryRow(store, i) {
  const v = store.values, o = i * 6;
  return [store.time[i], value(v[o]), value(v[o+1]), value(v[o+2]), value(v[o+3]), value(v[o+4]), drsOpen(value(v[o+5]))];
}
// Samples with from < t <= until plus the one predecessor at or before `from`
// (for sample-and-hold at the window start). Never a sample after `until`.
export function telemetryWindow(store, from, until) {
  const ts = store.time, at = t => t, first = Math.max(0, upperBound(ts, from, at) - 1), end = upperBound(ts, until, at), out = [];
  for (let i = first; i < end; i++) out.push(telemetryRow(store, i));
  return out;
}
// Latest sample at or before `time`, null when none or older than maxAge.
export function telemetryAt(store, time, maxAge = Infinity) {
  const i = upperBound(store.time, time, t => t) - 1;
  return i < 0 || time - store.time[i] > maxAge ? null : telemetryRow(store, i);
}
// Telemetry set: explicit camera targets plus the selected driver, else the P1 car.
export function telemetryDrivers({cameras = [], selectedDriver = null, leader = null} = {}) {
  const set = new Set(cameras.map(c => c.driver).filter(Number.isInteger));
  const focus = Number.isInteger(selectedDriver) ? selectedDriver : leader;
  if (Number.isInteger(focus)) set.add(focus);
  return [...set].sort((a,b) => a-b);
}
