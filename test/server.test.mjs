import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createReplayServer,f1LoginTransportAllowed} from '../server.mjs';
import {fixtureLoad,fixtureCircuit,fakeLive,ready,start} from './fixtures.mjs';
const token='unit-test-api-access-token-at-least-32-characters';
test('remote F1 password login requires TLS or an explicit trusted-network exception; forwarded headers grant no trust',()=>{
 const remote={socket:{remoteAddress:'192.168.10.23'},headers:{'x-forwarded-proto':'https','x-forwarded-for':'127.0.0.1'}};
 assert.equal(f1LoginTransportAllowed(remote),false);
 assert.equal(f1LoginTransportAllowed(remote,false),false);
 assert.equal(f1LoginTransportAllowed(remote,'1'),false);
 assert.equal(f1LoginTransportAllowed(remote,true),true);
 assert.equal(f1LoginTransportAllowed({...remote,socket:{...remote.socket,encrypted:true}}),true);
 for(const remoteAddress of ['127.0.0.1','::1','::ffff:127.0.0.1'])assert.equal(f1LoginTransportAllowed({socket:{remoteAddress}}),true);
});
async function withServer(run,options={}){
 const f=fakeLive(),server=createReplayServer({apiToken:token,load:fixtureLoad(),loadCircuit:fixtureCircuit,...f,...options});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const request=(route,{method='GET',body,headers={},signal}={})=>fetch(base+'/api/v1'+route,{method,headers:{Authorization:'Bearer '+token,...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal});
 try{await run({server,base,request,...f});}finally{server.shutdown();await new Promise(r=>server.close(r));}
}
test('public UI bootstrap exposes only its configured application token; raw env and application APIs stay protected',async()=>{
 await withServer(async({base})=>{
  const r=await fetch(base+'/ui-config.json');assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('access-control-allow-origin'),null);
  assert.deepEqual(await r.json(),{apiToken:token});
  for(const file of ['/.env','/.env.example','/public/.env','/ui-config.mjs'])assert.equal((await fetch(base+file)).status,404);
  assert.equal((await fetch(base+'/api/v1/system')).status,401);
  assert.equal((await fetch(base+'/ui-config.json',{method:'POST'})).status,405);
  const html=await(await fetch(base+'/')).text();assert.equal(html.includes('id="api-token"'),false);assert.equal(html.includes(token),false);
 },{uiConfig:{apiToken:token,subscriptionToken:'must-never-be-published'}});
 await withServer(async({base})=>{assert.equal((await fetch(base+'/ui-config.json')).status,503);});
});
test('bearer auth protects every API, including legacy paths, credentials, streams and media',async()=>{
 await withServer(async({base,request})=>{
  assert.equal((await fetch(base+'/')).status,200);assert.equal((await fetch(base+'/replay.js')).status,404);
  for(const path of ['/api/race?session=9590','/api/v1/system','/api/v1/f1/auth','/api/v1/media/radio/test','/api/v1/views/00000000-0000-0000-0000-000000000000/stream']){
   const r=await fetch(base+path);assert.equal(r.status,401);assert.match(r.headers.get('www-authenticate'),/Bearer/);assert.equal((await r.json()).error.code,'API_UNAUTHORIZED');
  }
  assert.equal((await request('/system',{headers:{Authorization:'Bearer wrong'}})).status,401);
  assert.equal((await fetch(base+'/api/v1/system?token='+token)).status,401);
  assert.equal((await request('/system')).status,200);assert.equal((await request('/system',{headers:{Origin:'https://foreign.invalid'}})).status,403);
  assert.equal((await fetch(base+'/api/races?year=2024',{headers:{Authorization:'Bearer '+token}})).status,404);
 });
});
test('native clients need no Origin; permitted browser preflight supports bearer headers',async()=>{
 await withServer(async({base,request})=>{
  assert.equal((await request('/system')).status,200);
  const r=await fetch(base+'/api/v1/system',{method:'OPTIONS',headers:{Origin:'https://native-ui.invalid','Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization'}});assert.equal(r.status,204);assert.equal(r.headers.get('access-control-allow-origin'),'https://native-ui.invalid');assert.match(r.headers.get('access-control-allow-headers'),/Authorization/);
 },{allowedOrigins:['https://native-ui.invalid']});
});
test('race discovery validates and performs all calendar filtering on the server',async()=>{
 await withServer(async({request})=>{
  const data=await(await request('/races?year=2024&month=9&circuit=39')).json();assert.equal(data.races.length,1);assert.equal(data.circuits.length,1);
  assert.equal((await(await request('/races?year=2024&month=8')).json()).races.length,0);
  for(const query of ['year=2022','year=2024&month=0','year=2024&circuit=../x','year=2024&unknown=1'])assert.equal((await request('/races?'+query)).status,400);
 });
});
test('the complete historical workflow works through API calls without the web UI',async()=>{
 await withServer(async({server,request})=>{
  let r=await request('/views',{method:'POST',body:{source:'history',raceId:9590}});assert.equal(r.status,201);const v=await r.json();assert.equal(r.headers.get('location'),'/api/v1/views/'+v.id);await ready(server.services.views,v.id);
  r=await request('/views/'+v.id+'/playback',{method:'POST',body:{action:'seek',time:start+100000}});let s=await r.json();assert.equal(s.cars[2].timing.leader.value,3);assert.equal(s.geometry.sectors.length,3);
  s=await(await request('/views/'+v.id,{method:'PATCH',body:{selectedDriver:2,selectedTurn:'1',notifications:['control'],overlays:{names:true}}})).json();assert.equal(s.settings.selectedDriver,2);assert.equal(s.settings.selectedTurn,'1');assert.equal(s.events.total,2);
  const events=await(await request('/views/'+v.id+'/events?offset=1&limit=1')).json();assert.equal(events.total,2);assert.equal(events.items.length,1);
  assert.equal((await request('/views/'+v.id+'/events?limit=1000')).status,400);
  assert.equal((await request('/views/'+v.id,{method:'DELETE'})).status,204);assert.equal((await request('/views/'+v.id)).status,404);
 });
});
test('F1 login, status, explicit connect and logout are API supported and never return secrets',async()=>{
 let received;
 await withServer(async({request,connects})=>{
  assert.equal((await(await request('/f1/auth')).json()).signedIn,false);
  const r=await request('/f1/auth/login',{method:'POST',body:{email:'owner@example.invalid',password:'unit-password'}}),text=await r.text();assert.equal(r.status,200);assert.equal(JSON.parse(text).signedIn,true);assert.equal(JSON.parse(text).signingIn,false);assert.equal(text.includes('unit-password'),false);assert.equal(text.includes('private-f1-test-token'),false);assert.deepEqual(received,{email:'owner@example.invalid',password:'unit-password'});
  assert.equal((await(await request('/live')).json()).connection.state,'disconnected');
  assert.equal((await request('/live/connect',{method:'POST',body:{}})).status,202);
  assert.equal((await request('/live/disconnect',{method:'POST',body:{}})).status,200);
  assert.equal((await(await request('/f1/auth/logout',{method:'POST',body:{}})).json()).signedIn,false);
  assert.equal((await(await request('/live')).json()).connection.state,'disconnected');
 },{login:async(email,password)=>{received={email,password};return {value:'private-f1-test-token',expiresAt:Date.now()+3600000};}});
});
test('invalid login bodies and upstream failures cannot leak credentials or touch F1 anonymously',async()=>{
 let calls=0;
 await withServer(async({request,base})=>{
  const unauth=await fetch(base+'/api/v1/f1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"email":"a","password":"unit-password"}'});assert.equal(unauth.status,401);assert.equal(calls,0);
  for(const body of [{email:'',password:'x'},{email:'a',password:'x',extra:1},{email:'a',password:2}])assert.equal((await request('/f1/auth/login',{method:'POST',body})).status,400);
  const failure=await request('/f1/auth/login',{method:'POST',body:{email:'a',password:'unit-password'}});assert.equal(failure.status,422);assert.equal((await failure.text()).includes('unit-password'),false);
  const badJson=await fetch(base+'/api/v1/f1/auth/login',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{bad'});assert.equal(badJson.status,400);
  assert.equal((await fetch(base+'/api/v1/f1/auth/login',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'x'.repeat(17000)})).status,413);
 },{login:async()=>{calls++;throw Error('upstream echoed unit-password');}});
});
test('radio is delivered through the bearer-protected API without arbitrary upstream URLs',async()=>{
 let fetched;
 await withServer(async({request,server})=>{
  const v=await(await request('/views',{method:'POST',body:{source:'history',raceId:9590}})).json();await ready(server.services.views,v.id);const s=await(await request('/views/'+v.id+'/playback',{method:'POST',body:{action:'seek',time:start+100000}})).json(),clip=s.events.items.find(e=>e.kind==='radio').clipId;
  const radio=await request('/media/radio/'+clip);assert.equal(radio.status,200);assert.equal(await radio.text(),'synthetic-audio-bytes');assert.equal(fetched,'https://livetiming.formula1.com/static/test/clip.mp3');assert.equal((await request('/media/radio/'+Buffer.from('https://evil.invalid').toString('base64url'))).status,404);
 },{fetchImpl:async url=>{fetched=url;return new Response('synthetic-audio-bytes');}});
});
test('OpenAPI is exposed under bearer auth with every route and referenced schemas',async()=>{
 await withServer(async({request})=>{
  const spec=await(await request('/openapi.json')).json();assert.equal(spec.openapi,'3.1.0');assert.equal(spec.components.securitySchemes.bearerAuth.scheme,'bearer');
  for(const route of ['/f1/auth/login','/views/{id}/playback','/views/{id}/stream-ticket','/media/radio/{clipId}'])assert.ok(spec.paths[route]);
  function walk(v){if(!v||typeof v!=='object')return;if(v.$ref)assert.ok(spec.components.schemas[v.$ref.split('/').at(-1)],v.$ref);for(const x of Object.values(v))walk(x);}walk(spec);
 });
});
