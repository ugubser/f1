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
