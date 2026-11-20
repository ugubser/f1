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
// Full source rate: drop only invalid, (0,0) placeholder and duplicate-timestamp samples.
export function compactLocations(rows) {
  const points = rows.map(r => [Date.parse(r.date), r.x, r.y, r.z ?? 0])
    .filter(p => p.every(Number.isFinite) && !(p[1] === 0 && p[2] === 0))
    .sort((a,b) => a[0]-b[0]);
  return points.filter((p,i) => !i || p[0] !== points[i-1][0]);
}
// Planar distance from (x,y) to a closed recorded polyline of [t,x,y,...] points.
export function distanceToPath(path, x, y) {
  let best = Infinity;
  for (let i = 0; i < path.length; i++) {
    const a = path[i], b = path[(i+1) % path.length], dx = b[1]-a[1], dy = b[2]-a[2];
    const f = Math.max(0, Math.min(1, ((x-a[1])*dx + (y-a[2])*dy) / (dx*dx + dy*dy || 1)));
    best = Math.min(best, Math.hypot(a[1] + f*dx - x, a[2] + f*dy - y));
  }
  return best;
}
// Pit-lane geometry is one recorded pit-stop trace of this session: the
// contiguous run of samples that leaves the reference lap (> threshold units)
// around a pit record, plus the on-track sample either side so it joins the
// track. Stops with sample gaps, position jumps (a frozen source position
// followed by a teleport: > max(jump, maxSpeed x dt), i.e. 25 m and 600 km/h),
// partial runs or no rejoin are skipped; no path is invented, smoothed or
// borrowed. Units are session units (~0.1 m); maxSpeed is units per ms.
export function pitLaneFromStops(reference, pits, pointsByDriver, {threshold = 40, before = 20000, after = 20000, search = 60000, maxGap = 1500, jump = 250, maxSpeed = 1.667, minSpacing = 5} = {}) {
  if (!(reference?.length > 2)) return null;
  const stops = pits.map(p => ({driver: p.driver_number, lap: Number.isInteger(p.lap_number) ? p.lap_number : null, entry: Date.parse(p.date), lane: p.lane_duration * 1000}))
    .filter(s => Number.isInteger(s.driver) && Number.isFinite(s.entry) && Number.isFinite(s.lane) && s.lane > 0).sort((a,b) => a.entry - b.entry || a.driver - b.driver);
  for (const stop of stops) {
    const points = pointsByDriver.get(stop.driver) || [], off = new Map();
    const away = i => { if (!off.has(i)) off.set(i, distanceToPath(reference, points[i][1], points[i][2]) > threshold); return off.get(i); };
    const lo = stop.entry - before, hi = stop.entry + stop.lane + after;
    let run = null;
    for (let i = upperBound(points, lo - 1), start = -1; i <= points.length; i++) {
      const inside = i < points.length && points[i][0] <= hi && away(i);
      if (inside && start < 0) start = i;
      if (!inside && start >= 0) { if (!run || i - start > run[1] - run[0] + 1) run = [start, i - 1]; start = -1; }
      if (i >= points.length || points[i][0] > hi) break;
    }
    if (!run) continue;
    let [first, last] = run;
    while (first > 0 && away(first - 1) && points[run[0]][0] - points[first - 1][0] <= search) first--;
    while (last < points.length - 1 && away(last + 1) && points[last + 1][0] - points[run[1]][0] <= search) last++;
    if (first === 0 || last === points.length - 1 || away(first - 1) || away(last + 1)) continue;
    const trace = points.slice(first - 1, last + 2);
    if (points[last][0] - points[first][0] < stop.lane * .5 || trace.some((p,i) => i && (p[0] - trace[i-1][0] > maxGap || Math.hypot(p[1]-trace[i-1][1], p[2]-trace[i-1][2]) > Math.max(jump, maxSpeed * (p[0] - trace[i-1][0]))))) continue;
    const out = [];
    for (const [i,p] of trace.entries()) {
      const prev = out.at(-1);
      // Drop stationary repeats (the pit box) so the polyline has no zero-length segments.
      if (prev && i < trace.length - 1 && Math.hypot(p[1]-prev[0], p[2]-prev[1], (p[3] ?? 0)-prev[2]) < minSpacing) continue;
      out.push([p[1], p[2], p[3] ?? 0]);
    }
    return {points: out, driverNumber: stop.driver, lap: stop.lap, entryTime: stop.entry};
  }
  return null;
}
export function referenceLap(points, laps) {
  const candidates = laps.filter(l => !l.is_pit_out_lap && l.lap_number > 1 && l.lap_duration > 30 && l.date_start)
    .sort((a,b) => a.lap_duration-b.lap_duration);
  for (const lap of candidates) {
    const start = Date.parse(lap.date_start), end = start + lap.lap_duration*1000;
    const path = points.filter(p => p[0]>=start && p[0]<=end);
    if (path.length < 25 || path.at(-1)[0]-path[0][0] < lap.lap_duration*850 || path.some((p,i)=>i && p[0]-path[i-1][0]>5000)) continue;
    const xs=path.map(p=>p[1]), ys=path.map(p=>p[2]);
    const span=Math.hypot(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys));
    const gap=Math.hypot(path[0][1]-path.at(-1)[1],path[0][2]-path.at(-1)[2]);
    if (span && gap/span < .18) return {points:path,lap};
  }
  return null;
}
export function circuitFromLap(points, laps) {return referenceLap(points,laps)?.points||[];}
export function lapAt(laps, time) {
  const i=upperBound(laps,time,l=>Date.parse(l.date_start))-1;
  return i<0 ? null : laps[i];
}

// Age is completed laps on this set, including any use before this stint.
// Stint changes have lap precision; OpenF1 does not timestamp tire fitting.
export function tireAt(stints, laps, time) {
  const lap=lapAt(laps,time);
  if(!lap) return null;
  const stint=stints.filter(s=>Number.isFinite(s.lap_start)&&s.lap_start<=lap.lap_number && (s.lap_end==null||s.lap_end>=lap.lap_number||(!lap.lap_duration&&s.lap_end===lap.lap_number-1)))
    .sort((a,b)=>b.lap_start-a.lap_start||b.stint_number-a.stint_number)[0];
  if(!stint)return null;
  const completed=lap.lap_duration>0 && Date.parse(lap.date_start)+lap.lap_duration*1000<=time;
  const age=Number.isFinite(stint.tyre_age_at_start)?stint.tyre_age_at_start+lap.lap_number-stint.lap_start+Number(completed):null;
  return {compound:stint.compound||'UNKNOWN',age,stint:stint.stint_number};
}

export function sectorsFromLap(points,lap) {
  const durations=[lap?.duration_sector_1,lap?.duration_sector_2,lap?.duration_sector_3];
  if(points.length<2||!durations.every(d=>Number.isFinite(d)&&d>0)||Math.abs(durations.reduce((a,b)=>a+b,0)-lap.lap_duration)>1)return [];
  const start=Date.parse(lap.date_start),b1=start+durations[0]*1000,b2=b1+durations[1]*1000;
  const boundaries=[b1,b2].map(t=>{const p=positionAt(points,t);return p&&!p.stale?[t,p.x,p.y]:null;});
  if(boundaries.some(p=>!p))return [];
  const edges=[points[0],...boundaries,points.at(-1)];
  return durations.map((duration,i)=>({number:i+1,duration,points:[edges[i],...points.filter(p=>p[0]>edges[i][0]&&p[0]<edges[i+1][0]),edges[i+1]]}));
}

// Markers and telemetry must already share a coordinate system. Reject a set
// that does not fit this session; do not stretch or invent turn positions.
export function alignCorners(points,corners,tolerance=.025) {
  if(points.length<2||!corners.length)return [];
  const xs=points.map(p=>p[1]),ys=points.map(p=>p[2]);
  const span=Math.hypot(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys));
  const aligned=[];
  for(const corner of corners){
    if(!Number.isFinite(corner.x)||!Number.isFinite(corner.y))return [];
    let best=null;
    for(let i=0;i<points.length;i++){
      const a=points[i],b=points[(i+1)%points.length],dx=b[1]-a[1],dy=b[2]-a[2];
      const f=Math.max(0,Math.min(1,((corner.x-a[1])*dx+(corner.y-a[2])*dy)/(dx*dx+dy*dy||1)));
      const x=a[1]+f*dx,y=a[2]+f*dy,d=Math.hypot(x-corner.x,y-corner.y);
      if(!best||d<best.error)best={...corner,x,y,error:d};
    }
    if(best.error>span*tolerance)return [];
    aligned.push(best);
  }
  return aligned;
}

export function messageDrivers(message,driverNumber) {
  const numbers=new Set(Number.isInteger(driverNumber)?[driverNumber]:[]);
  // Many incident messages omit driver_number, including multi-car incidents.
  for(const match of (message||'').matchAll(/\bCARS?\s+(\d{1,3})\b|\b(\d{1,3})\s*\([A-Z]{2,4}\)/g))numbers.add(+(match[1]||match[2]));
  return [...numbers];
}

export function buildEvents({race_control=[],pit=[],team_radio=[]}) {
  const events=[];
  for(const [index,row] of race_control.entries())events.push({id:`control-${index}`,time:Date.parse(row.date),kind:'control',drivers:messageDrivers(row.message,row.driver_number),message:row.message||row.category||'Race control',lap:row.lap_number});
  // A duration is only known after the car leaves the lane. Publish that
  // detail at pit exit, rather than leaking the eventual duration at entry.
  for(const [index,row] of pit.entries()){
    const entry=Date.parse(row.date),seconds=row.lane_duration;
    events.push({id:`pit-${index}`,time:entry,kind:'pit',drivers:[row.driver_number],message:'Entered pit lane',lap:row.lap_number});
    if(Number.isFinite(seconds)&&seconds>0)events.push({id:`pit-exit-${index}`,time:entry+seconds*1000,kind:'pit',drivers:[row.driver_number],message:`Left pit lane · ${seconds.toFixed(1)}s in lane${Number.isFinite(row.stop_duration)?' · '+row.stop_duration.toFixed(1)+'s stationary':''}`,lap:row.lap_number});
  }
  for(const [index,row] of team_radio.entries())events.push({id:`radio-${index}`,time:Date.parse(row.date),kind:'radio',drivers:[row.driver_number],message:'Team radio clip',url:safeRadioUrl(row.recording_url)});
  return events.filter(e=>Number.isFinite(e.time)).sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id));
}
export function safeRadioUrl(value) {
  try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='livetiming.formula1.com'&&url.pathname.endsWith('.mp3')?url.href:null;}catch{return null;}
}
export function eventsAt(events,time,{driver=null,kinds=['control','pit','radio'],window=Infinity}={}) {
  return events.slice(0,upperBound(events,time,e=>e.time)).filter(e=>e.time>=time-window&&kinds.includes(e.kind)&&(driver===null||!e.drivers.length||e.drivers.includes(driver)));
}

export function timingValue(value) {
  if(Number.isFinite(value)&&value>=0)return {unit:'seconds',value};
  if(typeof value==='string'){
    const match=/^\+?(\d+)\s+LAPS?$/.exec(value.trim().toUpperCase());
    if(match&&+match[1]>0)return {unit:'laps',value:+match[1]};
  }
  return null;
}
export function indexIntervals(records) {
  const indexed=new Map();
  for(const row of records){
    const time=Date.parse(row.date);
    if(!Number.isFinite(time)||!Number.isInteger(row.driver_number))continue;
    if(!indexed.has(row.driver_number))indexed.set(row.driver_number,[]);
    indexed.get(row.driver_number).push({time,ahead:timingValue(row.interval),leader:timingValue(row.gap_to_leader)});
  }
  for(const rows of indexed.values())rows.sort((a,b)=>a.time-b.time);
  return indexed;
}
export function formatTiming(value) {
  if(!value)return '—';
  return value.unit==='laps'?`+${value.value} ${value.value===1?'LAP':'LAPS'}`:`+${value.value.toFixed(3)}s`;
}

// Use the recorded interval and recorded cumulative leader gap. Do not add
// independently sampled intervals, interpolate future rows or estimate gaps
// from XY distance. Position changes invalidate comparisons to former rivals.
export function timingAt(records,time,{position=null,positionSince=-Infinity,aheadSince=null,leaderSince=null,raceStart=-Infinity,active=true,maxAge=15000}={}) {
  const empty={ahead:null,leader:null,sampleTime:null,status:'unavailable'};
  if(!active)return {...empty,status:'inactive'};
  if(!Number.isInteger(position)||position<1||time<raceStart)return empty;
  if(position===1)return {...empty,leader:{unit:'seconds',value:0},status:'leader'};
  const index=upperBound(records,time,row=>row.time)-1;
  if(index<0)return empty;
  const row=records[index];
  if(row.time<raceStart)return empty;
  if(time-row.time>maxAge)return {...empty,sampleTime:row.time,status:'stale'};
  const aheadCurrent=aheadSince!==null&&row.time>=Math.max(positionSince,aheadSince);
  const leaderCurrent=leaderSince!==null&&row.time>=Math.max(positionSince,leaderSince);
  const ahead=aheadCurrent?row.ahead:null,leader=leaderCurrent?row.leader:null;
  return {ahead,leader,sampleTime:row.time,status:ahead||leader?'recorded':aheadCurrent&&leaderCurrent?'unavailable':'pending'};
}
