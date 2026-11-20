// Presentation only: interpolate API-supplied samples, never calculate race rules.
const HEADING_WINDOW=400,HEADING_WINDOW_MAX=1600,HEADING_MIN_DISTANCE=3;
export class MotionBuffer {
  constructor({now=()=>performance.now(),wall=Date.now,maxGap=5000,liveDelay=300}={}) {
    this.staleAfter=2000;this.now=now;this.offset=wall()-now();this.maxGap=maxGap;this.liveDelay=liveDelay;this.reset();
  }
  reset(){this.epoch=null;this.source=null;this.anchor=null;this.points=new Map();this.telemetryRows=new Map();this.until=null;this.latest=null;this.liveAnchor=null;this.connected=false;this.receivedPackets=0;}
  setOffset(offset){if(Number.isFinite(offset))this.offset=offset;}
  state(state){
    if(state.rendering){this.maxGap=state.rendering.maxGapMs;this.staleAfter=state.rendering.staleAfterMs;this.liveDelay=state.rendering.liveBufferMs;}
    if(this.epoch!==state.motionEpoch){this.reset();this.epoch=state.motionEpoch;this.source=state.source;}
    if(!this.anchor||this.anchor.time===null&&state.playback.time!==null)
      this.anchor={...state.playback,serverTime:state.serverTime};
    this.connected=true;
  }
  coordinates(packet){
    if(packet.epoch!==this.epoch)return false;
    if(packet.replace){this.points.clear();this.telemetryRows.clear();this.liveAnchor=null;this.until=null;this.latest=null;}
    const at=this.now();
    if(packet.until!==null)this.until=packet.until;
    if(packet.latest!==null)this.latest=Math.max(this.latest??-Infinity,packet.latest);
    if(this.source==='live'&&!this.liveAnchor&&this.latest!==null)this.liveAnchor={time:this.latest-this.liveDelay,receivedAt:at};
    const cutoff=(this.time(at).time??-Infinity)-this.maxGap;
    for(const car of packet.cars){
      if(car.points)this.points.set(car.driverNumber,mergeRows(this.points.get(car.driverNumber),car.points,cutoff,p=>p.length>=3&&p.every(Number.isFinite),'coordinate sample'));
      // Telemetry rows [t,speedKph,gear,rpm,throttlePct,brakePct,drsOpen]: same merge/retention rules, values may be null.
      if(car.telemetry)this.telemetryRows.set(car.driverNumber,mergeRows(this.telemetryRows.get(car.driverNumber),car.telemetry,cutoff,p=>p.length>=7&&Number.isFinite(p[0])&&p.slice(1,7).every(v=>v===null||typeof v==='boolean'||Number.isFinite(v)),'telemetry sample'));
    }
    this.receivedPackets++;return true;
  }
  time(at=this.now()){
    if(!this.connected||!this.anchor)return {time:null,buffering:true};
    if(this.source==='live'){
      if(!this.liveAnchor||this.latest===null)return {time:null,buffering:true};
      const target=this.liveAnchor.time+Math.max(0,at-this.liveAnchor.receivedAt);
      return {time:Math.min(target,this.latest),buffering:target>this.latest};
    }
    const a=this.anchor;if(a.time===null)return {time:null,buffering:true};
    const target=Math.min(a.end,Math.max(a.start,a.time+(a.playing?Math.max(0,at-(a.serverTime-this.offset))*a.speed:0)));
    return {time:this.until===null?a.time:Math.min(target,this.until),buffering:this.until===null||target>this.until};
  }
  location(driverNumber,at=this.now()){
    const time=this.time(at).time,points=this.points.get(driverNumber);
    if(time===null||!points?.length)return null;
    const age=this.source==='live'?at+this.offset-points.at(-1)[0]:0;if(age>this.maxGap)return null;
    const i=upperBound(points,time)-1;if(i<0)return null;
    const a=points[i],b=points[i+1];if(time-a[0]>this.maxGap)return null;
    if(!b||b[0]-a[0]>this.maxGap)return {x:a[1],y:a[2],z:zOf(a),stale:time>a[0]+this.staleAfter||age>this.staleAfter};
    const f=(time-a[0])/(b[0]-a[0]),za=zOf(a),zb=zOf(b);
    return {x:a[1]+(b[1]-a[1])*f,y:a[2]+(b[2]-a[2])*f,z:za===null||zb===null?za??zb:za+(zb-za)*f,stale:age>this.staleAfter};
  }
  // Location plus a presentation heading (radians, session xy plane, atan2(dy,dx)) and pitch. The direction is measured
  // across supplied samples around the presentation time (±0.4 s, widened up to ±1.6 s for slow cars), clamped to the
  // contiguous run of buffered samples: it never looks past the last buffered sample or across a gap > maxGap.
  // heading is null when the supplied samples do not show movement.
  pose(driverNumber,at=this.now()){
    const location=this.location(driverNumber,at);if(!location)return null;
    const time=this.time(at).time,points=this.points.get(driverNumber),i=Math.max(0,upperBound(points,time)-1);
    let lo=i,hi=i;
    while(lo>0&&points[lo][0]-points[lo-1][0]<=this.maxGap&&points[lo][0]>time-HEADING_WINDOW_MAX)lo--;
    while(hi<points.length-1&&points[hi+1][0]-points[hi][0]<=this.maxGap&&points[hi][0]<time+HEADING_WINDOW_MAX)hi++;
    let heading=null,pitch=null;
    for(let w=HEADING_WINDOW;w<=HEADING_WINDOW_MAX&&heading===null;w*=2){
      const a=pathAt(points,lo,hi,time-w),b=pathAt(points,lo,hi,time+w),dx=b[0]-a[0],dy=b[1]-a[1],d=Math.hypot(dx,dy);
      if(d>=HEADING_MIN_DISTANCE){heading=Math.atan2(dy,dx);pitch=a[2]===null||b[2]===null?null:Math.atan2(b[2]-a[2],d);}
    }
    return {...location,heading,pitch};
  }
  // Sample-and-hold telemetry: the latest supplied row at or before presentation time, never interpolated or from the future.
  telemetry(driverNumber,at=this.now()){
    const time=this.time(at).time,rows=this.telemetryRows.get(driverNumber);
    if(time===null||!rows?.length)return null;
    const i=upperBound(rows,time)-1;if(i<0)return null;
    const r=rows[i];if(time-r[0]>this.maxGap)return null;
    return {time:r[0],speed:r[1],gear:r[2],rpm:r[3],throttle:r[4],brake:r[5],drs:r[6],stale:time-r[0]>this.staleAfter};
  }
}
const zOf=p=>Number.isFinite(p[3])?p[3]:null;
function mergeRows(existing=[],rows,cutoff,valid,name){
  const merged=new Map(existing.map(p=>[p[0],p]));
  for(const p of rows){if(!Array.isArray(p)||!valid(p))throw Error(`Invalid ${name}.`);merged.set(p[0],p);}
  const sorted=[...merged.values()].sort((a,b)=>a[0]-b[0]),retained=sorted.slice(Math.max(0,upperBound(sorted,cutoff)-1));
  if(retained.length>5000)throw Error('Coordinate buffer exceeded its limit.');
  return retained;
}
// Position along the supplied polyline points[lo..hi] at time t, clamped to that run's first/last sample.
function pathAt(points,lo,hi,t){
  if(t<=points[lo][0])return [points[lo][1],points[lo][2],zOf(points[lo])];
  if(t>=points[hi][0])return [points[hi][1],points[hi][2],zOf(points[hi])];
  const j=upperBound(points,t)-1,a=points[j],b=points[j+1],f=(t-a[0])/(b[0]-a[0]),za=zOf(a),zb=zOf(b);
  return [a[1]+(b[1]-a[1])*f,a[2]+(b[2]-a[2])*f,za===null||zb===null?null:za+(zb-za)*f];
}
function upperBound(points,time){let lo=0,hi=points.length;while(lo<hi){const mid=(lo+hi)>>>1;if(points[mid][0]<=time)lo=mid+1;else hi=mid;}return lo;}
