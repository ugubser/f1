// Points: [UTC milliseconds, x, y, z]. No dependency on UI or data transport.
export function upperBound(rows, time, timestamp = row => row[0]) {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (timestamp(rows[mid]) <= time) lo = mid + 1; else hi = mid; }
  return lo;
}
export function positionAt(points, time, maxGap = 5000) {
  const i = upperBound(points, time) - 1;
  if (i < 0) return null;
  const a = points[i], b = points[i + 1];
  if (time - a[0] > maxGap) return null;
  if (!b || b[0] - a[0] > maxGap) return {x:a[1], y:a[2], stale: time > a[0] + 2000};
  const f = (time - a[0]) / (b[0] - a[0]);
  return {x:a[1]+(b[1]-a[1])*f, y:a[2]+(b[2]-a[2])*f, stale:false};
}
export function compactLocations(rows, interval = 800) {
  const points = rows.map(r => [Date.parse(r.date), r.x, r.y, r.z ?? 0])
    .filter(p => p.every(Number.isFinite) && !(p[1] === 0 && p[2] === 0))
    .sort((a,b) => a[0]-b[0]);
  const out=[];
  for (let i=0; i<points.length; i++) if (!out.length || points[i][0]-out.at(-1)[0] >= interval || i===points.length-1) out.push(points[i]);
  return out;
}
export function circuitFromLap(points, laps) {
  const candidates = laps.filter(l => !l.is_pit_out_lap && l.lap_number > 1 && l.lap_duration > 30 && l.date_start)
    .sort((a,b) => a.lap_duration-b.lap_duration);
  for (const lap of candidates) {
    const start = Date.parse(lap.date_start), end = start + lap.lap_duration*1000;
    const path = points.filter(p => p[0]>=start && p[0]<=end);
    if (path.length < 25 || path.at(-1)[0]-path[0][0] < lap.lap_duration*850) continue;
    const xs=path.map(p=>p[1]), ys=path.map(p=>p[2]);
    const span=Math.hypot(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys));
    const gap=Math.hypot(path[0][1]-path.at(-1)[1],path[0][2]-path.at(-1)[2]);
    if (span && gap/span < .18) return path;
  }
  return [];
}
export function lapAt(laps, time) {
  const i=upperBound(laps,time,l=>Date.parse(l.date_start))-1;
  return i<0 ? null : laps[i];
}
