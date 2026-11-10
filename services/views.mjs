import {randomUUID} from 'node:crypto';
import {positionAt, upperBound, lapAt, tireAt, timingAt, eventsAt} from '../domain/replay.mjs';
import {liveTimingAt} from '../domain/live.mjs';
import {HistoryService, makeGeometry} from './history.mjs';
import {ApiError, invalid, objectBody, positiveId} from '../api-errors.mjs';

const kinds = ['control','pit','radio'];
const defaults = () => ({selectedDriver: null, selectedTurn: null, notifications: [...kinds], overlays: {sectors: true, turns: true, names: false}});
export class ViewService {
  constructor({history = new HistoryService(), live, now = Date.now, clock = () => performance.now(), maxViews = 12, idleMs = 1800000} = {}) {
    this.history = history; this.live = live; this.now = now; this.clock = clock; this.maxViews = maxViews; this.idleMs = idleMs; this.views = new Map();
  }
  create(body) {
    objectBody(body, ['source','raceId']);
    if (!['history','live'].includes(body.source)) throw invalid('source must be history or live.');
    if (body.raceId !== undefined) { positiveId(body.raceId); if (!Number.isInteger(body.raceId)) throw invalid('raceId must be an integer.'); }
    if (body.source === 'live' && body.raceId !== undefined) throw invalid('Live views do not take a raceId.');
    this.prune(); if (this.views.size >= this.maxViews) throw new ApiError(429, 'VIEW_LIMIT', 'Close an unused view before creating another.');
    const v = {id: randomUUID(), source: body.source, ...defaults(), history: null, playing: false, speed: 10, time: null, anchor: this.clock(), radio: null, revision: 1, sequence: 0, motionRevision: 0, touched: this.now()};
    if (body.raceId !== undefined) v.history = this.history.acquire(body.raceId);
    this.views.set(v.id, v); return v;
  }
  prune() { for (const [id,v] of this.views) if (this.now() - v.touched > this.idleMs) this.remove(id); }
  get(id) { this.prune(); const v = this.views.get(id); if (!v) throw new ApiError(404, 'VIEW_NOT_FOUND', 'This view has expired or the server restarted. Create a new view.'); v.touched = this.now(); return v; }
  remove(id) { const v = this.views.get(id); if (!v) return; this.history.release(v.history); this.views.delete(id); }
  currentTime(v) {
    const d = v.history;
    if (v.source === 'live') return this.now();
    if (!d || d.start === null) return null;
    const value = (v.time ?? d.start) + (v.playing ? Math.max(0, this.clock() - v.anchor) * v.speed : 0);
    return Math.min(d.end, Math.max(d.start, value));
  }
  pause(v) { v.motionRevision++; if (v.source === 'history') v.time = this.currentTime(v); v.anchor = this.clock(); v.playing = false; }
  patch(id, body) {
    objectBody(body, ['source','raceId','selectedDriver','selectedTurn','notifications','overlays']); const v = this.get(id);
    if (body.source !== undefined && !['history','live'].includes(body.source)) throw invalid('source must be history or live.');
    const nextSource = body.source ?? v.source;
    if (body.raceId !== undefined) { positiveId(body.raceId); if (!Number.isInteger(body.raceId)) throw invalid('raceId must be an integer.'); if (nextSource !== 'history') throw invalid('raceId requires a historical view.'); }
    if (body.selectedDriver !== undefined && body.selectedDriver !== null && (!Number.isInteger(body.selectedDriver) || body.selectedDriver < 1 || body.selectedDriver > 999)) throw invalid('Invalid selectedDriver.');
    if (body.selectedTurn !== undefined && body.selectedTurn !== null && (typeof body.selectedTurn !== 'string' || !/^\d{1,3}[A-Za-z]?$/.test(body.selectedTurn))) throw invalid('Invalid selectedTurn.');
    if (body.notifications !== undefined && (!Array.isArray(body.notifications) || body.notifications.some(k => !kinds.includes(k)) || new Set(body.notifications).size !== body.notifications.length)) throw invalid('Invalid notification categories.');
    if (body.overlays !== undefined) { objectBody(body.overlays, ['sectors','turns','names']); if (Object.values(body.overlays).some(v => typeof v !== 'boolean')) throw invalid('Overlay settings must be booleans.'); }
    if (body.source !== undefined && body.source !== v.source) { this.pause(v); v.source = body.source; v.radio = null; }
    if (body.raceId !== undefined && (+body.raceId !== v.history?.id || ['error','cancelled'].includes(v.history?.status))) {
      this.pause(v); this.history.release(v.history); v.history = this.history.acquire(body.raceId); v.time = null; v.selectedDriver = null; v.selectedTurn = null; v.radio = null;
    }
    for (const key of ['selectedDriver','selectedTurn','notifications']) if (body[key] !== undefined) v[key] = body[key];
    if (body.overlays) Object.assign(v.overlays, body.overlays);
    if (body.selectedDriver !== undefined || body.notifications !== undefined) v.radio = null;
    v.revision++; return v;
  }
  playback(id, body) {
    objectBody(body, ['action','time','speed']); const v = this.get(id), d = v.history;
    if (v.source !== 'history' || d?.status !== 'ready') throw new ApiError(409, 'REPLAY_NOT_READY', 'Load a historical race before controlling playback.');
    if (!['play','pause','seek','reset','speed'].includes(body.action)) throw invalid('Invalid playback action.');
    if (body.time !== undefined && body.action !== 'seek' || body.speed !== undefined && body.action !== 'speed') throw invalid('Unexpected field for this playback action.');
    if (body.action === 'seek' && (!Number.isFinite(body.time) || body.time < d.start || body.time > d.end)) throw invalid('Seek time must be UTC milliseconds inside this race.');
    if (body.action === 'speed' && ![1,5,10,30,60].includes(body.speed)) throw invalid('Unsupported playback speed.');
    const wasPlaying = v.playing; this.pause(v);
    if (body.action === 'play') { if (v.time >= d.end) v.time = d.start; v.playing = true; }
    if (body.action === 'seek') { v.time = body.time; v.radio = null; }
    if (body.action === 'reset') { v.time = d.start; v.radio = null; }
    if (body.action === 'speed') { v.speed = body.speed; v.playing = wasPlaying; }
    v.revision++; return v;
  }
  async radio(id, body) {
    objectBody(body, ['action','clipId','time']); const v = this.get(id);
    if (!['play','pause','stop','seek'].includes(body.action)) throw invalid('Invalid radio action.');
    if (body.action === 'play' && body.clipId) {
      const s = await this.snapshot(id, {geometry: false, eventLimit: Infinity});
      const event = s.events.items.find(e => e.clipId === body.clipId);
      if (!event) throw new ApiError(404, 'CLIP_NOT_AVAILABLE', 'This clip is not available in the current view.');
      this.pause(v); v.radio = {clipId: body.clipId, playing: true, time: 0, title: event.message, eventTime: event.time};
    } else if (!v.radio && body.action !== 'stop') throw new ApiError(409, 'NO_CLIP_SELECTED', 'Select a radio clip first.');
    else if (body.action === 'stop') v.radio = null;
    else if (body.action === 'seek') { if (!Number.isFinite(body.time) || body.time < 0) throw invalid('Invalid radio time.'); v.radio.time = body.time; }
    else { v.radio.playing = body.action === 'play'; if (v.radio.playing) this.pause(v); }
    v.revision++; return v;
  }
  async snapshot(id, {geometry = true, eventOffset = 0, eventLimit = 80} = {}) {
    const v = this.get(id), d = v.history, revision = v.revision, source = v.source;
    const live = v.source === 'live' ? await this.live.snapshot() : null;
    if (!this.views.has(id)) throw new ApiError(404, 'VIEW_NOT_FOUND', 'This view was closed.');
    if (v.revision !== revision || v.source !== source) return this.snapshot(id, {geometry, eventOffset, eventLimit});
    const time = this.currentTime(v);
    if (v.source === 'history' && d && time === d.end && v.playing) { this.pause(v); v.revision++; }
    const connected = live?.connection.state === 'streaming' && this.now() - live.updatedAt < 30000;
    const drivers = live?.cars || d?.drivers || [], allEvents = live ? live.events.map(e => ({...e, clipId: e.kind === 'radio' && e.clipAvailable ? Buffer.from(`l:${live.session.key}:${e.id}`).toString('base64url') : null})) : d?.events || [];
    const recent = time === null ? [] : eventsAt(allEvents, time, {window: 60000});
    const ordered = drivers.map(driver => {
      if (live) return {driver, position: driver.position, since: driver.positionSince};
      const records = d.positions.get(driver.driver_number) || [], index = time === null ? -1 : upperBound(records, time, r => Date.parse(r.date)) - 1, record = records[index];
      return {driver, position: record?.position ?? null, since: record ? Date.parse(record.date) : -Infinity};
    }).sort((a,b) => (a.position ?? 999) - (b.position ?? 999) || a.driver.driver_number - b.driver.driver_number);
    const classification = new Map(); for (const car of ordered) if (Number.isInteger(car.position)) { const group = classification.get(car.position) || []; group.push(car); classification.set(car.position, group); }
    const unique = pos => classification.get(pos)?.length === 1 ? classification.get(pos)[0] : null, leader = unique(1);
    const cars = ordered.map(({driver, position, since}) => {
      const n = driver.driver_number, laps = live ? [] : d.driverLaps.get(n) || [];
      const points = live ? connected && !driver.retired && !driver.stopped ? driver.points : [] : d.points.get(n) || [];
      const location = time === null ? null : positionAt(points, time);
      const ahead = unique(position - 1), context = {position: unique(position) ? position : null, positionSince: since, aheadSince: ahead?.since ?? null, leaderSince: leader?.since ?? null, raceStart: d?.start ?? -Infinity, active: Boolean(location)};
      const timing = live ? liveTimingAt(driver, time, {...context, connected}) : timingAt(d.intervals.get(n) || [], time ?? -Infinity, context);
      return {driverNumber: n, name: driver.full_name, abbreviation: driver.name_acronym, teamName: driver.team_name, color: /^[a-f\d]{6}$/i.test(driver.team_colour) ? '#' + driver.team_colour : '#b8c4c9', position,
        lap: live ? driver.lap : time === null ? null : lapAt(laps, time)?.lap_number ?? null, tire: live ? driver.tire : time === null ? null : tireAt(d.stints.get(n) || [], laps, time), location,
        timing: {...timing, aheadDriver: ahead?.driver.driver_number ?? null, leaderDriver: leader?.driver.driver_number ?? null}, selected: v.selectedDriver === n, hasNotification: recent.some(e => !e.drivers.length || e.drivers.includes(n))};
    });
    const filtered = time === null ? [] : eventsAt(allEvents, time, {driver: v.selectedDriver, kinds: v.notifications}).reverse();
    const events = filtered.map(({url,sourceUrl,clipAvailable,...event}) => event);
    const reference = live?.reference;
    const shape = !geometry ? null : live ? reference ? makeGeometry(reference.points, reference.sectors, null, reference.lap) : null : d?.geometry ?? null;
    const geometryRevision = live ? reference ? `${live.session.key}/${reference.lap.driver_number}/${reference.lap.lap_number}` : 'none' : `${d?.id ?? 'none'}/${d?.geometryRevision ?? 0}`;
    return {id, motionEpoch: this.motionEpoch(v, live), sequence: ++v.sequence, revision: v.revision, serverTime: this.now(), source: v.source, status: live ? live.connection.state : d?.status ?? 'empty', message: live ? live.connection.message : d?.message ?? 'Choose a race and load the replay.',
      session: live ? live.session : d?.session ? {key: d.id, circuit: d.session.circuit_short_name, name: d.session.session_name, start: d.session.date_start} : null,
      auth: live?.auth ?? null, liveStatus: live ? {session: live.sessionStatus, track: live.trackStatus, updatedAt: live.updatedAt} : null,
      playback: {time, start: v.source === 'history' ? d?.start ?? null : null, end: v.source === 'history' ? d?.end ?? null : null, playing: v.playing, speed: v.speed, supportedSpeeds: [1,5,10,30,60]},
      rendering: {maxGapMs: 5000, staleAfterMs: 2000, liveBufferMs: 300},
      settings: {selectedDriver: v.selectedDriver, selectedTurn: v.selectedTurn, notifications: v.notifications, overlays: v.overlays}, radio: v.radio,
      progress: {completed: d?.completed ?? 0, total: d?.total ?? 0, missingDrivers: d?.errors ?? []}, cars, lap: live ? live.lapCount.CurrentLap ?? null : cars.reduce((max,c) => Math.max(max,c.lap ?? 0),0), totalLaps: live ? live.lapCount.TotalLaps ?? null : d?.laps.length ? Math.max(...d.laps.map(l => l.lap_number)) : null,
      events: {total: events.length, items: events.slice(eventOffset,eventOffset + eventLimit)}, geometryRevision, ...(geometry ? {geometry: shape} : {}), availability: live ? {turns: {status: 'unavailable', message: 'Turn markers are not supplied by the live feed.'}} : d?.availability ?? {}};
  }
  motionEpoch(v, live) {
    return v.source === 'history' ? `h/${v.history?.id ?? 'empty'}/${v.motionRevision}` : `l/${live?.session.key ?? 'empty'}/${this.live.generation ?? 0}/${live?.connection.state ?? 'disconnected'}/${v.motionRevision}`;
  }
  coordinates(id, snapshot, cursor = null) {
    const v = this.get(id), epoch = snapshot.motionEpoch;
    if (v.source !== snapshot.source || v.revision !== snapshot.revision) return null;
    const replace = !cursor || cursor.epoch !== epoch || v.source === 'history' && (cursor.until === null || cursor.until < snapshot.playback.time);
    if (v.source === 'history') {
      const d = v.history, time = snapshot.playback.time;
      if (d?.status !== 'ready' || time === null) return {epoch, replace: true, from: null, until: null, latest: null, cars: []};
      const speed = snapshot.playback.playing ? snapshot.playback.speed : 1;
      if (!replace && (cursor.until >= d.end || cursor.until - time > speed * 1500)) return null;
      const from = replace ? Math.max(d.start, time - 5000) : cursor.until;
      const until = Math.min(d.end, time + Math.max(3000, speed * 2500));
      const cars = [...d.points].map(([driverNumber, points]) => ({driverNumber,
        points: points.slice(Math.max(0, upperBound(points, from) - 1), Math.min(points.length, upperBound(points, until) + 1))}));
      return {epoch, replace, from, until, latest: until, cars};
    }
    if (snapshot.status !== 'streaming') return replace ? {epoch, replace: true, from: null, until: null, latest: null, cars: []} : null;
    const cars = []; let latest = null;
    for (const [driverNumber, points] of this.live.store.points) {
      const after = replace ? this.now() - 8000 : cursor.drivers.get(driverNumber) ?? this.now() - 8000;
      const index = Math.max(0, upperBound(points, after) - (replace ? 1 : 0));
      const selected = points.slice(index);
      if (selected.length) { cars.push({driverNumber, points: selected}); latest = Math.max(latest ?? -Infinity, selected.at(-1)[0]); }
    }
    return cars.length || replace ? {epoch, replace, from: null, until: null, latest, cars} : null;
  }
  async events(id, {offset = '0', limit = '80'} = {}) {
    if (!/^\d+$/.test(offset) || !/^\d+$/.test(limit) || +limit < 1 || +limit > 100 || +offset > 100000) throw invalid('Invalid event pagination.');
    const s = await this.snapshot(id, {geometry: false, eventOffset: +offset, eventLimit: +limit});
    return {...s.events, offset: +offset};
  }
  close() { for (const id of this.views.keys()) this.remove(id); this.history.close(); }
}
