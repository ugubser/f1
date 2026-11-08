import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

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
