import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {createReplayServer} from '../server.mjs';
import {StreamService,stateDelta} from '../services/stream.mjs';
import {fixtureLoad,fixtureCircuit,fakeLive,ready,start} from './fixtures.mjs';
const token='unit-websocket-api-token-at-least-32-characters';
async function until(predicate,ms=2500){const end=Date.now()+ms;while(Date.now()<end){if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw Error('Timed out waiting for test stream state.');}
async function setup(run,options={}){
 const f=fakeLive(),server=createReplayServer({apiToken:token,...f,load:fixtureLoad(),loadCircuit:fixtureCircuit,...options});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port, sockets=[];
 const api=async(path,body,method=body?'POST':'GET')=>{const r=await fetch(base+'/api/v1'+path,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});if(r.status===204)return null;const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value;};
 const connect=async(ticket,{ack=true}={})=>{const ws=new WebSocket(base.replace('http:','ws:')+'/api/v1/socket');sockets.push(ws);ws.on('error',()=>{});const messages=[];ws.on('message',bytes=>{const m=JSON.parse(bytes.toString());messages.push(m);if(ack&&m.sequence)ws.send(JSON.stringify({type:'ack',sequence:m.sequence}));});await once(ws,'open');if(ticket)ws.send(JSON.stringify({type:'auth',ticket}));return {ws,messages};};
 try{await run({server,base,api,connect,...f});}finally{for(const ws of sockets)ws.terminate();server.shutdown();await new Promise(r=>server.close(r));}
}
test('tickets are single-use, expire, and have bounded issuance',()=>{
 let time=1000;const views={get:()=>({})},streams=new StreamService({views,now:()=>time,ticketMs:10});try{const a=streams.issue('view-a');assert.equal(a.url,'/api/v1/socket');assert.equal(streams.consume(a.ticket),'view-a');assert.equal(streams.consume(a.ticket),null);const b=streams.issue('view-b');time+=11;assert.equal(streams.consume(b.ticket),null);for(let i=0;i<128;i++)streams.issue('view');assert.throws(()=>streams.issue('view'),/Too many/);}finally{streams.close();}
});
test('REST bearer protection issues a ticket; no application data is sent before socket authentication',async()=>{
 await setup(async({api,connect,base})=>{
  const v=await api('/views',{source:'history',raceId:9590});const unauthorized=await fetch(base+'/api/v1/views/'+v.id+'/stream-ticket',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(unauthorized.status,401);
  const s=await connect();await new Promise(r=>setTimeout(r,30));assert.equal(s.messages.length,0);const t=await api('/views/'+v.id+'/stream-ticket',{});s.ws.send(JSON.stringify({type:'auth',ticket:t.ticket}));await until(()=>s.messages.some(m=>m.type==='snapshot'));const snap=s.messages.find(m=>m.type==='snapshot');assert.equal(snap.state.id,v.id);assert.equal(JSON.stringify(s.messages).includes(token),false);assert.equal(JSON.stringify(s.messages).includes(t.ticket),false);
  const reused=await connect(t.ticket);const [code]=await once(reused.ws,'close');assert.equal(code,4401);
 });
});
test('socket rejects invalid tickets, unauthenticated timeout, credentials in URL and foreign origins',async()=>{
 await setup(async({connect,base})=>{
  const invalid=await connect('not-a-ticket');assert.equal((await once(invalid.ws,'close'))[0],4401);
  const idle=await connect();assert.equal((await once(idle.ws,'close'))[0],4401);
  for(const options of [{url:base.replace('http:','ws:')+'/api/v1/socket?token=unit-secret'},{url:base.replace('http:','ws:')+'/api/v1/socket',headers:{Origin:'https://foreign.invalid'}}]){
   const ws=new WebSocket(options.url,{headers:options.headers});ws.on('error',()=>{});const code=await new Promise(resolve=>ws.on('unexpected-response',(_req,res)=>{res.resume();resolve(res.statusCode);ws.terminate();}));assert.equal(code,403);
  }
 },{streamOptions:{authMs:50}});
});
test('replay delivers buffered samples and deltas; REST seek/speed invalidates old coordinate epochs',async()=>{
 await setup(async({api,connect,server})=>{
  const v=await api('/views',{source:'history',raceId:9590});await ready(server.services.views,v.id);const t=await api('/views/'+v.id+'/stream-ticket',{}),s=await connect(t.ticket);await until(()=>s.messages.some(m=>m.type==='coordinates'&&m.cars.length));
  const first=s.messages.find(m=>m.type==='coordinates');assert.equal(first.replace,true);assert.ok(first.cars[0].points.length>2);
  const seek=await api('/views/'+v.id+'/playback',{action:'seek',time:start+60000});await until(()=>s.messages.some(m=>m.type==='coordinates'&&m.epoch===seek.motionEpoch));assert.notEqual(first.epoch,seek.motionEpoch);
  await api('/views/'+v.id,{selectedDriver:2},'PATCH');await until(()=>s.messages.some(m=>m.type==='state'&&m.changes.settings?.selectedDriver===2));
  const speed=await api('/views/'+v.id+'/playback',{action:'speed',speed:60});await api('/views/'+v.id+'/playback',{action:'play'});await until(()=>s.messages.some(m=>m.type==='snapshot'&&m.state.playback.speed===60));
  assert.notEqual(speed.motionEpoch,seek.motionEpoch);assert.ok(s.messages.every((m,i)=>m.sequence===i+1));
  await api('/views/'+v.id,undefined,'DELETE');await until(()=>s.messages.some(m=>m.type==='error'&&m.code==='VIEW_NOT_FOUND'));
 });
});
test('backpressure closes unacknowledged consumers for explicit resynchronization',async()=>{
 await setup(async({api,connect,server})=>{
  const v=await api('/views',{source:'history',raceId:9590});await ready(server.services.views,v.id);const t=await api('/views/'+v.id+'/stream-ticket',{}),s=await connect(t.ticket,{ack:false});const closed=once(s.ws,'close');await until(()=>s.messages.length>=2);
  await api('/views/'+v.id+'/playback',{action:'seek',time:start+10000});assert.equal((await closed)[0],1013);
 },{streamOptions:{maxUnacked:2}});
});
test('live stream retains actual samples and appends them without repeatedly sending driver metadata',async()=>{
 const time=Date.now(),live=fakeLive().live;live.generation=1;live.connection={state:'streaming'};live.store={revision:1,points:new Map([[2,[[time-400,10,20,0],[time-200,20,30,0]]]])};
 live.snapshot=async()=>({auth:{signedIn:true},connection:{state:'streaming',message:'Fixture live'},session:{key:55,circuit:'Fixture',name:'Race',start:null},updatedAt:Date.now(),sessionStatus:'Started',trackStatus:null,reference:null,lapCount:{CurrentLap:4,TotalLaps:50},events:[],cars:[{driver_number:2,full_name:'Fixture',name_acronym:'FIX',team_name:'Fixture',team_colour:'aabbcc',position:1,positionSince:time-10000,lap:4,tire:{compound:'HARD',age:3,stint:1},points:live.store.points.get(2),timing:{}}]});
 await setup(async({api,connect})=>{
  const v=await api('/views',{source:'live'}),t=await api('/views/'+v.id+'/stream-ticket',{}),s=await connect(t.ticket);await until(()=>s.messages.some(m=>m.type==='coordinates'));
  live.store.points.get(2).push([time-100,30,40,0]);live.store.revision++;await until(()=>s.messages.filter(m=>m.type==='coordinates').length===2);
  const packet=s.messages.filter(m=>m.type==='coordinates')[1];assert.equal(packet.replace,false);assert.deepEqual(packet.cars[0].points,[[time-100,30,40,0]]);assert.equal(s.messages.filter(m=>m.type==='snapshot').length,1);
 },{live});
});
test('state delta keeps notifications and updates changed car fields without resending unchanged geometry',()=>{
 const car={driverNumber:1,name:'Driver',lap:1,location:{x:1,y:2}},previous={motionEpoch:'a',playback:{time:1},cars:[car],events:{items:[]},geometryRevision:'one'};
 const next={...previous,playback:{time:2},cars:[{...car,lap:2,location:{x:2,y:3}}],events:{items:[{id:'control-1',message:'Penalty'}]}};
 const delta=stateDelta(previous,next);assert.deepEqual(delta.cars.upsert,[{driverNumber:1,lap:2}]);assert.ok(delta.changes.events);assert.equal('playback' in delta.changes,false);assert.equal('geometryRevision' in delta.changes,false);
});
test('stream state errors are sanitized and deleted-view tickets cannot open stale data',async()=>{
 await setup(async({api,connect,server,live})=>{
  const v=server.services.views.create({source:'live'}),t=await api('/views/'+v.id+'/stream-ticket',{});live.snapshot=async()=>{throw Error('unit-private-upstream');};const s=await connect(t.ticket);await until(()=>s.messages.some(m=>m.type==='error'));assert.equal(s.messages[0].code,'STATE_UNAVAILABLE');assert.equal(JSON.stringify(s.messages).includes('unit-private'),false);
  const other=server.services.views.create({source:'history'}),expired=await api('/views/'+other.id+'/stream-ticket',{});server.services.views.remove(other.id);const socket=await connect(expired.ticket);assert.equal((await once(socket.ws,'close'))[0],4404);assert.equal(socket.messages.length,0);
 });
});
test('browser transport consumes the actual ticket/ACK protocol and keeps control calls on REST',async()=>{
 const {APIClient}=await import('../public/api-client.js');
 await setup(async({base,api,server})=>{
  const v=await api('/views',{source:'history',raceId:9590});await ready(server.services.views,v.id);
  const originalFetch=globalThis.fetch,originalLocation=globalThis.location;globalThis.fetch=(url,options)=>originalFetch(new URL(url,base),options);globalThis.location={href:base+'/'};
  try{
   const client=new APIClient(token,{WebSocketImpl:WebSocket}),abort=new AbortController(),states=[],coordinates=[];
   const streaming=client.stream(v.id,{onState:s=>states.push(s),onCoordinates:p=>coordinates.push(p),onClock:()=>{}},{signal:abort.signal});
   await until(()=>coordinates.length>0);assert.equal(states[0].id,v.id);const result=await client.request('/views/'+v.id+'/playback',{method:'POST',body:{action:'speed',speed:60}});await until(()=>states.some(s=>s.motionEpoch===result.motionEpoch));assert.equal(states.at(-1).playback.speed,60);abort.abort();await streaming;
  }finally{globalThis.fetch=originalFetch;if(originalLocation===undefined)delete globalThis.location;else globalThis.location=originalLocation;}
 });
});
test('reconnecting the same view starts with fresh geometry, current clock and replacement coordinates',async()=>{
 await setup(async({api,connect,server})=>{
  const v=await api('/views',{source:'history',raceId:9590});await ready(server.services.views,v.id);await api('/views/'+v.id+'/playback',{action:'play'});
  const first=await connect((await api('/views/'+v.id+'/stream-ticket',{})).ticket);await until(()=>first.messages.some(m=>m.type==='coordinates'));const initial=first.messages.find(m=>m.type==='snapshot').state;
  const closed=once(first.ws,'close');first.ws.close(1012,'Test reconnect');await closed;
  const second=await connect((await api('/views/'+v.id+'/stream-ticket',{})).ticket);await until(()=>second.messages.some(m=>m.type==='coordinates'));
  const snapshot=second.messages.find(m=>m.type==='snapshot'),coordinates=second.messages.find(m=>m.type==='coordinates');assert.equal(snapshot.sequence,1);assert.equal(snapshot.state.motionEpoch,initial.motionEpoch);assert.ok(snapshot.state.sequence>initial.sequence);assert.ok(snapshot.state.playback.time>initial.playback.time);assert.ok(snapshot.state.geometry);assert.equal(coordinates.replace,true);
 });
});
