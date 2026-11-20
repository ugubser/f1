import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hudModel, formatGear, formatSpeed, formatRpm, formatAge, DASH, RPM_SCALE} from '../public/hud3d.js';

const car = {driverNumber: 16, abbreviation: 'LEC', color: '#e8002d', position: 1};
const sample = (over = {}) => ({time: 1000, speed: 312, gear: 8, rpm: 11234, throttle: 100, brake: 0, drs: true, stale: false, ...over});

test('formatting: supplied values verbatim, missing values as a dash (never 0), OpenF1 gear 0 is neutral', () => {
  assert.equal(formatGear(0), 'N'); assert.equal(formatGear(7), '7'); assert.equal(formatGear(-1), 'R'); assert.equal(formatGear(null), DASH); assert.equal(formatGear(undefined), DASH);
  assert.equal(formatSpeed(0), '0'); assert.equal(formatSpeed(null), DASH); assert.equal(formatSpeed(311.6), '312');
  assert.equal(formatRpm(11234), '11,234'); assert.equal(formatRpm(null), DASH); assert.equal(formatRpm(NaN), DASH);
  assert.equal(formatAge(240), '0.2 s'); assert.equal(formatAge(-5), ''); assert.equal(formatAge(null), '');
});

test('a current sample shows every value, bars scaled, DRS decoded, sample age from the presentation time', () => {
  const m = hudModel(sample(), car, {status: 'available', completed: 20, total: 20, missingDrivers: []}, {time: 1180});
  assert.equal(m.state, 'ok'); assert.equal(m.message, '');
  assert.deepEqual([m.driver, m.position, m.color, m.speed, m.gear, m.rpm, m.throttle, m.brake, m.drs], ['LEC', 'P1', '#e8002d', '312', '8', '11,234', '100', '0', 'open']);
  assert.equal(m.rpmFraction, 11234 / RPM_SCALE); assert.equal(m.throttleFraction, 1); assert.equal(m.brakeFraction, 0); assert.equal(m.age, '0.2 s');
  assert.equal(hudModel(sample({drs: false}), car).drs, 'closed');
  assert.equal(hudModel(sample({drs: null}), car).drs, 'unknown');
  assert.equal(hudModel(sample({throttle: 104}), car).throttleFraction, 1, 'bar clamps, the number stays as supplied');
  assert.equal(hudModel(sample({throttle: 104}), car).throttle, '104');
});

test('null fields inside a sample stay explicit instead of becoming 0', () => {
  const m = hudModel(sample({speed: null, gear: null, rpm: null, throttle: null, brake: null, drs: null}), car);
  assert.deepEqual([m.speed, m.gear, m.rpm, m.throttle, m.brake, m.drs], [DASH, DASH, DASH, DASH, DASH, 'unknown']);
  assert.equal(m.rpmFraction, null); assert.equal(m.throttleFraction, null); assert.equal(m.brakeFraction, null);
  // Real zeros (stationary car, gear N) are values, not missing.
  const z = hudModel(sample({speed: 0, gear: 0, rpm: 0, throttle: 0, brake: 0}), car);
  assert.deepEqual([z.speed, z.gear, z.rpm, z.throttle, z.brake], ['0', 'N', '0', '0', '0']); assert.equal(z.rpmFraction, 0);
});

test('stale samples are marked, values still the held sample', () => {
  const m = hudModel(sample({stale: true}), car, undefined, {time: 4000});
  assert.equal(m.state, 'stale'); assert.equal(m.message, 'STALE'); assert.equal(m.speed, '312'); assert.equal(m.age, '3.0 s');
});

test('without a sample the reason is explicit: loading, missing car, error, empty, live-unavailable, no sample', () => {
  const blank = m => [m.speed, m.gear, m.rpm, m.throttle, m.brake].every(v => v === DASH) && m.drs === 'unknown';
  const loading = hudModel(null, car, {status: 'loading', completed: 12, total: 20, missingDrivers: []});
  assert.equal(loading.state, 'loading'); assert.equal(loading.message, 'Telemetry loading 12/20'); assert.ok(blank(loading));
  const missing = hudModel(null, car, {status: 'available', completed: 20, total: 20, missingDrivers: [16]});
  assert.equal(missing.state, 'missing'); assert.equal(missing.message, 'No car_data for LEC'); assert.ok(blank(missing));
  assert.equal(hudModel(null, car, {status: 'loading', completed: 3, total: 20, missingDrivers: [16]}).state, 'missing', 'a failed car is not "loading"');
  const error = hudModel(null, car, {status: 'error', completed: 20, total: 20, missingDrivers: [], message: 'Telemetry could not be loaded.'});
  assert.equal(error.state, 'error'); assert.equal(error.message, 'Telemetry could not be loaded.');
  assert.equal(hudModel(null, car, {status: 'empty', completed: 20, total: 20, missingDrivers: []}).state, 'unavailable');
  const live = hudModel(null, car, {status: 'unavailable', message: 'Car telemetry is not supplied for live views.'});
  assert.equal(live.state, 'unavailable'); assert.equal(live.message, 'Car telemetry is not supplied for live views.');
  const none = hudModel(null, car, {status: 'available', completed: 20, total: 20, missingDrivers: []});
  assert.equal(none.state, 'nosample'); assert.match(none.message, /No telemetry sample for LEC/); assert.ok(blank(none));
  assert.equal(hudModel(null, car, undefined).state, 'nosample');
});

test('car identity: unknown position and abbreviation fall back explicitly; no car is its own state', () => {
  const m = hudModel(sample(), {driverNumber: 99, color: null, position: null});
  assert.equal(m.driver, '#99'); assert.equal(m.position, 'P' + DASH); assert.equal(m.color, '#9aa4a7');
  assert.equal(hudModel(sample(), null).state, 'nocar');
});
