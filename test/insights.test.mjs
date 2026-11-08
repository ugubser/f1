import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tireAt,sectorsFromLap,alignCorners,messageDrivers,buildEvents,eventsAt,safeRadioUrl,referenceLap} from '../public/replay.js';
const base=Date.parse('2024-09-01T13:00:00Z');
const iso=seconds=>new Date(base+seconds*1000).toISOString();
const laps=Array.from({length:4},(_,i)=>({date_start:iso(i*90),lap_number:i+1,lap_duration:90}));
const stints=[{lap_start:1,lap_end:2,stint_number:1,compound:'MEDIUM',tyre_age_at_start:3},{lap_start:3,lap_end:4,stint_number:2,compound:'HARD',tyre_age_at_start:0}];
test('tire age counts completed laps and resets on a new stint without future leakage',()=>{
  assert.equal(tireAt(stints,laps,base-1),null);
  assert.deepEqual(tireAt(stints,laps,base),{compound:'MEDIUM',age:3,stint:1});
  assert.equal(tireAt(stints,laps,base+89999).age,3);
  assert.equal(tireAt(stints,laps,base+90000).age,4);
  assert.deepEqual(tireAt(stints,laps,base+180000),{compound:'HARD',age:0,stint:2});
  assert.equal(tireAt(stints,laps,base+360000).age,2);
  assert.equal(tireAt(stints,laps,base+900000).age,2);
  assert.equal(tireAt(stints,laps,base+90000).compound,'MEDIUM');
});
test('missing stint coverage and unknown age stay unknown',()=>{
  assert.equal(tireAt([],laps,base),null);
  assert.equal(tireAt(stints.slice(0,1),laps,base+180000),null);
  assert.equal(tireAt([{...stints[0],tyre_age_at_start:null}],laps,base).age,null);
  assert.equal(tireAt([{...stints[0],compound:null}],laps,base).compound,'UNKNOWN');
});
const points=Array.from({length:91},(_,i)=>[base+i*1000,Math.cos(i/90*2*Math.PI)*100,Math.sin(i/90*2*Math.PI)*100]);
const ref={date_start:iso(0),lap_number:2,lap_duration:90,duration_sector_1:20.5,duration_sector_2:30,duration_sector_3:39.5};
test('sector boundaries follow actual unequal timing and share interpolated endpoints',()=>{
  const sectors=sectorsFromLap(points,ref);
  assert.equal(sectors.length,3);assert.equal(sectors[0].points.at(-1)[0],base+20500);
  assert.deepEqual(sectors[0].points.at(-1),sectors[1].points[0]);
  assert.equal(sectors[1].points.at(-1)[0],base+50500);
  assert.deepEqual(sectors[1].points.at(-1),sectors[2].points[0]);
  assert.deepEqual(sectors[2].points.at(-1),points.at(-1));
});
test('sectors are unavailable when timing is missing, inconsistent or crosses a telemetry gap',()=>{
  assert.deepEqual(sectorsFromLap(points,{...ref,duration_sector_2:null}),[]);
  assert.deepEqual(sectorsFromLap(points,{...ref,duration_sector_2:50}),[]);
  assert.deepEqual(sectorsFromLap(points.filter(p=>p[0]<base+18000||p[0]>base+28000),ref),[]);
  assert.equal(referenceLap(points.filter(p=>p[0]<base+18000||p[0]>base+28000),[ref]),null);
});
test('turn markers project to the nearest segment and incompatible coordinates are rejected',()=>{
  const path=[[0,0,0],[1,100,0],[2,100,100],[3,0,100]],turns=[{number:1,x:50,y:2,name:'Test turn'}];
  const aligned=alignCorners(path,turns);assert.equal(aligned[0].x,50);assert.equal(aligned[0].y,0);assert.equal(aligned[0].name,'Test turn');
  assert.deepEqual(alignCorners(path,[{number:1,x:1000,y:2000}]),[]);
  assert.deepEqual(alignCorners(path,[{number:1,x:null,y:2}]),[]);
  assert.deepEqual(alignCorners([],turns),[]);
});
test('race control attribution handles multiple cars and never mistakes a turn or lap for a car',()=>{
  assert.deepEqual(messageDrivers('TURN 8 INCIDENT INVOLVING CARS 3 (RIC) AND 27 (HUL) UNDER INVESTIGATION',null),[3,27]);
  assert.deepEqual(messageDrivers('CAR 3 (RIC) - 5 SECOND TIME PENALTY',3),[3]);
  assert.deepEqual(messageDrivers('YELLOW IN TRACK SECTOR 11 AT TURN 8 LAP 27',null),[]);
  assert.deepEqual(messageDrivers('TRACK CLEAR',16),[16]);
});
const insights={race_control:[{date:iso(10),driver_number:null,message:'CARS 3 (RIC) AND 27 (HUL) NOTED'},{date:iso(20),message:'YELLOW FLAG'}],pit:[{date:iso(30),driver_number:16,lap_number:2,lane_duration:24.5}],team_radio:[{date:iso(50),driver_number:16,recording_url:'https://livetiming.formula1.com/static/test.mp3'}]};
test('driver notifications include track-wide messages but exclude future and other-driver events',()=>{
  const events=buildEvents(insights);
  assert.equal(eventsAt(events,base+9000).length,0);
  assert.equal(eventsAt(events,base+10000,{driver:3}).length,1);
  assert.equal(eventsAt(events,base+10000,{driver:16}).length,0);
  assert.equal(eventsAt(events,base+30000,{driver:16}).length,2);
  assert.equal(eventsAt(events,base+60000,{driver:16,kinds:['radio']}).length,1);
  assert.equal(eventsAt(events,base+60000,{driver:16,window:1000}).length,0);
  assert.equal(eventsAt(events,base+30000,{kinds:[]}).length,0);
  assert.equal(eventsAt(events,base+9000).length,0); // backward seeking
});
test('pit entry does not reveal duration until exit and absent durations remain absent',()=>{
  const events=buildEvents(insights),entry=eventsAt(events,base+30000,{kinds:['pit']});
  assert.equal(entry.length,1);assert.equal(entry[0].message,'Entered pit lane');
  assert.equal(eventsAt(events,base+54499,{kinds:['pit']}).length,1);
  assert.match(eventsAt(events,base+54500,{kinds:['pit']})[1].message,/24.5s/);
  assert.equal(buildEvents({pit:[{date:iso(30),driver_number:16,lane_duration:null}]}).length,1);
});
test('invalid event dates and unsafe radio URLs do not enter playable content',()=>{
  assert.deepEqual(buildEvents({race_control:[{date:'bad'}]}),[]);
  assert.equal(safeRadioUrl('javascript:alert(1)'),null);
  assert.equal(safeRadioUrl('https://untrusted.example/clip.mp3'),null);
  assert.equal(safeRadioUrl('https://livetiming.formula1.com/static/test.mp3'),'https://livetiming.formula1.com/static/test.mp3');
});
test('the uncompleted retirement lap retains the last set without adding tire age',()=>{
  const retired=[laps[0],{...laps[1],lap_duration:null}];
  const stint=[{...stints[0],lap_end:1}];
  assert.deepEqual(tireAt(stint,retired,base+900000),{compound:'MEDIUM',age:4,stint:1});
});
test('stationary stop time is labeled separately from time in the pit lane',()=>{
  const events=buildEvents({pit:[{date:iso(30),driver_number:16,lane_duration:22.2,stop_duration:2.1}]});
  assert.equal(events[1].message,'Left pit lane · 22.2s in lane · 2.1s stationary');
});
