import {test} from 'node:test';
import {WebSocket} from 'ws';
import assert from 'node:assert/strict';
import {openapi} from '../openapi.mjs';
import {createReplayServer} from '../server.mjs';
import {fixtureLoad,fixtureCircuit,fakeLive,ready,start} from './fixtures.mjs';
const schemas=openapi.components.schemas;
// Validate the JSON Schema vocabulary actually used by the public contract.
function check(value,s,path='$'){
 if(s.$ref)return check(value,schemas[s.$ref.split('/').at(-1)],path);
 if(s.oneOf){const matches=s.oneOf.filter(choice=>{try{check(value,choice,path);return true;}catch{return false;}});assert.equal(matches.length,1,path+' oneOf mismatch');return;}
 if(s.const!==undefined)assert.deepEqual(value,s.const,path+' const');
 if(s.enum)assert.ok(s.enum.includes(value),path+' enum');
 const type=value===null?'null':Array.isArray(value)?'array':typeof value==='number'&&Number.isInteger(value)?'integer':typeof value;
 if(s.type){const types=Array.isArray(s.type)?s.type:[s.type];assert.ok(types.includes(type)||type==='integer'&&types.includes('number'),path+' type '+type);}
 if(value===null)return;
 if(typeof value==='number'){assert.ok(Number.isFinite(value),path+' finite');if(s.minimum!==undefined)assert.ok(value>=s.minimum,path+' minimum');if(s.maximum!==undefined)assert.ok(value<=s.maximum,path+' maximum');}
 if(typeof value==='string'){if(s.minLength!==undefined)assert.ok(value.length>=s.minLength,path+' minLength');if(s.maxLength!==undefined)assert.ok(value.length<=s.maxLength,path+' maxLength');}
 if(Array.isArray(value)){if(s.minItems!==undefined)assert.ok(value.length>=s.minItems,path+' minItems');if(s.maxItems!==undefined)assert.ok(value.length<=s.maxItems,path+' maxItems');for(let i=0;i<value.length;i++){const sub=s.prefixItems?.[i]||s.items;if(sub)check(value[i],sub,path+'['+i+']');}}
 else if(typeof value==='object'){for(const key of s.required||[])assert.ok(Object.hasOwn(value,key),path+' missing '+key);for(const [key,child]of Object.entries(value)){if(s.properties?.[key])check(child,s.properties[key],path+'.'+key);else{assert.notEqual(s.additionalProperties,false,path+' extra '+key);if(s.additionalProperties&&typeof s.additionalProperties==='object')check(child,s.additionalProperties,path+'.'+key);}}}
}

test('real HTTP response bodies conform to the OpenAPI schemas used by native clients',async()=>{
 const token='unit-contract-api-token-at-least-32-characters',f=fakeLive();
 const server=createReplayServer({apiToken:token,...f,load:fixtureLoad(),loadCircuit:fixtureCircuit,login:async()=>({value:'private-fixture',expiresAt:Date.now()+3600000})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port+'/api/v1';
 async function request(path,schema,body,method=body?'POST':'GET'){
  const r=await fetch(base+path,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));check(data,schemas[schema]);return data;
 }
 try{
  await request('/system','System');await request('/races?year=2024','Races');await request('/f1/auth','Auth');await request('/live','Live');
  const v=await request('/views','View',{source:'history',raceId:9590});await ready(server.services.views,v.id);await request('/views/'+v.id,'View');
  const s=await request('/views/'+v.id+'/playback','View',{action:'seek',time:start+100000});await request('/views/'+v.id+'/events','Events');
  await request('/views/'+v.id+'/radio','View',{action:'play',clipId:s.events.items.find(e=>e.kind==='radio').clipId});
  await request('/views/'+v.id,'View',{source:'live'},'PATCH');await request('/f1/auth/login','Auth',{email:'a',password:'fixture-password'});await request('/live/connect','Live',{});await request('/views/'+v.id,'View');await request('/f1/auth/logout','Auth',{});
 }finally{server.shutdown();await new Promise(r=>server.close(r));}
});

test('WebSocket wire snapshots, deltas, coordinates and clock replies conform to native message schemas',async()=>{
 const token='unit-contract-stream-token-at-least-32-characters',server=createReplayServer({apiToken:token,...fakeLive(),load:fixtureLoad(),loadCircuit:fixtureCircuit});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;let ws;
 try{
  const v=server.services.views.create({source:'history',raceId:9590});await ready(server.services.views,v.id);
  const response=await fetch(base+'/api/v1/views/'+v.id+'/stream-ticket',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'});const ticket=await response.json();check(ticket,schemas.StreamTicket);
  const seen=new Set(),errors=[];ws=new WebSocket(base.replace('http:','ws:')+ticket.url);ws.on('error',()=>{});
  ws.on('message',raw=>{const m=JSON.parse(raw);try{check(m,schemas[{snapshot:'SnapshotMessage',state:'StateMessage',coordinates:'Coordinates',pong:'StreamPong',error:'StreamError'}[m.type]]);seen.add(m.type);}catch(e){errors.push(e);}if(m.sequence)ws.send(JSON.stringify({type:'ack',sequence:m.sequence}));});
  ws.on('open',()=>{ws.send(JSON.stringify({type:'auth',ticket:ticket.ticket}));ws.send(JSON.stringify({type:'ping',sentAt:1}));});
  for(let i=0;i<100&&!seen.has('coordinates');i++)await new Promise(r=>setTimeout(r,5));
  server.services.views.patch(v.id,{selectedDriver:2});for(let i=0;i<100&&!seen.has('state');i++)await new Promise(r=>setTimeout(r,5));
  if(errors.length)throw errors[0];for(const type of ['snapshot','coordinates','state','pong'])assert.ok(seen.has(type),type);
 }finally{ws?.terminate();server.shutdown();await new Promise(r=>server.close(r));}
});
