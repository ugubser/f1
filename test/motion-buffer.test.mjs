import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MotionBuffer} from '../public/motion-buffer.js';
import {ViewService} from '../services/views.mjs';
import {HistoryService} from '../services/history.mjs';
import {positionAt} from '../domain/replay.mjs';
import {fixtureLoad,fixtureCircuit,fakeLive,ready,start} from './fixtures.mjs';
for(const speed of [1,10,60])test(`buffered replay at ${speed}x renders every 60 Hz frame between actual samples`,async()=>{
 let elapsed=0;const wall=Date.now(),history=new HistoryService({load:fixtureLoad(),loadCircuit:fixtureCircuit}),views=new ViewService({history,live:fakeLive().live,clock:()=>elapsed,now:()=>wall+elapsed}),buffer=new MotionBuffer({now:()=>elapsed,wall:()=>wall+elapsed});
 const v=views.create({source:'history',raceId:9590});try{
  await ready(views,v.id);views.playback(v.id,{action:'speed',speed});views.playback(v.id,{action:'play'});let snapshot=await views.snapshot(v.id),cursor=null,frames=0;
  buffer.state(snapshot);
  for(let frame=0;frame<=90;frame++){
   elapsed=frame*1000/60;
   if(frame%3===0){snapshot=await views.snapshot(v.id);buffer.state(snapshot);const packet=views.coordinates(v.id,snapshot,cursor);if(packet){buffer.coordinates(packet);cursor={epoch:packet.epoch,until:packet.until,drivers:new Map()};}}
   const sample=buffer.time(),expected=positionAt(v.history.points.get(1),start+elapsed*speed),actual=buffer.location(1);
   assert.equal(sample.buffering,false);assert.ok(Math.abs(sample.time-(start+elapsed*speed))<.001);assert.ok(Math.abs(actual.x-expected.x)<1e-6);assert.ok(Math.abs(actual.y-expected.y)<1e-6);frames++;
  }
  assert.equal(frames,91);assert.ok(buffer.receivedPackets<=3,'position data should arrive as chunks, not a message per frame');
 }finally{views.close();}
});
test('seek/speed epoch changes discard buffered samples and reject old in-flight packets',()=>{
 let now=0;const buffer=new MotionBuffer({now:()=>now,wall:()=>1000});const state={motionEpoch:'first',source:'history',serverTime:1000,playback:{time:0,start:0,end:10000,playing:true,speed:1}};buffer.state(state);buffer.coordinates({epoch:'first',replace:true,from:0,until:5000,latest:5000,cars:[{driverNumber:1,points:[[0,0,0],[5000,100,100]]}]});now=1000;assert.equal(buffer.location(1).x,20);
 buffer.state({...state,motionEpoch:'second',serverTime:2000,playback:{...state.playback,time:7000}});assert.equal(buffer.location(1),null);assert.equal(buffer.coordinates({epoch:'first',replace:true,cars:[]}),false);assert.equal(buffer.points.size,0);
});
test('buffer underrun stops at supplied coverage and long source gaps never become invented movement',()=>{
 let now=0;const buffer=new MotionBuffer({now:()=>now,wall:()=>1000});buffer.state({motionEpoch:'a',source:'history',serverTime:1000,playback:{time:0,start:0,end:30000,playing:true,speed:1}});buffer.coordinates({epoch:'a',replace:true,from:0,until:20000,latest:20000,cars:[{driverNumber:1,points:[[0,10,10],[20000,200,200]]}]});now=10000;assert.equal(buffer.location(1),null);now=25000;assert.equal(buffer.time().time,20000);assert.equal(buffer.time().buffering,true);buffer.reset();assert.equal(buffer.location(1),null);
});
test('live buffer uses real samples at source pace and never extrapolates beyond its latest sample',()=>{
 let now=0;const buffer=new MotionBuffer({now:()=>now,wall:()=>10000,liveDelay:100});buffer.state({motionEpoch:'live',source:'live',serverTime:10000,playback:{time:10000}});buffer.coordinates({epoch:'live',replace:true,from:null,until:null,latest:10000,cars:[{driverNumber:2,points:[[9800,10,20],[10000,30,40]]}]});assert.equal(buffer.location(2).x,20);now=50;assert.equal(buffer.location(2).x,25);now=500;assert.equal(buffer.time().time,10000);assert.equal(buffer.location(2).x,30);now=2500;assert.equal(buffer.location(2).stale,true);now=6000;assert.equal(buffer.location(2),null);
});
const replayBuffer=(cars,{until=100000,time=0}={})=>{let now=0;const buffer=new MotionBuffer({now:()=>now,wall:()=>1000});buffer.state({motionEpoch:'p',source:'history',serverTime:1000,playback:{time,start:0,end:200000,playing:true,speed:1}});buffer.coordinates({epoch:'p',replace:true,from:0,until,latest:until,cars});return {buffer,set:t=>{now=t;}};};
test('location carries interpolated z and stays null-safe for samples without z',()=>{
 const {buffer,set}=replayBuffer([{driverNumber:1,points:[[0,0,0,100],[1000,10,0,120]]},{driverNumber:2,points:[[0,0,0],[1000,10,0]]}]);set(250);
 assert.equal(buffer.location(1).z,105);assert.equal(buffer.location(2).z,null);assert.equal(buffer.pose(2).heading,0);
});
test('pose heading follows supplied samples, wraps cleanly and never looks beyond buffered samples or long gaps',()=>{
 // A car going round a circle anticlockwise at 240 ms sampling: heading is the tangent direction (angle + 90°).
 const points=[];for(let k=0;k<=100;k++){const a=k*0.1;points.push([k*240,1000*Math.cos(a),1000*Math.sin(a),5]);}
 const {buffer,set}=replayBuffer([{driverNumber:7,points}],{until:24000});
 let previous=null;
 for(let t=480;t<=23000;t+=37){set(t);const pose=buffer.pose(7),angle=Math.atan2(pose.y,pose.x),expected=Math.atan2(Math.sin(angle+Math.PI/2),Math.cos(angle+Math.PI/2));
  assert.ok(Math.abs(Math.atan2(Math.sin(pose.heading-expected),Math.cos(pose.heading-expected)))<0.02,`heading at ${t}`);assert.ok(pose.heading>=-Math.PI&&pose.heading<=Math.PI);
  if(previous!==null)assert.ok(Math.abs(Math.atan2(Math.sin(pose.heading-previous),Math.cos(pose.heading-previous)))<0.05,'heading is continuous across ±π');previous=pose.heading;assert.equal(pose.pitch,0);}
 // At the end of the buffer the window is clamped to the last supplied sample: heading still comes only from real samples.
 set(24000);const end=buffer.pose(7);assert.ok(Number.isFinite(end.heading));
 // Gap longer than maxGap: samples on the far side are never used for direction.
 const gap=replayBuffer([{driverNumber:3,points:[[0,0,0,0],[200,10,0,0],[400,20,0,0],[6000,20,500,0]]}]);gap.set(400);assert.equal(gap.buffer.pose(3).heading,0);
 // A stationary car has no measurable heading; it is reported as null rather than guessed.
 const still=replayBuffer([{driverNumber:4,points:[[0,5,5,0],[240,5,5,0],[480,5,5,0]]}]);still.set(240);assert.equal(still.buffer.pose(4).heading,null);assert.equal(still.buffer.pose(9),null);
});
test('pose pitch follows supplied elevation',()=>{const {buffer,set}=replayBuffer([{driverNumber:1,points:[[0,0,0,0],[1000,100,0,10],[2000,200,0,20]]}]);set(1000);assert.ok(Math.abs(buffer.pose(1).pitch-Math.atan2(10,100))<1e-9);});
test('telemetry is sample-and-hold: latest row at or before presentation time, never interpolated or future, null after maxGap',()=>{
 const {buffer,set}=replayBuffer([{driverNumber:16,points:[[0,0,0,0]],telemetry:[[0,250,7,11000,100,0,1],[240,260,8,11500,100,0,1],[480,120,3,9000,0,100,0]]}]);
 set(0);assert.deepEqual(buffer.telemetry(16),{time:0,speed:250,gear:7,rpm:11000,throttle:100,brake:0,drs:1,stale:false});
 set(470);assert.equal(buffer.telemetry(16).speed,260);set(480);assert.equal(buffer.telemetry(16).gear,3);
 set(3000);assert.equal(buffer.telemetry(16).stale,true);set(5600);assert.equal(buffer.telemetry(16),null);assert.equal(buffer.telemetry(44),null);
 // Merge by timestamp with later packets; epoch change clears telemetry; invalid rows are rejected.
 buffer.coordinates({epoch:'p',replace:false,from:0,until:100000,latest:100000,cars:[{driverNumber:16,points:[],telemetry:[[5500,300,8,12000,100,0,null]]}]});assert.equal(buffer.telemetry(16).speed,300);assert.equal(buffer.telemetry(16).drs,null);
 assert.throws(()=>buffer.coordinates({epoch:'p',replace:false,from:0,until:100000,latest:100000,cars:[{driverNumber:16,telemetry:[[null,1,1,1,1,1,1]]}]}),/Invalid telemetry/);
 buffer.state({motionEpoch:'q',source:'history',serverTime:1000,playback:{time:0,start:0,end:200000,playing:false,speed:1}});assert.equal(buffer.telemetry(16),null);assert.equal(buffer.telemetryRows.size,0);
});
test('telemetry before the first row is null (no backfilled values)',()=>{const {buffer,set}=replayBuffer([{driverNumber:1,points:[[0,0,0,0]],telemetry:[[500,100,3,8000,50,0,0]]}]);set(100);assert.equal(buffer.telemetry(1),null);});
