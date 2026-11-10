import {upstream, circuitMetadata} from '../providers.mjs';
import {referenceLap, sectorsFromLap, alignCorners, buildEvents, indexIntervals} from '../domain/replay.mjs';
import {ApiError, positiveId} from '../api-errors.mjs';

export class HistoryService {
  constructor({load = upstream, loadCircuit = circuitMetadata, now = Date.now} = {}) {
    this.load = load; this.loadCircuit = loadCircuit; this.now = now; this.datasets = new Map();
  }
  async races({year, month, circuit} = {}) {
    year = positiveId(year, 'year');
    if (year < 2023 || year > new Date(this.now()).getUTCFullYear()) throw new ApiError(400, 'INVALID_REQUEST', 'Choose a season from 2023 through the current year.');
    if (month !== undefined && (!/^\d{1,2}$/.test(String(month)) || +month < 1 || +month > 12)) throw new ApiError(400, 'INVALID_REQUEST', 'Invalid month.');
    if (circuit !== undefined) positiveId(circuit, 'circuit');
    const all = (await this.load('sessions', {year: String(year), session_name: 'Race'}))
      .filter(s => !s.is_cancelled && Date.parse(s.date_end) < this.now() - 3 * 3600000).sort((a,b) => a.date_start.localeCompare(b.date_start));
    return {races: all.filter(s => (month === undefined || new Date(s.date_start).getUTCMonth() + 1 === +month) && (circuit === undefined || s.circuit_key === +circuit)),
      circuits: [...new Map(all.map(s => [s.circuit_key, {id: s.circuit_key, name: s.circuit_short_name}])).values()].sort((a,b) => a.name.localeCompare(b.name))};
  }
  acquire(id) {
    id = positiveId(id);
    let d = this.datasets.get(id);
    if (d?.status === 'cancelled' || d?.status === 'error') { this.datasets.delete(id); d = null; }
    if (!d) {
      // Unreferenced datasets can be evicted; datasets in open views stay shared.
      for (const [key, old] of this.datasets) if (!old.refs && this.datasets.size >= 3) { old.cancelled = true; this.datasets.delete(key); }
      d = {id, refs: 0, status: 'loading', cancelled: false, completed: 0, total: 0, message: 'Loading race metadata…', errors: [], availability: {}, drivers: [], laps: [], points: new Map(), positions: new Map(), driverLaps: new Map(), stints: new Map(), intervals: new Map(), events: [], geometry: null, geometryRevision: 0, start: null, end: null};
      this.datasets.set(id, d); d.task = this.prepare(d);
    }
    d.refs++; return d;
  }
  release(d) { if (!d) return; d.refs = Math.max(0, d.refs - 1); if (!d.refs && d.status === 'loading') { d.cancelled = true; d.status = 'cancelled'; } }
  async prepare(d) {
    const active = () => !d.cancelled;
    const get = async endpoint => { if (!active()) return []; return this.load(endpoint, {session_key: String(d.id)}); };
    try {
      const sessions = await get('sessions'); if (!active()) return;
      const session = sessions[0];
      if (!session || session.session_key !== d.id || session.session_name !== 'Race' || session.is_cancelled || !(Date.parse(session.date_end) < this.now() - 3 * 3600000)) throw Error('Choose an available completed race.');
      d.session = session;
      const drivers = await get('drivers'); if (!active()) return;
      if (!drivers.length) throw Error('No driver data is available for this race.');
      d.drivers = [...drivers].sort((a,b) => a.driver_number - b.driver_number); d.total = drivers.length;
      d.laps = (await get('laps')).filter(l => Number.isFinite(Date.parse(l.date_start))).sort((a,b) => Date.parse(a.date_start) - Date.parse(b.date_start)); if (!active()) return;
      const positions = await get('position'); if (!active()) return;
      const first = d.laps.filter(l => l.lap_number === 1);
      d.start = first.length ? Math.min(...first.map(l => Date.parse(l.date_start))) : Date.parse(session.date_start);
      if (!Number.isFinite(d.start)) throw Error('Race timing is unavailable.');
      d.end = Math.max(d.start + 60000, ...d.laps.map(l => Date.parse(l.date_start) + (l.lap_duration || 0) * 1000));
      for (const driver of drivers) {
        const n = driver.driver_number;
        d.driverLaps.set(n, d.laps.filter(l => l.driver_number === n));
        d.positions.set(n, positions.filter(p => p.driver_number === n).sort((a,b) => Date.parse(a.date) - Date.parse(b.date)));
      }
      const sourceData = {};
      const optional = ['stints','race_control','pit','team_radio','intervals'].map(async endpoint => {
        try { const value = await get(endpoint); if (!active()) return; sourceData[endpoint] = value; d.availability[endpoint] = {status: value.length ? 'available' : 'empty', count: value.length}; }
        catch { if (active()) d.availability[endpoint] = {status: 'error', message: 'This source could not be loaded.'}; }
      });
      optional.push((async () => {
        try { d.circuit = await this.loadCircuit(String(d.id)); if (active()) d.availability.circuit = {status: d.circuit.corners?.length ? 'available' : 'empty'}; }
        catch { if (active()) d.availability.circuit = {status: 'error', message: 'Turn metadata is unavailable.'}; }
      })());
      for (const driver of drivers) {
        if (!active()) return;
        d.message = `Loading car ${driver.driver_number} · ${d.completed}/${d.total} cars ready.`;
        try {
          const points = await this.load('location', {session_key: String(d.id), driver_number: String(driver.driver_number)});
          if (!active()) return;
          if (!points.length) throw Error();
          d.points.set(driver.driver_number, points);
          if (!d.reference) { const ref = referenceLap(points, d.driverLaps.get(driver.driver_number)); if (ref) d.reference = ref; }
        } catch { d.errors.push(driver.driver_number); }
        d.completed++;
      }
      await Promise.all(optional); if (!active()) return;
      for (const driver of drivers) d.stints.set(driver.driver_number, (sourceData.stints || []).filter(s => s.driver_number === driver.driver_number));
      d.intervals = indexIntervals(sourceData.intervals || []);
      d.events = buildEvents(sourceData).map(event => ({...event, clipId: event.kind === 'radio' && event.url ? Buffer.from(`h:${d.id}:${event.id}`).toString('base64url') : null}));
      if (d.reference) {
        const points = d.reference.points, sectors = sectorsFromLap(points, d.reference.lap);
        d.geometry = makeGeometry(points, sectors, d.circuit, d.reference.lap); d.geometryRevision++;
      }
      if (!d.points.size) throw Error('No car position data is available for this race.');
      d.status = 'ready'; d.message = `${session.circuit_short_name} ready · ${d.points.size}/${d.total} cars${d.errors.length ? ' · some positions unavailable' : ''}.`;
    } catch { if (active()) { d.status = 'error'; d.message = 'Could not load this completed race. Retry or choose another race.'; } }
  }
  clip(id) { for (const d of this.datasets.values()) { const event = d.events.find(e => e.clipId === id); if (event) return event; } return null; }
  close() { for (const d of this.datasets.values()) d.cancelled = true; }
}

export function makeGeometry(points, sectors, circuit, lap) {
  const corners = alignCorners(points, circuit?.corners || []).map(corner => {
    const nearest = points.reduce((a,p) => Math.hypot(p[1]-corner.x,p[2]-corner.y) < Math.hypot(a[1]-corner.x,a[2]-corner.y) ? p : a, points[0]);
    return {...corner, id: String(corner.number) + corner.letter, sector: sectors.find(s => nearest[0] >= s.points[0][0] && nearest[0] <= s.points.at(-1)[0])?.number ?? null};
  });
  return {points, sectors: sectors.map(s => ({...s, color: ['#74bdff','#c5a0ff','#ffb472'][s.number - 1]})), corners, referenceLap: {driverNumber: lap.driver_number, lap: lap.lap_number},
    coordinateSystem: 'session-xy', approximate: true, source: circuit?.source ?? 'F1 timing', referenceYear: circuit?.referenceYear ?? null, nameSource: circuit?.nameSource ?? null};
}
