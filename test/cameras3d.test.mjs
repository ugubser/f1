import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildTrack, nearestIndex} from '../public/track3d.js';
import {mapTransform, mapProject, mapUnproject, positionStatus, sessionAbove, heightAbove, clampHeight, cornerPlacement, generateVantages, placedVantage,
  approachingVantage, arcDelta, directorStep, newShot, straightAhead, DIRECTOR, FAR_LIMIT_M, layoutFor, hudVisible, resolveTarget} from '../public/camera-grid.js';

// Rounded-rectangle circuit in session units (≈ dm): 800 m × 300 m, 60 m corner radius, gentle elevation, ~15 m samples.
function roundedRect({W = 8000, H = 3000, r = 600, step = 150, z = (x, y) => 1800 + x / 100} = {}) {
  const pts = [], hw = W / 2, hh = H / 2, line = (x0, y0, x1, y1) => { const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / step)); for (let i = 0; i < n; i++) pts.push([x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n]); };
  const arc = (cx, cy, a0) => { const n = Math.max(2, Math.round(r * Math.PI / 2 / step)); for (let i = 0; i < n; i++) { const a = a0 + i / n * Math.PI / 2; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } };
  // Counter-clockwise in session xy from the middle of the bottom straight.
  line(0, -hh, hw - r, -hh); arc(hw - r, -hh + r, -Math.PI / 2); line(hw, -hh + r, hw, hh - r); arc(hw - r, hh - r, 0);
  line(hw - r, hh, -hw + r, hh); arc(-hw + r, hh - r, Math.PI / 2); line(-hw, hh - r, -hw, -hh + r); arc(-hw + r, -hh + r, Math.PI); line(-hw + r, -hh, 0, -hh);
  return pts.map(([x, y], i) => [1e12 + i * 240, x, y, z(x, y)]);
}
const geometry = (extra = {}) => ({points: roundedRect(), corners: [], ...extra});
const track = buildTrack(geometry());
const world = p => track.mapper.toWorld(p.x, p.y, p.z);
const distanceToCenterline = p => { const [X, , Z] = world(p); return nearestIndex(track.center, X, Z).distance; };

test('2D map projection matches the app formula and its inverse returns the clicked session point', () => {
  const pts = roundedRect(), t = mapTransform(pts, 900, 600);
  // Fitted with 145 px spare, centred: the limiting axis spans exactly width-145 px.
  assert.equal(t.cx, 0); assert.equal(t.cy, 0); assert.ok(Math.abs(t.scale - Math.min((900 - 145) / 8000, (600 - 145) / 3000)) < 1e-12);
  const [px, py] = mapProject(t, 4000, 1500); assert.ok(Math.abs(px - (450 + 4000 * t.scale)) < 1e-9); assert.ok(Math.abs(py - (300 - 1500 * t.scale)) < 1e-9, 'session +y is up on the map');
  for (const [x, y] of [[0, 0], [-3210, 777], [4000, -1500], [123.5, -2222]]) {
    const [u, v] = mapProject(t, x, y), back = mapUnproject(t, u, v);
    assert.ok(Math.abs(back.x - x) < 1e-6 && Math.abs(back.y - y) < 1e-6);
  }
  const out = [0, 0]; assert.equal(mapProject(t, 1, 2, out), out, 'projection can reuse an output array');
});

test('trackside positions: missing, on this circuit, or far away (another circuit) are told apart', () => {
  assert.equal(positionStatus(track, null).status, 'missing');
  assert.equal(positionStatus(track, {x: NaN, y: 0, z: 0}).status, 'missing');
  assert.equal(positionStatus(null, {x: 0, y: 0, z: 0}).status, 'missing');
  const near = positionStatus(track, {x: 0, y: -1500 - 300, z: 1900}); assert.equal(near.status, 'ok'); assert.ok(Math.abs(near.distance - 30) < 1);
  assert.equal(positionStatus(track, {x: 0, y: 0, z: 1800}).status, 'ok', 'the infield is on this circuit');
  assert.equal(positionStatus(track, {x: 0, y: -1500 - (FAR_LIMIT_M + 50) * 10, z: 1800}).status, 'far');
  assert.equal(positionStatus(track, {x: 0, y: -1500 - (FAR_LIMIT_M - 50) * 10, z: 1800}).status, 'ok');
  assert.equal(positionStatus(track, {x: 9e6, y: -9e6, z: 0}).status, 'far', 'Monza camera on another circuit');
});

test('placement heights are measured from the local track surface and clamped to 1–300 m', () => {
  const p = sessionAbove(track, 3000, -1800, 8);
  assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y) && Number.isInteger(p.z));
  assert.ok(Math.abs(heightAbove(track, p) - 8) < 0.1);
  // The circuit climbs with x: the same height above the track is a higher absolute z further east.
  assert.ok(sessionAbove(track, 3500, -1800, 8).z > sessionAbove(track, -3500, -1800, 8).z);
  assert.equal(clampHeight(0), 1); assert.equal(clampHeight(500), 300); assert.equal(clampHeight(12), 12);
});

test('"At turn" places the camera outside the corner, 25–40 m from the centerline and aims at the apex', () => {
  const corners = [{id: '1', x: 3900, y: -1400, angle: -45}, {id: '2', x: 3900, y: 1400, angle: 45}, {id: '3', x: -3900, y: 1400, angle: 135}, {id: '4', x: -3900, y: -1400, angle: -135}];
  for (const corner of corners) {
    const p = cornerPlacement(track, corner, {offset: 32, height: 8});
    const d = distanceToCenterline(p.position), apex = world(p.target), apexOnTrack = nearestIndex(track.center, apex[0], apex[2]);
    assert.ok(d >= 25 && d <= 40, `T${corner.id} ${d.toFixed(1)} m from the centerline`);
    // Outside of a convex circuit's corner: farther from the infield centre than the apex.
    assert.ok(Math.hypot(p.position.x, p.position.y) > Math.hypot(p.target.x, p.target.y) + 200, `T${corner.id} outside`);
    assert.ok(Math.abs(heightAbove(track, p.position) - 8) < 0.2);
    assert.ok(apexOnTrack.distance < 1 && Math.abs(apex[1] - track.center[apexOnTrack.index][1] - 0.5) < 0.1, 'apex at track height');
  }
  // On a straight the marker's angle decides the side (both directions are tried).
  const top = cornerPlacement(track, {id: 's', x: 0, y: 1500, angle: 90}), bottom = cornerPlacement(track, {id: 's', x: 0, y: 1500, angle: -90});
  assert.ok(top.position.y > 1500 + 200 && bottom.position.y < 1500 - 200);
});

test('a chicane-like gap: placements never land closer to another part of the circuit', () => {
  // Narrow hairpin: two parallel straights 40 m apart. The inside between them is rejected.
  const pts = roundedRect({W: 8000, H: 400, r: 200}), narrow = buildTrack({points: pts, corners: []});
  const p = cornerPlacement(narrow, {id: '1', x: 0, y: 200, angle: -90}, {offset: 32});
  const [X, , Z] = narrow.mapper.toWorld(p.position.x, p.position.y, p.position.z);
  assert.ok(nearestIndex(narrow.center, X, Z).distance >= 32 * 0.8 - 1e-6);
  assert.ok(p.position.y > 200, 'moved to the open side');
  for (const v of generateVantages(narrow)) assert.ok(nearestIndex(narrow.center, v.world[0], v.world[2]).distance >= 25 * 0.8 - 1e-6);
});

test('director vantages: every ~320 m, alternating sides, 25–40 m out, 5–15 m up, deterministic', () => {
  const vantages = generateVantages(track), again = generateVantages(track);
  assert.deepEqual(vantages, again);
  const expected = Math.floor(track.length / 320); assert.ok(Math.abs(vantages.length - expected) <= 1, `${vantages.length} vantages for ${track.length.toFixed(0)} m`);
  for (let i = 1; i < vantages.length; i++) assert.ok(Math.abs(vantages[i].s - vantages[i - 1].s - 320) < 3);
  let left = 0, right = 0;
  for (const v of vantages) {
    const c = track.center[v.index], d = Math.hypot(v.world[0] - c[0], v.world[2] - c[2]), up = v.world[1] - c[1];
    assert.ok(d >= 25 && d <= 40 && up >= 5 && up <= 15, `${v.label}: ${d.toFixed(1)} m out, ${up.toFixed(1)} m up`);
    const t = track.ribbon.tangents[v.index], side = Math.sign(t[1] * (v.world[0] - c[0]) - t[0] * (v.world[2] - c[2]));
    if (side > 0) left++; else right++;
  }
  assert.ok(Math.abs(left - right) <= 1, 'alternating sides');
  const placed = placedVantage(track, {id: 'tv-1', position: {x: 0, y: -1800, z: 1900}});
  assert.equal(placed.kind, 'placed'); assert.equal(placed.label, 'CAM TV-1');
  assert.equal(placedVantage(track, {id: 'tv-2', position: {x: 9e6, y: 0, z: 0}}), null, 'a camera from another circuit is not a vantage');
});

test('arc helpers wrap around the start/finish line and pick the vantage the car is approaching', () => {
  assert.equal(arcDelta(10, 30, 100), 20); assert.equal(arcDelta(90, 10, 100), 20); assert.equal(arcDelta(10, 90, 100), -20);
  const vantages = [{s: 100}, {s: 400}, {s: 700}, {s: 1000}];
  assert.equal(approachingVantage(vantages, 50, 1200), 0);
  assert.equal(approachingVantage(vantages, 80, 1200), 1, 'less than 40 m before a vantage: take the next one');
  assert.equal(approachingVantage(vantages, 1100, 1200), 0, 'wraps past the line');
  assert.ok(straightAhead(track, nearestIndex(track.center, 0, 150).index) > 300, 'long bottom straight');
  assert.ok(straightAhead(track, nearestIndex(track.center, 395, 145).index) < 80, 'corner close');
});

test('director cuts: minimum shot, cut after the car has passed and receded, max shot, follow shots on straights, deterministic', () => {
  const L = 3200, vantages = Array.from({length: 10}, (_, i) => ({s: 160 + i * 320}));
  const run = (straightLength, speed = 80, seconds = 120, fps = 30) => {
    const shot = newShot(), log = [];
    for (let k = 0; k <= seconds * fps; k++) {
      const now = k / fps, carS = (now * speed) % L, before = `${shot.kind}:${shot.vantage}`;
      directorStep(shot, vantages, {now, carS, length: L, straight: () => straightLength});
      if (`${shot.kind}:${shot.vantage}` !== before || k === 0) log.push({now, kind: shot.kind, vantage: shot.vantage, carS});
    }
    return log;
  };
  const cuts = run(0);
  assert.ok(cuts.length > 10);
  for (let i = 1; i < cuts.length; i++) assert.ok(cuts[i].now - cuts[i - 1].now >= DIRECTOR.minShot - 1e-9, 'minimum shot length');
  for (const c of cuts) {
    assert.equal(c.kind, 'trackside', 'no follow shots without a long straight');
    const ahead = ((vantages[c.vantage].s - c.carS) % L + L) % L;
    assert.ok(ahead >= 40 && ahead < 400, 'cuts to the vantage the car is approaching');
  }
  // The car stays in a shot until it is past the vantage by the recede distance.
  for (let i = 1; i < cuts.length; i++) { const v = vantages[cuts[i - 1].vantage]; assert.ok(arcDelta(v.s, cuts[i].carS, L) >= DIRECTOR.recede - 3); }
  assert.deepEqual(run(0), cuts, 'deterministic');
  const straights = run(1000), kinds = new Set(straights.map(c => c.kind));
  assert.ok(kinds.has('chase') && kinds.has('onboard') && kinds.has('trackside'), [...kinds].join());
  for (let i = 1; i < straights.length; i++) if (straights[i - 1].kind !== 'trackside') assert.ok(straights[i].now - straights[i - 1].now <= DIRECTOR.followShot + 0.05);
  // Paused car: no cuts after the opening shot even after maxShot (the best vantage does not change).
  const paused = newShot(); for (let k = 0; k < 900; k++) directorStep(paused, vantages, {now: k / 30, carS: 500, length: L, straight: () => 0});
  assert.equal(paused.count, 1);
  // A seek far away (car well behind the vantage) cuts as soon as the minimum shot allows.
  const seek = newShot(); directorStep(seek, vantages, {now: 0, carS: 500, length: L, straight: () => 0});
  directorStep(seek, vantages, {now: 3.1, carS: 2000, length: L, straight: () => 0}); assert.equal(seek.count, 2);
  // No vantages at all: chase/onboard alternate.
  const none = newShot(); directorStep(none, [], {now: 0, carS: 0, length: L, straight: () => 0}); assert.notEqual(none.kind, 'trackside');
});

test('grid helpers: layout tokens, camera target fallback and HUD visibility', () => {
  assert.equal(layoutFor(0, null), '0'); assert.equal(layoutFor(3, null), '3'); assert.equal(layoutFor(9, null), '4'); assert.equal(layoutFor(2, 'cam-1'), 'max');
  const state = {settings: {selectedDriver: null}, cars: [{driverNumber: 16, position: 2}, {driverNumber: 81, position: 1}]};
  assert.equal(resolveTarget({driver: 4}, state), 4); assert.equal(resolveTarget({driver: null}, state), 81);
  assert.equal(resolveTarget({driver: null}, {...state, settings: {selectedDriver: 16}}), 16);
  assert.equal(hudVisible({hud: true}, {ok: true, follow: true}), true);
  assert.equal(hudVisible({hud: false}, {ok: true, follow: true}), false);
  assert.equal(hudVisible({hud: true}, {ok: true, follow: false}), false, 'trackside / orbit shots carry no HUD');
  assert.equal(hudVisible({hud: true}, {ok: false, follow: true}), false);
});
