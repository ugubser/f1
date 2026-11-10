import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {F1LiveClient,SignalRFrames} from '../f1-live.mjs';
import {AuthError} from '../f1-auth.mjs';
const secret='unit-test-token-not-real',base=Date.now(),utc=new Date(base).toISOString();
const tokens={read:async()=>({value:secret,expiresAt:base+3600000})};
const reply=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers});
class MockSocket extends EventTarget{
  constructor(url,options){super();this.url=url;this.options=options;this.sent=[];this.readyState=0;}
  open(){this.readyState=1;this.dispatchEvent(new Event('open'));}
  message(value){this.dispatchEvent(new MessageEvent('message',{data:value}));}
  send(value){this.sent.push(value);}
  close(){if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new Event('close'));}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check){for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,2));}throw Error('Mock connection did not reach expected state.');}
function setup(options={}){
  const requests=[],sockets=[];
  class Socket extends MockSocket{constructor(...args){super(...args);sockets.push(this);}}
  const fetchImpl=async(url,options)=>{
    requests.push({url,options});
    if(options.method==='OPTIONS')return reply({},200,{'set-cookie':'AWSALBCORS=unit-affinity; Secure'});
    assert.match(url,/negotiateVersion=1/);assert.equal(options.headers.Cookie,'AWSALBCORS=unit-affinity');return reply({connectionToken:'unit-connection-id',availableTransports:[{transport:'WebSockets',transferFormats:['Text']}]});
  };
  const client=new F1LiveClient({tokens,fetchImpl,WebSocketImpl:Socket,retryBase:1,...options});return {client,requests,sockets};
}
function subscribed(socket,{key=123,driver='16'}={}){
  socket.open();socket.message('{}\x1e');socket.message(JSON.stringify({type:3,invocationId:'1',result:{Heartbeat:{Utc:utc},SessionInfo:{Key:key,Name:'Race'},SessionStatus:{Status:'Started'},DriverList:{[driver]:{Tla:'TEST',FullName:'Fixture driver'}},TimingData:{Lines:{[driver]:{Position:'1',NumberOfLaps:0}}}}})+'\x1e');
}
test('SignalR parses split/coalesced frames and rejects malformed or oversized buffers',()=>{
  const parser=new SignalRFrames();assert.deepEqual(parser.push('{}\x1e{"type":'),[{}]);assert.deepEqual(parser.push('6}\x1e'),[{type:6}]);assert.throws(()=>parser.push('bad\x1e'));assert.throws(()=>new SignalRFrames().push('x'.repeat(21*1024*1024)),/size limit/);
});
test('direct negotiation authenticates OPTIONS, POST and WebSocket; only sanitized state reaches the browser',async()=>{
  const {client,requests,sockets}=setup();try{
    await client.connect();await until(()=>sockets.length===1);const socket=sockets[0];subscribed(socket);
    assert.equal(requests.length,2);assert.ok(requests.every(r=>r.options.headers.Authorization==='Bearer '+secret&&r.options.redirect==='manual'));
    assert.match(socket.url,/wss:\/\/livetiming.formula1.com\/signalrcore\?id=/);assert.equal(socket.url.includes(secret),false);assert.equal(socket.options.headers.Authorization,'Bearer '+secret);assert.equal(socket.options.headers.Cookie,'AWSALBCORS=unit-affinity');
    assert.match(socket.sent[0],/"protocol":"json"/);assert.match(socket.sent[1],/"target":"Subscribe"/);
    const snapshot=await client.snapshot();assert.equal(snapshot.connection.state,'streaming');assert.equal(snapshot.cars[0].name_acronym,'TEST');assert.equal(JSON.stringify(snapshot).includes(secret),false);
  }finally{client.disconnect();}
});
test('no anonymous connection is attempted without a saved valid sign-in',async()=>{
  const {client,requests}=setup({tokens:{read:async()=>{throw new AuthError('Sign in first.');}}});
  await assert.rejects(client.connect(),/Sign in first/);assert.equal(requests.length,0);assert.equal((await client.snapshot()).auth.signedIn,false);client.disconnect();
});
test('F1 authorization rejection stops retries and does not expose token or upstream body',async()=>{
  const {client}=setup({fetchImpl:async()=>reply({message:secret},401)});try{
    await client.connect();await until(()=>client.connection.state==='auth_required');
    const snapshot=await client.snapshot();assert.equal(snapshot.auth.signedIn,false);assert.equal(JSON.stringify(snapshot).includes(secret),false);assert.equal(client.wanted,false);await assert.rejects(client.connect(),/rejected/);
  }finally{client.disconnect();}
});
test('reconnect resubscribes to a new snapshot and clears previous-session state',async()=>{
  const {client,sockets}=setup();try{
    await client.connect();await until(()=>sockets.length===1);subscribed(sockets[0]);sockets[0].close();await until(()=>sockets.length===2);subscribed(sockets[1],{key:124,driver:'4'});
    const snapshot=await client.snapshot();assert.equal(snapshot.session.key,124);assert.deepEqual(snapshot.cars.map(c=>c.driver_number),[4]);assert.equal(snapshot.events.length,0);
  }finally{client.disconnect();}
});
test('source staleness is explicit and removing sign-in disconnects an active feed',async()=>{
  let available=true,clock=base;
  const {client,sockets}=setup({now:()=>clock,tokens:{read:async()=>{if(!available)throw new AuthError('Signed out.');return {value:secret,expiresAt:base+3600000};}}});try{
    await client.connect();await until(()=>sockets.length===1);subscribed(sockets[0]);clock=base+31000;assert.equal((await client.snapshot()).connection.state,'stale');
    available=false;assert.equal((await client.snapshot()).connection.state,'auth_required');assert.equal(client.wanted,false);
  }finally{client.disconnect();}
});
test('disconnect cancels a pending sign-in read before any upstream call',async()=>{
  let resolve;const {client,requests}=setup({tokens:{read:()=>new Promise(r=>resolve=r)}});
  const pending=client.connect();client.disconnect();resolve({value:secret,expiresAt:base+3600000});await pending;await tick();assert.equal(requests.length,0);assert.equal(client.wanted,false);
});
test('native Node WebSocket sends private headers without putting credentials in URLs',async()=>{
  let seen,socket;const server=createServer();server.on('upgrade',(req,s)=>{seen=req.headers;socket=s;const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');});
  server.listen(0,'127.0.0.1');await once(server,'listening');const ws=new WebSocket('ws://127.0.0.1:'+server.address().port,{headers:{Authorization:'Bearer '+secret,Cookie:'test=affinity'}});ws.addEventListener('error',()=>{});
  try{await once(ws,'open');assert.equal(seen.authorization,'Bearer '+secret);assert.equal(seen.cookie,'test=affinity');assert.equal(ws.url.includes(secret),false);}finally{ws.close();socket?.destroy();server.close();await once(server,'close');}
});
test('radio uses server-side authentication only for F1 static MP3 URLs',async()=>{
  let sent;const {client}=setup({fetchImpl:async(url,options)=>{sent={url,options};return new Response(Buffer.from('MP3'));}});
  client.store.events.set('radio-0',{kind:'radio',sourceUrl:'https://livetiming.formula1.com/static/session/TeamRadio/clip.mp3'});
  assert.equal((await client.radio('radio-0')).toString(),'MP3');assert.equal(sent.options.headers.Authorization,'Bearer '+secret);assert.equal(sent.options.redirect,'manual');
  client.store.events.set('radio-1',{kind:'radio',sourceUrl:'https://untrusted.invalid/clip.mp3'});await assert.rejects(client.radio('radio-1'),/unavailable/);client.disconnect();
});
test('updates arriving before the subscription snapshot are applied after it without being lost',async()=>{
  const {client,sockets}=setup();try{
    await client.connect();await until(()=>sockets.length===1);const socket=sockets[0];socket.open();socket.message('{}\x1e');
    socket.message(JSON.stringify({type:1,target:'feed',arguments:['TimingData',{Lines:{16:{GapToLeader:'+1.234',Position:'2'}}},new Date(base+1000).toISOString()]})+'\x1e');
    socket.message(JSON.stringify({type:3,invocationId:'1',result:{Heartbeat:{Utc:utc},SessionInfo:{Key:123},DriverList:{16:{Tla:'TEST'}},TimingData:{Lines:{16:{Position:'3',GapToLeader:'+3.000'}}},SessionStatus:{Status:'Started'}}})+'\x1e');
    const snapshot=await client.snapshot();assert.equal(snapshot.cars[0].position,2);assert.equal(snapshot.cars[0].timing.leader.value,1.234);
  }finally{client.disconnect();}
});
test('F1 OPTIONS 405 with affinity cookies proceeds to authenticated negotiation',async()=>{
  const methods=[];const {client,sockets}=setup({fetchImpl:async(url,options)=>{
    methods.push(options.method);
    if(options.method==='OPTIONS')return reply(null,405,{'set-cookie':'AWSALBCORS=unit-affinity; Secure'});
    assert.equal(options.headers.Cookie,'AWSALBCORS=unit-affinity');assert.equal(options.headers.Authorization,'Bearer '+secret);
    return reply({connectionToken:'unit-connection-id',availableTransports:[{transport:'WebSockets',transferFormats:['Text']}]});
  }});
  try{await client.connect();await until(()=>sockets.length===1);subscribed(sockets[0]);assert.deepEqual(methods,['OPTIONS','POST']);assert.equal((await client.snapshot()).connection.state,'streaming');}finally{client.disconnect();}
});
test('OPTIONS 405 without affinity is rejected with a safe, specific error',async()=>{
  const methods=[];const {client}=setup({retryBase:60000,fetchImpl:async(url,options)=>{methods.push(options.method);return reply({message:secret},405);}});
  try{await client.connect();await until(()=>client.connection.state==='reconnecting');assert.deepEqual(methods,['OPTIONS']);assert.match(client.connection.message,/connection setup returned HTTP 405/);assert.equal(JSON.stringify(await client.snapshot()).includes(secret),false);}finally{client.disconnect();}
});
test('POST negotiation failure is never accepted as an affinity bootstrap',async()=>{
  const {client,sockets}=setup({retryBase:60000,fetchImpl:async(url,options)=>options.method==='OPTIONS'?reply({},200,{'set-cookie':'AWSALBCORS=unit-affinity'}):reply({message:secret},405,{'set-cookie':'AWSALBCORS=unit-affinity'})});
  try{await client.connect();await until(()=>client.connection.state==='reconnecting');assert.equal(sockets.length,0);assert.match(client.connection.message,/timing negotiation returned HTTP 405/);assert.equal(JSON.stringify(await client.snapshot()).includes(secret),false);}finally{client.disconnect();}
});
