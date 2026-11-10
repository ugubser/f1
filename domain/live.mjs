// Live values are separate from historical lap interpolation. Each gap keeps
// its own source timestamp, and each comparison is invalidated independently.
export function liveTimingAt(car,time,{position,aheadSince=null,leaderSince=null,connected=false,maxAge=15000}={}){
  const empty={ahead:null,leader:null,sampleTime:null,status:'unavailable'};
  if(!connected||car.retired||car.stopped)return {...empty,status:'inactive'};
  if(!Number.isInteger(position)||position<1)return empty;
  if(position===1)return {...empty,leader:{unit:'seconds',value:0},status:'leader'};
  const timing=car.timing||{},since=car.positionSince??-Infinity;
  const current=(date,rival)=>Number.isFinite(date)&&date<=time&&date>=Math.max(since,rival??Infinity)&&time-date<=maxAge;
  const ahead=current(timing.aheadTime,aheadSince)?timing.ahead:null,leader=current(timing.leaderTime,leaderSince)?timing.leader:null;
  const dates=[timing.aheadTime,timing.leaderTime].filter(Number.isFinite),sampleTime=dates.length?Math.min(...dates):null;
  return {ahead,leader,sampleTime,status:ahead||leader?'recorded':sampleTime!==null&&time-sampleTime>maxAge?'stale':'pending'};
}
