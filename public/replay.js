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
