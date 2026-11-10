import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import {LiveState,mergePatch,gapFromF1,secondsFromF1} from '../live-state.mjs';
import {liveTimingAt} from '../domain/live.mjs';
const base=Date.parse('2024-09-01T13:00:00Z'),utc=seconds=>new Date(base+seconds*1000).toISOString();
const zip=value=>deflateRawSync(Buffer.from(JSON.stringify(value))).toString('base64');
test('partial indexed patches preserve fields, handle arrays, reject older leaves and prototype pollution',()=>{
  const target={},stamps=new Map();mergePatch(target,{Lines:{16:{Position:'2',Stints:[{Compound:'MEDIUM',TotalLaps:4}]}}},10,stamps);
  mergePatch(target,{Lines:{16:{Stints:{0:{TotalLaps:5}}}}},11,stamps);
  mergePatch(target,{Lines:{16:{Position:'3',Retired:false}}},9,stamps);
  mergePatch(target,JSON.parse('{"__proto__":{"polluted":true},"constructor":{"bad":1}}'),20,stamps);
  assert.equal(target.Lines[16].Position,'2');assert.equal(target.Lines[16].Retired,false);assert.equal(target.Lines[16].Stints[0].Compound,'MEDIUM');assert.equal(target.Lines[16].Stints[0].TotalLaps,5);assert.equal({}.polluted,undefined);
});
test('F1 time and gap values preserve zero, seconds, laps and unknowns',()=>{
  assert.equal(secondsFromF1('1:23.456'),83.456);assert.equal(secondsFromF1('23.456'),23.456);assert.equal(secondsFromF1(''),null);
  assert.deepEqual(gapFromF1('+1.234'),{unit:'seconds',value:1.234});assert.deepEqual(gapFromF1('+1 LAP'),{unit:'laps',value:1});assert.deepEqual(gapFromF1('0'),{unit:'seconds',value:0});assert.equal(gapFromF1('STOP'),null);
});
function initial(state){state.apply('SessionInfo',{Key:123,Name:'Race',Path:'2024/race/',Meeting:{Circuit:{ShortName:'Test circuit'}}},utc(0),{snapshot:true});state.apply('DriverList',{'16':{Tla:'LEC',FullName:'Charles Leclerc',TeamName:'Ferrari'}},utc(0));state.apply('TimingData',{Lines:{16:{Position:'2',NumberOfLaps:4,InPit:false,GapToLeader:'+2.000',IntervalToPositionAhead:{Value:'0.500'}}}},utc(0),{snapshot:true});}
test('compressed positions keep UTC and real XY; invalid points and late samples do not become cars',()=>{
  const state=new LiveState();initial(state);
  const samples=[{Timestamp:utc(1),Entries:{16:{X:10,Y:20,Z:3},4:{X:0,Y:0,Z:0}}},{Timestamp:utc(2),Entries:{16:{X:20,Y:30,Z:3}}}];
  state.apply('Position.z',zip({Position:samples}),utc(2));state.apply('Position.z',zip({Position:[samples[0]]}),utc(3));
  assert.deepEqual(state.snapshot().cars[0].points,[[base+1000,10,20,3],[base+2000,20,30,3]]);assert.equal(state.points.has(4),false);
  assert.throws(()=>state.apply('Position.z','bad compressed data',utc(4)));
});
test('live tires aggregate partial stints; pit transitions and radio/control events are upserts',()=>{
  const state=new LiveState();initial(state);
  state.apply('TimingAppData',{Lines:{16:{Stints:[{Compound:'MEDIUM',TotalLaps:5}]}}},utc(1));
  state.apply('TimingAppData',{Lines:{16:{Stints:{0:{TotalLaps:6}}}}},utc(2));assert.equal(state.snapshot().cars[0].tire.age,6);assert.equal(state.snapshot().cars[0].tire.compound,'MEDIUM');
  state.apply('TimingData',{Lines:{16:{InPit:true}}},utc(3));state.apply('TimingData',{Lines:{16:{InPit:false}}},utc(4));
  state.apply('RaceControlMessages',{Messages:{0:{Utc:utc(2),Message:'CARS 16 (LEC) AND 4 (NOR) NOTED'}}},utc(2));
  state.apply('RaceControlMessages',{Messages:{0:{Message:'CARS 16 (LEC) AND 4 (NOR) UNDER INVESTIGATION'}}},utc(5));
  state.apply('TeamRadio',{Captures:[{Utc:utc(3),RacingNumber:'16',Path:'TeamRadio/clip.mp3'}]},utc(5));
  const events=state.snapshot().events;assert.equal(events.filter(e=>e.kind==='pit').length,2);assert.equal(events.filter(e=>e.kind==='control').length,1);assert.deepEqual(events.find(e=>e.kind==='control').drivers,[16,4]);
  assert.equal(events.find(e=>e.kind==='radio').clipAvailable,true);assert.equal('sourceUrl' in events.find(e=>e.kind==='radio'),false);
});
test('session changes clear old positions, events, lap references and drivers; old session messages cannot reset the new one',()=>{
  const state=new LiveState();initial(state);state.events.set('test',{id:'test'});state.reference={points:[[1,2,3]]};
  state.apply('SessionInfo',{Key:124,Name:'Qualifying'},utc(10));assert.equal(state.snapshot().cars.length,0);assert.equal(state.snapshot().events.length,0);assert.equal(state.reference,null);
  state.apply('SessionInfo',{Key:123},utc(5));assert.equal(state.snapshot().session.key,124);
});
test('a live map waits for a complete clean observed lap, then splits recorded sectors',()=>{
  const state=new LiveState();initial(state);
  const samples=Array.from({length:161},(_,i)=>({Timestamp:utc(i),Entries:{16:{X:200+100*Math.cos(i/80*Math.PI*2),Y:200+100*Math.sin(i/80*Math.PI*2),Z:0}}}));
  state.apply('Position.z',zip({Position:samples}),utc(160));assert.equal(state.reference,null);
  state.apply('TimingData',{Lines:{16:{NumberOfLaps:5,LastLapTime:{Value:'1:20.000'}}}},utc(80));assert.equal(state.reference,null);
  state.apply('TimingData',{Lines:{16:{NumberOfLaps:6,LastLapTime:{Value:'1:20.000'},Sectors:{0:{Value:'20.000'},1:{Value:'30.000'},2:{Value:'30.000'}}}}},utc(160));
  assert.ok(state.reference);assert.equal(state.reference.lap.lap_number,6);assert.equal(state.reference.sectors.length,3);
});
test('independent live gap timestamps expire separately and are invalidated by changed rivals',()=>{
  const car={positionSince:base,retired:false,stopped:false,timing:{ahead:{unit:'seconds',value:1},leader:{unit:'seconds',value:3},aheadTime:base+1000,leaderTime:base+10000}};
  const context={position:3,aheadSince:base,leaderSince:base,connected:true};
  const result=liveTimingAt(car,base+17000,context);assert.equal(result.ahead,null);assert.equal(result.leader.value,3);
  assert.equal(liveTimingAt(car,base+12000,{...context,leaderSince:base+11000}).leader,null);
  assert.equal(liveTimingAt(car,base+12000,{...context,connected:false}).status,'inactive');
  assert.equal(liveTimingAt({...car,retired:true},base+12000,context).leader,null);
  assert.equal(liveTimingAt(car,base+500,context).ahead,null);
});
test('late messages from before a session transition do not refill the new session',()=>{
  const state=new LiveState();initial(state);state.apply('SessionInfo',{Key:124},utc(10));state.apply('DriverList',{16:{Tla:'OLD'}},utc(9));state.apply('Position.z',zip({Position:[{Timestamp:utc(9),Entries:{16:{X:10,Y:20,Z:0}}}]}),utc(9));assert.equal(state.snapshot().cars.length,0);assert.equal(state.points.size,0);
});
test('live positions preserve sub-600ms samples for buffered presentation',()=>{
 const state=new LiveState();initial(state);const samples=[0,100,200,300].map((ms,i)=>({Timestamp:new Date(base+ms).toISOString(),Entries:{16:{X:10+i,Y:20+i,Z:0}}}));state.apply('Position.z',zip({Position:samples}),utc(1));assert.equal(state.points.get(16).length,4);assert.deepEqual(state.points.get(16).map(p=>p[0]),samples.map(s=>Date.parse(s.Timestamp)));
});
