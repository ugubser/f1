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
