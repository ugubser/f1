import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HistoryService} from '../services/history.mjs';
import {ViewService} from '../services/views.mjs';
import {fixtureLoad,fixtureCircuit,fakeLive,ready,start} from './fixtures.mjs';
function setup(){let tick=0;const {live}=fakeLive(),history=new HistoryService({load:fixtureLoad(),loadCircuit:fixtureCircuit}),views=new ViewService({history,live,clock:()=>tick});return {views,history,advance:n=>{tick+=n;}};}
test('replay views share data but have independent server-owned clocks, selections and filters',async()=>{
 const {views,history,advance}=setup(),a=views.create({source:'history',raceId:9590}),b=views.create({source:'history',raceId:9590});
 try{
  await ready(views,a.id);assert.equal(history.datasets.size,1);assert.equal(a.history,b.history);
  views.playback(a.id,{action:'seek',time:start+100000});views.playback(a.id,{action:'play'});advance(1000);
  assert.equal((await views.snapshot(a.id)).playback.time,start+110000);assert.equal((await views.snapshot(b.id)).playback.time,start);
  views.patch(a.id,{selectedDriver:2,notifications:['control'],overlays:{names:true}});
  const s=await views.snapshot(a.id);assert.equal(s.settings.selectedDriver,2);assert.equal((await views.snapshot(b.id)).settings.selectedDriver,null);assert.equal(s.events.total,2);assert.ok(s.events.items.every(e=>e.kind==='control'));
  views.playback(a.id,{action:'pause'});advance(1000);assert.equal((await views.snapshot(a.id)).playback.time,start+110000);
 }finally{views.close();}
});
test('API-ready frames calculate tires, gaps, positions, circuit sectors, turns and notifications',async()=>{
 const {views}=setup(),v=views.create({source:'history',raceId:9590});try{
  await ready(views,v.id);views.playback(v.id,{action:'seek',time:start+100000});const s=await views.snapshot(v.id);
  assert.equal(s.cars[1].timing.ahead.value,1.5);assert.equal(s.cars[2].timing.leader.value,3);assert.equal(s.cars[1].tire.compound,'HARD');assert.equal(s.cars[1].tire.age,1);assert.ok(s.cars[1].location);assert.equal(s.cars[1].hasNotification,true);assert.equal(s.geometry.sectors.length,3);assert.equal(s.geometry.corners[0].name,'Fixture bend');
  assert.ok(s.events.items.find(e=>e.kind==='radio').clipId);assert.equal(JSON.stringify(s.events).includes('https://'),false);
  views.playback(v.id,{action:'seek',time:start});const before=await views.snapshot(v.id);assert.equal(before.events.total,0);assert.equal(before.cars[1].timing.ahead,null);
 }finally{views.close();}
});
test('switching source preserves paused historical position and does not disconnect shared live feed',async()=>{
 const {views,advance}=setup(),v=views.create({source:'history',raceId:9590});try{
  await ready(views,v.id);views.playback(v.id,{action:'seek',time:start+100000});views.playback(v.id,{action:'play'});advance(1000);views.patch(v.id,{source:'live'});advance(1000);views.patch(v.id,{source:'history'});
  const s=await views.snapshot(v.id);assert.equal(s.playback.time,start+110000);assert.equal(s.playback.playing,false);
 }finally{views.close();}
});
test('invalid patch is atomic; seek bounds, speed and unsupported live playback are explicit',async()=>{
 const {views}=setup(),v=views.create({source:'history',raceId:9590});try{
  await ready(views,v.id);assert.throws(()=>views.patch(v.id,{source:'live',overlays:{names:'yes'}}),/booleans/);assert.equal(v.source,'history');assert.throws(()=>views.playback(v.id,{action:'seek',time:start-1}),/inside this race/);assert.throws(()=>views.playback(v.id,{action:'speed',speed:1000}),/speed/);views.patch(v.id,{source:'live'});assert.throws(()=>views.playback(v.id,{action:'play'}),/historical/);
 }finally{views.close();}
});
test('radio commands use view-visible clips and pause only that replay',async()=>{
 const {views}=setup(),v=views.create({source:'history',raceId:9590}),b=views.create({source:'history',raceId:9590});try{
  await ready(views,v.id);views.playback(v.id,{action:'seek',time:start+100000});const s=await views.snapshot(v.id),clip=s.events.items.find(e=>e.kind==='radio').clipId;
  await assert.rejects(views.radio(b.id,{action:'play',clipId:clip}),/not available/);views.playback(v.id,{action:'play'});await views.radio(v.id,{action:'play',clipId:clip});assert.equal(v.playing,false);assert.equal(v.radio.clipId,clip);await views.radio(v.id,{action:'seek',time:2});assert.equal(v.radio.time,2);await views.radio(v.id,{action:'pause'});assert.equal(v.radio.playing,false);await views.radio(v.id,{action:'stop'});assert.equal(v.radio,null);
 }finally{views.close();}
});
test('loading cancellation, view bounds and restart/expiry errors do not start background collection',async()=>{
 const {views}=setup(),v=views.create({source:'history',raceId:9590});views.remove(v.id);assert.equal(v.history.cancelled,true);assert.throws(()=>views.get(v.id),/expired/);views.close();
 let now=0;const other=new ViewService({live:fakeLive().live,now:()=>now,idleMs:100,maxViews:1});other.create({source:'live'});assert.throws(()=>other.create({source:'live'}),/unused view/);now=101;assert.doesNotThrow(()=>other.create({source:'live'}));other.close();
});
test('partial optional source failures remain explicit without replacing the data source',async()=>{
 const history=new HistoryService({load:fixtureLoad({fail:['intervals','race_control']}),loadCircuit:async()=>{throw Error('unit-private-error');}}),views=new ViewService({history,live:fakeLive().live}),v=views.create({source:'history',raceId:9590});try{
  const s=await ready(views,v.id);assert.equal(s.status,'ready');assert.equal(s.availability.intervals.status,'error');assert.equal(s.availability.circuit.status,'error');assert.equal(JSON.stringify(s).includes('unit-private'),false);
 }finally{views.close();}
});
test('a source change during an asynchronous live read cannot return a mixed historical/live frame',async()=>{
 const f=fakeLive(),original=f.live.snapshot;let release;f.live.snapshot=()=>new Promise(r=>{release=async()=>r(await original());});const views=new ViewService({live:f.live}),v=views.create({source:'live'});
 try{const pending=views.snapshot(v.id);views.patch(v.id,{source:'history'});await release();const s=await pending;assert.equal(s.source,'history');assert.equal(s.liveStatus,null);assert.equal(s.status,'empty');}finally{views.close();}
});
test('older paginated radio clips remain playable even when outside the initial 80 events',async()=>{
 const {views}=setup(),v=views.create({source:'history',raceId:9590});try{
  await ready(views,v.id);const clip=v.history.events.find(e=>e.kind==='radio');v.history.events.push(...Array.from({length:100},(_,i)=>({id:'extra-'+i,time:start+100001+i,kind:'control',drivers:[],message:'Fixture message'})));
  views.playback(v.id,{action:'seek',time:start+110000});const s=await views.snapshot(v.id);assert.equal(s.events.items.some(e=>e.clipId===clip.clipId),false);await views.radio(v.id,{action:'play',clipId:clip.clipId});assert.equal(v.radio.clipId,clip.clipId);
 }finally{views.close();}
});
test('live frames normalize radio IDs, gaps and stale locations without browser calculations',async()=>{
 const f=fakeLive(),time=Date.now();f.live.snapshot=async()=>({auth:{signedIn:true},connection:{state:'stale',message:'Source stale'},session:{key:55,circuit:'Fixture',name:'Race'},updatedAt:time-40000,sessionStatus:'Started',trackStatus:null,reference:null,lapCount:{CurrentLap:4,TotalLaps:50},events:[{id:'radio-1',time:time-1000,kind:'radio',drivers:[2],message:'Team radio clip',clipAvailable:true}],cars:[{driver_number:2,full_name:'Fixture Driver',name_acronym:'FDR',team_name:'Fixture',team_colour:'aabbcc',position:1,positionSince:time-40000,lap:4,tire:{compound:'HARD',age:3,stint:1},points:[[time-1000,10,20]],timing:{}}]});
 const views=new ViewService({live:f.live,now:()=>time}),v=views.create({source:'live'});try{const s=await views.snapshot(v.id);assert.equal(s.cars[0].location,null);assert.equal(s.cars[0].timing.status,'inactive');assert.equal(s.lap,4);assert.ok(s.events.items[0].clipId);assert.equal('clipAvailable' in s.events.items[0],false);assert.equal(s.geometry,null);}finally{views.close();}
});
