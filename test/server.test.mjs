import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {request as httpRequest} from 'node:http';

test('local server serves UI and rejects unknown routes without contacting upstream',async()=>{
  const server=spawn(process.execPath,['server.mjs','--port','31987'],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','pipe']});
  try {
    await once(server.stdout,'data');
    const home=await fetch('http://127.0.0.1:31987/');
    assert.equal(home.status,200);
    assert.match(await home.text(),/Back on track/);
    const script=await fetch('http://127.0.0.1:31987/replay.js');
    assert.match(script.headers.get('content-type'),/javascript/);
    const missing=await fetch('http://127.0.0.1:31987/unknown');
    assert.equal(missing.status,404);
    const method=await fetch('http://127.0.0.1:31987/api/race',{method:'POST'});
    assert.equal(method.status,405);
    const invalid=await fetch('http://127.0.0.1:31987/api/races?year=2022');
    assert.equal(invalid.status,400);
  }finally {server.kill();await once(server,'exit');}
});

import {createReplayServer} from '../server.mjs';
async function withServer(options,run){
  const server=createReplayServer(options);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await run('http://127.0.0.1:'+server.address().port);}finally{await new Promise(resolve=>server.close(resolve));}
}
test('insights preserve partial-source errors and empty coverage explicitly',async()=>{
  const calls=[];
  await withServer({load:async(endpoint,params)=>{calls.push([endpoint,params]);if(endpoint==='race_control')throw Error('Provider offline');return endpoint==='stints'?[{compound:'HARD'}]:[];}},async base=>{
    const response=await fetch(base+'/api/insights?session=9590'),data=await response.json();
    assert.equal(response.status,200);assert.equal(data.availability.stints.status,'available');
    assert.deepEqual(data.availability.race_control,{status:'error',message:'Provider offline'});
    assert.equal(data.availability.team_radio.status,'empty');assert.deepEqual(data.race_control,[]);
    assert.equal(calls.length,4);assert.ok(calls.every(([,params])=>params.session_key==='9590'));
    const invalid=await fetch(base+'/api/insights?session=bad');assert.equal(invalid.status,400);assert.equal(calls.length,4);
  });
});
test('circuit route only passes a validated session and exposes provider failure',async()=>{
  const calls=[];
  await withServer({loadCircuit:async session=>{calls.push(session);if(session==='99')throw Error('No circuit coverage');return {source:'MultiViewer',corners:[{number:1,x:12,y:34}]};}},async base=>{
    const response=await fetch(base+'/api/circuit?session=9590');assert.equal(response.status,200);assert.equal((await response.json()).corners[0].number,1);
    const invalid=await fetch(base+'/api/circuit?session=../secret');assert.equal(invalid.status,400);assert.deepEqual(calls,['9590']);
    const unavailable=await fetch(base+'/api/circuit?session=99');assert.equal(unavailable.status,502);assert.match((await unavailable.json()).error,/No circuit coverage/);
  });
});

test('timing route returns recorded intervals and explicit session coverage',async()=>{
  const calls=[];
  await withServer({load:async(endpoint,params)=>{calls.push([endpoint,params]);return params.session_key==='9590'?[{date:'2024-09-01T13:30:00Z',driver_number:16,interval:1.2,gap_to_leader:3.4}]:[];}},async base=>{
    const response=await fetch(base+'/api/timing?session=9590'),data=await response.json();
    assert.equal(response.status,200);assert.equal(data.availability.status,'available');
    assert.equal(data.intervals[0].gap_to_leader,3.4);assert.deepEqual(calls,[['intervals',{session_key:'9590'}]]);
    const empty=await(await fetch(base+'/api/timing?session=99')).json();assert.equal(empty.availability.status,'empty');assert.deepEqual(empty.intervals,[]);
    const invalid=await fetch(base+'/api/timing?session=../secret');assert.equal(invalid.status,400);assert.equal(calls.length,2);
  });
});
test('timing provider failure is explicit and does not break the race route',async()=>{
  await withServer({load:async endpoint=>{if(endpoint==='intervals')throw Error('Timing provider offline');return [];}},async base=>{
    const response=await fetch(base+'/api/timing?session=9590');assert.equal(response.status,502);assert.match((await response.json()).error,/Timing provider offline/);
    const race=await fetch(base+'/api/race?session=9590');assert.equal(race.status,200);assert.deepEqual(await race.json(),{drivers:[],laps:[],positions:[]});
  });
});

test('live controls are local-only and reject cross-origin or missing action headers',async()=>{
  let connects=0,disconnects=0;
  const live={snapshot:async()=>({auth:{signedIn:false},connection:{state:'disconnected'}}),connect:async()=>{connects++;},disconnect:()=>{disconnects++;}};
  await withServer({live},async base=>{
    const initial=await fetch(base+'/api/live');assert.equal(initial.status,200);assert.equal(initial.headers.get('cross-origin-resource-policy'),'same-origin');assert.equal(initial.headers.get('cache-control'),'no-store');
    const foreign=await fetch(base+'/api/live',{headers:{Origin:'https://untrusted.invalid'}});assert.equal(foreign.status,403);
    const rebinding=await new Promise((resolve,reject)=>{const req=httpRequest(base+'/api/live',{headers:{Host:'untrusted.invalid:'+new URL(base).port}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(rebinding,403);
    const missing=await fetch(base+'/api/live/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(missing.status,403);assert.equal(connects,0);
    const headers={Origin:base,'Content-Type':'application/json','X-F1-Action':'1'};
    assert.equal((await fetch(base+'/api/live/connect',{method:'POST',headers,body:'{}'})).status,200);assert.equal(connects,1);
    assert.equal((await fetch(base+'/api/live/disconnect',{method:'POST',headers,body:'{}'})).status,200);assert.equal(disconnects,1);
    assert.equal((await fetch(base+'/api/live/connect')).status,405);
  });
});
test('no HTTP sign-in accepts credentials and live errors cannot leak upstream secrets',async()=>{
  const live={snapshot:async()=>{throw Error('unit-test-secret');},disconnect:()=>{}};
  await withServer({live},async base=>{
    const response=await fetch(base+'/api/live');assert.equal(response.status,502);assert.equal((await response.text()).includes('unit-test-secret'),false);
    const signin=await fetch(base+'/api/live/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-F1-Action':'1'},body:'{"password":"unit-test-secret"}'});assert.equal(signin.status,405);
  });
});
