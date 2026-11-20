import {test} from 'node:test';
import assert from 'node:assert/strict';
import {drsOpen,compactCarData,telemetryStore,telemetryWindow,telemetryAt,telemetryDrivers} from '../domain/telemetry.mjs';
import {HistoryService} from '../services/history.mjs';
import {ViewService} from '../services/views.mjs';
import {fixtureLoad,fixtureCircuit,fakeLive,ready,start,carData} from './fixtures.mjs';
test('DRS is decoded on the server: 10/12/14 open, every other code closed, missing stays missing',()=>{
 for(const code of [10,12,14])assert.equal(drsOpen(code),true);
 for(const code of [0,1,2,3,8,9,13])assert.equal(drsOpen(code),false);
 assert.equal(drsOpen(null),null);
});
test('car_data compacts to sorted rows, keeps missing values explicit and drops bad or duplicate timestamps',()=>{
 const rows=[{date:'2024-09-01T13:00:00.500Z',speed:300,n_gear:8,rpm:11000,throttle:100,brake:0,drs:12},{date:'2024-09-01T13:00:00.250Z',speed:290,n_gear:7,rpm:10500,throttle:99,brake:0,drs:8},{date:'bad',speed:1},{date:'2024-09-01T13:00:00.500Z',speed:1},{date:'2024-09-01T13:00:00.750Z',speed:null,n_gear:8,rpm:11100,throttle:100,brake:100}];
 const t=Date.parse('2024-09-01T13:00:00.250Z');
 assert.deepEqual(compactCarData(rows),[[t,290,7,10500,99,0,8],[t+250,300,8,11000,100,0,12],[t+500,null,8,11100,100,100,null]]);
});
test('telemetry windows are sample-and-hold ready: one predecessor, nothing after until, decoded rows',()=>{
 const store=telemetryStore(compactCarData([0,250,500,750,1000].map((ms,i)=>({date:new Date(start+ms).toISOString(),speed:200+i,n_gear:5,rpm:9000,throttle:50,brake:i===2?100:0,drs:[0,8,10,12,1][i]}))));
 assert.deepEqual(telemetryWindow(store,start+300,start+750).map(r=>r[0]-start),[250,500,750]);
 assert.deepEqual(telemetryWindow(store,start+250,start+260).map(r=>r[0]-start),[250]);
 assert.deepEqual(telemetryWindow(store,start-1000,start-1),[]);
 assert.deepEqual(telemetryWindow(store,start+500,start+500)[0],[start+500,202,5,9000,50,100,true]);
 assert.deepEqual(telemetryWindow(store,start+250,start+250)[0].slice(-1),[false]);
 assert.equal(telemetryAt(store,start+600)[0],start+500);assert.equal(telemetryAt(store,start-1),null);assert.equal(telemetryAt(store,start+7000,5000),null);
 const missing=telemetryStore([[start,null,3,null,40,0,null]]);assert.deepEqual(telemetryRowOf(missing),[start,null,3,null,40,0,null]);
});
const telemetryRowOf=store=>telemetryWindow(store,store.time[0],store.time[0])[0];
test('telemetry set is camera targets plus the selected driver, else the P1 car',()=>{
 assert.deepEqual(telemetryDrivers({cameras:[{driver:null},{driver:44},{driver:16},{driver:44}],selectedDriver:null,leader:1}),[1,16,44]);
 assert.deepEqual(telemetryDrivers({cameras:[{driver:null}],selectedDriver:81,leader:1}),[81]);
 assert.deepEqual(telemetryDrivers({cameras:[],selectedDriver:null,leader:null}),[]);
});
function setup(load=fixtureLoad()){let tick=0;const history=new HistoryService({load,loadCircuit:fixtureCircuit}),views=new ViewService({history,live:fakeLive().live,clock:()=>tick});return {views,history,advance:n=>{tick+=n;}};}
test('car_data loads after ready, sequentially, with explicit availability and missing drivers',async()=>{
 let release,blocked=0;const calls=[],base=fixtureLoad({calls}),gate=new Promise(r=>{release=r;});
 const load=async(endpoint,params)=>{if(endpoint==='car_data'){blocked++;await gate;}return base(endpoint,params);};
 const {views}=setup(load),v=views.create({source:'history',raceId:9590});try{
  const s=await ready(views,v.id);assert.equal(s.status,'ready');assert.deepEqual(s.availability.car_data,{status:'loading',completed:0,total:3,missingDrivers:[]});assert.equal(blocked,1);
  release();await v.history.telemetryTask;
  const done=await views.snapshot(v.id);assert.deepEqual(done.availability.car_data,{status:'available',completed:3,total:3,missingDrivers:[3]});
  const order=calls.filter(c=>c[0]==='car_data').map(c=>c[1].driver_number);assert.deepEqual(order,['1','2','3']);
  assert.ok(calls.findIndex(c=>c[0]==='car_data')>calls.findLastIndex(c=>c[0]==='location'));
 }finally{views.close();}
 const failed=setup(fixtureLoad({fail:['car_data']})),f=failed.views.create({source:'history',raceId:9590});try{
  await ready(failed.views,f.id);await f.history.telemetryTask;const s=await failed.views.snapshot(f.id);assert.equal(s.status,'ready');assert.equal(s.availability.car_data.status,'error');assert.deepEqual(s.availability.car_data.missingDrivers,[1,2,3]);assert.equal(JSON.stringify(s).includes('unit-private'),false);
 }finally{failed.views.close();}
 const empty=setup(fixtureLoad({empty:['car_data']})),e=empty.views.create({source:'history',raceId:9590});try{
  await ready(empty.views,e.id);await e.history.telemetryTask;assert.equal((await empty.views.snapshot(e.id)).availability.car_data.status,'empty');
 }finally{empty.views.close();}
});
test('releasing the dataset stops further car_data requests; re-acquiring resumes the remaining cars',async()=>{
 let release;const calls=[],base=fixtureLoad({calls}),gate=new Promise(r=>{release=r;});
 const load=async(endpoint,params)=>{if(endpoint==='car_data'&&params.driver_number==='1')await gate;return base(endpoint,params);};
 const {views,history}=setup(load),v=views.create({source:'history',raceId:9590});try{
  await ready(views,v.id);const d=v.history;views.remove(v.id);release();await d.telemetryTask;
  assert.deepEqual(calls.filter(c=>c[0]==='car_data').map(c=>c[1].driver_number),['1']);assert.equal(d.availability.car_data.status,'loading');
  const again=views.create({source:'history',raceId:9590});assert.equal(again.history,d);await d.telemetryTask;
  assert.deepEqual(calls.filter(c=>c[0]==='car_data').map(c=>c[1].driver_number),['1','2','3']);assert.equal((await views.snapshot(again.id)).availability.car_data.status,'available');
  history.close();
 }finally{views.close();}
});
test('coordinates carry decoded telemetry only for the HUD set; set changes force a replace without a new epoch',async()=>{
 const {views}=setup(),v=views.create({source:'history',raceId:9590});try{
  await ready(views,v.id);await v.history.telemetryTask;views.playback(v.id,{action:'seek',time:start+100000});
  let s=await views.snapshot(v.id),p=views.coordinates(v.id,s);
  assert.deepEqual(p.cars.filter(c=>c.telemetry).map(c=>c.driverNumber),[1]);
  const t=p.cars[0].telemetry;assert.ok(t[0][0]<=p.from&&t[1][0]>p.from);assert.ok(t.every(r=>r[0]<=p.until));assert.ok(t.every(r=>typeof r[6]==='boolean'&&r.length===7));
  const raw=carData.find(r=>r[0]===t[3][0]);assert.deepEqual(t[3].slice(0,6),raw.slice(0,6));assert.equal(t[3][6],[10,12,14].includes(raw[6]));
  let cursor={epoch:p.epoch,until:p.until,drivers:new Map(),telemetry:p.telemetryKey};
  assert.equal(views.coordinates(v.id,s,cursor),null);
  views.patch(v.id,{cameras:[{id:'a',mode:'onboard',driver:2},{id:'b',mode:'onboard',driver:3}]});s=await views.snapshot(v.id);
  const q=views.coordinates(v.id,s,cursor);assert.equal(q.replace,true);assert.equal(q.epoch,p.epoch);assert.deepEqual(q.cars.filter(c=>c.telemetry).map(c=>c.driverNumber),[1,2]);
  cursor={...cursor,telemetry:q.telemetryKey,until:q.until};views.patch(v.id,{selectedDriver:2});s=await views.snapshot(v.id);
  const r=views.coordinates(v.id,s,cursor);assert.equal(r.replace,true);assert.deepEqual(r.cars.filter(c=>c.telemetry).map(c=>c.driverNumber),[2]);
  views.patch(v.id,{source:'live'});s=await views.snapshot(v.id);assert.equal(s.availability.car_data.status,'unavailable');
 }finally{views.close();}
});
