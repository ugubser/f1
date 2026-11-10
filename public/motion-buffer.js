// Presentation only: interpolate API-supplied samples, never calculate race rules.
export class MotionBuffer {
  constructor({now=()=>performance.now(),wall=Date.now,maxGap=5000,liveDelay=300}={}) {
    this.staleAfter=2000;this.now=now;this.offset=wall()-now();this.maxGap=maxGap;this.liveDelay=liveDelay;this.reset();
  }
  reset(){this.epoch=null;this.source=null;this.anchor=null;this.points=new Map();this.until=null;this.latest=null;this.liveAnchor=null;this.connected=false;this.receivedPackets=0;}
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
    if(packet.replace){this.points.clear();this.liveAnchor=null;this.until=null;this.latest=null;}
    const at=this.now();
    if(packet.until!==null)this.until=packet.until;
    if(packet.latest!==null)this.latest=Math.max(this.latest??-Infinity,packet.latest);
    if(this.source==='live'&&!this.liveAnchor&&this.latest!==null)this.liveAnchor={time:this.latest-this.liveDelay,receivedAt:at};
    const cutoff=(this.time(at).time??-Infinity)-this.maxGap;
    for(const car of packet.cars){
      const existing=this.points.get(car.driverNumber)||[],merged=new Map(existing.map(p=>[p[0],p]));
      for(const p of car.points){if(!Array.isArray(p)||p.length<3||!p.every(Number.isFinite))throw Error('Invalid coordinate sample.');merged.set(p[0],p);}
      const points=[...merged.values()].sort((a,b)=>a[0]-b[0]),first=Math.max(0,upperBound(points,cutoff)-1);
      const retained=points.slice(first);if(retained.length>5000)throw Error('Coordinate buffer exceeded its limit.');
      this.points.set(car.driverNumber,retained);
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
    if(!b||b[0]-a[0]>this.maxGap)return {x:a[1],y:a[2],stale:time>a[0]+this.staleAfter||age>this.staleAfter};
    const f=(time-a[0])/(b[0]-a[0]);return {x:a[1]+(b[1]-a[1])*f,y:a[2]+(b[2]-a[2])*f,stale:age>this.staleAfter};
  }
}
function upperBound(points,time){let lo=0,hi=points.length;while(lo<hi){const mid=(lo+hi)>>>1;if(points[mid][0]<=time)lo=mid+1;else hi=mid;}return lo;}
