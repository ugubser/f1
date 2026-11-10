import {inflateRawSync} from 'node:zlib';
import {referenceLap,sectorsFromLap,messageDrivers,safeRadioUrl,timingValue} from './public/replay.js';
const forbidden=new Set(['__proto__','constructor','prototype']);
export const LIVE_TOPICS=['Heartbeat','DriverList','ExtrapolatedClock','SessionInfo','SessionStatus','SessionData','TimingData','TimingAppData','LapCount','RaceControlMessages','TeamRadio','TrackStatus','Position.z'];
export function secondsFromF1(value){
  if(typeof value!=='string'||!/^\d+(?::\d{1,2})?(?:\.\d+)?$/.test(value))return null;
  const parts=value.split(':').map(Number),seconds=parts.length===2?parts[0]*60+parts[1]:parts[0];
  return Number.isFinite(seconds)?seconds:null;
}
export function gapFromF1(value){
  if(typeof value==='string'&&/^\+?\d+(?:\.\d+)?$/.test(value))return timingValue(Number(value));
  return timingValue(value);
}
// Numeric collection keys are patches, not array replacements. A leaf's own
// source timestamp prevents an older partial update overwriting newer fields.
export function mergePatch(target,patch,time,stamps,prefix=''){
  for(const [key,value] of Object.entries(patch||{})){
    if(forbidden.has(key))continue;
    const field=prefix?prefix+'.'+key:key;
    if(value!==null&&typeof value==='object'){
      if(time<(stamps.get(field)??-Infinity))continue;
      if(!target[key]||typeof target[key]!=='object')target[key]={};
      mergePatch(target[key],value,time,stamps,field);
    }else if(time>=(stamps.get(field)??-Infinity)){
      target[key]=value;stamps.set(field,time);
    }
  }
  return target;
}
const entries=value=>Object.entries(value||{}).filter(([key])=>!forbidden.has(key));
const integer=value=>Number.isInteger(Number(value))&&value!==null&&value!==''?Number(value):null;
export class LiveState{
  constructor(){this.reset();}
  reset(){this.raw={};this.stamps=new Map();this.points=new Map();this.lapStarts=new Map();this.pendingLaps=[];this.laps=[];this.reference=null;this.events=new Map();this.updatedAt=null;this.sessionEpoch=null;this.revision=0;}
  fieldTime(path){return this.stamps.get(path)??null;}
  apply(topic,patch,timestamp,{snapshot=false}={}){
    if(!LIVE_TOPICS.includes(topic))return;
    const time=Date.parse(timestamp);if(!Number.isFinite(time))throw Error('The F1 message has no valid UTC timestamp.');
    if(this.sessionEpoch!==null&&time<this.sessionEpoch)return;
    if(topic==='SessionInfo'&&patch?.Key!=null&&this.raw.SessionInfo?.Key!=null&&patch.Key!==this.raw.SessionInfo.Key){
      if(time<(this.fieldTime('SessionInfo.Key')??-Infinity))return;
      this.reset();this.sessionEpoch=time;
    }
    if(topic==='Position.z'){
      const decoded=JSON.parse(inflateRawSync(Buffer.from(patch,'base64'),{maxOutputLength:16*1024*1024}).toString('utf8'));
      for(const sample of Object.values(decoded.Position||{})){
        const date=Date.parse(sample.Timestamp);if(!Number.isFinite(date))continue;
        for(const [number,p] of entries(sample.Entries)){
          if(!Number.isInteger(+number)||!p||![p.X,p.Y,p.Z].every(Number.isFinite)||(p.X===0&&p.Y===0))continue;
          const points=this.points.get(+number)||[];const last=points.at(-1);
          if(last&&date<=last[0])continue;
          if(!last||date-last[0]>=600)points.push([date,p.X,p.Y,p.Z]);
          while(points.length&&(date-points[0][0]>20*60*1000||points.length>3000))points.shift();
          this.points.set(+number,points);
        }
      }
    }else{
      const prior=topic==='TimingData'?structuredClone(this.raw.TimingData?.Lines||{}):null;
      this.raw[topic]??={};mergePatch(this.raw[topic],patch,time,this.stamps,topic);
      if(topic==='TimingData')this.timingChanges(prior,patch.Lines,time,snapshot);
      if(topic==='RaceControlMessages')this.controlEvents();
      if(topic==='TeamRadio')this.radioEvents();
    }
    this.updatedAt=Math.max(this.updatedAt??-Infinity,time);this.revision++;
    this.completeReference();
  }
  timingChanges(prior,lines,time,snapshot){
    for(const [number,patch] of entries(lines)){
      const line=this.raw.TimingData.Lines[number],old=prior[number]||{},driver=+number;
      if(!Number.isInteger(driver)||!line||!patch)continue;
      if(!snapshot&&typeof patch.InPit==='boolean'&&patch.InPit!==old.InPit&&this.fieldTime(`TimingData.Lines.${number}.InPit`)===time){
        if(typeof old.InPit==='boolean')this.events.set(`pit-${number}-${time}`,{id:`pit-${number}-${time}`,time,kind:'pit',drivers:[driver],message:patch.InPit?'Entered pit lane':'Left pit lane',lap:integer(line.NumberOfLaps)});
      }
      const life=this.lapStarts.get(driver);
      if(life&&(line.InPit||patch.PitOut))life.dirty=true;
      if(integer(line.NumberOfLaps)!==null&&line.NumberOfLaps!==old.NumberOfLaps&&this.fieldTime(`TimingData.Lines.${number}.NumberOfLaps`)===time){
        const completed=integer(line.NumberOfLaps),previous=integer(old.NumberOfLaps);
        if(!snapshot&&life&&previous!==null&&completed===previous+1&&life.number===completed)this.pendingLaps.push({driver,number:completed,start:life.start,end:time,dirty:life.dirty});
        if(!snapshot||!life)this.lapStarts.set(driver,{number:completed+1,start:time,dirty:snapshot||Boolean(line.InPit||patch.PitOut)});
      }
    }
    if(this.events.size>1000){const oldest=[...this.events.values()].sort((a,b)=>a.time-b.time);for(const event of oldest.slice(0,this.events.size-1000))this.events.delete(event.id);}
  }
  completeReference(){
    if(this.reference)return;
    for(const pending of this.pendingLaps){
      if(pending.dirty||pending.done)continue;
      const line=this.raw.TimingData?.Lines?.[pending.driver],prefix=`TimingData.Lines.${pending.driver}`;
      const duration=secondsFromF1(line?.LastLapTime?.Value),reported=this.fieldTime(prefix+'.LastLapTime.Value');
      if(!duration||reported===null||Math.abs(reported-pending.end)>5000||Math.abs(duration*1000-(pending.end-pending.start))>3000)continue;
      const lap={driver_number:pending.driver,lap_number:pending.number,date_start:new Date(pending.end-duration*1000).toISOString(),lap_duration:duration,is_pit_out_lap:false};
      for(let i=0;i<3;i++){
        const stamp=this.fieldTime(prefix+`.Sectors.${i}.Value`);
        lap['duration_sector_'+(i+1)]=stamp!==null&&stamp>=pending.start&&stamp<=pending.end+5000?secondsFromF1(line?.Sectors?.[i]?.Value):null;
      }
      const ref=referenceLap(this.points.get(pending.driver)||[],[lap]);
      if(ref){this.reference={points:ref.points,lap,sectors:sectorsFromLap(ref.points,lap)};pending.done=true;return;}
    }
    this.pendingLaps=this.pendingLaps.filter(p=>!p.done&&p.end>this.updatedAt-20*60*1000).slice(-60);
  }
  controlEvents(){
    for(const [key,row] of entries(this.raw.RaceControlMessages?.Messages)){
      const time=Date.parse(row?.Utc);if(!Number.isFinite(time)||!row.Message)continue;
      const id='control-'+key;this.events.set(id,{id,time,kind:'control',drivers:messageDrivers(row.Message,integer(row.RacingNumber)),message:row.Message,lap:integer(row.Lap)});
    }
  }
  radioEvents(){
    const sessionPath=this.raw.SessionInfo?.Path;
    for(const [key,row] of entries(this.raw.TeamRadio?.Captures)){
      const time=Date.parse(row?.Utc);if(!Number.isFinite(time)||!row.Path||!sessionPath)continue;
      const url=safeRadioUrl('https://livetiming.formula1.com/static/'+sessionPath+row.Path);if(!url)continue;
      const id='radio-'+key;this.events.set(id,{id,time,kind:'radio',drivers:[integer(row.RacingNumber)].filter(n=>n!==null),message:'Team radio clip',url:'/api/live/radio?id='+encodeURIComponent(id),sourceUrl:url});
    }
  }
  snapshot(){
    const info=this.raw.SessionInfo||{},cars=[];
    for(const [number,driver] of entries(this.raw.DriverList)){
      if(!Number.isInteger(+number)||!driver)continue;
      const line=this.raw.TimingData?.Lines?.[number]||{},stints=entries(this.raw.TimingAppData?.Lines?.[number]?.Stints).sort((a,b)=>+a[0]-+b[0]),stint=stints.at(-1);
      const prefix=`TimingData.Lines.${number}`;
      cars.push({driver_number:+number,name_acronym:driver.Tla||number,full_name:driver.FullName||driver.BroadcastName||number,team_name:driver.TeamName||'',team_colour:driver.TeamColour||'',position:integer(line.Position),positionSince:this.fieldTime(prefix+'.Position'),lap:integer(line.NumberOfLaps),inPit:line.InPit===true,retired:line.Retired===true,stopped:line.Stopped===true,
        tire:stint?{compound:stint[1].Compound||'UNKNOWN',age:integer(stint[1].TotalLaps),stint:+stint[0]+1}:null,
        timing:{ahead:gapFromF1(line.IntervalToPositionAhead?.Value),leader:gapFromF1(line.GapToLeader),aheadTime:this.fieldTime(prefix+'.IntervalToPositionAhead.Value'),leaderTime:this.fieldTime(prefix+'.GapToLeader')},points:(this.points.get(+number)||[]).slice(-10)});
    }
    return {revision:this.revision,updatedAt:this.updatedAt,session:{key:info.Key??null,name:info.Name||'',type:info.Type||'',circuit:info.Meeting?.Circuit?.ShortName||'',circuitKey:info.Meeting?.Circuit?.Key??null,start:info.StartDate||null,path:info.Path||null},sessionStatus:this.raw.SessionStatus?.Status||null,trackStatus:this.raw.TrackStatus?.Message||null,lapCount:this.raw.LapCount||{},cars,reference:this.reference,events:[...this.events.values()].sort((a,b)=>a.time-b.time).slice(-500).map(({sourceUrl,...event})=>event)};
  }
}
